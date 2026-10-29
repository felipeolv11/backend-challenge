import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { setupQueues, type QueueUrls } from '../../../src/infrastructure/sqs/setup-queues';
import { type Instance, killInstance, startInstance } from '../../support/instances';
import { drainQueue, testSqsClient } from '../../support/sqs';
import { createTestOrm, testDatabaseUrl } from '../../support/test-database';
import { countRows, expectWalletMatchesLedger, storedBalance } from '../../support/wagering';

// Seção 13, concorrência itens 4 e 8:
//   4. ≥ 3 processos/instâncias simultâneos
//   8. reinício do serviço com comprovação da consistência final
// Cada instância é um PROCESSO separado (bun run src/main.ts), com seu pool de conexões e seus
// três workers, todos usando o mesmo PostgreSQL e as mesmas filas SQS.

let orm: MikroORM;
let sqs: SQSClient;
let queues: QueueUrls;
let instanceEnv: Record<string, string>;
let running: Instance[] = [];
let nextPort = 3_101;

beforeAll(async () => {
  orm = await createTestOrm();
  sqs = testSqsClient();
  const suffix = `multi-${Date.now()}`;
  const queueNames = { wagerQueue: `wager-${suffix}.fifo`, wagerDeadLetterQueue: `wager-dlq-${suffix}.fifo`, eventsQueue: `events-${suffix}.fifo` };
  // Visibility timeout de 3s: mensagens que estavam com uma instância morta voltam rápido.
  queues = await setupQueues(sqs, queueNames, { visibilityTimeoutSeconds: 3, maxReceiveCount: 20 });
  instanceEnv = {
    DATABASE_URL: testDatabaseUrl(),
    WAGER_QUEUE_NAME: queueNames.wagerQueue,
    WAGER_DLQ_NAME: queueNames.wagerDeadLetterQueue,
    EVENTS_QUEUE_NAME: queueNames.eventsQueue,
    CONSUMER_WAIT_TIME_SECONDS: '1',
    CONSUMER_RETRY_BASE_DELAY_SECONDS: '1',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_BASE_DELAY_MS: '200',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '200',
  };
});

afterEach(async () => {
  await Promise.all(running.map(killInstance));
  running = [];
});

afterAll(async () => {
  sqs.destroy();
  await orm.close(true);
});

async function start(count: number): Promise<Instance[]> {
  const started = await Promise.all(Array.from({ length: count }, (_, i) => startInstance(`instance-${nextPort + i}`, nextPort + i, instanceEnv)));
  nextPort += count;
  running.push(...started);
  return started;
}

// ------------------------------------------------------------------ helpers

/** Chamada HTTP com reenvio para outra instância se a escolhida cair ou responder 503 (como faria um provedor). */
async function submitWithRetry(instances: Instance[], startAt: number, body: Record<string, unknown>) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const instance = instances[(startAt + attempt) % instances.length]!;
    try {
      const response = await fetch(`${instance.url}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}` },
        body: JSON.stringify(body),
      });
      if (response.status !== 503) return { status: response.status, body: (await response.json()) as { transactionId: string; idempotentReplay: boolean } };
    } catch {
      // instância morta: tenta a próxima
    }
    await Bun.sleep(100);
  }
  throw new Error(`could not submit ${body.externalTransactionId}`);
}

async function createWallets(instance: Instance, count: number, amount: string) {
  return Promise.all(
    Array.from({ length: count }, async () => {
      const playerId = Bun.randomUUIDv7();
      const response = await fetch(`${instance.url}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
      });
      const wallet = (await response.json()) as { id: string };
      return { id: wallet.id, playerId };
    }),
  );
}

function bet(wallet: { id: string; playerId: string }, externalTransactionId: string, amount: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-multi',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

/** Envia mensagens pela fila em lotes de 10. `copies` > 1 manda cada mensagem várias vezes (duplicatas). */
async function sendToQueue(messages: Array<{ messageId: string; data: Record<string, unknown> }>, copies = 1) {
  const entries = messages.flatMap((message) =>
    Array.from({ length: copies }, (_, copy) => ({
      Id: `${message.messageId.replace(/[^A-Za-z0-9_-]/g, '_')}-${copy}`,
      MessageBody: JSON.stringify({ type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), ...message }),
      MessageGroupId: String(message.data.walletId),
      MessageDeduplicationId: `${message.messageId}-${copy}-${Date.now()}`,
    })),
  );
  await Promise.all(
    Array.from({ length: Math.ceil(entries.length / 10) }, (_, i) =>
      sqs.send(new SendMessageBatchCommand({ QueueUrl: queues.wagerQueueUrl, Entries: entries.slice(i * 10, i * 10 + 10) })),
    ),
  );
}

async function waitUntil(description: string, condition: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for: ${description}`);
}

const transactionsOf = (providerPrefix: string) =>
  countRows(orm, `SELECT 1 FROM wager_transactions WHERE external_transaction_id LIKE ?`, [`${providerPrefix}%`]);

/** Soma uma métrica do /metrics de todas as instâncias. */
async function sumMetric(instances: Instance[], pattern: RegExp): Promise<number[]> {
  return Promise.all(
    instances.map(async (instance) => {
      const text = await (await fetch(`${instance.url}/metrics`)).text();
      return text
        .split('\n')
        .filter((line) => pattern.test(line))
        .reduce((sum, line) => sum + Number(line.split(' ').pop()), 0);
    }),
  );
}

// ------------------------------------------------------------------ testes

describe('≥ 3 instâncias simultâneas (processos separados)', () => {
  test('HTTP nas 3 + fila disputada pelos 3 consumidores, com duplicatas: saldo exato, nenhum débito duplicado', async () => {
    const instances = await start(3);
    const wallets = await createWallets(instances[0]!, 6, '100.00');

    // Por wallet: 30 apostas de 10.00 com saldo 100.00 → exatamente 10 podem passar.
    // 15 por HTTP (espalhadas pelas 3 instâncias, cada uma enviada 2x para instâncias DIFERENTES)
    // e 15 pela fila (cada mensagem enviada 2x). Tudo ao mesmo tempo.
    const httpBets = wallets.flatMap((w, wi) => Array.from({ length: 15 }, (_, i) => bet(w, `mi-http-${wi}-${i}`, '10.00')));
    const queueBets = wallets.flatMap((w, wi) =>
      Array.from({ length: 15 }, (_, i) => ({ messageId: `mi-msg-${wi}-${i}`, data: { ...bet(w, `mi-sqs-${wi}-${i}`, '10.00'), idempotencyKey: `provider-multi:mi-sqs-${wi}-${i}` } })),
    );

    await Promise.all([
      ...httpBets.flatMap((body, i) => [submitWithRetry(instances, i, body), submitWithRetry(instances, i + 1, body)]),
      sendToQueue(queueBets, 2),
    ]);

    await waitUntil('all 180 bets terminal', async () => (await transactionsOf('mi-')) === 180);
    await waitUntil('queue drained', async () => (await countRows(orm, `SELECT 1 FROM inbox_messages WHERE message_id LIKE 'mi-msg-%'`)) === 90);

    for (const wallet of wallets) {
      expect(await storedBalance(orm, wallet.id)).toBe('0.00');
      expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet.id])).toBe(10);
      expect(
        await countRows(orm, `SELECT 1 FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' AND status = 'REJECTED' AND failure_code = 'INSUFFICIENT_FUNDS'`, [
          wallet.id,
        ]),
      ).toBe(20);
      await expectWalletMatchesLedger(orm, wallet.id);
    }

    // As métricas das 3 instâncias somadas batem com o banco, e as 3 trabalharam.
    const httpNew = await sumMetric(instances, /^wagering_transactions_total\{.*source="http"/);
    const httpReplays = await sumMetric(instances, /^wagering_duplicates_detected_total\{source="http"/);
    const sqsNew = await sumMetric(instances, /^wagering_transactions_total\{.*source="sqs"/);
    const sqsDuplicates = await sumMetric(instances, /^wagering_duplicates_detected_total\{source="sqs"/);
    console.log('  por instância → http novas', httpNew, '| http replays', httpReplays, '| fila novas', sqsNew, '| fila duplicadas', sqsDuplicates);
    expect(httpNew.reduce((a, b) => a + b, 0)).toBe(90);
    expect(httpReplays.reduce((a, b) => a + b, 0)).toBe(90);
    expect(sqsNew.reduce((a, b) => a + b, 0)).toBe(90);
    expect(sqsDuplicates.reduce((a, b) => a + b, 0)).toBe(90);
    expect(httpNew.every((count) => count > 0)).toBe(true);
  }, 120_000);

  test('a mesma aposta enviada 50 vezes, espalhada pelas 3 instâncias: um único débito', async () => {
    const instances = await start(3);
    const [wallet] = await createWallets(instances[0]!, 1, '100.00');
    const same = bet(wallet!, 'mi-same-bet', '25.00');

    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submitWithRetry(instances, i, same)));

    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(await storedBalance(orm, wallet!.id)).toBe('75.00');
    expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet!.id])).toBe(1);
    await expectWalletMatchesLedger(orm, wallet!.id);
  }, 60_000);
});

describe('queda e reinício do serviço no meio do processamento', () => {
  test('instâncias mortas à força (kill -9) no meio da carga; novas instâncias concluem tudo com consistência final', async () => {
    const first = await start(3);
    const wallets = await createWallets(first[0]!, 20, '1000.00');

    // 20 apostas de 1.00 por wallet pela fila (400 mensagens) + em 5 wallets um REFUND que chega
    // ANTES da sua BET (exercita o worker de pendentes atravessando a queda).
    const messages = wallets.flatMap((w, wi) =>
      Array.from({ length: 20 }, (_, i) => ({ messageId: `rs-msg-${wi}-${i}`, data: { ...bet(w, `rs-bet-${wi}-${i}`, '1.00'), idempotencyKey: `provider-multi:rs-bet-${wi}-${i}` } })),
    );
    const refunds = wallets.slice(0, 5).map((w, wi) => ({
      refund: { messageId: `rs-refund-msg-${wi}`, data: { ...bet(w, `rs-refund-${wi}`, '7.00', { kind: 'REFUND', referenceExternalTransactionId: `rs-late-${wi}` }), idempotencyKey: `provider-multi:rs-refund-${wi}` } },
      lateBet: { messageId: `rs-late-msg-${wi}`, data: { ...bet(w, `rs-late-${wi}`, '7.00'), idempotencyKey: `provider-multi:rs-late-${wi}` } },
    }));
    await sendToQueue(refunds.map((r) => r.refund));
    await sendToQueue(messages);
    await sendToQueue(refunds.map((r) => r.lateBet));

    // Deixa processar um pouco e derruba UMA instância à força...
    await Bun.sleep(400);
    await killInstance(first[1]!);
    const atFirstKill = await transactionsOf('rs-');
    // ...e logo depois derruba TODAS: o serviço inteiro caiu no meio do processamento.
    await Bun.sleep(300);
    await Promise.all([killInstance(first[0]!), killInstance(first[2]!)]);
    running = [];
    const atFullOutage = await transactionsOf('rs-');
    console.log(`  transações gravadas na 1ª queda: ${atFirstKill}/410, quando tudo caiu: ${atFullOutage}/410`);

    // O serviço volta com 3 instâncias novas.
    await start(3);

    await waitUntil('all 410 transactions recorded', async () => (await transactionsOf('rs-')) === 410, 90_000);
    await waitUntil(
      'no transaction left pending',
      async () => (await countRows(orm, `SELECT 1 FROM wager_transactions WHERE external_transaction_id LIKE 'rs-%' AND status NOT IN ('PROCESSED')`)) === 0,
      90_000,
    );
    await waitUntil('outbox fully published', async () => (await countRows(orm, `SELECT 1 FROM outbox_messages WHERE published_at IS NULL`)) === 0, 90_000);

    // Consistência final.
    for (const [wi, wallet] of wallets.entries()) {
      // 20 apostas de 1.00; nas 5 primeiras wallets, +1 aposta de 7.00 devolvida pelo REFUND.
      expect(await storedBalance(orm, wallet.id)).toBe('980.00');
      const expectedEntries = 1 + 20 + (wi < 5 ? 2 : 0); // abertura + apostas (+ aposta tardia + refund)
      expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ?`, [wallet.id])).toBe(expectedEntries);
      await expectWalletMatchesLedger(orm, wallet.id);
    }
    // Cada mensagem virou exatamente uma transação e um registro de inbox (nada duplicado, nada perdido).
    expect(await countRows(orm, `SELECT 1 FROM inbox_messages WHERE message_id LIKE 'rs-%'`)).toBe(410);
    expect(await countRows(orm, `SELECT 1 FROM wager_transactions WHERE kind = 'REFUND' AND external_transaction_id LIKE 'rs-refund-%' AND status = 'PROCESSED'`)).toBe(5);

    // Todo evento confirmado no banco chegou à fila de eventos (nenhum perdido na queda).
    const outboxIds = new Set(
      (await orm.em.fork().execute(`SELECT id FROM outbox_messages WHERE aggregate_id IN (SELECT id FROM wager_transactions WHERE external_transaction_id LIKE 'rs-%')`)).map(
        (row) => row.id as string,
      ),
    );
    const publishedIds = new Set<string>();
    await waitUntil(
      'all events received on the events queue',
      async () => {
        for (const message of await drainQueue(sqs, queues.eventsQueueUrl, 5)) publishedIds.add(JSON.parse(message.Body!).eventId);
        return [...outboxIds].every((id) => publishedIds.has(id));
      },
      60_000,
    );
    expect([...outboxIds].every((id) => publishedIds.has(id))).toBe(true);
  }, 240_000);
});
