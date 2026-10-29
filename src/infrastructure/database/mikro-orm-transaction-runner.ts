import { type MikroORM, UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError, DuplicateRecordError, TransientInfrastructureError } from '../../application/errors';
import type { TransactionalRepositories, TransactionRunner } from '../../application/ports';
import { createRepositories } from './repositories';

// Quanto tempo uma transação espera pelo lock de uma wallet antes de desistir.
// Sem isso, uma transação travada seguraria as outras da mesma wallet indefinidamente.
// Estourou = erro transitório: HTTP 503 / a mensagem da fila volta para retry.
const LOCK_TIMEOUT = '5s';

// Códigos de erro que indicam falha TEMPORÁRIA: tentar de novo pode funcionar.
const TRANSIENT_SQLSTATES = new Set([
  '55P03', // lock_not_available (lock_timeout estourou)
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (banco subindo)
]);
const TRANSIENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

/** Tipos de conflito de concorrência, para a métrica wagering_lock_conflicts_total. */
export type ConflictType = 'lock_timeout' | 'deadlock' | 'version_conflict' | 'duplicate_key';

export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(
    private readonly orm: MikroORM,
    private readonly onConflict: (type: ConflictType) => void = () => {},
  ) {}

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      // fork(): cada transação tem o seu próprio EntityManager (nada compartilhado entre requisições).
      return await this.orm.em.fork().transactional(async (em) => {
        // SET LOCAL vale só até o fim desta transação.
        await em.execute(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        return await work(createRepositories(em));
      });
    } catch (error) {
      const conflict = conflictTypeOf(error);
      if (conflict) this.onConflict(conflict);
      throw translateDatabaseError(error);
    }
  }
}

function conflictTypeOf(error: unknown): ConflictType | undefined {
  if (error instanceof ConcurrencyConflictError) return 'version_conflict';
  if (error instanceof UniqueConstraintViolationException) return 'duplicate_key';
  const code = errorCode(error) ?? errorCode((error as { cause?: unknown })?.cause);
  if (code === '55P03') return 'lock_timeout';
  if (code === '40P01' || code === '40001') return 'deadlock';
  return undefined;
}

/** Converte erros do banco/driver nos erros que a application entende. */
export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    return new DuplicateRecordError(extractConstraintName(error.message), error.message);
  }
  if (isTransient(error)) {
    return new TransientInfrastructureError('Database temporarily unavailable', { cause: error });
  }
  return error;
}

function isTransient(error: unknown): boolean {
  const codes = [errorCode(error), errorCode((error as { cause?: unknown })?.cause)];
  return codes.some(
    (code) =>
      code !== undefined &&
      (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NETWORK_CODES.has(code) || code.startsWith('08')), // classe 08 = conexão
  );
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const { code, sqlState } = error as { code?: unknown; sqlState?: unknown };
    if (typeof sqlState === 'string') return sqlState;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** O Postgres informa a constraint na mensagem: ... violates unique constraint "nome" */
function extractConstraintName(message: string): string | undefined {
  return /constraint "([^"]+)"/.exec(message)?.[1];
}
