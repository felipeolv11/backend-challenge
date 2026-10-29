import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DeleteMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../../src/application/errors';
import type { TransactionRunner } from '../../../src/application/ports';
import { ProcessWagerTransaction } from '../../../src/application/process-wager-transaction';
import type { ConsumerConfig } from '../../../src/config';
import { MikroOrmTransactionRunner } from '../../../src/infrastructure/database/mikro-orm-transaction-runner';
import type { QueueUrls } from '../../../src/infrastructure/sqs/setup-queues';
import { type ConsumerAction, WagerTransactionConsumer } from '../../../src/infrastructure/sqs/wager-transaction-consumer';
import { createTestQueues, drainQueue, sendRawMessage, sendWagerMessage, sleep, testSqsClient } from '../../support/sqs';
import { createTestOrm } from '../../support/test-database';
import { buildServices, command, countRows, expectWalletMatchesLedger, openWallet, type Services, storedBalance } from '../../support/wagering';

// SQS de verdade (MiniStack) + PostgreSQL de verdade. Visibility timeout curto (2s) para os
// testes de redelivery não demorarem.

let orm: MikroORM;
let services: Services;
let sqs: SQSClient;
let queues: QueueUrls;

const config: ConsumerConfig = {
  consumerName: 'wager-transactions-consumer',
  maxAttempts: 3,
  retryBaseDelaySeconds: 1,
  retryMaxDelaySeconds: 4,
  waitTimeSeconds: 1,
};

beforeAll(async () => {
  orm = await createTestOrm();
  services = buildServices(orm);
  sqs = testSqsClient();
  queues = await createTestQueues(sqs, 'consumer');
});

afterAll(async () => {
  sqs.destroy();
  await orm.close(true);
});

function consumer(options: { sqsClient?: SQSClient; process?: ProcessWagerTransaction; actions?: ConsumerAction[] } = {}) {
  return new WagerTransactionConsumer(
    options.sqsClient ?? sqs,
    { queueUrl: queues.wagerQueueUrl, deadLetterQueueUrl: queues.wagerDeadLetterQueueUrl },
    options.process ?? services.processWagerTransaction,
    config,
    (action) => options.actions?.push(action),
  );
}

let sequence = 0;
async function messageFor(walletBalance = '100.00', overrides: Parameters<typeof command>[1] = {}) {
  const wallet = await openWallet(services, walletBalance);
  const data = command(wallet, { amount: '30.00', ...overrides });
  return { wallet, envelope: { messageId: `msg-${Date.now()}-${++sequence}`, data: { ...data } } };
}

/** Recebe e trata até a fila ficar vazia (algumas rodadas). */
async function consumeAll(c = consumer(), rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    if ((await c.pollOnce()) === 0) break;
  }
}

async function deadLetters() {
  return (await drainQueue(sqs, queues.wagerDeadLetterQueueUrl)).map((m) => ({
    reason: m.MessageAttributes?.deadLetterReason?.StringValue,
    body: m.Body,
  }));
}

describe('caminho feliz', () => {
  test('processa a mensagem com o mesmo caso de uso do HTTP, grava a inbox e faz ack', async () => {
    const { wallet, envelope } = await messageFor();
    await sendWagerMessage(sqs, queues.wagerQueueUrl, envelope);

    const actions: ConsumerAction[] = [];
    await consumeAll(consumer({ actions }));

    expect(actions).toEqual(['acked']);
    expect(await storedBalance(orm, wallet.id)).toBe('70.00');
    expect(await countRows(orm, `SELECT 1 FROM inbox_messages WHERE message_id = ?`, [envelope.messageId])).toBe(1);
    await expectWalletMatchesLedger(orm, wallet.id);
  });

  test('rejeição de negócio (sem saldo) é resultado final: ack, sem DLQ', async () => {
    const { wallet, envelope } = await messageFor('10.00');
    await sendWagerMessage(sqs, queues.wagerQueueUrl, envelope);
    const actions: ConsumerAction[] = [];
    await consumeAll(consumer({ actions }));

    expect(actions).toEqual(['acked']);
    const [row] = await orm.em.fork().execute(`SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = ?`, [
      envelope.data.externalTransactionId,
    ]);
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await storedBalance(orm, wallet.id)).toBe('10.00');
  });
});

describe('at-least-once: duplicatas e redelivery não duplicam efeitos', () => {
  test('a mesma mensagem entregue duas vezes: um débito só, as duas com ack', async () => {
    const { wallet, envelope } = await messageFor();
    await sendWagerMessage(sqs, queues.wagerQueueUrl, envelope);
    await sendWagerMessage(sqs, queues.wagerQueueUrl, envelope);

    const actions: ConsumerAction[] = [];
    await consumeAll(consumer({ actions }));

    expect(actions).toEqual(['acked', 'acked']);
    expect(await storedBalance(orm, wallet.id)).toBe('70.00');
    expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet.id])).toBe(1);
  });

  test('worker morre DEPOIS do commit e ANTES do ack: o SQS entrega de novo e não há débito duplo', async () => {
    const { wallet, envelope } = await messageFor();
    await sendWagerMessage(sqs, queues.wagerQueueUrl, envelope);

    // Cliente SQS que "morre" na hora do ack: o commit no banco já aconteceu, o DeleteMessage não.
    const crashingOnAck = new Proxy(sqs, {
      get(target, property, receiver) {
        if (property === 'send') {
          return (cmd: unknown, ...rest: unknown[]) => {
            if (cmd instanceof DeleteMessageCommand) return Promise.reject(new Error('process killed before ack'));
            return (target.send as (...args: unknown[]) => unknown).call(target, cmd, ...rest);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const crashedActions: ConsumerAction[] = [];
    await consumer({ sqsClient: crashingOnAck, actions: crashedActions }).pollOnce();
    expect(crashedActions).toEqual([]); // não houve ack, nem retry, nem DLQ: a mensagem ficou na fila
    expect(await storedBalance(orm, wallet.id)).toBe('70.00'); // mas o commit foi feito

    // O visibility timeout (2s) expira e o SQS entrega a MESMA mensagem de novo, para outra instância.
    await sleep(2_500);
    const actions: ConsumerAction[] = [];
    await consumeAll(consumer({ actions }));

    expect(actions).toEqual(['acked']); // replay pela inbox, e agora o ack
    expect(await storedBalance(orm, wallet.id)).toBe('70.00'); // sem débito duplo
    expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet.id])).toBe(1);
    await expectWalletMatchesLedger(orm, wallet.id);
  });
});

describe('erros permanentes vão para a DLQ na hora', () => {
  test('mensagem que não é JSON → INVALID_MESSAGE', async () => {
    await sendRawMessage(sqs, queues.wagerQueueUrl, '{not json');
    const actions: ConsumerAction[] = [];
    await consumeAll(consumer({ actions }));
    expect(actions).toEqual(['dead-lettered']);
    expect((await deadLetters()).map((m) => m.reason)).toEqual(['INVALID_MESSAGE']);
  });

  test('payload com amount inválido → INVALID_PAYLOAD, nada gravado', async () => {
    const { wallet, envelope } = await messageFor('100.00', { money: { amount: '25.5', currency: 'BRL' } });
    await sendWagerMessage(sqs, queues.wagerQueueUrl, envelope);
    await consumeAll();
    expect((await deadLetters()).map((m) => m.reason)).toEqual(['INVALID_PAYLOAD']);
    expect(await storedBalance(orm, wallet.id)).toBe('100.00');
  });

  test('mesmo messageId com conteúdo diferente → MESSAGE_ID_CONFLICT', async () => {
    const { wallet, envelope } = await messageFor();
    await sendWagerMessage(sqs, queues.wagerQueueUrl, envelope);
    await consumeAll();
    const tampered = { ...envelope, data: { ...envelope.data, money: { amount: '99.00', currency: 'BRL' } } };
    await sendWagerMessage(sqs, queues.wagerQueueUrl, tampered);
    await consumeAll();

    expect((await deadLetters()).map((m) => m.reason)).toEqual(['MESSAGE_ID_CONFLICT']);
    expect(await storedBalance(orm, wallet.id)).toBe('70.00');
  });
});

describe('erros transitórios: retry com backoff e limite de tentativas', () => {
  /** Runner que falha com erro transitório nas primeiras `failures` chamadas. */
  function flakyRunner(failures: number): TransactionRunner {
    const real = new MikroOrmTransactionRunner(orm);
    let calls = 0;
    return {
      run: (work) => (++calls <= failures ? Promise.reject(new TransientInfrastructureError('database down')) : real.run(work)),
    };
  }

  test('falha 1 vez, a mensagem volta depois do backoff e é processada', async () => {
    const { wallet, envelope } = await messageFor();
    await sendWagerMessage(sqs, queues.wagerQueueUrl, envelope);
    const actions: ConsumerAction[] = [];
    const c = consumer({ process: new ProcessWagerTransaction(flakyRunner(1)), actions });
    await c.pollOnce(); // tentativa 1: falha → volta à fila em 1s
    expect(actions).toEqual(['retry-scheduled']);
    expect(await storedBalance(orm, wallet.id)).toBe('100.00');

    await sleep(1_500);
    await c.pollOnce(); // tentativa 2: sucesso
    expect(actions).toEqual(['retry-scheduled', 'acked']);
    expect(await storedBalance(orm, wallet.id)).toBe('70.00');
  });

  test('esgotou as tentativas: transação FAILED (auditável) e mensagem na DLQ', async () => {
    const { wallet, envelope } = await messageFor();
    await sendWagerMessage(sqs, queues.wagerQueueUrl, envelope);

    // Falha nas 3 tentativas de processar; a 4ª chamada ao runner é o recordFailure, que funciona.
    const alwaysFailing = new ProcessWagerTransaction(flakyRunner(config.maxAttempts));
    const actions: ConsumerAction[] = [];
    const c = consumer({ process: alwaysFailing, actions });

    await c.pollOnce(); // 1ª: backoff de 1s
    await sleep(1_500);
    await c.pollOnce(); // 2ª: backoff de 2s
    await sleep(2_500);
    await c.pollOnce(); // 3ª: limite → FAILED + DLQ

    expect(actions).toEqual(['retry-scheduled', 'retry-scheduled', 'dead-lettered']);
    const [row] = await orm.em.fork().execute(`SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = ?`, [
      envelope.data.externalTransactionId,
    ]);
    expect(row).toEqual({ status: 'FAILED', failure_code: 'PROCESSING_ERROR' });
    expect((await deadLetters()).map((m) => m.reason)).toEqual(['MAX_ATTEMPTS_EXCEEDED']);
    expect(await storedBalance(orm, wallet.id)).toBe('100.00');
  }, 15_000);
});

describe('SIGTERM: parada graciosa', () => {
  test('termina a mensagem em andamento, devolve as outras à fila, e outra instância as processa', async () => {
    const wallet = await openWallet(services, '100.00');
    const envelopes = [1, 2, 3].map((i) => ({ messageId: `sigterm-${Date.now()}-${i}`, data: { ...command(wallet, { amount: '10.00' }) } }));
    for (const envelope of envelopes) await sendWagerMessage(sqs, queues.wagerQueueUrl, envelope);

    // Processamento lento (1s por mensagem) para dar tempo de pedir a parada no meio.
    const real = new MikroOrmTransactionRunner(orm);
    const slowRunner: TransactionRunner = { run: async (work) => (await sleep(1_000), real.run(work)) };
    const firstActions: ConsumerAction[] = [];
    const first = consumer({ process: new ProcessWagerTransaction(slowRunner), actions: firstActions });

    first.start();
    await sleep(1_300); // a primeira mensagem está sendo processada
    await first.stop(); // "SIGTERM"

    expect(firstActions[0]).toBe('acked'); // a que estava em andamento terminou (commit + ack)
    expect(firstActions.filter((a) => a === 'released').length).toBeGreaterThanOrEqual(1); // as outras voltaram

    // Outra instância pega as devolvidas imediatamente (sem esperar o visibility timeout).
    const secondActions: ConsumerAction[] = [];
    await consumeAll(consumer({ actions: secondActions }));

    expect(await storedBalance(orm, wallet.id)).toBe('70.00'); // as 3 apostas, cada uma uma vez
    expect(await countRows(orm, `SELECT 1 FROM inbox_messages WHERE message_id LIKE 'sigterm-%'`)).toBe(3);
    await expectWalletMatchesLedger(orm, wallet.id);
  }, 15_000);
});
