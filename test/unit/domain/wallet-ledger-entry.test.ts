import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidLedgerEntryError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import { type CreateLedgerEntryProps, LedgerDirection, WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-29T12:00:00.000Z');

function props(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('80.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('20.00'),
    walletVersion: 2,
    createdAt: at,
    ...overrides,
  };
}

describe('WalletLedgerEntry.create', () => {
  test('cria um DEBIT balanceado (100.00 - 80.00 = 20.00)', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
  });

  test('cria um CREDIT balanceado (20.00 + 80.00 = 100.00)', () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceBefore: brl('20.00'), balanceAfter: brl('100.00') }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejeita aritmética errada', () => {
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: brl('20.01') }))).toThrow(InvalidLedgerEntryError);
    // CREDIT com o saldo calculado como se fosse DEBIT
    expect(() => WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit }))).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita valor zero', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ money: brl('0.00'), balanceBefore: brl('100.00'), balanceAfter: brl('100.00') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita saldo negativo depois do lançamento', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ balanceBefore: brl('50.00'), balanceAfter: brl('50.00').subtract(brl('80.00')) })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita moedas diferentes entre valor e saldos', () => {
    expect(() => WalletLedgerEntry.create(props({ money: Money.from({ amount: '80.00', currency: 'USD' }) }))).toThrow(
      CurrencyMismatchError,
    );
  });
});

test('walletVersion precisa ser inteiro >= 1', () => {
  expect(() => WalletLedgerEntry.create(props({ walletVersion: 0 }))).toThrow(InvalidLedgerEntryError);
  expect(() => WalletLedgerEntry.create(props({ walletVersion: 1.5 }))).toThrow(InvalidLedgerEntryError);
});

describe('WalletLedgerEntry — imutabilidade estrutural', () => {
  test('o objeto é congelado: atribuir um campo lança erro em runtime', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('999.00');
    }).toThrow();
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('reconstrói sem revalidar', () => {
    // Um dado inconsistente vindo do banco não deve quebrar a leitura: quem acusa
    // a divergência é a reconciliação, não o rehydrate.
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('20.01') }));
    expect(entry.isBalanced()).toBe(false);
  });
});
