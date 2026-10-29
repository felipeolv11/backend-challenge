import { CurrencyMismatchError, InvalidMoneyError } from './errors';

// DTO usado nos contratos (API, fila, eventos e banco). Interface é adequada aqui.
export interface MoneyProps {
  amount: string; // string decimal com exatamente 2 casas, ex.: "25.00"
  currency: string; // código ISO-4217, ex.: "BRL"
}

// DECISÃO: formato de entrada estrito, sempre com exatamente 2 casas ("25.00").
// POR QUÊ: o enunciado diz que o amount é "recebido sempre com escala fixa de 2 casas".
//          Também evita que "25" e "25.00" (mesmo valor, textos diferentes) gerem hashes de
//          payload diferentes, o que transformaria um reenvio legítimo em conflito de idempotência.
// ALTERNATIVA: aceitar de 0 a 2 casas e normalizar — não usei porque exigiria normalizar antes
//              do hash de idempotência, e seria mais um lugar para errar.
// A regex também rejeita, sem precisar de código extra: sinal negativo, notação científica
// ("1e3"), "NaN", "Infinity", string vazia, espaços e zeros à esquerda ("007.00").
const AMOUNT_FORMAT = /^(0|[1-9]\d*)\.\d{2}$/;

// ISO-4217: três letras maiúsculas. Não validamos contra a lista oficial de moedas.
const CURRENCY_FORMAT = /^[A-Z]{3}$/;

// A coluna no banco é NUMERIC(20,2): 18 dígitos antes da vírgula.
// Validar aqui faz um valor grande demais virar erro de validação (400), em vez de
// estourar como erro de banco (que seria confundido com falha de infraestrutura).
const MAX_INTEGER_DIGITS = 18;

const CENTS_PER_UNIT = 100n;

export class Money {
  // DECISÃO: guardar o valor como BigInt em centavos ("25.00" vira 2500n).
  // POR QUÊ: BigInt é inteiro exato e nativo do JavaScript (sem dependência). Como a escala é
  //          sempre 2 e só fazemos soma e subtração, centavos inteiros resolvem tudo sem
  //          arredondamento: 0.10 + 0.20 vira 10n + 20n = 30n, exatamente "0.30".
  // ALTERNATIVA: lib de decimal (decimal.js), como sugere o tipo `Decimal` do esqueleto do
  //              enunciado — não usei porque adiciona uma dependência, exige configurar
  //              precisão e arredondamento que nunca usaríamos, e aceita entradas que o
  //              enunciado manda rejeitar ("1e3"), então a regex continuaria necessária.
  // E por que não `number`? Porque 0.1 + 0.2 === 0.30000000000000004 em JavaScript.
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  /**
   * Cria um Money a partir de um contrato de entrada (API, fila ou banco).
   * Rejeita valores negativos: dinheiro negativo só existe como resultado de conta interna
   * (ex.: a diferença numa reconciliação), nunca como entrada.
   */
  static from(props: MoneyProps): Money {
    // Em runtime o JSON pode trazer um number (ex.: 25.5) mesmo com a tipagem dizendo string.
    if (typeof props.amount !== 'string' || !AMOUNT_FORMAT.test(props.amount)) {
      throw new InvalidMoneyError(
        `Invalid amount "${String(props.amount)}": expected a non-negative decimal string with exactly 2 decimal places, e.g. "25.00"`,
      );
    }

    const [integerPart, decimalPart] = props.amount.split('.') as [string, string];
    if (integerPart.length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError(`Invalid amount "${props.amount}": too many digits (max ${MAX_INTEGER_DIGITS} before the decimal point)`);
    }

    const cents = BigInt(integerPart) * CENTS_PER_UNIT + BigInt(decimalPart);
    return new Money(cents, Money.validateCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.validateCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  /** Mesma moeda e mesmo valor. Moedas diferentes não são "iguais" (não lança erro). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  /** Converte centavos de volta para string com 2 casas: 2500n -> "25.00", -5n -> "-0.05". */
  private formatAmount(): string {
    const sign = this.cents < 0n ? '-' : '';
    const absoluteCents = this.cents < 0n ? -this.cents : this.cents;
    const integerPart = absoluteCents / CENTS_PER_UNIT; // divisão de BigInt já descarta a fração
    const decimalPart = (absoluteCents % CENTS_PER_UNIT).toString().padStart(2, '0');
    return `${sign}${integerPart}.${decimalPart}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  private static validateCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_FORMAT.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${String(currency)}": expected an ISO-4217 code, e.g. "BRL"`);
    }
    return currency;
  }
}
