import type { SQSClient } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import type { TransactionRunner } from '../../application/ports';
import type { ProcessWagerTransaction } from '../../application/process-wager-transaction';
import { PublishOutbox } from '../../application/publish-outbox';
import type { RetryPendingReferences } from '../../application/retry-pending-references';
import type { ConsumerConfig, OutboxPublisherConfig, PendingReferenceConfig, QueueNames } from '../../config';
import { getQueueUrl } from '../sqs/sqs-client';
import { SqsEventPublisher } from '../sqs/sqs-event-publisher';
import { WagerTransactionConsumer } from '../sqs/wager-transaction-consumer';
import { PeriodicWorker } from './periodic-worker';

export interface WorkerFlags {
  sqsConsumer: boolean;
  outboxPublisher: boolean;
  pendingReferenceWorker: boolean;
}

export interface BackgroundWorkersDependencies {
  flags: WorkerFlags;
  sqs: SQSClient;
  queueNames: QueueNames;
  consumerConfig: ConsumerConfig;
  outboxConfig: OutboxPublisherConfig;
  pendingReferenceConfig: PendingReferenceConfig;
  runner: TransactionRunner;
  processWagerTransaction: ProcessWagerTransaction;
  retryPendingReferences: RetryPendingReferences;
}

/**
 * Liga e desliga os três workers junto com a aplicação (cada um pode ser desligado por variável
 * de ambiente). Cada instância roda os três: com 3 instâncias, há 3 consumidores, 3 publishers e
 * 3 workers de pendentes trabalhando juntos, e o banco garante que não se atrapalham.
 *
 * - Subida: não bloqueia a API. Se o SQS estiver fora, fica tentando achar as filas em segundo plano.
 * - Desligamento (SIGTERM): beforeApplicationShutdown roda ANTES do NestJS fechar o banco, então o
 *   consumidor ainda consegue terminar a mensagem em andamento (commit + ack).
 */
export class BackgroundWorkers {
  private readonly logger = new Logger(BackgroundWorkers.name);
  private consumer: WagerTransactionConsumer | undefined;
  private outboxWorker: PeriodicWorker | undefined;
  private pendingReferenceWorker: PeriodicWorker | undefined;
  private starting: Promise<void> | undefined;
  private stopRequested = false;

  constructor(private readonly deps: BackgroundWorkersDependencies) {}

  onApplicationBootstrap(): void {
    this.starting = this.startAll();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopRequested = true;
    await this.starting;
    await this.consumer?.stop(); // primeiro: para de pegar mensagens e termina a atual
    await this.pendingReferenceWorker?.stop();
    await this.outboxWorker?.stop();
    this.deps.sqs.destroy();
  }

  private async startAll(): Promise<void> {
    const { flags, outboxConfig, pendingReferenceConfig } = this.deps;

    if (flags.pendingReferenceWorker) {
      this.pendingReferenceWorker = new PeriodicWorker('PendingReferenceWorker', pendingReferenceConfig.pollIntervalMs, async () => {
        const result = await this.deps.retryPendingReferences.runOnce();
        const handled = result.processed + result.rejected + result.stillPending + result.skipped;
        return handled >= pendingReferenceConfig.batchSize; // lote cheio: provavelmente há mais
      });
      this.pendingReferenceWorker.start();
    }

    if (!flags.sqsConsumer && !flags.outboxPublisher) return;
    const urls = await this.resolveQueueUrls();
    if (!urls) return; // pediram para parar antes de as filas aparecerem

    if (flags.outboxPublisher) {
      const publisher = new PublishOutbox(this.deps.runner, new SqsEventPublisher(this.deps.sqs, urls.events), outboxConfig.batchSize);
      this.outboxWorker = new PeriodicWorker('OutboxPublisher', outboxConfig.pollIntervalMs, async () => {
        const result = await publisher.publishBatch();
        return result.claimed >= outboxConfig.batchSize;
      });
      this.outboxWorker.start();
    }

    if (flags.sqsConsumer) {
      this.consumer = new WagerTransactionConsumer(
        this.deps.sqs,
        { queueUrl: urls.wager, deadLetterQueueUrl: urls.deadLetter },
        this.deps.processWagerTransaction,
        this.deps.consumerConfig,
      );
      this.consumer.start();
    }
    this.logger.log(`Workers started: ${JSON.stringify(flags)}`);
  }

  /** Tenta achar as filas até conseguir (SQS ainda subindo, setup ainda não rodou...). */
  private async resolveQueueUrls(): Promise<{ wager: string; deadLetter: string; events: string } | undefined> {
    const { sqs, queueNames } = this.deps;
    while (!this.stopRequested) {
      try {
        return {
          wager: await getQueueUrl(sqs, queueNames.wagerQueue),
          deadLetter: await getQueueUrl(sqs, queueNames.wagerDeadLetterQueue),
          events: await getQueueUrl(sqs, queueNames.eventsQueue),
        };
      } catch (error) {
        this.logger.warn(`SQS queues not available yet (${error instanceof Error ? error.message : String(error)}); retrying in 2s`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    return undefined;
  }
}
