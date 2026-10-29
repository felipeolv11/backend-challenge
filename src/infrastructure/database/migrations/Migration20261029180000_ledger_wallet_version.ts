import { Migration } from '@mikro-orm/migrations';

/**
 * 3ª proteção contra lost update, garantida só pelo banco.
 *
 * Cada lançamento guarda a version da wallet DEPOIS dele (abertura = 1, depois 2, 3...).
 * Como o trigger wallets_guard_update obriga a version a subir exatamente 1 por mudança de
 * saldo, cada lançamento ocupa uma posição única na "corrente" da wallet.
 *
 * Por que precisa: num teste de mutação, removi o lock (FOR UPDATE) e a checagem de version do
 * código. Duas apostas de 80 com saldo 100 calcularam o mesmo resultado (saldo 20, version 2) e as
 * duas foram gravadas: nenhum CHECK ou trigger existente percebia, porque cada linha, sozinha,
 * estava certa. Com UNIQUE (wallet_id, wallet_version), o segundo lançamento com version 2
 * é recusado pelo banco.
 */
export class Migration20261029180000LedgerWalletVersion extends Migration {
  override up(): void {
    this.addSql(`ALTER TABLE wallet_ledger_entries ADD COLUMN wallet_version integer`);

    // Backfill de lançamentos que já existam: a ordem dos ids (UUID v7, ordenados pelo tempo)
    // é a ordem em que a wallet mudou. O ledger não aceita UPDATE (trigger), então o trigger
    // é desligado SÓ durante este backfill. A migration roda numa transação: se algo falhar,
    // o trigger volta ligado junto com o rollback.
    this.addSql(`ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ledger_append_only`);
    this.addSql(`
      UPDATE wallet_ledger_entries AS entry
         SET wallet_version = numbered.position
        FROM (
          SELECT id, row_number() OVER (PARTITION BY wallet_id ORDER BY id) AS position
            FROM wallet_ledger_entries
        ) AS numbered
       WHERE entry.id = numbered.id
    `);
    this.addSql(`ALTER TABLE wallet_ledger_entries ENABLE TRIGGER ledger_append_only`);

    this.addSql(`ALTER TABLE wallet_ledger_entries ALTER COLUMN wallet_version SET NOT NULL`);
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
        ADD CONSTRAINT ledger_wallet_version_positive CHECK (wallet_version >= 1)
    `);
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
        ADD CONSTRAINT ledger_one_entry_per_wallet_version UNIQUE (wallet_id, wallet_version)
    `);
  }

  override down(): void {
    // DROP COLUMN remove junto a CHECK e a UNIQUE que dependem da coluna.
    this.addSql(`ALTER TABLE wallet_ledger_entries DROP COLUMN wallet_version`);
  }
}
