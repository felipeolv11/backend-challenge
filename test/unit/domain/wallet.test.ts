import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientBalanceError, InvalidMoneyError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const openedAt = new Date('2026-10-29T12:00:00.000Z');
const later = new Date('2026-10-29T12:05:00.000Z');

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

function openWallet(initialBalance: string) {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initialBalance),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    at: openedAt,
  });
}

const movement = (amount: string | Money, at = later) => ({
  entryId: nextId('entry'),
  transactionId: nextId('tx'),
  money: typeof amount === 'string' ? brl(amount) : amount,
  at,
});

/** Reconstrói o saldo somando os lançamentos: CREDIT soma, DEBIT subtrai. */
function balanceFromLedger(entries: WalletLedgerEntry[]): Money {
  return entries.reduce(
    (total, entry) => (entry.direction === LedgerDirection.Credit ? total.add(entry.money) : total.subtract(entry.money)),
    Money.zero('BRL'),
  );
}

describe('Wallet.open', () => {
  test('com saldo inicial: version 1 e um lançamento CREDIT de 0.00 para o saldo inicial', () => {
    const { wallet, openingEntry } = openWallet('1000.00');

    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeDefined();
    expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry!.transactionId).toBe('tx-opening');
    expect(openingEntry!.balanceBefore.toJSON().amount).toBe('0.00');
    expect(openingEntry!.balanceAfter.toJSON().amount).toBe('1000.00');
  });

  test('com saldo zero: version 1 e nenhum lançamento', () => {
    const { wallet, openingEntry } = openWallet('0.00');
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('rejeita saldo inicial negativo', () => {
    expect(() =>
      Wallet.open({
        id: 'w',
        playerId: 'p',
        initialBalance: brl('10.00').negate(),
        openingTransactionId: 't',
        openingEntryId: 'e',
        at: openedAt,
      }),
    ).toThrow(InvalidMoneyError);
  });
});

describe('Wallet.debit', () => {
  test('debita, devolve o lançamento DEBIT e incrementa a version', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.debit(movement('25.00'));

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
  });

  test('pode debitar exatamente o saldo inteiro (saldo final 0.00)', () => {
    const { wallet } = openWallet('80.00');
    wallet.debit(movement('80.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('saldo insuficiente: lança erro e NÃO altera saldo, version nem updatedAt', () => {
    const { wallet } = openWallet('50.00');
    expect(() => wallet.debit(movement('50.01'))).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toJSON().amount).toBe('50.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
  });
});

describe('Wallet.credit', () => {
  test('credita, devolve o lançamento CREDIT e incrementa a version', () => {
    const { wallet } = openWallet('10.00');
    const entry = wallet.credit(movement('15.50'));

    expect(wallet.balance.toJSON().amount).toBe('25.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toJSON().amount).toBe('10.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('25.50');
  });
});

describe('Wallet — valores inválidos', () => {
  test.each(['debit', 'credit'] as const)('%s com valor zero é rejeitado (version só muda se o saldo mudar)', (method) => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet[method](movement('0.00'))).toThrow(InvalidMoneyError);
    expect(wallet.version).toBe(1);
  });

  test.each(['debit', 'credit'] as const)('%s com valor negativo é rejeitado', (method) => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet[method](movement(brl('10.00').negate()))).toThrow(InvalidMoneyError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test.each(['debit', 'credit'] as const)('%s em moeda diferente da wallet lança CurrencyMismatchError', (method) => {
    const { wallet } = openWallet('100.00');
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => wallet[method](movement(usd))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet — invariantes', () => {
  test('cenário da seção 8 (em memória): saldo 100, duas apostas de 80 → uma passa, outra é recusada', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const ledger: WalletLedgerEntry[] = [openingEntry!];

    ledger.push(wallet.debit(movement('80.00')));
    expect(() => wallet.debit(movement('80.00'))).toThrow(InsufficientBalanceError);

    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(ledger.filter((e) => e.direction === LedgerDirection.Debit)).toHaveLength(1);
    // Obs.: aqui é sequencial, em memória. A versão concorrente de verdade
    // (várias instâncias, mesmo banco) é testada nos testes de concorrência.
  });

  test('após várias operações, wallet.balance == saldo reconstruído pelo ledger', () => {
    const { wallet, openingEntry } = openWallet('1000.00');
    const ledger: WalletLedgerEntry[] = [openingEntry!];

    ledger.push(wallet.debit(movement('25.00')));
    ledger.push(wallet.credit(movement('50.00')));
    ledger.push(wallet.debit(movement('0.01')));
    try {
      wallet.debit(movement('5000.00')); // recusada: não pode gerar lançamento
    } catch {}
    ledger.push(wallet.credit(movement('25.00')));

    expect(wallet.balance.toJSON().amount).toBe('1049.99');
    expect(balanceFromLedger(ledger).equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(1 + 4); // abertura + 4 movimentos aceitos
    // Cada lançamento começa onde o anterior terminou (o extrato é contínuo).
    for (let i = 1; i < ledger.length; i++) {
      expect(ledger[i]!.balanceBefore.equals(ledger[i - 1]!.balanceAfter)).toBe(true);
    }
  });
});

describe('Wallet.rehydrate', () => {
  test('restaura o estado salvo sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: brl('975.00'),
      version: 7,
      createdAt: openedAt,
      updatedAt: later,
    });

    expect(wallet.balance.toJSON().amount).toBe('975.00');
    expect(wallet.version).toBe(7);
    wallet.debit(movement('75.00'));
    expect(wallet.version).toBe(8);
  });
});
