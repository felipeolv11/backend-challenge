import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PendingReferencePolicy } from '../../../src/application/pending-reference-policy';
import { ProcessWagerTransaction } from '../../../src/application/process-wager-transaction';
import { RetryPendingReferences } from '../../../src/application/retry-pending-references';
import { FailureCode } from '../../../src/domain/failure-code';
import { WagerTransactionStatus as Status } from '../../../src/domain/wager-transaction';
import { MikroOrmTransactionRunner } from '../../../src/infrastructure/database/mikro-orm-transaction-runner';
import { sleep } from '../../support/sqs';
import { createTestOrm } from '../../support/test-database';
import { buildServices, command, context, countRows, expectWalletMatchesLedger, openWallet, type Services, storedBalance } from '../../support/wagering';

// Política curta para o teste não demorar: 3 novas tentativas, a partir de 50ms.
const policy = new PendingReferencePolicy({ maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 });

let orm: MikroORM;
let services: Services;
let processTransaction: ProcessWagerTransaction;

beforeAll(async () => {
  orm = await createTestOrm();
  services = buildServices(orm);
  processTransaction = new ProcessWagerTransaction(new MikroOrmTransactionRunner(orm), policy);
});

afterAll(async () => {
  await orm.close(true);
});

const worker = () => new RetryPendingReferences(new MikroOrmTransactionRunner(orm), policy);

async function statusOf(transactionId: string) {
  const [row] = await orm.em
    .fork()
    .execute(`SELECT status, failure_code, reference_attempts FROM wager_transactions WHERE id = ?`, [transactionId]);
  return row!;
}

describe('referência fora de ordem (seção 7.1)', () => {
  test('REFUND chega antes da BET: fica pendente; quando a BET chega, o worker processa o REFUND', async () => {
    const wallet = await openWallet(services, '100.00');

    const refund = await processTransaction.execute(
      command(wallet, { kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: 'bet-late-1' }),
      context,
    );
    expect(refund.status).toBe(Status.PendingReference);

    // A BET chega depois (pode vir da fila, do HTTP, de outra instância...).
    await processTransaction.execute(command(wallet, { kind: 'BET', amount: '30.00', externalTransactionId: 'bet-late-1' }), context);
    expect(await storedBalance(orm, wallet.id)).toBe('70.00');

    await sleep(60); // espera a primeira nova tentativa vencer
    const result = await worker().runOnce();

    expect(result.processed).toBe(1);
    expect(await statusOf(refund.transactionId)).toMatchObject({ status: 'PROCESSED', failure_code: null });
    expect(await storedBalance(orm, wallet.id)).toBe('100.00'); // a aposta foi devolvida
    expect(
      await countRows(orm, `SELECT 1 FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WagerTransactionProcessed'`, [
        refund.transactionId,
      ]),
    ).toBe(1);
    await expectWalletMatchesLedger(orm, wallet.id);
  });

  test('ROLLBACK de um WIN que chega depois: processa debitando', async () => {
    const wallet = await openWallet(services, '0.00');
    const rollback = await processTransaction.execute(
      command(wallet, { kind: 'ROLLBACK', amount: '20.00', referenceExternalTransactionId: 'win-late-1' }),
      context,
    );
    await processTransaction.execute(command(wallet, { kind: 'WIN', amount: '20.00', externalTransactionId: 'win-late-1' }), context);
    await sleep(60);
    await worker().runOnce();

    expect(await statusOf(rollback.transactionId)).toMatchObject({ status: 'PROCESSED' });
    expect(await storedBalance(orm, wallet.id)).toBe('0.00');
    await expectWalletMatchesLedger(orm, wallet.id);
  });

  test('a referência nunca chega: depois do limite, REJECTED com REFERENCE_NOT_FOUND e evento publicado', async () => {
    const wallet = await openWallet(services, '100.00');
    const refund = await processTransaction.execute(
      command(wallet, { kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: 'bet-never' }),
      context,
    );

    // Backoff: 50ms, 100ms, 200ms. Três novas tentativas e, na terceira, desiste.
    const attempts: number[] = [];
    for (let i = 0; i < 3; i++) {
      await sleep(250);
      await worker().runOnce();
      attempts.push((await statusOf(refund.transactionId)).reference_attempts);
    }

    expect(attempts).toEqual([1, 2, 2]); // a 3ª tentativa não reagenda: rejeita
    expect(await statusOf(refund.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: FailureCode.ReferenceNotFound });
    expect(
      await countRows(orm, `SELECT 1 FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WagerTransactionRejected'`, [
        refund.transactionId,
      ]),
    ).toBe(1);
    expect(await storedBalance(orm, wallet.id)).toBe('100.00');
    await expectWalletMatchesLedger(orm, wallet.id);
  });

  test('antes do horário agendado, o worker não mexe na transação', async () => {
    const wallet = await openWallet(services, '100.00');
    const slowPolicy = new PendingReferencePolicy({ maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 });
    const slowProcess = new ProcessWagerTransaction(new MikroOrmTransactionRunner(orm), slowPolicy);
    const refund = await slowProcess.execute(
      command(wallet, { kind: 'REFUND', amount: '30.00', referenceExternalTransactionId: 'bet-later' }),
      context,
    );
    await worker().runOnce();
    expect(await statusOf(refund.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 0 });
  });
});

describe('vários workers ao mesmo tempo', () => {
  test('a mesma pendente é processada uma vez só, mesmo com 3 workers simultâneos', async () => {
    const wallet = await openWallet(services, '100.00');
    const refund = await processTransaction.execute(
      command(wallet, { kind: 'REFUND', amount: '40.00', referenceExternalTransactionId: 'bet-race-1' }),
      context,
    );
    await processTransaction.execute(command(wallet, { kind: 'BET', amount: '40.00', externalTransactionId: 'bet-race-1' }), context);
    await sleep(60);

    const results = await Promise.all([worker().retryOne(refund.transactionId), worker().retryOne(refund.transactionId), worker().retryOne(refund.transactionId)]);

    expect(results.filter((r) => r === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(2);
    expect(await storedBalance(orm, wallet.id)).toBe('100.00'); // devolveu UMA vez
    expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = ?`, [refund.transactionId])).toBe(1);
    await expectWalletMatchesLedger(orm, wallet.id);
  });
});
