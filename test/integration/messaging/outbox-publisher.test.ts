import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { EventPublisher } from '../../../src/application/ports';
import { PublishOutbox } from '../../../src/application/publish-outbox';
import type { OutboxMessage } from '../../../src/domain/outbox-message';
import { MikroOrmTransactionRunner } from '../../../src/infrastructure/database/mikro-orm-transaction-runner';
import type { QueueUrls } from '../../../src/infrastructure/sqs/setup-queues';
import { SqsEventPublisher } from '../../../src/infrastructure/sqs/sqs-event-publisher';
import { createTestQueues, drainQueue, sleep, testSqsClient } from '../../support/sqs';
import { createTestOrm } from '../../support/test-database';
import { buildServices, command, context, countRows, openWallet, type Services } from '../../support/wagering';

let orm: MikroORM;
let services: Services;
let sqs: SQSClient;
let queues: QueueUrls;
let runner: MikroOrmTransactionRunner;

beforeAll(async () => {
  orm = await createTestOrm();
  services = buildServices(orm);
  runner = new MikroOrmTransactionRunner(orm);
  sqs = testSqsClient();
  queues = await createTestQueues(sqs, 'outbox');
});

afterAll(async () => {
  sqs.destroy();
  await orm.close(true);
});

const pending = () => countRows(orm, `SELECT 1 FROM outbox_messages WHERE published_at IS NULL`);

/** Publica tudo o que estiver pendente (todas as rodadas necessárias). */
async function publishAll(publisher: PublishOutbox) {
  while ((await publisher.publishBatch()).claimed > 0) {}
}

/** Envolve um publisher contando quantas vezes cada evento foi publicado com sucesso. */
function countingPublisher(inner: EventPublisher, delayMs = 0) {
  const counts = new Map<string, number>();
  const publisher: EventPublisher = {
    async publishAll(messages: OutboxMessage[]) {
      if (delayMs) await sleep(delayMs);
      const outcomes = await inner.publishAll(messages);
      for (const outcome of outcomes) {
        if (outcome.error === undefined) counts.set(outcome.messageId, (counts.get(outcome.messageId) ?? 0) + 1);
      }
      return outcomes;
    },
  };
  return { publisher, counts };
}

async function generateEvents(bets: number) {
  const wallet = await openWallet(services, '1000.00');
  for (let i = 0; i < bets; i++) {
    await services.processWagerTransaction.execute(command(wallet, { amount: '1.00' }), context);
  }
  return wallet;
}

describe('publicação', () => {
  test('publica todos os pendentes no SQS com o envelope do evento e marca como publicados', async () => {
    const wallet = await generateEvents(2); // abertura (2 eventos: Processed + BalanceChanged) + 2 apostas (2 cada) = 6
    await publishAll(new PublishOutbox(runner, new SqsEventPublisher(sqs, queues.eventsQueueUrl)));

    expect(await pending()).toBe(0);
    const received = await drainQueue(sqs, queues.eventsQueueUrl);
    const events = received.map((m) => JSON.parse(m.Body!));
    const balanceChanges = events.filter((e) => e.eventType === 'WalletBalanceChanged' && e.data.walletId === wallet.id);

    expect(balanceChanges).toHaveLength(3);
    // Mesma wallet, mesmo MessageGroupId: chegam em ordem (version 1, 2, 3).
    expect(balanceChanges.map((e) => e.data.walletVersion)).toEqual([1, 2, 3]);
    expect(received[0]!.Attributes?.MessageGroupId).toBe(wallet.id);
    for (const event of events) {
      expect(event).toMatchObject({ eventId: expect.any(String), eventType: expect.any(String), version: 1, occurredAt: expect.any(String) });
    }
  });
});

describe('vários publishers concorrentes sobre a mesma outbox', () => {
  test('dois publishers ao mesmo tempo: todo evento publicado exatamente uma vez', async () => {
    await generateEvents(15); // 2 + 30 eventos
    const total = await pending();
    const sqsPublisher = new SqsEventPublisher(sqs, queues.eventsQueueUrl);

    // Publicação lenta (20ms) para os dois ficarem disputando a outbox ao mesmo tempo.
    const a = countingPublisher(sqsPublisher, 20);
    const b = countingPublisher(sqsPublisher, 20);
    await Promise.all([
      publishAll(new PublishOutbox(new MikroOrmTransactionRunner(orm), a.publisher, 5)),
      publishAll(new PublishOutbox(new MikroOrmTransactionRunner(orm), b.publisher, 5)),
    ]);

    expect(await pending()).toBe(0);
    const ids = [...a.counts.keys(), ...b.counts.keys()];
    expect(ids).toHaveLength(total); // nenhum evento publicado pelos dois
    expect(new Set(ids).size).toBe(total);
    expect([...a.counts.values(), ...b.counts.values()].every((count) => count === 1)).toBe(true);
    // Os dois trabalharam (SKIP LOCKED dividiu o trabalho), não um esperando o outro.
    expect(a.counts.size).toBeGreaterThan(0);
    expect(b.counts.size).toBeGreaterThan(0);
    await drainQueue(sqs, queues.eventsQueueUrl, 10);
  });
});

describe('falhas e recuperação (seção 11)', () => {
  test('commit feito, processo morre antes de publicar: outra instância publica depois', async () => {
    await generateEvents(1);
    // "Processo morreu": os eventos estão na outbox (commitados junto com a aposta), ninguém publicou.
    expect(await pending()).toBe(4); // abertura (2) + aposta (2)

    const otherInstance = new PublishOutbox(new MikroOrmTransactionRunner(orm), new SqsEventPublisher(sqs, queues.eventsQueueUrl));
    await publishAll(otherInstance);

    expect(await pending()).toBe(0);
    expect(await drainQueue(sqs, queues.eventsQueueUrl)).toHaveLength(4);
  });

  test('morre DEPOIS de publicar e ANTES de marcar: republica com o MESMO eventId (seguro para o consumidor)', async () => {
    await generateEvents(1);
    const sqsPublisher = new SqsEventPublisher(sqs, queues.eventsQueueUrl);
    const published: string[] = [];

    // Pega um evento, publica no SQS e "morre" antes do commit: o erro escapa da transação,
    // que faz rollback. A outbox continua pendente, como se o processo tivesse caído ali.
    await expect(
      runner.run(async (repositories) => {
        const [first] = await repositories.outbox.claimDue(new Date(), 1);
        await sqsPublisher.publishAll([first!]);
        published.push(first!.id);
        throw new Error('process killed after publish');
      }),
    ).rejects.toThrow('process killed after publish');
    expect(await pending()).toBe(4); // nada foi marcado como publicado

    const republished: string[] = [];
    await publishAll(
      new PublishOutbox(runner, {
        async publishAll(messages) {
          const outcomes = await sqsPublisher.publishAll(messages);
          republished.push(...messages.map((message) => message.id));
          return outcomes;
        },
      }),
    );

    expect(republished).toContain(published[0]!); // o mesmo evento foi publicado de novo...
    expect(await pending()).toBe(0);
    // ...e o SQS FIFO descartou a cópia (MessageDeduplicationId = eventId): 4 mensagens, não 5.
    const received = await drainQueue(sqs, queues.eventsQueueUrl);
    expect(received).toHaveLength(4);
    expect(new Set(received.map((m) => JSON.parse(m.Body!).eventId)).size).toBe(4);
  });

  test('falha ao publicar (SQS fora): não perde o evento, agenda nova tentativa com backoff', async () => {
    await generateEvents(1);
    const before = Date.now();
    const result = await new PublishOutbox(runner, {
      publishAll: async (messages) => messages.map((message) => ({ messageId: message.id, error: new Error('SQS unavailable') })),
    }).publishBatch();

    expect(result).toEqual({ claimed: 4, published: 0, failed: 4 });
    const rows = await orm.em
      .fork()
      .execute(`SELECT attempts, next_attempt_at, published_at FROM outbox_messages WHERE published_at IS NULL`);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.attempts).toBe(1);
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThanOrEqual(before + 1_000); // backoff de 1s
    }

    // Enquanto o backoff não vence, ninguém pega de novo.
    expect((await new PublishOutbox(runner, new SqsEventPublisher(sqs, queues.eventsQueueUrl)).publishBatch()).claimed).toBe(0);
    await sleep(1_100);
    await publishAll(new PublishOutbox(runner, new SqsEventPublisher(sqs, queues.eventsQueueUrl)));
    expect(await pending()).toBe(0);
    await drainQueue(sqs, queues.eventsQueueUrl);
  });

  test('falha PARCIAL no lote: só as que falharam são reagendadas; as outras ficam publicadas', async () => {
    await generateEvents(1);
    const sqsPublisher = new SqsEventPublisher(sqs, queues.eventsQueueUrl);
    let failedId: string | undefined;

    // O SQS aceita o lote mas recusa UMA das mensagens (o SendMessageBatch pode fazer isso).
    const result = await new PublishOutbox(runner, {
      async publishAll(messages) {
        failedId = messages[1]!.id;
        const ok = await sqsPublisher.publishAll(messages.filter((message) => message.id !== failedId));
        return [...ok, { messageId: failedId, error: new Error('InternalError: throttled') }];
      },
    }).publishBatch();

    expect(result).toEqual({ claimed: 4, published: 3, failed: 1 });
    const stillPending = await orm.em.fork().execute(`SELECT id, attempts FROM outbox_messages WHERE published_at IS NULL`);
    expect(stillPending).toEqual([{ id: failedId, attempts: 1 }]);

    await sleep(1_100);
    await publishAll(new PublishOutbox(runner, sqsPublisher));
    expect(await pending()).toBe(0);
    expect(await drainQueue(sqs, queues.eventsQueueUrl)).toHaveLength(4);
  });
});
