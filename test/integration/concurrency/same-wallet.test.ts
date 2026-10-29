import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { FailureCode } from '../../../src/domain/failure-code';
import { WagerTransactionStatus as Status } from '../../../src/domain/wager-transaction';
import { createTestOrm } from '../../support/test-database';
import { buildServices, command, context, countRows, expectWalletMatchesLedger, openWallet, type Services, storedBalance } from '../../support/wagering';

// Concorrência REAL: as chamadas rodam em paralelo (Promise.all), cada uma numa transação e
// numa conexão própria do pool do Postgres. Não é mock sequencial.

let orm: MikroORM;
let services: Services;

beforeAll(async () => {
  orm = await createTestOrm();
  services = buildServices(orm);
});

afterAll(async () => {
  await orm.close(true);
});

describe('cenário obrigatório da seção 8: saldo 100.00, duas apostas de 80.00 simultâneas', () => {
  // Repetido várias vezes: um teste de corrida que passa uma vez pode ter tido "sorte".
  test.each(Array.from({ length: 10 }, (_, i) => i + 1))('rodada %i', async () => {
    const wallet = await openWallet(services, '100.00');

    const results = await Promise.all([
      services.processWagerTransaction.execute(command(wallet, { amount: '80.00' }), context),
      services.processWagerTransaction.execute(command(wallet, { amount: '80.00' }), context),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([Status.Processed, Status.Rejected]);
    expect(results.find((r) => r.status === Status.Rejected)!.failureCode).toBe(FailureCode.InsufficientFunds);

    expect(await storedBalance(orm, wallet.id)).toBe('20.00');
    expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet.id])).toBe(1);
    await expectWalletMatchesLedger(orm, wallet.id);
  });

  test('nenhum retry duplica o débito: reenviar as duas apostas devolve o resultado original', async () => {
    const wallet = await openWallet(services, '100.00');
    const bets = [command(wallet, { amount: '80.00' }), command(wallet, { amount: '80.00' })];

    const first = await Promise.all(bets.map((bet) => services.processWagerTransaction.execute(bet, context)));
    const retried = await Promise.all(bets.map((bet) => services.processWagerTransaction.execute(bet, context)));

    for (let i = 0; i < bets.length; i++) {
      expect(retried[i]).toEqual({ ...first[i]!, idempotentReplay: true });
    }
    expect(await storedBalance(orm, wallet.id)).toBe('20.00');
    expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet.id])).toBe(1);
    await expectWalletMatchesLedger(orm, wallet.id);
  });
});

describe('a mesma aposta enviada 50 vezes em paralelo', () => {
  test('gera um único débito; as outras 49 são replays do mesmo resultado', async () => {
    const wallet = await openWallet(services, '1000.00');
    const sameBet = command(wallet, { amount: '25.00' });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => services.processWagerTransaction.execute(sameBet, context)),
    );

    const transactionIds = new Set(results.map((r) => r.transactionId));
    expect(transactionIds.size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    // Todos devolvem o MESMO resultado, inclusive o saldo observado naquele momento.
    for (const result of results) {
      expect(result.status).toBe(Status.Processed);
      expect(result.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    }

    expect(await storedBalance(orm, wallet.id)).toBe('975.00');
    expect(await countRows(orm, `SELECT 1 FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`, [wallet.id])).toBe(1);
    expect(await countRows(orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet.id])).toBe(1);
    await expectWalletMatchesLedger(orm, wallet.id);
  });
});

describe('hot wallet: muitas apostas diferentes disputando o mesmo saldo', () => {
  test('30 apostas de 10.00 com saldo 100.00: exatamente 10 passam, saldo final 0.00, nunca negativo', async () => {
    const wallet = await openWallet(services, '100.00');

    const results = await Promise.all(
      Array.from({ length: 30 }, () => services.processWagerTransaction.execute(command(wallet, { amount: '10.00' }), context)),
    );

    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(10);
    expect(results.filter((r) => r.status === Status.Rejected && r.failureCode === FailureCode.InsufficientFunds)).toHaveLength(20);
    expect(await storedBalance(orm, wallet.id)).toBe('0.00');
    // Os saldos observados pelas apostas aceitas são todos diferentes (90, 80, ..., 0):
    // prova de que cada uma viu o saldo deixado pela anterior (sem lost update).
    const observed = results.filter((r) => r.status === Status.Processed).map((r) => r.balance!.amount);
    expect(new Set(observed).size).toBe(10);
    await expectWalletMatchesLedger(orm, wallet.id);
  });

  test('créditos e débitos misturados em paralelo terminam com o saldo exato', async () => {
    const wallet = await openWallet(services, '50.00');
    const operations = [
      ...Array.from({ length: 20 }, () => command(wallet, { kind: 'WIN', amount: '5.00' })),
      ...Array.from({ length: 20 }, () => command(wallet, { kind: 'BET', amount: '2.50' })),
    ];

    const results = await Promise.all(operations.map((op) => services.processWagerTransaction.execute(op, context)));

    // Todo WIN passa. As BETs também (o saldo nunca fica abaixo de 2.50 neste cenário: começa em 50).
    expect(results.every((r) => r.status === Status.Processed)).toBe(true);
    expect(await storedBalance(orm, wallet.id)).toBe('100.00'); // 50 + 20*5 - 20*2.50
    await expectWalletMatchesLedger(orm, wallet.id);
  });
});

describe('wallets diferentes em paralelo', () => {
  test('20 wallets, 5 apostas cada, tudo ao mesmo tempo: todas corretas e independentes', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(services, '100.00')));

    const operations = wallets.flatMap((wallet) => Array.from({ length: 5 }, () => command(wallet, { amount: '7.00' })));
    const started = performance.now();
    const results = await Promise.all(operations.map((op) => services.processWagerTransaction.execute(op, context)));
    const elapsedMs = performance.now() - started;

    expect(results.every((r) => r.status === Status.Processed)).toBe(true);
    for (const wallet of wallets) {
      expect(await storedBalance(orm, wallet.id)).toBe('65.00');
      await expectWalletMatchesLedger(orm, wallet.id);
    }
    console.log(`  100 apostas em 20 wallets processadas em ${elapsedMs.toFixed(0)} ms`);
  });
});
