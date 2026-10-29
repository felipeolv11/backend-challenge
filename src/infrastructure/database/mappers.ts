import type { FailureCode } from '../../domain/failure-code';
import { InboxMessage } from '../../domain/inbox-message';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { InboxMessageRow, LedgerEntryRow, OutboxMessageRow, WagerTransactionRow, WalletRow } from './entities';

// Conversão linha do banco ⇄ objeto de domínio.
// Banco → domínio sempre por rehydrate() (não revalida; o dado já foi validado ao ser gravado).
// Os valores NUMERIC chegam como string ("975.00") e vão direto para Money.from(): nunca viram number.

const money = (amount: string, currency: string) => Money.from({ amount, currency });
const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

// ------------------------------------------------------------------ Wallet

export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: money(row.balance, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function walletToRow(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

// ------------------------------------------------------------------ WagerTransaction

export function toWagerTransaction(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: money(row.amount, row.currency),
    referenceExternalTransactionId: orUndefined(row.referenceExternalTransactionId),
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: orUndefined(row.referenceTransactionId),
    failureCode: orUndefined(row.failureCode) as FailureCode | undefined,
    processedAt: orUndefined(row.processedAt),
    balanceAfter: row.balanceAfter ? money(row.balanceAfter, row.currency) : undefined,
    referenceAttempts: row.referenceAttempts,
    nextReferenceAttemptAt: orUndefined(row.nextReferenceAttemptAt),
  });
}

export function wagerTransactionToRow(transaction: WagerTransaction, updatedAt: Date): WagerTransactionRow {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.toJSON().amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balanceAfter: transaction.balanceAfter?.toJSON().amount ?? null,
    processedAt: transaction.processedAt ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
    createdAt: transaction.createdAt,
    updatedAt,
  };
}

// ------------------------------------------------------------------ Ledger

export function toLedgerEntry(row: LedgerEntryRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction as LedgerDirection,
    money: money(row.amount, row.currency),
    balanceBefore: money(row.balanceBefore, row.currency),
    balanceAfter: money(row.balanceAfter, row.currency),
    walletVersion: row.walletVersion,
    createdAt: row.createdAt,
  });
}

export function ledgerEntryToRow(entry: WalletLedgerEntry): LedgerEntryRow {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}

// ------------------------------------------------------------------ Inbox / Outbox

export function toInboxMessage(row: InboxMessageRow): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: row.messageId,
    consumerName: row.consumerName,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: orUndefined(row.processedAt),
  });
}

export function inboxMessageToRow(message: InboxMessage): InboxMessageRow {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

export function toOutboxMessage(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: orUndefined(row.nextAttemptAt),
    publishedAt: orUndefined(row.publishedAt),
  });
}

export function outboxMessageToRow(message: OutboxMessage): OutboxMessageRow {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
  };
}
