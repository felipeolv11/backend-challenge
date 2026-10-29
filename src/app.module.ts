import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import type { MikroORM, Options } from '@mikro-orm/postgresql';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CreateWallet } from './application/create-wallet';
import type { TransactionRunner } from './application/ports';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import { ReconcileWallet } from './application/reconcile-wallet';
import { WalletQueries } from './application/wallet-queries';
import mikroOrmConfig from './infrastructure/database/mikro-orm.config';
import { MikroOrmTransactionRunner } from './infrastructure/database/mikro-orm-transaction-runner';
import { AuthGuard } from './http/auth.guard';
import { HttpErrorFilter } from './http/error-filter';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');

// Os casos de uso são classes TypeScript comuns (sem decorators do NestJS): o NestJS só monta
// as dependências aqui, com factories. Assim a application não depende do framework.
@Module({})
export class AppModule {
  /** `ormOverrides` permite aos testes apontar para outro banco (ex.: wagering_test). */
  static register(ormOverrides: Partial<Options> = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot({ ...mikroOrmConfig, ...ormOverrides })],
      controllers: [WalletsController, WageringController],
      providers: [
        {
          provide: TRANSACTION_RUNNER,
          // O @mikro-orm/nestjs registra a instância com o token do pacote core; em runtime ela
          // é a versão do PostgreSQL (definida pelo defineConfig do pacote postgresql).
          useFactory: (orm: CoreMikroORM) => new MikroOrmTransactionRunner(orm as unknown as MikroORM),
          inject: [CoreMikroORM],
        },
        { provide: CreateWallet, useFactory: (runner: TransactionRunner) => new CreateWallet(runner), inject: [TRANSACTION_RUNNER] },
        {
          provide: ProcessWagerTransaction,
          useFactory: (runner: TransactionRunner) => new ProcessWagerTransaction(runner),
          inject: [TRANSACTION_RUNNER],
        },
        { provide: WalletQueries, useFactory: (runner: TransactionRunner) => new WalletQueries(runner), inject: [TRANSACTION_RUNNER] },
        {
          provide: ReconcileWallet,
          // O listener de divergência ganha log estruturado e métrica na etapa de observabilidade.
          useFactory: (runner: TransactionRunner) => new ReconcileWallet(runner),
          inject: [TRANSACTION_RUNNER],
        },
        AuthGuard,
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}
