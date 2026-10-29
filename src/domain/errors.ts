// Erros de domínio: violações de regra de negócio.
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

/** Lançamento de ledger com aritmética errada. Indica bug no código, não erro do provedor. */
export class InvalidLedgerEntryError extends DomainError {}
