import { describe, expect, test } from 'bun:test';
import { InvalidMessageStateError } from '../../../src/domain/errors';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { InboxMessage } from '../../../src/domain/inbox-message';
import { Money } from '../../../src/domain/money';
import { OutboxMessage } from '../../../src/domain/outbox-message';
import { Wallet } from '../../../src/domain/wallet';

const t0 = new Date('2026-10-29T12:00:00.000Z');
const plusMs = (date: Date, ms: number) => new Date(date.getTime() + ms);

describe('InboxMessage', () => {
  const receive = () => InboxMessage.receive({ messageId: 'msg-1', consumerName: 'wager-consumer', payloadHash: 'h1', receivedAt: t0 });

  test('nasce não processada; markProcessed marca a data', () => {
    const inbox = receive();
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(t0);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(t0);
  });

  test('processar duas vezes é bug', () => {
    const inbox = receive();
    inbox.markProcessed(t0);
    expect(() => inbox.markProcessed(t0)).toThrow(InvalidMessageStateError);
  });

  test('matchesPayload: mesmo messageId com conteúdo diferente é detectável', () => {
    expect(receive().matchesPayload('h1')).toBe(true);
    expect(receive().matchesPayload('h2')).toBe(false);
  });
});

describe('OutboxMessage', () => {
  function enqueue() {
    const { wallet } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      openingTransactionId: 'tx-open',
      openingEntryId: 'entry-open',
      at: t0,
    });
    const entry = wallet.debit({ entryId: 'e-1', transactionId: 'tx-1', money: Money.from({ amount: '25.00', currency: 'BRL' }), at: t0 });
    const event = WalletBalanceChanged.from(wallet, entry, { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: t0 });
    return OutboxMessage.enqueue(event);
  }

  test('enqueue: id = eventId, payload = envelope serializado, pendente e já devido', () => {
    const outbox = enqueue();
    expect(outbox.id).toBe('evt-1');
    expect(outbox.aggregateId).toBe('wallet-1');
    expect(outbox.eventType).toBe('WalletBalanceChanged');
    expect(outbox.payload.eventId).toBe('evt-1');
    expect(outbox.attempts).toBe(0);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(t0)).toBe(true);
  });

  test('o payload é JSON puro: sobrevive a stringify/parse sem mudar', () => {
    const outbox = enqueue();
    expect(JSON.parse(JSON.stringify(outbox.payload))).toEqual(outbox.payload as Record<string, unknown>);
  });

  test('backoff: 1s, 2s, 4s, 8s... com teto de 5 minutos, sem desistir nunca', () => {
    expect([1, 2, 3, 4, 5].map(OutboxMessage.retryDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(OutboxMessage.retryDelayMs(9)).toBe(256_000);
    expect(OutboxMessage.retryDelayMs(10)).toBe(300_000); // 512s passaria do teto
    expect(OutboxMessage.retryDelayMs(1_000)).toBe(300_000); // 2^999 vira Infinity, o teto segura
  });

  test('scheduleRetry incrementa attempts e só fica devido depois do backoff', () => {
    const outbox = enqueue();
    outbox.scheduleRetry(t0);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt).toEqual(plusMs(t0, 1_000));
    expect(outbox.isDue(plusMs(t0, 999))).toBe(false);
    expect(outbox.isDue(plusMs(t0, 1_000))).toBe(true);

    outbox.scheduleRetry(plusMs(t0, 1_000));
    expect(outbox.attempts).toBe(2);
    expect(outbox.nextAttemptAt).toEqual(plusMs(t0, 3_000));
  });

  test('depois de publicado: não está pendente nem devido, e não aceita nova transição', () => {
    const outbox = enqueue();
    outbox.markPublished(t0);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(plusMs(t0, 60_000))).toBe(false);
    expect(outbox.publishedAt).toEqual(t0);
    expect(() => outbox.markPublished(t0)).toThrow(InvalidMessageStateError);
    expect(() => outbox.scheduleRetry(t0)).toThrow(InvalidMessageStateError);
  });
});
