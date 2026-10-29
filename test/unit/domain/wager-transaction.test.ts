import { describe, expect, test } from 'bun:test';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  ProgrammingError,
  DomainError,
  WagerRuleViolationError,
} from '../../../src/domain/errors';
import { FailureCode } from '../../../src/domain/failure-code';
import { Money } from '../../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wager-transaction';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-29T12:00:00.000Z');

let sequence = 0;

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${++sequence}`;
  return {
    id: `tx-${sequence}`,
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: Kind.Bet,
    money: brl('80.00'),
    createdAt: at,
    ...overrides,
  };
}

/** Cria uma transação já terminal no status desejado (como se tivesse sido lida do banco). */
function stored(overrides: Partial<CreateWagerTransactionProps> = {}, status = Status.Processed) {
  return WagerTransaction.rehydrate({ ...props(overrides), status });
}

const bet = (overrides: Partial<CreateWagerTransactionProps> = {}, status = Status.Processed) =>
  stored({ kind: Kind.Bet, ...overrides }, status);

const reversal = (kind: Kind.Refund | Kind.Rollback, reference: WagerTransaction, overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(
    props({ kind, money: reference.money, referenceExternalTransactionId: reference.externalTransactionId, ...overrides }),
  );

function expectRuleViolation(fn: () => void, code: FailureCode) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WagerRuleViolationError);
    expect((error as WagerRuleViolationError).failureCode).toBe(code);
    return;
  }
  throw new Error(`expected WagerRuleViolationError(${code}) but nothing was thrown`);
}

describe('WagerTransaction.create — validação do payload', () => {
  test('nasce PENDING, sem failureCode e sem processedAt', () => {
    const tx = WagerTransaction.create(props());
    expect(tx.status).toBe(Status.Pending);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.isTerminal()).toBe(false);
  });

  test('OPENING não pode ser submetido pelo provedor', () => {
    expect(() => WagerTransaction.create(props({ kind: Kind.Opening }))).toThrow(InvalidWagerTransactionError);
  });

  test('kind desconhecido (vindo do JSON) é rejeitado', () => {
    expect(() => WagerTransaction.create(props({ kind: 'JACKPOT' as Kind }))).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s sem referenceExternalTransactionId é payload inválido', (kind) => {
    expect(() => WagerTransaction.create(props({ kind }))).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.create(props({ kind, referenceExternalTransactionId: '' }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test('uma transação não pode referenciar a si mesma', () => {
    expect(() =>
      WagerTransaction.create(props({ kind: Kind.Refund, externalTransactionId: 'x', referenceExternalTransactionId: 'x' })),
    ).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Bet, Kind.Refund, Kind.Rollback])('%s com valor 0.00 é payload inválido', (kind) => {
    expect(() => WagerTransaction.create(props({ kind, money: brl('0.00'), referenceExternalTransactionId: 'ref' }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each([Kind.Win, Kind.Loss])('%s com valor 0.00 é aceito', (kind) => {
    expect(WagerTransaction.create(props({ kind, money: brl('0.00') })).status).toBe(Status.Pending);
  });

  test('erros de payload são DomainError; erros de estado são ProgrammingError (bug, não 4xx)', () => {
    expect(new InvalidWagerTransactionError('x')).toBeInstanceOf(DomainError);
    expect(new InvalidTransactionStateError('x')).toBeInstanceOf(ProgrammingError);
    expect(new InvalidTransactionStateError('x')).not.toBeInstanceOf(DomainError);
  });
});

describe('WagerTransaction.opening', () => {
  test('é interna, já nasce PROCESSED e credita', () => {
    const tx = WagerTransaction.opening({ id: 'tx-open', walletId: 'w-1', playerId: 'p-1', money: brl('1000.00'), at });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(at);
    expect(tx.providerId).toBe('internal');
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('exige valor > 0 (saldo inicial zero não gera OPENING)', () => {
    expect(() => WagerTransaction.opening({ id: 't', walletId: 'w', playerId: 'p', money: brl('0.00'), at })).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('WagerTransaction — transições de estado', () => {
  test('PENDING → PROCESSED guarda referência e processedAt', () => {
    const tx = WagerTransaction.create(props());
    tx.markProcessed('tx-ref', at, brl('20.00'));
    expect(tx.balanceAfter?.toJSON().amount).toBe('20.00');
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('tx-ref');
    expect(tx.processedAt).toEqual(at);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED e PENDING → FAILED guardam o failureCode', () => {
    const rejected = WagerTransaction.create(props());
    rejected.reject(FailureCode.InsufficientFunds);
    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

    const failed = WagerTransaction.create(props());
    failed.fail(FailureCode.ProcessingError);
    expect(failed.status).toBe(Status.Failed);
    expect(failed.failureCode).toBe(FailureCode.ProcessingError);
  });

  test('PENDING → PENDING_REFERENCE → PROCESSED', () => {
    const tx = WagerTransaction.create(props({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' }));
    tx.markPendingReference(at);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceAttemptAt).toEqual(at);
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('tx-bet-1', at, brl('100.00'));
    expect(tx.status).toBe(Status.Processed);
  });

  test('PENDING_REFERENCE → REJECTED (ex.: referência nunca chegou)', () => {
    const tx = WagerTransaction.create(props({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' }));
    tx.markPendingReference(at);
    tx.reject(FailureCode.ReferenceNotFound);
    expect(tx.status).toBe(Status.Rejected);
  });

  test('PENDING_REFERENCE → PENDING_REFERENCE não é transição válida', () => {
    const tx = WagerTransaction.create(props({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' }));
    tx.markPendingReference(at);
    expect(() => tx.markPendingReference(at)).toThrow(InvalidTransactionStateError);
  });

  test('scheduleReferenceRetry conta a tentativa e reagenda; só vale em PENDING_REFERENCE', () => {
    const tx = WagerTransaction.create(props({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' }));
    expect(() => tx.scheduleReferenceRetry(at)).toThrow(InvalidTransactionStateError);
    tx.markPendingReference(at);
    const later = new Date(at.getTime() + 4_000);
    tx.scheduleReferenceRetry(later);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceAttemptAt).toEqual(later);
    tx.markProcessed('ref', later, brl('1.00'));
    expect(tx.nextReferenceAttemptAt).toBeUndefined(); // terminal: não há mais o que agendar
  });

  // Toda combinação de (estado terminal) x (transição) precisa lançar erro e não mudar nada.
  const terminalStatuses = [Status.Processed, Status.Rejected, Status.Failed];
  const transitions: Record<string, (tx: WagerTransaction) => void> = {
    markProcessed: (tx) => tx.markProcessed(undefined, at, brl('1.00')),
    markPendingReference: (tx) => tx.markPendingReference(at),
    reject: (tx) => tx.reject(FailureCode.InsufficientFunds),
    fail: (tx) => tx.fail(FailureCode.ProcessingError),
  };

  for (const status of terminalStatuses) {
    for (const [name, transition] of Object.entries(transitions)) {
      test(`${status} é terminal: ${name}() lança InvalidTransactionStateError`, () => {
        const tx = stored({}, status);
        expect(() => transition(tx)).toThrow(InvalidTransactionStateError);
        expect(tx.status).toBe(status);
      });
    }
  }
});

describe('WagerTransaction — efeito no saldo e direção no ledger', () => {
  test('BET debita; WIN e REFUND creditam', () => {
    expect(WagerTransaction.create(props({ kind: Kind.Bet })).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(WagerTransaction.create(props({ kind: Kind.Win })).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      WagerTransaction.create(props({ kind: Kind.Refund, referenceExternalTransactionId: 'r' })).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK é o inverso da referência', () => {
    const rollback = WagerTransaction.create(props({ kind: Kind.Rollback, referenceExternalTransactionId: 'r' }));
    expect(rollback.ledgerDirectionFor(stored({ kind: Kind.Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(stored({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(stored({ kind: Kind.Refund, referenceExternalTransactionId: 'x' }))).toBe(
      LedgerDirection.Debit,
    );
  });

  test('ROLLBACK sem a referência não sabe a direção (bug de quem chama)', () => {
    const rollback = WagerTransaction.create(props({ kind: Kind.Rollback, referenceExternalTransactionId: 'r' }));
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('LOSS não afeta o saldo e não tem direção', () => {
    const loss = WagerTransaction.create(props({ kind: Kind.Loss }));
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('WIN de 0.00 não afeta o saldo; WIN > 0 afeta', () => {
    expect(WagerTransaction.create(props({ kind: Kind.Win, money: brl('0.00') })).affectsBalance()).toBe(false);
    expect(WagerTransaction.create(props({ kind: Kind.Win, money: brl('10.00') })).affectsBalance()).toBe(true);
  });

  test('requiresReference: só REFUND e ROLLBACK', () => {
    expect(WagerTransaction.create(props({ kind: Kind.Bet })).requiresReference()).toBe(false);
    expect(WagerTransaction.create(props({ kind: Kind.Win })).requiresReference()).toBe(false);
    expect(WagerTransaction.create(props({ kind: Kind.Loss })).requiresReference()).toBe(false);
    expect(WagerTransaction.create(props({ kind: Kind.Refund, referenceExternalTransactionId: 'r' })).requiresReference()).toBe(true);
    expect(WagerTransaction.create(props({ kind: Kind.Rollback, referenceExternalTransactionId: 'r' })).requiresReference()).toBe(
      true,
    );
  });
});

describe('WagerTransaction.assertValidReference', () => {
  test('REFUND de uma BET processada, mesmo contexto e mesmo valor: válido', () => {
    const reference = bet();
    expect(() => reversal(Kind.Refund, reference).assertValidReference(reference)).not.toThrow();
  });

  test.each([
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['rodada', { roundId: 'round-2' }],
  ])('referência de outro(a) %s → REFERENCE_MISMATCH', (_name, contextOverride) => {
    const reference = bet(contextOverride);
    expectRuleViolation(() => reversal(Kind.Refund, reference, { money: brl('80.00') }).assertValidReference(reference), FailureCode.ReferenceMismatch);
  });

  test('referência em outra moeda → REFERENCE_MISMATCH', () => {
    const reference = bet({ money: Money.from({ amount: '80.00', currency: 'USD' }) });
    expectRuleViolation(
      () => reversal(Kind.Refund, reference, { money: brl('80.00') }).assertValidReference(reference),
      FailureCode.ReferenceMismatch,
    );
  });

  test('REFUND só referencia BET', () => {
    for (const kind of [Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback]) {
      const reference = stored({ kind, referenceExternalTransactionId: 'x' });
      expectRuleViolation(() => reversal(Kind.Refund, reference).assertValidReference(reference), FailureCode.InvalidReferenceKind);
    }
  });

  test('ROLLBACK referencia BET, WIN ou REFUND; nunca LOSS ou outro ROLLBACK', () => {
    for (const kind of [Kind.Bet, Kind.Win, Kind.Refund]) {
      const reference = stored({ kind, referenceExternalTransactionId: kind === Kind.Refund ? 'x' : undefined });
      expect(() => reversal(Kind.Rollback, reference).assertValidReference(reference)).not.toThrow();
    }
    for (const kind of [Kind.Loss, Kind.Rollback]) {
      const reference = stored({ kind, referenceExternalTransactionId: 'x' });
      expectRuleViolation(() => reversal(Kind.Rollback, reference).assertValidReference(reference), FailureCode.InvalidReferenceKind);
    }
  });

  test('WIN e LOSS com referência: só podem apontar para BET', () => {
    const betRef = bet();
    const winRef = stored({ kind: Kind.Win });
    for (const kind of [Kind.Win, Kind.Loss]) {
      const tx = WagerTransaction.create(props({ kind, money: brl('150.00'), referenceExternalTransactionId: 'r' }));
      expect(() => tx.assertValidReference(betRef)).not.toThrow();
      expectRuleViolation(() => tx.assertValidReference(winRef), FailureCode.InvalidReferenceKind);
    }
  });

  test.each([Status.Rejected, Status.Failed])('referência %s → REFERENCE_NOT_PROCESSED', (status) => {
    const reference = bet({}, status);
    expectRuleViolation(() => reversal(Kind.Refund, reference).assertValidReference(reference), FailureCode.ReferenceNotProcessed);
  });

  test('referência ainda não terminal é bug de quem chama (deveria ficar PENDING_REFERENCE)', () => {
    const reference = bet({}, Status.Pending);
    expect(() => reversal(Kind.Refund, reference).assertValidReference(reference)).toThrow(InvalidTransactionStateError);
  });

  test.each([Kind.Refund, Kind.Rollback] as const)('%s com valor diferente da referência → AMOUNT_MISMATCH (sem reversão parcial)', (kind) => {
    const reference = bet({ money: brl('80.00') });
    expectRuleViolation(
      () => reversal(kind, reference, { money: brl('40.00') }).assertValidReference(reference),
      FailureCode.AmountMismatch,
    );
  });

  test('WIN pode ter valor diferente da BET referenciada (o prêmio não é a aposta)', () => {
    const reference = bet({ money: brl('10.00') });
    const win = WagerTransaction.create(props({ kind: Kind.Win, money: brl('500.00'), referenceExternalTransactionId: 'r' }));
    expect(() => win.assertValidReference(reference)).not.toThrow();
  });
});

describe('WagerTransaction.matchesPayload — idempotência', () => {
  test('mesmo hash = replay; hash diferente = conflito', () => {
    const tx = WagerTransaction.create(props({ payloadHash: 'abc' }));
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('xyz')).toBe(false);
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('restaura estado terminal com failureCode sem revalidar', () => {
    const tx = WagerTransaction.rehydrate({
      ...props({ kind: Kind.Bet, money: brl('500.00') }),
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.isTerminal()).toBe(true);
  });
});
