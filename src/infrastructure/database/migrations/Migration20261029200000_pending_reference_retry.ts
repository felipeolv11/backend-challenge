import { Migration } from '@mikro-orm/migrations';

/**
 * Controle de novas tentativas das transações PENDING_REFERENCE (seção 7.1):
 * quantas vezes o worker já tentou achar a referência e quando tentar de novo.
 */
export class Migration20261029200000PendingReferenceRetry extends Migration {
  override up(): void {
    this.addSql(`ALTER TABLE wager_transactions ADD COLUMN reference_attempts integer NOT NULL DEFAULT 0`);
    this.addSql(`ALTER TABLE wager_transactions ADD COLUMN next_reference_attempt_at timestamptz`);

    // Pendentes que já existam passam a ser tentados imediatamente.
    this.addSql(`
      UPDATE wager_transactions
         SET next_reference_attempt_at = now()
       WHERE status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_tx_reference_attempts_non_negative CHECK (reference_attempts >= 0)
    `);
    // Toda transação esperando referência precisa ter a próxima tentativa agendada,
    // senão o worker nunca a encontraria (ficaria pendurada para sempre).
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_tx_pending_reference_is_scheduled
        CHECK (status <> 'PENDING_REFERENCE' OR next_reference_attempt_at IS NOT NULL)
    `);
    // Índice parcial: só as pendentes, que é o que o worker procura.
    this.addSql(`
      CREATE INDEX wager_tx_due_pending_reference_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'
    `);
  }

  override down(): void {
    // DROP COLUMN remove junto o índice e as constraints que usam a coluna.
    this.addSql(`ALTER TABLE wager_transactions DROP COLUMN next_reference_attempt_at`);
    this.addSql(`ALTER TABLE wager_transactions DROP COLUMN reference_attempts`);
  }
}
