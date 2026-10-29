import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../../src/create-app';
import { setupQueues } from '../../../src/infrastructure/sqs/setup-queues';
import { testSqsClient } from '../../support/sqs';
import { createTestOrm, testDatabaseUrl } from '../../support/test-database';

const noWorkers = { sqsConsumer: false, outboxPublisher: false, pendingReferenceWorker: false };

let orm: MikroORM;
let sqs: SQSClient;
let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  orm = await createTestOrm();
  sqs = testSqsClient();
  const suffix = `obs-${Date.now()}`;
  const queueNames = { wagerQueue: `wager-${suffix}.fifo`, wagerDeadLetterQueue: `wager-dlq-${suffix}.fifo`, eventsQueue: `events-${suffix}.fifo` };
  await setupQueues(sqs, queueNames);
  app = await createApp({ orm: { clientUrl: testDatabaseUrl() }, queueNames, workers: noWorkers });
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
});

afterAll(async () => {
  await app.close();
  sqs.destroy();
  await orm.close(true);
});

async function get(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  // Corpo JSON livre (any): quem confere o formato são os expects de cada teste.
  return { status: response.status, json: (await response.json()) as any };
}

describe('health checks (abertos, sem autenticação)', () => {
  test('/health/live responde 200', async () => {
    const response = await get('/health/live');
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  test('/health/ready responde 200 quando PostgreSQL e SQS estão alcançáveis', async () => {
    const response = await get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: { status: 'up' }, sqs: { status: 'up' } } });
  });

  test('/health/ready responde 503 apontando qual dependência caiu; /health/live continua 200', async () => {
    // Outra instância do app com banco inexistente e fila inexistente.
    const broken = await createApp({
      orm: { clientUrl: 'postgresql://wagering:wagering@localhost:5999/nothing' },
      queueNames: { wagerQueue: 'does-not-exist.fifo', wagerDeadLetterQueue: 'x.fifo', eventsQueue: 'y.fifo' },
      workers: noWorkers,
    });
    await broken.listen(0);
    const url = (await broken.getUrl()).replace('[::1]', 'localhost');
    try {
      const ready = await fetch(`${url}/health/ready`);
      const body = (await ready.json()) as { status: string; checks: { database: { status: string }; sqs: { status: string } } };
      expect(ready.status).toBe(503);
      expect(body.status).toBe('unavailable');
      expect(body.checks.database.status).toBe('down');
      expect(body.checks.sqs.status).toBe('down');
      expect((await fetch(`${url}/health/live`)).status).toBe(200); // vivo, só não está pronto
    } finally {
      await broken.close();
    }
  }, 15_000);
});

describe('métricas (GET /metrics, formato Prometheus)', () => {
  test('transações por status, duplicatas, latência, conflitos, divergências e outbox lag', async () => {
    const playerId = Bun.randomUUIDv7();
    const wallet = (await post('/wallets', { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } })).json;
    const bet = (id: string, amount: string) => ({
      providerId: 'provider-a',
      externalTransactionId: id,
      playerId,
      walletId: wallet.id,
      roundId: 'r1',
      gameId: 'g1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    });

    await post('/wagering/transactions', bet('obs-1', '5.00'), { 'Idempotency-Key': 'provider-a:obs-1' }); // PROCESSED
    await post('/wagering/transactions', bet('obs-1', '5.00'), { 'Idempotency-Key': 'provider-a:obs-1' }); // replay
    await post('/wagering/transactions', bet('obs-2', '50.00'), { 'Idempotency-Key': 'provider-a:obs-2' }); // REJECTED
    await post('/wallets', { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } }); // 409: corrida na UNIQUE
    await orm.em.fork().execute(`UPDATE wallets SET balance = balance + 1.00, version = version + 1 WHERE id = ?`, [wallet.id]);
    await post(`/wallets/${wallet.id}/reconciliation`, {}); // divergência

    const metrics = await get('/metrics');
    expect(metrics.status).toBe(200);
    const text = metrics.text;
    expect(text).toContain('wagering_transactions_total{status="PROCESSED",kind="BET",source="http"} 1');
    expect(text).toContain('wagering_transactions_total{status="REJECTED",kind="BET",source="http"} 1');
    expect(text).toContain('wagering_duplicates_detected_total{source="http",reason="idempotent_replay"} 1');
    expect(text).toContain('wagering_lock_conflicts_total{type="duplicate_key"} 1');
    expect(text).toContain('wagering_reconciliation_divergences_total 1');
    expect(text).toMatch(/wagering_processing_duration_seconds_count\{source="http",outcome="PROCESSED"\} 2/);
    expect(text).toMatch(/wagering_outbox_pending_events \d+/); // eventos esperando (workers desligados)
    expect(text).toMatch(/wagering_outbox_lag_seconds [\d.]+/);
    // Também declaradas (aparecem com valor quando os workers rodam):
    for (const name of ['wagering_retries_total', 'wagering_dlq_messages_total']) {
      expect(text).toContain(`# TYPE ${name} counter`);
    }
  });
});

describe('logs estruturados', () => {
  test('cada transação gera uma linha JSON com os ids de rastreio e SEM valores financeiros', async () => {
    const playerId = Bun.randomUUIDv7();
    const wallet = (await post('/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } })).json;

    // Captura o que o logger escreve no stdout durante a requisição.
    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
      await post(
        '/wagering/transactions',
        {
          providerId: 'provider-log',
          externalTransactionId: 'log-1',
          playerId,
          walletId: wallet.id,
          roundId: 'r1',
          gameId: 'g1',
          kind: 'BET',
          money: { amount: '12.34', currency: 'BRL' },
        },
        { 'Idempotency-Key': 'provider-log:log-1', 'X-Correlation-Id': 'corr-log-1' },
      );
    } finally {
      process.stdout.write = originalWrite;
    }

    const entries = lines
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line));
    const entry = entries.find((e) => e.message?.event === 'wager_transaction_handled');

    expect(entry).toBeDefined();
    expect(entry.level).toBe('log');
    expect(entry.message).toMatchObject({
      correlationId: 'corr-log-1',
      providerId: 'provider-log',
      externalTransactionId: 'log-1',
      walletId: wallet.id,
      transactionId: expect.any(String),
      status: 'PROCESSED',
    });
    // Nada de valor nem saldo nos logs.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('12.34');
    expect(serialized).not.toContain('87.66');
  });
});
