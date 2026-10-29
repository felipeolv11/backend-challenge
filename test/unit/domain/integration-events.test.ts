import { describe, expect, test } from 'bun:test';
import { InvalidEventSourceError } from '../../../src/domain/errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../src/domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { FailureCode } from '../../../src/domain/failure-code';
import { Money } from '../../../src/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../../src/domain/wager-transaction';
import { Wallet } from '../../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-29T12:00:00.000Z');
const ctx = (eventId: string) => ({ eventId, correlationId: 'corr-1', causationId: 'msg-1', occurredAt: at });

function newTx(kind = WagerTransactionKind.Bet, referenceExternalTransactionId?: string) {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    referenceExternalTransactionId,
    createdAt: at,
  });
}

describe('IntegrationEvent — envelope', () => {
  test('toJSON segue o envelope do enunciado, com eventType e version vindos do tipo', () => {
    const tx = newTx();
    tx.markProcessed(undefined, at);
    // Compara o JSON que de fato vai para a fila (depois de stringify/parse).
    const wire = JSON.parse(JSON.stringify(WagerTransactionProcessed.from(tx, brl('975.00'), ctx('evt-1'))));

    expect(wire).toEqual({
      eventId: 'evt-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'tx-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-10-29T12:00:00.000Z',
      version: 1,
      data: {
        transactionId: 'tx-1',
        providerId: 'provider-a',
        externalTransactionId: 'ext-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: null,
        referenceTransactionId: null,
        balance: { amount: '975.00', currency: 'BRL' },
        processedAt: '2026-10-29T12:00:00.000Z',
      },
    });
  });

  test('data carrega MoneyProps (strings), nunca instâncias de Money', () => {
    const tx = newTx();
    tx.markProcessed(undefined, at);
    const event = WagerTransactionProcessed.from(tx, brl('975.00'), ctx('evt-1'));
    expect(event.data.money).not.toBeInstanceOf(Money);
    expect(typeof event.data.money.amount).toBe('string');
  });

  test('data é congelado (imutável)', () => {
    const tx = newTx();
    tx.markProcessed(undefined, at);
    const event = WagerTransactionProcessed.from(tx, brl('975.00'), ctx('evt-1'));
    expect(Object.isFrozen(event.data)).toBe(true);
  });
});

describe('WagerTransactionProcessed / Rejected / PendingReference', () => {
  test('cada evento exige a transação no status certo', () => {
    const pending = newTx();
    expect(() => WagerTransactionProcessed.from(pending, brl('1.00'), ctx('e'))).toThrow(InvalidEventSourceError);
    expect(() => WagerTransactionRejected.from(pending, ctx('e'))).toThrow(InvalidEventSourceError);
    expect(() => WagerTransactionPendingReference.from(pending, ctx('e'))).toThrow(InvalidEventSourceError);
  });

  test('Rejected leva o failureCode', () => {
    const tx = newTx();
    tx.reject(FailureCode.InsufficientFunds);
    const event = WagerTransactionRejected.from(tx, ctx('evt-2'));
    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('PendingReference leva a referência que está faltando', () => {
    const tx = newTx(WagerTransactionKind.Refund, 'bet-ext-99');
    tx.markPendingReference();
    const event = WagerTransactionPendingReference.from(tx, ctx('evt-3'));
    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.data.referenceExternalTransactionId).toBe('bet-ext-99');
  });
});

describe('WalletBalanceChanged', () => {
  function openAndDebit() {
    const { wallet } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('100.00'),
      openingTransactionId: 'tx-open',
      openingEntryId: 'entry-open',
      at,
    });
    const entry = wallet.debit({ entryId: 'e-1', transactionId: 'tx-1', money: brl('25.00'), at });
    return { wallet, entry };
  }

  test('reflete o lançamento e a version da wallet', () => {
    const { wallet, entry } = openAndDebit();
    const event = WalletBalanceChanged.from(wallet, entry, ctx('evt-4'));

    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe('wallet-1');
    expect(JSON.parse(JSON.stringify(event.data))).toEqual({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('recusa um lançamento que não corresponde ao estado atual da wallet', () => {
    const { wallet, entry } = openAndDebit();
    wallet.credit({ entryId: 'e-2', transactionId: 'tx-2', money: brl('1.00'), at }); // a wallet andou
    expect(() => WalletBalanceChanged.from(wallet, entry, ctx('evt-5'))).toThrow(InvalidEventSourceError);
  });
});
