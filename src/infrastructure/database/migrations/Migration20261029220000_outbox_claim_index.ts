import { Migration } from '@mikro-orm/migrations';

/**
 * Índice para a consulta que pega o lote da outbox:
 *   WHERE published_at IS NULL AND (...) ORDER BY occurred_at, id LIMIT 100 FOR UPDATE SKIP LOCKED
 *
 * Achado do teste de carga (EXPLAIN ANALYZE com 40 mil pendentes): o índice antigo
 * (next_attempt_at) não servia para essa ordenação. O Postgres lia a tabela INTEIRA (seq scan) e
 * ordenava todos os pendentes a cada lote, um custo que cresce com o tamanho da tabela. Com o índice
 * parcial em (occurred_at, id), ele lê os pendentes já na ordem e para nos primeiros 100.
 */
export class Migration20261029220000OutboxClaimIndex extends Migration {
  override up(): void {
    this.addSql(`DROP INDEX outbox_pending_idx`);
    this.addSql(`
      CREATE INDEX outbox_pending_by_occurrence_idx
        ON outbox_messages (occurred_at, id)
        WHERE published_at IS NULL
    `);
  }

  override down(): void {
    this.addSql(`DROP INDEX outbox_pending_by_occurrence_idx`);
    this.addSql(`CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at) WHERE published_at IS NULL`);
  }
}
