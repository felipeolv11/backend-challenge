import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import type { MikroORM, Options } from '@mikro-orm/postgresql';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { QUEUE_NAMES, SQS_CLIENT, TRANSACTION_RUNNER } from './app.tokens';
import { CreateWallet } from './application/create-wallet';
import { PendingReferencePolicy } from './application/pending-reference-policy';
import type { TransactionRunner } from './application/ports';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import { ReconcileWallet } from './application/reconcile-wallet';
import { RetryPendingReferences } from './application/retry-pending-references';
import { WalletQueries } from './application/wallet-queries';
import {
  type ConsumerConfig,
  loadConsumerConfig,
  loadOutboxPublisherConfig,
  loadPendingReferenceConfig,
  loadQueueNames,
  loadSqsConfig,
  loadWorkerFlags,
  type OutboxPublisherConfig,
  type PendingReferenceConfig,
  type QueueNames,
} from './config';
import mikroOrmConfig from './infrastructure/database/mikro-orm.config';
import { MikroOrmTransactionRunner } from './infrastructure/database/mikro-orm-transaction-runner';
import { Metrics } from './infrastructure/observability/metrics';
import { ObservedProcessWagerTransaction } from './infrastructure/observability/observed-process-wager-transaction';
import { createSqsClient } from './infrastructure/sqs/sqs-client';
import { BackgroundWorkers, type WorkerFlags } from './infrastructure/workers/background-workers';
import { AuthGuard } from './http/auth.guard';
import { HttpErrorFilter } from './http/error-filter';
import { HealthController } from './http/health.controller';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';

export { QUEUE_NAMES, SQS_CLIENT, TRANSACTION_RUNNER } from './app.tokens';

export interface AppOptions {
  /** Permite aos testes apontar para outro banco (ex.: wagering_test). */
  orm?: Partial<Options>;
  /** Permite ligar/desligar workers sem mexer nas variáveis de ambiente (ex.: testes da API). */
  workers?: Partial<WorkerFlags>;
  /** Os testes usam filas com nomes únicos e tempos curtos. */
  queueNames?: QueueNames;
  consumer?: Partial<ConsumerConfig>;
  outbox?: Partial<OutboxPublisherConfig>;
  pendingReference?: Partial<PendingReferenceConfig>;
}

/** O @mikro-orm/nestjs registra o ORM com o token do pacote core; em runtime é a versão PostgreSQL. */
const asPostgres = (orm: CoreMikroORM) => orm as unknown as MikroORM;

// Os casos de uso são classes TypeScript comuns (sem decorators do NestJS): o NestJS só monta
// as dependências aqui, com factories. Assim a application não depende do framework.
@Module({})
export class AppModule {
  static register(options: AppOptions = {}): DynamicModule {
    const pendingReferenceConfig = { ...loadPendingReferenceConfig(), ...options.pendingReference };
    const pendingReferencePolicy = new PendingReferencePolicy(pendingReferenceConfig);
    const workerFlags: WorkerFlags = { ...loadWorkerFlags(), ...options.workers };
    const queueNames = options.queueNames ?? loadQueueNames();

    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot({ ...mikroOrmConfig, ...options.orm })],
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        {
          provide: Metrics,
          // Outbox lag: lido do banco a cada coleta do /metrics.
          useFactory: (orm: CoreMikroORM) =>
            new Metrics(async () => {
              const [row] = await asPostgres(orm)
                .em.fork()
                .execute(
                  `SELECT count(*)::int AS pending,
                          COALESCE(EXTRACT(EPOCH FROM now() - min(occurred_at)), 0)::float8 AS age
                     FROM outbox_messages WHERE published_at IS NULL`,
                );
              return { pending: row!.pending, oldestPendingAgeSeconds: row!.age };
            }),
          inject: [CoreMikroORM],
        },
        {
          provide: TRANSACTION_RUNNER,
          useFactory: (orm: CoreMikroORM, metrics: Metrics) =>
            new MikroOrmTransactionRunner(asPostgres(orm), (type) => metrics.lockConflicts.inc({ type })),
          inject: [CoreMikroORM, Metrics],
        },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(loadSqsConfig()) },
        { provide: QUEUE_NAMES, useValue: queueNames },
        { provide: CreateWallet, useFactory: (runner: TransactionRunner) => new CreateWallet(runner), inject: [TRANSACTION_RUNNER] },
        {
          // Controller e consumidor recebem a versão com log e métricas (mesma interface).
          provide: ProcessWagerTransaction,
          useFactory: (runner: TransactionRunner, metrics: Metrics) =>
            new ObservedProcessWagerTransaction(runner, pendingReferencePolicy, metrics),
          inject: [TRANSACTION_RUNNER, Metrics],
        },
        { provide: WalletQueries, useFactory: (runner: TransactionRunner) => new WalletQueries(runner), inject: [TRANSACTION_RUNNER] },
        {
          provide: ReconcileWallet,
          // Divergência: log de alerta + métrica (seção 9: nunca corrigir em silêncio).
          useFactory: (runner: TransactionRunner, metrics: Metrics) => {
            const logger = new Logger('Reconciliation');
            return new ReconcileWallet(runner, (result) => {
              metrics.reconciliationDivergences.inc();
              logger.warn({
                event: 'reconciliation_divergence',
                walletId: result.walletId,
                difference: result.difference,
                checkedEntries: result.checkedEntries,
              });
            });
          },
          inject: [TRANSACTION_RUNNER, Metrics],
        },
        {
          provide: RetryPendingReferences,
          useFactory: (runner: TransactionRunner) =>
            new RetryPendingReferences(runner, pendingReferencePolicy, pendingReferenceConfig.batchSize),
          inject: [TRANSACTION_RUNNER],
        },
        {
          provide: BackgroundWorkers,
          useFactory: (
            runner: TransactionRunner,
            sqs: SQSClient,
            processWagerTransaction: ProcessWagerTransaction,
            retryPendingReferences: RetryPendingReferences,
            metrics: Metrics,
          ) =>
            new BackgroundWorkers({
              flags: workerFlags,
              sqs,
              queueNames,
              consumerConfig: { ...loadConsumerConfig(), ...options.consumer },
              outboxConfig: { ...loadOutboxPublisherConfig(), ...options.outbox },
              pendingReferenceConfig,
              runner,
              processWagerTransaction,
              retryPendingReferences,
              metrics,
            }),
          inject: [TRANSACTION_RUNNER, SQS_CLIENT, ProcessWagerTransaction, RetryPendingReferences, Metrics],
        },
        AuthGuard,
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}
