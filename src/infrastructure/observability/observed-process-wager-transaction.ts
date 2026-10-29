import { Logger } from '@nestjs/common';
import type { TransactionRunner } from '../../application/ports';
import type { PendingReferencePolicy } from '../../application/pending-reference-policy';
import {
  type ProcessingContext,
  ProcessWagerTransaction,
  type WagerTransactionCommand,
  type WagerTransactionResult,
} from '../../application/process-wager-transaction';
import type { Metrics } from './metrics';

/**
 * O mesmo caso de uso, com log estruturado e métricas em volta.
 *
 * Por que uma subclasse aqui (na infraestrutura) e não código de log dentro do caso de uso:
 * a application fica só com regra de negócio, e quem usa (controller HTTP e consumidor SQS)
 * recebe a versão observada sem mudar nada.
 *
 * Logs SEM dados sensíveis nem payload financeiro completo (seção 12): só ids, tipo, status,
 * failureCode e duração. Valores e saldos não são logados.
 */
export class ObservedProcessWagerTransaction extends ProcessWagerTransaction {
  private readonly logger = new Logger('WagerTransaction');

  constructor(
    runner: TransactionRunner,
    pendingReferencePolicy: PendingReferencePolicy,
    private readonly metrics: Metrics,
  ) {
    super(runner, pendingReferencePolicy);
  }

  override async execute(command: WagerTransactionCommand, context: ProcessingContext): Promise<WagerTransactionResult> {
    const source = context.inbox ? 'sqs' : 'http';
    const startedAt = performance.now();
    const ids = {
      correlationId: context.correlationId,
      messageId: context.inbox?.messageId,
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      walletId: command.walletId,
      kind: command.kind,
    };

    try {
      const result = await super.execute(command, context);
      const seconds = (performance.now() - startedAt) / 1_000;

      if (result.idempotentReplay) {
        // Na fila, replay quase sempre é redelivery (at-least-once); no HTTP, é reenvio do provedor.
        this.metrics.duplicates.inc({ source, reason: source === 'sqs' ? 'redelivery' : 'idempotent_replay' });
      } else {
        this.metrics.transactions.inc({ status: result.status, kind: command.kind, source });
      }
      this.metrics.processingDuration.observe({ source, outcome: result.status }, seconds);

      this.logger.log({
        event: 'wager_transaction_handled',
        ...ids,
        transactionId: result.transactionId,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
        durationMs: Math.round(seconds * 1_000),
      });
      return result;
    } catch (error) {
      const seconds = (performance.now() - startedAt) / 1_000;
      this.metrics.processingDuration.observe({ source, outcome: 'error' }, seconds);
      this.logger.warn({
        event: 'wager_transaction_failed',
        ...ids,
        error: error instanceof Error ? error.name : 'UnknownError',
        reason: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(seconds * 1_000),
      });
      throw error;
    }
  }
}
