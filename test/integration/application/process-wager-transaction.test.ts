import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { IdempotencyConflictError, InboxMessageConflictError, WalletAlreadyExistsError } from '../../../src/application/errors';
import type { TransactionalRepositories, TransactionRunner } from '../../../src/application/ports';
import { InvalidWagerTransactionError } from '../../../src/domain/errors';
import { FailureCode } from '../../../src/domain/failure-code';
import { WagerTransactionStatus as Status } from '../../../src/domain/wager-transaction';
import { MikroOrmTransactionRunner } from '../../../src/infrastructure/database/mikro-orm-transaction-runner';
import { createTestOrm } from '../../support/test-database';
import {
  buildServices,
  command,
  context,
  countRows,
  expectWalletMatchesLedger,
  openWallet,
  type Services,
  storedBalance,
} from '../../support/wagering';

let orm: MikroORM;
let services: Services;
const touchedWallets: string[] = [];

beforeAll(async () => {
  orm = await createTestOrm();
  services = buildServices(orm);
});

// Invariante final de TODOS os testes: saldo da wallet == saldo reconstruído pelo ledger.
afterEach(async () => {
  for (const walletId of touchedWallets.splice(0)) {
    await expectWalletMatchesLedger(orm, walletId);
  }
});

afterAll(async () => {
  await orm.close(true);
});

async function wallet(initialBalance = '100.00') {
  const created = await openWallet(services, initialBalance);
  touchedWallets.push(created.id);
  return created;
}

const submit = (cmd: Parameters<typeof command>[1] & {}, w: { id: string; playerId: string }) =>
  services.processWagerTransaction.execute(command(w, cmd), context);

const outboxEvents = (aggregateId: string) =>
  orm.em.fork().execute(`SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY id`, [aggregateId]);

describe('criar wallet', () => {
  test('saldo inicial > 0: wallet version 1 + OPENING + lançamento CREDIT + eventos, tudo junto', async () => {
    const w = await wallet('1000.00');
    expect(w).toMatchObject({ balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    expect(await countRows(orm, `SELECT 1 FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING' AND status = 'PROCESSED'`, [w.id])).toBe(1);
    expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT'`, [w.id])).toBe(1);
    expect((await outboxEvents(w.id)).map((e) => e.event_type)).toEqual(['WalletBalanceChanged']);
  });

  test('saldo inicial zero: sem OPENING e sem lançamento', async () => {
    const w = await wallet('0.00');
    expect(await countRows(orm, `SELECT 1 FROM wager_transactions WHERE wallet_id = ?`, [w.id])).toBe(0);
    expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ?`, [w.id])).toBe(0);
  });

  test('duplicada para o mesmo player + moeda é conflito', async () => {
    const w = await wallet();
    await expect(openWallet(services, '5.00', w.playerId)).rejects.toThrow(WalletAlreadyExistsError);
  });
});

describe('BET, WIN e LOSS', () => {
  test('BET debita, grava o lançamento e os eventos Processed + BalanceChanged na outbox', async () => {
    const w = await wallet('100.00');
    const result = await submit({ kind: 'BET', amount: '25.00' }, w);

    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: '75.00' }, failureCode: null, idempotentReplay: false });
    expect(await storedBalance(orm, w.id)).toBe('75.00');
    expect((await outboxEvents(result.transactionId)).map((e) => e.event_type)).toEqual(['WagerTransactionProcessed']);
    expect(await countRows(orm, `SELECT 1 FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WalletBalanceChanged'`, [w.id])).toBe(2);
  });

  test('WIN credita', async () => {
    const w = await wallet('100.00');
    const result = await submit({ kind: 'WIN', amount: '150.00' }, w);
    expect(result.status).toBe(Status.Processed);
    expect(await storedBalance(orm, w.id)).toBe('250.00');
  });

  test('LOSS é PROCESSED sem mexer no saldo, sem lançamento e sem WalletBalanceChanged', async () => {
    const w = await wallet('100.00');
    const result = await submit({ kind: 'LOSS', amount: '25.00' }, w);

    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: '100.00' } });
    expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = ?`, [result.transactionId])).toBe(0);
    expect((await outboxEvents(result.transactionId)).map((e) => e.event_type)).toEqual(['WagerTransactionProcessed']);
    const [row] = await orm.em.fork().execute(`SELECT version FROM wallets WHERE id = ?`, [w.id]);
    expect(row!.version).toBe(1);
  });

  test('WIN de 0.00 é PROCESSED sem lançamento', async () => {
    const w = await wallet('100.00');
    const result = await submit({ kind: 'WIN', amount: '0.00' }, w);
    expect(result.status).toBe(Status.Processed);
    expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = ?`, [result.transactionId])).toBe(0);
  });

  test('BET sem saldo é REJECTED com INSUFFICIENT_FUNDS, auditável e com evento', async () => {
    const w = await wallet('10.00');
    const result = await submit({ kind: 'BET', amount: '10.01' }, w);

    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.InsufficientFunds, balance: { amount: '10.00' } });
    expect(await storedBalance(orm, w.id)).toBe('10.00');
    expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = ?`, [result.transactionId])).toBe(0);
    expect((await outboxEvents(result.transactionId)).map((e) => e.event_type)).toEqual(['WagerTransactionRejected']);
  });
});

describe('REFUND e ROLLBACK', () => {
  test('REFUND de uma BET devolve o valor', async () => {
    const w = await wallet('100.00');
    await submit({ kind: 'BET', amount: '30.00', externalTransactionId: 'bet-r1' }, w);
    const refund = await submit({ kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: 'bet-r1' }, w);

    expect(refund.status).toBe(Status.Processed);
    expect(await storedBalance(orm, w.id)).toBe('100.00');
  });

  test('a mesma BET não pode ser revertida de novo, nem por outro tipo (REFUND + ROLLBACK)', async () => {
    const w = await wallet('100.00');
    await submit({ kind: 'BET', amount: '30.00', externalTransactionId: 'bet-r2' }, w);
    await submit({ kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: 'bet-r2' }, w);

    const secondRefund = await submit({ kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: 'bet-r2' }, w);
    const rollback = await submit({ kind: 'ROLLBACK', amount: '30.00', referenceExternalTransactionId: 'bet-r2' }, w);

    expect(secondRefund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(rollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await storedBalance(orm, w.id)).toBe('100.00'); // devolveu UMA vez só
  });

  test('ROLLBACK de um WIN debita; se o prêmio já foi gasto, é REVERSAL_WOULD_OVERDRAW (≠ INSUFFICIENT_FUNDS)', async () => {
    const w = await wallet('0.00');
    await submit({ kind: 'WIN', amount: '50.00', externalTransactionId: 'win-r3', roundId: 'round-r3' }, w);
    await submit({ kind: 'BET', amount: '40.00', roundId: 'round-r4' }, w); // gastou o prêmio

    const rollback = await submit(
      { kind: 'ROLLBACK', amount: '50.00', referenceExternalTransactionId: 'win-r3', roundId: 'round-r3' },
      w,
    );

    expect(rollback).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReversalWouldOverdraw, balance: { amount: '10.00' } });
    expect(await storedBalance(orm, w.id)).toBe('10.00');
  });

  test('ROLLBACK de uma BET credita', async () => {
    const w = await wallet('100.00');
    await submit({ kind: 'BET', amount: '20.00', externalTransactionId: 'bet-r5' }, w);
    const rollback = await submit({ kind: 'ROLLBACK', amount: '20.00', referenceExternalTransactionId: 'bet-r5' }, w);
    expect(rollback.status).toBe(Status.Processed);
    expect(await storedBalance(orm, w.id)).toBe('100.00');
  });

  test('valor diferente da referência é AMOUNT_MISMATCH', async () => {
    const w = await wallet('100.00');
    await submit({ kind: 'BET', amount: '20.00', externalTransactionId: 'bet-r6' }, w);
    const refund = await submit({ kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: 'bet-r6' }, w);
    expect(refund.failureCode).toBe(FailureCode.AmountMismatch);
  });

  test('referência de outra rodada é REFERENCE_MISMATCH', async () => {
    const w = await wallet('100.00');
    await submit({ kind: 'BET', amount: '20.00', externalTransactionId: 'bet-r7', roundId: 'round-a' }, w);
    const refund = await submit({ kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: 'bet-r7', roundId: 'round-b' }, w);
    expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test('REFUND antes da BET fica PENDING_REFERENCE, sem mexer no saldo, com evento', async () => {
    const w = await wallet('100.00');
    const refund = await submit({ kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: 'bet-not-yet' }, w);

    expect(refund).toMatchObject({ status: Status.PendingReference, balance: null, failureCode: null });
    expect(await storedBalance(orm, w.id)).toBe('100.00');
    expect((await outboxEvents(refund.transactionId)).map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference']);
  });
});

describe('validações de wallet', () => {
  test('wallet inexistente: REJECTED WALLET_NOT_FOUND, gravado e com replay estável', async () => {
    const ghost = { id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() };
    const bet = command(ghost, { amount: '10.00' });

    const first = await services.processWagerTransaction.execute(bet, context);
    const replay = await services.processWagerTransaction.execute(bet, context);

    expect(first).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.WalletNotFound, balance: null });
    expect(replay).toEqual({ ...first, idempotentReplay: true });
  });

  test('wallet de outro player: PLAYER_WALLET_MISMATCH', async () => {
    const w = await wallet();
    const result = await submit({ playerId: Bun.randomUUIDv7() }, w);
    expect(result.failureCode).toBe(FailureCode.PlayerWalletMismatch);
  });

  test('moeda diferente da wallet: CURRENCY_MISMATCH', async () => {
    const w = await wallet();
    const result = await submit({ money: { amount: '10.00', currency: 'USD' } }, w);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(await storedBalance(orm, w.id)).toBe('100.00');
  });
});

describe('payload inválido não é gravado', () => {
  test.each([
    ['REFUND sem referência', { kind: 'REFUND' }],
    ['BET de 0.00', { kind: 'BET', amount: '0.00' }],
    ['OPENING vindo do provedor', { kind: 'OPENING' }],
  ])('%s → InvalidWagerTransactionError', async (_name, overrides) => {
    const w = await wallet();
    const bet = command(w, overrides);
    await expect(services.processWagerTransaction.execute(bet, context)).rejects.toThrow(InvalidWagerTransactionError);
    expect(await countRows(orm, `SELECT 1 FROM wager_transactions WHERE external_transaction_id = ?`, [bet.externalTransactionId])).toBe(0);
  });
});

describe('idempotência', () => {
  test('requisição idêntica devolve o MESMO resultado, com idempotentReplay = true e o saldo original', async () => {
    const w = await wallet('100.00');
    const bet = command(w, { amount: '10.00' });

    const first = await services.processWagerTransaction.execute(bet, context);
    await submit({ kind: 'BET', amount: '50.00' }, w); // o saldo muda depois
    const replay = await services.processWagerTransaction.execute(bet, context);

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance).toEqual({ amount: '90.00', currency: 'BRL' }); // o saldo observado NAQUELE momento
  });

  test('mesma key com payload diferente é conflito, não replay, e não grava nada', async () => {
    const w = await wallet('100.00');
    const bet = command(w, { amount: '10.00' });
    await services.processWagerTransaction.execute(bet, context);

    await expect(services.processWagerTransaction.execute({ ...bet, money: { amount: '99.00', currency: 'BRL' } }, context)).rejects.toThrow(
      IdempotencyConflictError,
    );
    expect(await storedBalance(orm, w.id)).toBe('90.00');
  });

  test('mesma transação externa com outra key é conflito', async () => {
    const w = await wallet('100.00');
    const bet = command(w, { amount: '10.00' });
    await services.processWagerTransaction.execute(bet, context);
    await expect(services.processWagerTransaction.execute({ ...bet, idempotencyKey: 'other-key' }, context)).rejects.toThrow(
      IdempotencyConflictError,
    );
  });

  test('o hash ignora a ordem das chaves do JSON', async () => {
    const w = await wallet('100.00');
    const bet = command(w, { amount: '10.00' });
    const reordered = Object.fromEntries(Object.entries(bet).reverse()) as typeof bet;
    await services.processWagerTransaction.execute(bet, context);
    const replay = await services.processWagerTransaction.execute(reordered, context);
    expect(replay.idempotentReplay).toBe(true);
  });
});

describe('inbox (entrada pela fila)', () => {
  const inboxContext = (messageId: string, payloadHash = 'hash-a') => ({
    correlationId: 'test',
    inbox: { consumerName: 'wager-transactions-consumer', messageId, payloadHash },
  });

  test('a mensagem fica registrada na mesma transação; a redelivery devolve replay sem duplicar', async () => {
    const w = await wallet('100.00');
    const bet = command(w, { amount: '10.00' });

    const first = await services.processWagerTransaction.execute(bet, inboxContext('msg-1'));
    const redelivery = await services.processWagerTransaction.execute(bet, inboxContext('msg-1'));

    expect(redelivery).toEqual({ ...first, idempotentReplay: true });
    expect(await countRows(orm, `SELECT 1 FROM inbox_messages WHERE message_id = 'msg-1'`)).toBe(1);
    expect(await storedBalance(orm, w.id)).toBe('90.00');
  });

  test('mesmo messageId com conteúdo diferente é InboxMessageConflictError (vai para a DLQ)', async () => {
    const w = await wallet('100.00');
    await services.processWagerTransaction.execute(command(w, { amount: '10.00' }), inboxContext('msg-2', 'hash-a'));
    await expect(
      services.processWagerTransaction.execute(command(w, { amount: '10.00' }), inboxContext('msg-2', 'hash-b')),
    ).rejects.toThrow(InboxMessageConflictError);
  });
});

describe('atomicidade: transação, ledger, saldo, outbox e inbox são gravados juntos ou nada', () => {
  test('se gravar a outbox falhar, NADA é gravado (nem transação, nem ledger, nem saldo, nem inbox)', async () => {
    const w = await wallet('100.00');

    // Runner real, mas com a outbox quebrada: simula uma falha no meio da transação SQL,
    // DEPOIS de a transação, o lançamento e o saldo já terem sido gravados.
    const realRunner = new MikroOrmTransactionRunner(orm);
    const failingOutboxRunner: TransactionRunner = {
      run: (work) =>
        realRunner.run((repositories: TransactionalRepositories) =>
          work({
            ...repositories,
            outbox: {
              insert: async () => {
                throw new Error('simulated outbox failure');
              },
              claimDue: (now, limit) => repositories.outbox.claimDue(now, limit),
              update: (message) => repositories.outbox.update(message),
              markPublished: (ids, at) => repositories.outbox.markPublished(ids, at),
            },
          }),
        ),
    };
    const broken = buildServices(orm, failingOutboxRunner);

    const bet = command(w, { amount: '40.00' });
    await expect(
      broken.processWagerTransaction.execute(bet, {
        correlationId: 'test',
        inbox: { consumerName: 'c', messageId: 'msg-atomic', payloadHash: 'h' },
      }),
    ).rejects.toThrow('simulated outbox failure');

    expect(await countRows(orm, `SELECT 1 FROM wager_transactions WHERE external_transaction_id = ?`, [bet.externalTransactionId])).toBe(0);
    expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [w.id])).toBe(0);
    expect(await countRows(orm, `SELECT 1 FROM inbox_messages WHERE message_id = 'msg-atomic'`)).toBe(0);
    expect(await storedBalance(orm, w.id)).toBe('100.00');

    // E depois da falha, o mesmo pedido funciona normalmente com a infraestrutura boa.
    const retried = await services.processWagerTransaction.execute(bet, context);
    expect(retried).toMatchObject({ status: Status.Processed, idempotentReplay: false, balance: { amount: '60.00' } });
  });
});
