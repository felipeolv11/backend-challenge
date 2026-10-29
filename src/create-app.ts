import 'reflect-metadata';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, type AppOptions } from './app.module';
import { correlationIdMiddleware } from './http/correlation-id.middleware';

/** Monta a aplicação. Usado pelo main.ts e pelos testes de integração da API. */
export async function createApp(options: AppOptions = {}): Promise<INestApplication> {
  // DECISÃO: logs em JSON com o logger embutido do NestJS (ConsoleLogger com json: true).
  // POR QUÊ: zero dependência; todo `new Logger(...)` do código passa a sair como uma linha JSON,
  //          e objetos logados (ex.: { event, correlationId, walletId }) viram campos pesquisáveis.
  // ALTERNATIVA: pino + nestjs-pino — não usei porque são duas dependências para trocar o logger
  //              inteiro por uma performance que não precisamos aqui.
  const logger = new ConsoleLogger({ json: true, logLevels: ['error', 'warn', 'log'] });
  const app = await NestFactory.create(AppModule.register(options), { logger });
  app.use(correlationIdMiddleware);
  // Repassa SIGTERM/SIGINT para os hooks de desligamento (fecha conexões com o banco etc.).
  app.enableShutdownHooks();
  return app;
}
