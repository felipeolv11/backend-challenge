import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import type { MikroORM, Options } from '@mikro-orm/postgresql';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
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
import { createSqsClient } from './infrastructure/sqs/sqs-client';
import { BackgroundWorkers, type WorkerFlags } from './infrastructure/workers/background-workers';
import { AuthGuard } from './http/auth.guard';
import { HttpErrorFilter } from './http/error-filter';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');
export const SQS_CLIENT = Symbol('SQS_CLIENT');

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

// Os casos de uso são classes TypeScript comuns (sem decorators do NestJS): o NestJS só monta
// as dependências aqui, com factories. Assim a application não depende do framework.
@Module({})
export class AppModule {
  static register(options: AppOptions = {}): DynamicModule {
    const pendingReferenceConfig = { ...loadPendingReferenceConfig(), ...options.pendingReference };
    const pendingReferencePolicy = new PendingReferencePolicy(pendingReferenceConfig);
    const workerFlags: WorkerFlags = { ...loadWorkerFlags(), ...options.workers };

    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot({ ...mikroOrmConfig, ...options.orm })],
      controllers: [WalletsController, WageringController],
      providers: [
        {
          provide: TRANSACTION_RUNNER,
          // O @mikro-orm/nestjs registra a instância com o token do pacote core; em runtime ela
          // é a versão do PostgreSQL (definida pelo defineConfig do pacote postgresql).
          useFactory: (orm: CoreMikroORM) => new MikroOrmTransactionRunner(orm as unknown as MikroORM),
          inject: [CoreMikroORM],
        },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(loadSqsConfig()) },
        { provide: CreateWallet, useFactory: (runner: TransactionRunner) => new CreateWallet(runner), inject: [TRANSACTION_RUNNER] },
        {
          provide: ProcessWagerTransaction,
          useFactory: (runner: TransactionRunner) => new ProcessWagerTransaction(runner, pendingReferencePolicy),
          inject: [TRANSACTION_RUNNER],
        },
        { provide: WalletQueries, useFactory: (runner: TransactionRunner) => new WalletQueries(runner), inject: [TRANSACTION_RUNNER] },
        {
          provide: ReconcileWallet,
          // O listener de divergência ganha log estruturado e métrica na etapa de observabilidade.
          useFactory: (runner: TransactionRunner) => new ReconcileWallet(runner),
          inject: [TRANSACTION_RUNNER],
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
          ) =>
            new BackgroundWorkers({
              flags: workerFlags,
              sqs,
              queueNames: options.queueNames ?? loadQueueNames(),
              consumerConfig: { ...loadConsumerConfig(), ...options.consumer },
              outboxConfig: { ...loadOutboxPublisherConfig(), ...options.outbox },
              pendingReferenceConfig,
              runner,
              processWagerTransaction,
              retryPendingReferences,
            }),
          inject: [TRANSACTION_RUNNER, SQS_CLIENT, ProcessWagerTransaction, RetryPendingReferences],
        },
        AuthGuard,
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}
