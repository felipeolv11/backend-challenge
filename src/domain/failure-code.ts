// DECISÃO: lista simples de códigos em MAIÚSCULAS, documentada numa tabela no ARCHITECTURE.md
//          com "o que o provedor deve fazer" para cada um.
// POR QUÊ: são poucos códigos (~12); um nome direto é fácil de ler, de testar e de usar no
//          provedor (um switch no código inteiro).
// ALTERNATIVA: códigos hierárquicos (BALANCE.INSUFFICIENT_FUNDS) — não usei porque o prefixo
//              não muda a decisão do provedor e só adiciona formalidade.
// Os valores são um CONTRATO público: nunca renomear, só adicionar novos.
export enum FailureCode {
  // ---- REJECTED: regra de negócio. Reenviar igual não adianta.
  /** BET maior que o saldo da wallet. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** REFUND/ROLLBACK que deixaria o saldo negativo (ex.: rollback de um WIN já gasto). */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Moeda da transação diferente da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** A wallet informada não existe. */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** A wallet existe, mas pertence a outro player. */
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** A transação referenciada não chegou dentro do limite de tentativas. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** A referência é de outro provider, player, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Tipo de referência não permitido (ex.: REFUND de um WIN, ROLLBACK de um LOSS). */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** A referência existe mas terminou REJECTED ou FAILED: não há o que reverter. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** A referência já foi revertida (por REFUND ou ROLLBACK). */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Valor do REFUND/ROLLBACK diferente do valor da referência. */
  AmountMismatch = 'AMOUNT_MISMATCH',

  // ---- FAILED: erro permanente de infraestrutura, auditável.
  /** Erro inesperado que continuou acontecendo depois de esgotar os retries. */
  ProcessingError = 'PROCESSING_ERROR',
}
