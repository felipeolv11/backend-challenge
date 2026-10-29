import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade ficam AQUI,
 * no banco (seção 5, item 9 do enunciado): mesmo que um bug no código tente violar uma regra,
 * o PostgreSQL recusa o commit.
 *
 * Os nomes das constraints são explícitos para a aplicação conseguir identificar qual regra
 * foi violada (ex.: wallets_player_currency_unique → 409 "wallet já existe").
 */
export class Migration20261029120000InitialSchema extends Migration {
  override up(): void {
    // DECISÃO: colunas de status/kind/direction como TEXT + CHECK, e não ENUM do Postgres.
    // POR QUÊ: adicionar um valor novo é só trocar o CHECK numa migration comum (com down()
    //          simples). Remover um valor de um ENUM do Postgres exige recriar o tipo.
    // ALTERNATIVA: CREATE TYPE ... AS ENUM — não usei porque migrations de enum são mais
    //              difíceis de reverter, sem ganho real de integridade sobre o CHECK.

    // ------------------------------------------------------------------ wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   uuid           NOT NULL,
        currency    char(3)        NOT NULL,
        balance     numeric(20, 2) NOT NULL,
        version     integer        NOT NULL,
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$')
      )
    `);

    // ------------------------------------------------------------------ wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid           PRIMARY KEY,
        provider_id                       text           NOT NULL,
        external_transaction_id           text           NOT NULL,
        idempotency_key                   text           NOT NULL,
        payload_hash                      text           NOT NULL,
        -- Sem FK para wallets: uma transação com WALLET_NOT_FOUND também é gravada (REJECTED),
        -- para ficar auditável e para o replay idempotente devolver a mesma resposta.
        wallet_id                         uuid           NOT NULL,
        player_id                         uuid           NOT NULL,
        round_id                          text           NOT NULL,
        game_id                           text           NOT NULL,
        kind                              text           NOT NULL,
        amount                            numeric(20, 2) NOT NULL,
        currency                          char(3)        NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid           REFERENCES wager_transactions (id),
        status                            text           NOT NULL,
        failure_code                      text,
        balance_after                     numeric(20, 2),
        processed_at                      timestamptz,
        created_at                        timestamptz    NOT NULL,
        updated_at                        timestamptz    NOT NULL,

        -- DECISÃO: as duas chaves de idempotência são únicas POR PROVIDER.
        -- POR QUÊ: dois provedores podem usar a mesma Idempotency-Key ("tx-1") sem colidir; e a
        --          mesma transação externa com outra key é barrada (é conflito, não outra aposta).
        -- ALTERNATIVA: idempotency_key única global — não usei porque um provedor receberia
        --              conflito por causa da key de outro.
        CONSTRAINT wager_tx_provider_idempotency_key_unique UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_tx_provider_external_id_unique UNIQUE (provider_id, external_transaction_id),

        CONSTRAINT wager_tx_required_text CHECK (
          provider_id <> '' AND external_transaction_id <> '' AND idempotency_key <> ''
          AND round_id <> '' AND game_id <> ''
        ),
        CONSTRAINT wager_tx_kind_valid CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_tx_status_valid CHECK (
          status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        CONSTRAINT wager_tx_failure_code_valid CHECK (failure_code IN (
          'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_OVERDRAW', 'CURRENCY_MISMATCH', 'WALLET_NOT_FOUND',
          'PLAYER_WALLET_MISMATCH', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH', 'INVALID_REFERENCE_KIND',
          'REFERENCE_NOT_PROCESSED', 'REFERENCE_ALREADY_REVERSED', 'AMOUNT_MISMATCH', 'PROCESSING_ERROR'
        )),
        CONSTRAINT wager_tx_currency_format CHECK (currency ~ '^[A-Z]{3}$'),

        -- Não-negatividade. WIN e LOSS aceitam 0.00; os demais exigem > 0.
        CONSTRAINT wager_tx_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT wager_tx_amount_positive_when_required CHECK (kind IN ('WIN', 'LOSS') OR amount > 0),
        CONSTRAINT wager_tx_balance_after_non_negative CHECK (balance_after >= 0),

        -- REFUND e ROLLBACK sempre trazem a referência do provedor...
        CONSTRAINT wager_tx_reversal_requires_reference CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL
        ),
        -- ...e, quando PROCESSED, o id interno dela. Sem isso, um NULL escaparia do índice
        -- único de "uma reversão por referência" logo abaixo.
        CONSTRAINT wager_tx_processed_reversal_has_reference_id CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK') OR status <> 'PROCESSED' OR reference_transaction_id IS NOT NULL
        ),

        -- Coerência entre status e os campos de resultado.
        CONSTRAINT wager_tx_failure_code_iff_failed CHECK (
          (status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT wager_tx_processed_at_iff_processed CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT wager_tx_processed_has_balance_after CHECK (status <> 'PROCESSED' OR balance_after IS NOT NULL)
      )
    `);

    // Interpretação da regra 4: cada transação pode ser revertida UMA vez no total (REFUND ou
    // ROLLBACK). Índice único parcial: só conta reversões PROCESSED, então uma reversão REJECTED
    // não impede outra válida depois. É a garantia final contra duas reversões simultâneas.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_one_reversal_per_reference
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
    `);
    this.addSql(`CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id)`);

    // ------------------------------------------------------------------ wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        wallet_id       uuid           NOT NULL REFERENCES wallets (id),
        transaction_id  uuid           NOT NULL REFERENCES wager_transactions (id),
        direction       text           NOT NULL,
        amount          numeric(20, 2) NOT NULL,
        currency        char(3)        NOT NULL,
        balance_before  numeric(20, 2) NOT NULL,
        balance_after   numeric(20, 2) NOT NULL,
        created_at      timestamptz    NOT NULL,
        -- No máximo um lançamento por transação por wallet (seção 6.4).
        CONSTRAINT ledger_one_entry_per_transaction_per_wallet UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        -- A mesma regra do WalletLedgerEntry.isBalanced(), garantida também pelo banco.
        CONSTRAINT ledger_arithmetic CHECK (
          (direction = 'DEBIT'  AND balance_after = balance_before - amount) OR
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
        )
      )
    `);
    // Serve à reconciliação (SUM por wallet) e à paginação do extrato por wallet.
    this.addSql(`CREATE INDEX ledger_wallet_idx ON wallet_ledger_entries (wallet_id, id)`);

    // ------------------------------------------------------------------ inbox_messages
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL,
        message_id    text        NOT NULL,
        payload_hash  text        NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        -- A deduplicação persistente da fila (seção 10): (consumerName, messageId) único.
        CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id)
      )
    `);

    // ------------------------------------------------------------------ outbox_messages
    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY, -- é o eventId
        aggregate_id    uuid        NOT NULL,
        event_type      text        NOT NULL,
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer     NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at    timestamptz,
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0),
        CONSTRAINT outbox_published_has_no_next_attempt CHECK (published_at IS NULL OR next_attempt_at IS NULL)
      )
    `);
    // Índice parcial: só os pendentes, que é o que o worker procura.
    this.addSql(`
      CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL
    `);

    // ------------------------------------------------------------------ triggers de imutabilidade

    // DECISÃO: imutabilidade garantida por triggers que lançam erro.
    // POR QUÊ: o Postgres recusa a operação venha de onde vier (app, script, DBeaver) e funciona
    //          com um único usuário de banco.
    // ALTERNATIVA: REVOKE UPDATE/DELETE para um usuário só da aplicação — não usei porque exige
    //              dois usuários e duas conexões, e não protege contra quem usa o usuário dono.
    this.addSql(`
      CREATE FUNCTION forbid_modification() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql
    `);

    // Ledger: nunca sobrescrever nem excluir lançamentos (seção 5, item 5).
    this.addSql(`
      CREATE TRIGGER ledger_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_modification()
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification()
    `);

    // Transações: são o registro de auditoria, então também não podem ser apagadas.
    this.addSql(`
      CREATE TRIGGER wager_tx_no_delete
        BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION forbid_modification()
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_no_truncate
        BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification()
    `);

    // Transações: estados terminais nunca mudam, e os dados do pedido nunca mudam.
    // Só podem mudar os campos de resultado, e só enquanto o status não é terminal.
    this.addSql(`
      CREATE FUNCTION wager_tx_guard_update() RETURNS trigger AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is % (terminal) and cannot be changed', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;

        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'wager transaction %: request fields are immutable', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard_update
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_tx_guard_update()
    `);

    // Wallets: dono, moeda e criação não mudam; a version sobe exatamente 1 quando o saldo muda
    // e não muda quando o saldo não muda (seção 6.2). Wallets não são apagadas.
    this.addSql(`
      CREATE FUNCTION wallets_guard_update() RETURNS trigger AS $$
      BEGIN
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet %: id, player_id, currency and created_at are immutable', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;

        IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'wallet %: version must increase by exactly 1 when the balance changes', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;

        IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet %: version can only change when the balance changes', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    this.addSql(`
      CREATE TRIGGER wallets_guard_update
        BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_guard_update()
    `);
    this.addSql(`
      CREATE TRIGGER wallets_no_delete
        BEFORE DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION forbid_modification()
    `);
  }

  override down(): void {
    // Ordem inversa do up(). DROP TABLE remove junto os triggers e índices da tabela.
    this.addSql('DROP TABLE outbox_messages');
    this.addSql('DROP TABLE inbox_messages');
    this.addSql('DROP TABLE wallet_ledger_entries');
    this.addSql('DROP TABLE wager_transactions');
    this.addSql('DROP TABLE wallets');
    this.addSql('DROP FUNCTION wallets_guard_update()');
    this.addSql('DROP FUNCTION wager_tx_guard_update()');
    this.addSql('DROP FUNCTION forbid_modification()');
  }
}
