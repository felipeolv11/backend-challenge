import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../../support/test-database';

// Estes testes NÃO passam pelo domínio: escrevem SQL direto, como faria um bug, um script ou
// alguém no DBeaver. O objetivo é provar que o próprio banco recusa dados inválidos.

let orm: MikroORM;
const sql = (query: string, params: unknown[] = []) => orm.em.execute(query, params);
const newId = () => Bun.randomUUIDv7();

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  await orm.close(true);
});

async function insertWallet(overrides: { id?: string; playerId?: string; currency?: string; balance?: string } = {}) {
  const id = overrides.id ?? newId();
  await sql(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, now(), now())`,
    [id, overrides.playerId ?? newId(), overrides.currency ?? 'BRL', overrides.balance ?? '100.00'],
  );
  return id;
}

interface TxRow {
  id?: string;
  providerId?: string;
  externalId?: string;
  idempotencyKey?: string;
  walletId?: string;
  kind?: string;
  amount?: string;
  status?: string;
  failureCode?: string | null;
  referenceExternalId?: string | null;
  referenceId?: string | null;
  balanceAfter?: string | null;
}

async function insertTx(row: TxRow = {}) {
  const id = row.id ?? newId();
  const externalId = row.externalId ?? `ext-${id}`;
  const status = row.status ?? 'PROCESSED';
  await sql(
    `INSERT INTO wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
       status, failure_code, balance_after, processed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'hash', ?, ?, 'round-1', 'game-1', ?, ?, 'BRL', ?, ?, ?, ?, ?, ?, now(), now())`,
    [
      id,
      row.providerId ?? 'provider-a',
      externalId,
      row.idempotencyKey ?? `provider-a:${externalId}`,
      row.walletId ?? newId(),
      newId(),
      row.kind ?? 'BET',
      row.amount ?? '10.00',
      row.referenceExternalId ?? null,
      row.referenceId ?? null,
      status,
      row.failureCode ?? null,
      row.balanceAfter === undefined ? (status === 'PROCESSED' ? '90.00' : null) : row.balanceAfter,
      status === 'PROCESSED' ? new Date() : null,
    ],
  );
  return id;
}

async function insertLedger(row: {
  walletId: string;
  transactionId: string;
  direction?: string;
  amount?: string;
  before?: string;
  after?: string;
}) {
  const id = newId();
  await sql(
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
     VALUES (?, ?, ?, ?, ?, 'BRL', ?, ?, now())`,
    [id, row.walletId, row.transactionId, row.direction ?? 'DEBIT', row.amount ?? '10.00', row.before ?? '100.00', row.after ?? '90.00'],
  );
  return id;
}

describe('migrations', () => {
  test('são reversíveis: down remove tudo e up recria', async () => {
    await orm.migrator.down();
    const afterDown = await sql(
      `SELECT count(*)::int AS total FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'`,
    );
    expect(afterDown[0]!.total).toBe(0);

    await orm.migrator.up();
    const afterUp = await sql(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations' ORDER BY table_name`,
    );
    expect(afterUp.map((r) => r.table_name)).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);
  });
});

describe('wallets', () => {
  test('saldo negativo é recusado (CHECK)', async () => {
    await expect(insertWallet({ balance: '-0.01' })).rejects.toThrow(/wallets_balance_non_negative/);
  });

  test('no máximo uma wallet por player + moeda (UNIQUE)', async () => {
    const playerId = newId();
    await insertWallet({ playerId, currency: 'BRL' });
    await expect(insertWallet({ playerId, currency: 'BRL' })).rejects.toThrow(/wallets_player_currency_unique/);
    // Outra moeda para o mesmo player é permitida.
    await insertWallet({ playerId, currency: 'USD' });
  });

  test('version sobe exatamente 1 quando o saldo muda, e só quando o saldo muda', async () => {
    const id = await insertWallet({ balance: '100.00' });
    await sql(`UPDATE wallets SET balance = 80.00, version = version + 1 WHERE id = ?`, [id]);

    await expect(sql(`UPDATE wallets SET balance = 60.00 WHERE id = ?`, [id])).rejects.toThrow(/version must increase by exactly 1/);
    await expect(sql(`UPDATE wallets SET balance = 60.00, version = version + 2 WHERE id = ?`, [id])).rejects.toThrow(
      /version must increase by exactly 1/,
    );
    await expect(sql(`UPDATE wallets SET version = version + 1 WHERE id = ?`, [id])).rejects.toThrow(
      /version can only change when the balance changes/,
    );

    const [wallet] = await sql(`SELECT balance::text AS balance, version FROM wallets WHERE id = ?`, [id]);
    expect(wallet).toEqual({ balance: '80.00', version: 2 });
  });

  test('moeda e dono não mudam; wallet não é apagada', async () => {
    const id = await insertWallet();
    await expect(sql(`UPDATE wallets SET currency = 'USD' WHERE id = ?`, [id])).rejects.toThrow(/immutable/);
    await expect(sql(`UPDATE wallets SET player_id = ? WHERE id = ?`, [newId(), id])).rejects.toThrow(/immutable/);
    await expect(sql(`DELETE FROM wallets WHERE id = ?`, [id])).rejects.toThrow(/append-only/);
  });
});

describe('wallet_ledger_entries', () => {
  async function walletAndTx() {
    const walletId = await insertWallet();
    const transactionId = await insertTx({ walletId });
    return { walletId, transactionId };
  }

  test('aceita um lançamento com a aritmética correta', async () => {
    const ids = await walletAndTx();
    await insertLedger({ ...ids, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '90.00' });
  });

  test('aritmética errada é recusada (CHECK)', async () => {
    const ids = await walletAndTx();
    await expect(insertLedger({ ...ids, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '95.00' })).rejects.toThrow(
      /ledger_arithmetic/,
    );
    await expect(insertLedger({ ...ids, direction: 'CREDIT', amount: '10.00', before: '100.00', after: '90.00' })).rejects.toThrow(
      /ledger_arithmetic/,
    );
  });

  test('valor zero e saldo negativo são recusados', async () => {
    const ids = await walletAndTx();
    await expect(insertLedger({ ...ids, amount: '0.00', before: '100.00', after: '100.00' })).rejects.toThrow(/ledger_amount_positive/);
    await expect(insertLedger({ ...ids, amount: '10.00', before: '5.00', after: '-5.00' })).rejects.toThrow(
      /ledger_balances_non_negative/,
    );
  });

  test('no máximo um lançamento por transação por wallet (UNIQUE)', async () => {
    const ids = await walletAndTx();
    await insertLedger(ids);
    await expect(insertLedger(ids)).rejects.toThrow(/ledger_one_entry_per_transaction_per_wallet/);
  });

  test('é append-only: UPDATE, DELETE e TRUNCATE são recusados', async () => {
    const ids = await walletAndTx();
    const entryId = await insertLedger(ids);

    await expect(sql(`UPDATE wallet_ledger_entries SET amount = 1.00 WHERE id = ?`, [entryId])).rejects.toThrow(/append-only: UPDATE/);
    await expect(sql(`DELETE FROM wallet_ledger_entries WHERE id = ?`, [entryId])).rejects.toThrow(/append-only: DELETE/);
    await expect(sql(`TRUNCATE wallet_ledger_entries CASCADE`)).rejects.toThrow(/append-only: TRUNCATE/);

    const [row] = await sql(`SELECT amount::text AS amount FROM wallet_ledger_entries WHERE id = ?`, [entryId]);
    expect(row!.amount).toBe('10.00');
  });

  test('lançamento precisa de wallet e transação existentes (FK)', async () => {
    await expect(insertLedger({ walletId: newId(), transactionId: newId() })).rejects.toThrow(/foreign key/);
  });
});

describe('wager_transactions — idempotência', () => {
  test('(provider, idempotency_key) é único', async () => {
    await insertTx({ idempotencyKey: 'provider-a:dup-key', externalId: 'ext-a1' });
    await expect(insertTx({ idempotencyKey: 'provider-a:dup-key', externalId: 'ext-a2' })).rejects.toThrow(
      /wager_tx_provider_idempotency_key_unique/,
    );
  });

  test('a mesma key em outro provider não colide', async () => {
    await insertTx({ providerId: 'provider-x', idempotencyKey: 'shared-key', externalId: 'ext-x' });
    await insertTx({ providerId: 'provider-y', idempotencyKey: 'shared-key', externalId: 'ext-y' });
  });

  test('a mesma transação externa com outra key é barrada', async () => {
    await insertTx({ externalId: 'same-ext', idempotencyKey: 'key-1' });
    await expect(insertTx({ externalId: 'same-ext', idempotencyKey: 'key-2' })).rejects.toThrow(/wager_tx_provider_external_id_unique/);
  });
});

describe('wager_transactions — regras de valor e de status', () => {
  test('BET de 0.00 é recusada; WIN e LOSS de 0.00 são aceitos', async () => {
    await expect(insertTx({ kind: 'BET', amount: '0.00' })).rejects.toThrow(/wager_tx_amount_positive_when_required/);
    await insertTx({ kind: 'WIN', amount: '0.00' });
    await insertTx({ kind: 'LOSS', amount: '0.00' });
  });

  test('valor negativo é recusado', async () => {
    await expect(insertTx({ kind: 'WIN', amount: '-1.00' })).rejects.toThrow(/wager_tx_amount_non_negative/);
  });

  test('REFUND/ROLLBACK sem referência são recusados', async () => {
    await expect(insertTx({ kind: 'REFUND', status: 'PENDING' })).rejects.toThrow(/wager_tx_reversal_requires_reference/);
    await expect(insertTx({ kind: 'ROLLBACK', status: 'PENDING' })).rejects.toThrow(/wager_tx_reversal_requires_reference/);
  });

  test('failure_code obrigatório em REJECTED/FAILED e proibido nos outros status', async () => {
    await expect(insertTx({ status: 'REJECTED' })).rejects.toThrow(/wager_tx_failure_code_iff_failed/);
    await expect(insertTx({ status: 'PENDING', failureCode: 'INSUFFICIENT_FUNDS' })).rejects.toThrow(
      /wager_tx_failure_code_iff_failed/,
    );
    await insertTx({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: '5.00' });
  });

  test('failure_code fora da taxonomia é recusado', async () => {
    await expect(insertTx({ status: 'REJECTED', failureCode: 'SOMETHING_WRONG' })).rejects.toThrow(/wager_tx_failure_code_valid/);
  });

  test('PROCESSED precisa de balance_after (para o replay idempotente)', async () => {
    await expect(insertTx({ status: 'PROCESSED', balanceAfter: null })).rejects.toThrow(/wager_tx_processed_has_balance_after/);
  });

  test('kind e status fora da lista são recusados', async () => {
    await expect(insertTx({ kind: 'JACKPOT' })).rejects.toThrow(/wager_tx_kind_valid/);
    await expect(insertTx({ status: 'DONE' })).rejects.toThrow(/wager_tx_status_valid/);
  });
});

describe('wager_transactions — uma reversão por referência (interpretação da regra 4)', () => {
  test('a segunda reversão PROCESSED da mesma transação é recusada, mesmo sendo de outro tipo', async () => {
    const betId = await insertTx({ kind: 'BET', externalId: 'bet-rev-1' });
    const reversal = { referenceExternalId: 'bet-rev-1', referenceId: betId };

    await insertTx({ kind: 'REFUND', ...reversal });
    await expect(insertTx({ kind: 'ROLLBACK', ...reversal })).rejects.toThrow(/wager_tx_one_reversal_per_reference/);
    await expect(insertTx({ kind: 'REFUND', ...reversal })).rejects.toThrow(/wager_tx_one_reversal_per_reference/);
  });

  test('reversões REJECTED não ocupam a vaga', async () => {
    const betId = await insertTx({ kind: 'BET', externalId: 'bet-rev-2' });
    const reversal = { referenceExternalId: 'bet-rev-2', referenceId: betId };

    await insertTx({ kind: 'REFUND', ...reversal, status: 'REJECTED', failureCode: 'AMOUNT_MISMATCH', balanceAfter: '90.00' });
    await insertTx({ kind: 'REFUND', ...reversal }); // a válida ainda pode acontecer
  });

  test('reversão PROCESSED sem reference_transaction_id é recusada (senão escaparia do índice único)', async () => {
    await expect(insertTx({ kind: 'REFUND', referenceExternalId: 'bet-x', referenceId: null })).rejects.toThrow(
      /wager_tx_processed_reversal_has_reference_id/,
    );
  });
});

describe('wager_transactions — imutabilidade', () => {
  test('PENDING pode virar PROCESSED', async () => {
    const id = await insertTx({ status: 'PENDING' });
    await sql(`UPDATE wager_transactions SET status = 'PROCESSED', processed_at = now(), balance_after = 10.00 WHERE id = ?`, [id]);
  });

  test.each(['PROCESSED', 'REJECTED', 'FAILED'])('%s é terminal: qualquer UPDATE é recusado', async (status) => {
    const failureCode = status === 'PROCESSED' ? null : 'PROCESSING_ERROR';
    const id = await insertTx({ status, failureCode });
    await expect(sql(`UPDATE wager_transactions SET status = 'PENDING', failure_code = NULL WHERE id = ?`, [id])).rejects.toThrow(
      /terminal/,
    );
    await expect(sql(`UPDATE wager_transactions SET updated_at = now() WHERE id = ?`, [id])).rejects.toThrow(/terminal/);
  });

  test('os dados do pedido não mudam, nem com status PENDING', async () => {
    const id = await insertTx({ status: 'PENDING' });
    await expect(sql(`UPDATE wager_transactions SET amount = 999.00 WHERE id = ?`, [id])).rejects.toThrow(/request fields are immutable/);
  });

  test('transações não podem ser apagadas', async () => {
    const id = await insertTx();
    await expect(sql(`DELETE FROM wager_transactions WHERE id = ?`, [id])).rejects.toThrow(/append-only/);
  });
});

describe('inbox_messages e outbox_messages', () => {
  test('(consumer_name, message_id) é único', async () => {
    const insert = () =>
      sql(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ('consumer', 'msg-1', 'h', now())`);
    await insert();
    await expect(insert()).rejects.toThrow(/inbox_messages_pkey/);
  });

  test('o mesmo message_id em outro consumidor é permitido', async () => {
    await sql(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ('other', 'msg-1', 'h', now())`);
  });

  test('outbox não aceita attempts negativo', async () => {
    await expect(
      sql(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts) VALUES (?, ?, 'X', '{}', now(), -1)`,
        [newId(), newId()],
      ),
    ).rejects.toThrow(/outbox_attempts_non_negative/);
  });
});
