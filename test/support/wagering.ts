import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from '../../src/application/create-wallet';
import { ProcessWagerTransaction, type WagerTransactionCommand } from '../../src/application/process-wager-transaction';
import type { TransactionRunner } from '../../src/application/ports';
import { MikroOrmTransactionRunner } from '../../src/infrastructure/database/mikro-orm-transaction-runner';

/** Monta os casos de uso com a infraestrutura REAL (MikroORM + PostgreSQL). */
export function buildServices(orm: MikroORM, runner: TransactionRunner = new MikroOrmTransactionRunner(orm)) {
  return {
    runner,
    createWallet: new CreateWallet(runner),
    processWagerTransaction: new ProcessWagerTransaction(runner),
  };
}

export type Services = ReturnType<typeof buildServices>;

export const context = { correlationId: 'test-correlation' };

export async function openWallet(services: Services, initialBalance: string, playerId = Bun.randomUUIDv7()) {
  return services.createWallet.execute({ playerId, initialBalance: { amount: initialBalance, currency: 'BRL' } }, context);
}

let sequence = 0;

/** Monta um pedido de transação com valores padrão; o externalTransactionId é único por chamada. */
export function command(
  wallet: { id: string; playerId: string },
  overrides: Partial<WagerTransactionCommand> & { amount?: string } = {},
): WagerTransactionCommand {
  const { amount, ...rest } = overrides;
  const externalTransactionId = rest.externalTransactionId ?? `ext-${Date.now()}-${++sequence}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: amount ?? '10.00', currency: 'BRL' },
    ...rest,
  };
}

/** Saldo gravado na wallet. */
export async function storedBalance(orm: MikroORM, walletId: string): Promise<string> {
  const [row] = await orm.em.fork().execute(`SELECT balance::text AS balance FROM wallets WHERE id = ?`, [walletId]);
  return row!.balance;
}

/**
 * Invariante final de todos os testes (seção 13 do enunciado):
 *   wallet.balance == saldo reconstruído pelo ledger
 * Também confere que o extrato é contínuo: o último lançamento termina no saldo atual.
 */
export async function expectWalletMatchesLedger(orm: MikroORM, walletId: string): Promise<void> {
  const em = orm.em.fork();
  const [row] = await em.execute(
    `SELECT w.balance::text AS stored,
            COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20, 2)::text AS rebuilt
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ?
      GROUP BY w.balance`,
    [walletId],
  );
  expect(row).toBeDefined();
  expect(row!.rebuilt).toBe(row!.stored);

  const [last] = await em.execute(
    `SELECT balance_after::text AS balance_after FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY id DESC LIMIT 1`,
    [walletId],
  );
  if (last) {
    expect(last.balance_after).toBe(row!.stored);
  }
}

export async function countRows(orm: MikroORM, query: string, params: unknown[] = []): Promise<number> {
  const [row] = await orm.em.fork().execute(`SELECT count(*)::int AS total FROM (${query}) AS q`, params);
  return row!.total;
}
