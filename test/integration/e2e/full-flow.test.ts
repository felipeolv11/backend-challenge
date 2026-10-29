import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../../src/create-app';
import type { QueueUrls } from '../../../src/infrastructure/sqs/setup-queues';
import { drainQueue, sendWagerMessage, sleep, testSqsClient } from '../../support/sqs';
import { createTestOrm, testDatabaseUrl } from '../../support/test-database';
import { expectWalletMatchesLedger } from '../../support/wagering';
import { setupQueues } from '../../../src/infrastructure/sqs/setup-queues';

// O app COMPLETO: API + consumidor SQS + publisher da outbox + worker de pendentes, todos ligados,
// contra PostgreSQL e SQS reais. Uma aposta entra pela fila e os eventos saem na fila de eventos.

let orm: MikroORM;
let app: INestApplication;
let baseUrl: string;
let sqs: SQSClient;
let queues: QueueUrls;

beforeAll(async () => {
  orm = await createTestOrm();
  sqs = testSqsClient();
  const suffix = `e2e-${Date.now()}`;
  const queueNames = { wagerQueue: `wager-${suffix}.fifo`, wagerDeadLetterQueue: `wager-dlq-${suffix}.fifo`, eventsQueue: `events-${suffix}.fifo` };
  queues = await setupQueues(sqs, queueNames, { visibilityTimeoutSeconds: 5, maxReceiveCount: 10 });

  app = await createApp({
    orm: { clientUrl: testDatabaseUrl() },
    queueNames,
    consumer: { waitTimeSeconds: 1 },
    outbox: { pollIntervalMs: 100 },
    pendingReference: { baseDelayMs: 100, pollIntervalMs: 100 },
  });
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
});

afterAll(async () => {
  await app.close();
  sqs.destroy();
  await orm.close(true);
});

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Corpo JSON livre (any): quem confere o formato são os expects de cada teste.
  return { status: response.status, body: (await response.json()) as any };
}

/** Espera até a condição ser verdadeira (os workers rodam em segundo plano). */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() - started > timeoutMs) return value;
    await sleep(100);
  }
}

describe('fluxo completo com os workers ligados', () => {
  test('aposta pela fila → processada → eventos publicados na fila de eventos', async () => {
    const playerId = Bun.randomUUIDv7();
    const wallet = (await http('POST', '/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } })).body;

    const data = {
      providerId: 'provider-a',
      externalTransactionId: 'e2e-bet-1',
      idempotencyKey: 'provider-a:e2e-bet-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    await sendWagerMessage(sqs, queues.wagerQueueUrl, { messageId: 'e2e-msg-1', data });

    // O consumidor processa em segundo plano; consultamos pela API até aparecer.
    const transaction = await eventually(
      () => http('GET', '/providers/provider-a/wagering/transactions/e2e-bet-1'),
      (r) => r.status === 200,
    );
    expect(transaction.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } });

    // O publisher da outbox publica os eventos (abertura + aposta) na fila de eventos.
    const received: Array<{ eventType: string; data: { walletId: string } }> = [];
    await eventually(
      async () => {
        received.push(...(await drainQueue(sqs, queues.eventsQueueUrl, 1)).map((m) => JSON.parse(m.Body!)));
        return received.filter((e) => e.data.walletId === wallet.id && e.eventType === 'WalletBalanceChanged').length;
      },
      (balanceChanges) => balanceChanges >= 2,
    );
    const types = received.filter((e) => e.data.walletId === wallet.id).map((e) => e.eventType);
    expect(types).toContain('WagerTransactionProcessed');
    expect(types.filter((t) => t === 'WalletBalanceChanged')).toHaveLength(2); // abertura + aposta

    await expectWalletMatchesLedger(orm, wallet.id);
  });

  test('REFUND pela fila antes da BET: o worker de pendentes conclui quando a BET chega pela API', async () => {
    const playerId = Bun.randomUUIDv7();
    const wallet = (await http('POST', '/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } })).body;
    const base = { providerId: 'provider-a', playerId, walletId: wallet.id, roundId: 'round-1', gameId: 'game-1', money: { amount: '40.00', currency: 'BRL' } };

    await sendWagerMessage(sqs, queues.wagerQueueUrl, {
      messageId: 'e2e-refund-msg',
      data: { ...base, externalTransactionId: 'e2e-refund', idempotencyKey: 'provider-a:e2e-refund', kind: 'REFUND', referenceExternalTransactionId: 'e2e-late-bet' },
    });
    const pending = await eventually(
      () => http('GET', '/providers/provider-a/wagering/transactions/e2e-refund'),
      (r) => r.status === 200,
    );
    expect(pending.body.status).toBe('PENDING_REFERENCE');

    const bet = await http('POST', '/wagering/transactions', { ...base, externalTransactionId: 'e2e-late-bet', kind: 'BET' }, {
      'Idempotency-Key': 'provider-a:e2e-late-bet',
    });
    expect(bet.status).toBe(200);

    const refund = await eventually(
      () => http('GET', '/providers/provider-a/wagering/transactions/e2e-refund'),
      (r) => r.body.status === 'PROCESSED',
    );
    expect(refund.body.status).toBe('PROCESSED');
    expect((await http('GET', `/wallets/${wallet.id}`)).body.balance.amount).toBe('100.00');
    await expectWalletMatchesLedger(orm, wallet.id);
  });
});
