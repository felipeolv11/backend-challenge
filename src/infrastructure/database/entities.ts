import { defineEntity, type InferEntity, p } from '@mikro-orm/postgresql';

// Entidades de BANCO (não de domínio): espelham as tabelas criadas pela migration.
// O domínio não as conhece; os mappers (mappers.ts) fazem a conversão via rehydrate().
//
// DECISÃO: defineEntity em vez de decorators.
// POR QUÊ: é o jeito recomendado pela documentação do MikroORM 7, já vem no pacote que usamos e
//          não depende de metadados de tipo (reflect-metadata), o que evita surpresas no Bun.
// ALTERNATIVA: decorators (@Entity/@Property) — não usei porque no MikroORM 7 exigem o pacote
//              extra @mikro-orm/decorators.
//
// Valores em dinheiro: p.decimal() devolve STRING ("975.00"), nunca number. A string vai
// direto para Money.from().
// Os nomes das colunas seguem o padrão do MikroORM: camelCase vira snake_case (playerId → player_id).

export const WalletRecord = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string(),
    balance: p.decimal(),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export type WalletRow = InferEntity<typeof WalletRecord>;

export const WagerTransactionRecord = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.string(),
    externalTransactionId: p.string(),
    idempotencyKey: p.string(),
    payloadHash: p.string(),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.string(),
    gameId: p.string(),
    kind: p.string(),
    amount: p.decimal(),
    currency: p.string(),
    referenceExternalTransactionId: p.string().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.string(),
    failureCode: p.string().nullable(),
    balanceAfter: p.decimal().nullable(),
    processedAt: p.datetime().nullable(),
    referenceAttempts: p.integer(),
    nextReferenceAttemptAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export type WagerTransactionRow = InferEntity<typeof WagerTransactionRecord>;

export const LedgerEntryRecord = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.string(),
    amount: p.decimal(),
    currency: p.string(),
    balanceBefore: p.decimal(),
    balanceAfter: p.decimal(),
    walletVersion: p.integer(),
    createdAt: p.datetime(),
  },
});
export type LedgerEntryRow = InferEntity<typeof LedgerEntryRecord>;

export const InboxMessageRecord = defineEntity({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.string().primary(),
    messageId: p.string().primary(),
    payloadHash: p.string(),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export type InboxMessageRow = InferEntity<typeof InboxMessageRecord>;

export const OutboxMessageRecord = defineEntity({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.string(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    publishedAt: p.datetime().nullable(),
  },
});
export type OutboxMessageRow = InferEntity<typeof OutboxMessageRecord>;

export const allEntities = [WalletRecord, WagerTransactionRecord, LedgerEntryRecord, InboxMessageRecord, OutboxMessageRecord];
