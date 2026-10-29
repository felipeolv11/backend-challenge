import { InvalidTransactionStateError, InvalidWagerTransactionError, WagerRuleViolationError } from './errors';
import { FailureCode } from './failure-code';
import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violação de regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal, auditável)
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id da transação referenciada NO PROVEDOR — não o id interno */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

// Valores fixos da transação interna OPENING, que não vem de nenhum provedor.
export const INTERNAL_PROVIDER_ID = 'internal';
const OPENING_ROUND_AND_GAME = 'wallet-opening';

const TERMINAL_STATUSES = [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed];

// Tipos que o provedor pode submeter (API ou fila). OPENING fica de fora: é interno.
const PROVIDER_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

// Regra 3 da seção 7 + decisão de validar a referência opcional de WIN e LOSS.
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
};

/**
 * Transições válidas:
 *
 *   PENDING ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED: terminais, nenhuma transição.
 *
 * Qualquer outra transição lança InvalidTransactionStateError (erro de programação).
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  /** Transação vinda do provedor. Nasce em PENDING. Lança InvalidWagerTransactionError se o payload for inválido. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!PROVIDER_KINDS.includes(props.kind)) {
      // Cobre OPENING (interno) e qualquer valor fora do enum vindo do JSON.
      throw new InvalidWagerTransactionError(`Kind "${props.kind}" cannot be submitted by a provider`);
    }

    const reference = props.referenceExternalTransactionId;
    const requiresReference = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && !reference) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('A transaction cannot reference itself');
    }

    // DECISÃO: BET, REFUND e ROLLBACK exigem valor > 0; WIN e LOSS aceitam 0.00.
    // POR QUÊ: WIN de 0.00 é comum ("ganhou zero") e LOSS não move saldo, então o valor é só
    //          informativo. Uma aposta ou reversão de 0.00 não faz sentido: é payload inválido.
    // ALTERNATIVA: exigir > 0 de todos — não usei porque recusaria provedores que mandam
    //              WIN 0.00 para fechar a rodada.
    const mustBePositive = props.kind === WagerTransactionKind.Bet || requiresReference;
    if (mustBePositive && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(`${props.kind} amount must be greater than zero`);
    }

    return WagerTransaction.fromState({ ...props, status: WagerTransactionStatus.Pending });
  }

  /**
   * Transação interna de abertura da wallet. Não passa pelo create() porque OPENING não pode
   * vir do provedor. Já nasce PROCESSED: é aplicada na mesma transação SQL que cria a wallet.
   * Os campos de provedor recebem valores fixos ("internal").
   */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('Opening amount must be greater than zero');
    }
    const externalId = `opening:${props.walletId}`;
    return WagerTransaction.fromState({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: externalId,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:${externalId}`,
      payloadHash: '',
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: OPENING_ROUND_AND_GAME,
      gameId: OPENING_ROUND_AND_GAME,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
      status: WagerTransactionStatus.Processed,
      processedAt: props.at,
    });
  }

  /** Reconstrução a partir da persistência: não revalida transições nem regras. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return WagerTransaction.fromState(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertCanTransition(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    // Só a partir de PENDING. Se já está PENDING_REFERENCE, o worker apenas tenta de novo
    // depois; não é uma transição nova.
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`Cannot move transaction ${this.id} from ${this._status} to PENDING_REFERENCE`);
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertCanTransition(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertCanTransition(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  /** false para LOSS e para WIN de 0.00: não mexem no saldo nem geram lançamento. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss && this.money.isPositive();
  }

  /** true para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** true quando veio uma referência (obrigatória em REFUND/ROLLBACK, opcional em WIN/LOSS). */
  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  /** true para REFUND e ROLLBACK: desfazem outra transação. */
  isReversal(): boolean {
    return this.requiresReference();
  }

  /** Mesma idempotency key com hash diferente = conflito, não replay. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento no ledger. ROLLBACK precisa da referência: é o inverso dela
   * (rollback de BET credita; rollback de WIN ou REFUND debita).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError(`ROLLBACK ${this.id} needs its reference to define the ledger direction`);
        }
        const referenceDirection = reference.ledgerDirectionFor();
        return referenceDirection === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError(`LOSS ${this.id} does not affect the balance and has no ledger direction`);
    }
  }

  /**
   * Valida a referência já encontrada e terminal. Lança WagerRuleViolationError com o
   * failureCode adequado. Não cobre:
   * - referência ausente ou ainda não terminal (o caso de uso deixa em PENDING_REFERENCE);
   * - "já revertida" (precisa consultar o banco; garantido também por índice único).
   */
  assertValidReference(reference: WagerTransaction): void {
    if (!reference.isTerminal()) {
      throw new InvalidTransactionStateError(`Reference ${reference.id} is not terminal yet; keep ${this.id} pending`);
    }

    // Regra 2 da seção 7: mesmo provider, player, wallet, moeda e rodada.
    const sameContext =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId;
    if (!sameContext) {
      throw new WagerRuleViolationError(FailureCode.ReferenceMismatch, `Reference ${reference.id} belongs to another context`);
    }

    const allowedKinds = ALLOWED_REFERENCE_KINDS[this.kind] ?? [];
    if (!allowedKinds.includes(reference.kind)) {
      throw new WagerRuleViolationError(FailureCode.InvalidReferenceKind, `${this.kind} cannot reference a ${reference.kind}`);
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new WagerRuleViolationError(FailureCode.ReferenceNotProcessed, `Reference ${reference.id} is ${reference.status}`);
    }

    // Regra 5: reversão parcial está fora de escopo, o valor tem que ser igual.
    if (this.isReversal() && !this.money.equals(reference.money)) {
      throw new WagerRuleViolationError(FailureCode.AmountMismatch, `${this.kind} amount differs from reference ${reference.id}`);
    }
  }

  private assertCanTransition(target: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Transaction ${this.id} is ${this._status} (terminal) and cannot become ${target}`);
    }
  }

  private static fromState(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }
}
