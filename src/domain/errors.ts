import type { FailureCode } from './failure-code';

// Erros de domínio: violações de regra de negócio, causadas pelo que o provedor enviou.
// Ficam separados dos erros de infraestrutura (banco fora do ar, SQS indisponível etc.)
// porque o tratamento é diferente: erro de domínio não adianta tentar de novo.
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}

export class CurrencyMismatchError extends DomainError {}

/** Saldo atual menor que o valor do débito. O caso de uso decide o failureCode. */
export class InsufficientBalanceError extends DomainError {}

/** Payload da transação inválido (ex.: REFUND sem referência). Não é persistido. */
export class InvalidWagerTransactionError extends DomainError {}

/** Regra de negócio violada: a transação vira REJECTED com este failureCode. */
export class WagerRuleViolationError extends DomainError {
  constructor(
    public readonly failureCode: FailureCode,
    message: string,
  ) {
    super(message);
  }
}

// Erros de programação: indicam BUG no nosso código, nunca erro do provedor.
// Por isso NÃO herdam de DomainError: não devem virar 4xx nem REJECTED.
export class ProgrammingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Lançamento de ledger com aritmética errada. */
export class InvalidLedgerEntryError extends ProgrammingError {}

/** Tentativa de transicionar uma transação que já está num estado terminal (ou transição inválida). */
export class InvalidTransactionStateError extends ProgrammingError {}
