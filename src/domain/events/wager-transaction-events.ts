import { InvalidEventSourceError } from '../errors';
import type { FailureCode } from '../failure-code';
import type { MoneyProps } from '../money';
import { type WagerTransaction, type WagerTransactionKind, WagerTransactionStatus } from '../wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

// Campos comuns aos eventos de transação. Campos opcionais usam null (e não undefined)
// para aparecerem sempre no JSON: o formato do payload fica estável para o consumidor.
interface WagerTransactionEventBase {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
}

function baseData(tx: WagerTransaction): WagerTransactionEventBase {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
  };
}

function assertStatus(tx: WagerTransaction, expected: WagerTransactionStatus, eventType: string): void {
  if (tx.status !== expected) {
    throw new InvalidEventSourceError(`${eventType} requires a ${expected} transaction, ${tx.id} is ${tx.status}`);
  }
}

// ---- WagerTransactionProcessed: qualquer transação aplicada, inclusive LOSS.

export interface WagerTransactionProcessedData extends WagerTransactionEventBase {
  referenceTransactionId: string | null;
  /** Saldo da wallet logo depois de aplicar a transação (para LOSS, o saldo não mudou). */
  balance: MoneyProps;
  processedAt: string; // ISO-8601
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        referenceTransactionId: tx.referenceTransactionId ?? null,
        balance: tx.balanceAfter!.toJSON(),
        processedAt: tx.processedAt!.toISOString(),
      },
    });
  }
}

// ---- WagerTransactionRejected: transação rejeitada por regra de negócio.

export interface WagerTransactionRejectedData extends WagerTransactionEventBase {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: { ...baseData(tx), failureCode: tx.failureCode! },
    });
  }
}

// ---- WagerTransactionPendingReference: a referência ainda não chegou.

export type WagerTransactionPendingReferenceData = WagerTransactionEventBase;

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference, 'WagerTransactionPendingReference');
    return new WagerTransactionPendingReference({ ...ctx, aggregateId: tx.id, data: baseData(tx) });
  }
}
