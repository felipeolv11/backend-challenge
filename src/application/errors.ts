// Erros da camada de aplicação. Cada um tem um significado diferente para quem chama
// (HTTP ou fila), por isso são classes separadas.

/** Mesma idempotency key (ou mesma transação externa) com payload diferente. Não é replay. */
export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

/** Mesmo messageId da fila com conteúdo diferente: bug do produtor, vai para a DLQ. */
export class InboxMessageConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxMessageConflictError';
  }
}

/** Já existe wallet para este player + moeda. */
export class WalletAlreadyExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletAlreadyExistsError';
  }
}

/**
 * Falha temporária de infraestrutura (banco fora do ar, lock demorou demais, deadlock...).
 * Tentar de novo depois pode funcionar: HTTP 503 / fila com retry.
 */
export class TransientInfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientInfrastructureError';
  }
}

/** A wallet mudou entre o lock e o UPDATE (version diferente). Também é transitório. */
export class ConcurrencyConflictError extends TransientInfrastructureError {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyConflictError';
  }
}

/**
 * Um INSERT bateu numa constraint UNIQUE. Normalmente é uma corrida entre duas requisições
 * iguais; o caso de uso tenta de novo e encontra o registro já gravado (replay).
 */
export class DuplicateRecordError extends Error {
  constructor(
    public readonly constraint: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'DuplicateRecordError';
  }
}
