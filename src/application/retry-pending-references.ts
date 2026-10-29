import type { EventContext } from '../domain/events/integration-event';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-events';
import { FailureCode } from '../domain/failure-code';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { newId } from './ids';
import { PendingReferencePolicy } from './pending-reference-policy';
import type { TransactionRunner } from './ports';
import { WagerTransactionProcessor } from './wager-transaction-processor';

export type PendingReferenceOutcome = 'processed' | 'rejected' | 'still-pending' | 'skipped';

export interface RetryPendingReferencesResult {
  processed: number;
  rejected: number;
  stillPending: number;
  skipped: number;
}

/**
 * Worker agendado das transações PENDING_REFERENCE (seção 7.1): tenta de novo achar a referência.
 * - Achou: processa normalmente (mesma decisão do caso de uso, via WagerTransactionProcessor).
 * - Não achou: agenda a próxima tentativa com backoff.
 * - Esgotou o limite: REJECTED com REFERENCE_NOT_FOUND e evento WagerTransactionRejected.
 */
export class RetryPendingReferences {
  private readonly processor: WagerTransactionProcessor;

  constructor(
    private readonly runner: TransactionRunner,
    private readonly policy = new PendingReferencePolicy(),
    private readonly batchSize = 20,
  ) {
    this.processor = new WagerTransactionProcessor(policy);
  }

  async runOnce(): Promise<RetryPendingReferencesResult> {
    const ids = await this.runner.run((repositories) => repositories.transactions.findDuePendingReferenceIds(new Date(), this.batchSize));
    const result: RetryPendingReferencesResult = { processed: 0, rejected: 0, stillPending: 0, skipped: 0 };

    for (const id of ids) {
      const outcome = await this.retryOne(id);
      if (outcome === 'processed') result.processed += 1;
      else if (outcome === 'rejected') result.rejected += 1;
      else if (outcome === 'still-pending') result.stillPending += 1;
      else result.skipped += 1;
    }
    return result;
  }

  /** Cada transação pendente é tratada numa transação SQL própria. */
  async retryOne(transactionId: string): Promise<PendingReferenceOutcome> {
    return this.runner.run(async (repositories) => {
      const candidate = await repositories.transactions.findById(transactionId);
      if (!candidate || candidate.status !== WagerTransactionStatus.PendingReference) return 'skipped';

      // Mesma ordem de lock do caso de uso (wallet primeiro): sem risco de deadlock entre os dois.
      const wallet = await repositories.wallets.findByIdForUpdate(candidate.walletId);

      // Lê de novo DEPOIS do lock: outra instância do worker pode ter tratado esta transação
      // enquanto esperávamos. Com a wallet travada, o que lemos agora é o estado final.
      const transaction = await repositories.transactions.findById(transactionId);
      const now = new Date();
      if (
        !transaction ||
        transaction.status !== WagerTransactionStatus.PendingReference ||
        (transaction.nextReferenceAttemptAt && transaction.nextReferenceAttemptAt > now)
      ) {
        return 'skipped';
      }

      // Sem requisição de origem: o próprio id da transação serve de rastreio dos eventos.
      const trace = { correlationId: transaction.id, causationId: transaction.id };
      const outcome = await this.processor.decide(repositories, transaction, wallet, now, trace);

      let result: PendingReferenceOutcome;
      if (transaction.status === WagerTransactionStatus.PendingReference) {
        const attemptsMade = transaction.referenceAttempts + 1;
        if (this.policy.isExhausted(attemptsMade)) {
          transaction.reject(FailureCode.ReferenceNotFound, wallet?.balance);
          const eventContext: EventContext = { eventId: newId(), occurredAt: now, ...trace };
          outcome.events.push(WagerTransactionRejected.from(transaction, eventContext));
          result = 'rejected';
        } else {
          transaction.scheduleReferenceRetry(this.policy.nextAttemptAt(now, attemptsMade + 1));
          result = 'still-pending';
        }
      } else {
        result = transaction.status === WagerTransactionStatus.Processed ? 'processed' : 'rejected';
      }

      await repositories.transactions.updateOutcome(transaction);
      await this.processor.persist(repositories, wallet, outcome);
      return result;
    });
  }
}
