import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from — entradas válidas', () => {
  test.each(['0.00', '0.01', '25.00', '1000.00', '999999999999999999.99'])('aceita "%s" e devolve o mesmo texto', (amount) => {
    expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
  });
});

describe('Money.from — entradas inválidas', () => {
  test.each([
    ['string vazia', ''],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['notação científica', '1e3'],
    ['notação científica com casas', '1.00e3'],
    ['mais de 2 casas decimais', '25.001'],
    ['valor negativo', '-25.00'],
    ['sinal de mais', '+25.00'],
    ['sem casas decimais', '25'],
    ['só 1 casa decimal', '25.5'],
    ['zeros à esquerda', '007.00'],
    ['vírgula em vez de ponto', '25,00'],
    ['espaços', ' 25.00 '],
    ['separador de milhar', '1,000.00'],
    ['mais de 18 dígitos inteiros', '1000000000000000000.00'],
  ])('rejeita %s ("%s")', (_description, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount do tipo number (JSON sem aspas)', () => {
    // O TypeScript barraria isso, mas em runtime o JSON da requisição pode trazer um number.
    expect(() => Money.from({ amount: 25.5 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: NaN as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: Infinity as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['', 'brl', 'BR', 'BRLL', 'R$', '123'])('rejeita moeda inválida "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
  });
});

describe('Money — aritmética exata (escala e arredondamento)', () => {
  test('0.10 + 0.20 é exatamente 0.30 (com number daria 0.30000000000000004)', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test('somar 0.01 mil vezes dá exatamente 10.00', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
    expect(total.toJSON().amount).toBe('10.00');
  });

  test('o resultado sempre tem escala fixa de 2 casas', () => {
    expect(brl('10.50').add(brl('0.50')).toJSON().amount).toBe('11.00');
    expect(brl('1.00').subtract(brl('1.00')).toJSON().amount).toBe('0.00');
    expect(brl('100.00').subtract(brl('0.01')).toJSON().amount).toBe('99.99');
  });

  test('nunca arredonda: um valor com 3 casas é rejeitado na entrada', () => {
    // Não existe arredondamento porque só fazemos soma e subtração de valores com 2 casas.
    expect(() => brl('0.005')).toThrow(InvalidMoneyError);
  });

  test('valores acima de Number.MAX_SAFE_INTEGER continuam exatos', () => {
    // 9007199254740993 não pode ser representado como number (vira ...992).
    expect(brl('9007199254740992.00').add(brl('1.00')).toJSON().amount).toBe('9007199254740993.00');
  });

  test('subtract pode gerar negativo (ex.: diferença na reconciliação) e formata com sinal', () => {
    const difference = brl('20.00').subtract(brl('20.05'));
    expect(difference.isNegative()).toBe(true);
    expect(difference.toJSON().amount).toBe('-0.05');
  });

  test('negate inverte o sinal', () => {
    expect(brl('25.00').negate().toJSON().amount).toBe('-25.00');
    expect(brl('25.00').negate().negate().equals(brl('25.00'))).toBe(true);
  });
});

describe('Money — imutabilidade', () => {
  test('operações devolvem uma nova instância e não alteram a original', () => {
    const original = brl('100.00');
    const added = original.add(brl('1.00'));
    const subtracted = original.subtract(brl('1.00'));
    const negated = original.negate();

    expect(original.toJSON().amount).toBe('100.00');
    expect(added).not.toBe(original);
    expect(subtracted).not.toBe(original);
    expect(negated).not.toBe(original);
  });
});

describe('Money — consultas', () => {
  test('isZero / isPositive / isNegative', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.zero('BRL').isNegative()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
  });

  test('isLessThan', () => {
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80.01').isLessThan(brl('80.00'))).toBe(false);
  });

  test('equals compara valor e moeda', () => {
    expect(brl('25.00').equals(brl('25.00'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
    expect(brl('25.00').equals(Money.from({ amount: '25.00', currency: 'USD' }))).toBe(false);
  });

  test('toString e JSON.stringify', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
    expect(JSON.stringify({ money: brl('25.00') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });
});

describe('Money — conflito de moeda', () => {
  const usd = Money.from({ amount: '10.00', currency: 'USD' });

  test('add, subtract e isLessThan entre moedas diferentes lançam CurrencyMismatchError', () => {
    expect(() => brl('10.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('10.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('10.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('a moeda é preservada nas operações', () => {
    expect(usd.add(usd).currency).toBe('USD');
    expect(Money.zero('EUR').currency).toBe('EUR');
  });
});
