import 'reflect-metadata';
import type { Options } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { correlationIdMiddleware } from './http/correlation-id.middleware';

/** Monta a aplicação. Usado pelo main.ts e pelos testes de integração da API. */
export async function createApp(ormOverrides: Partial<Options> = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(ormOverrides), { logger: ['error', 'warn', 'log'] });
  app.use(correlationIdMiddleware);
  // Repassa SIGTERM/SIGINT para os hooks de desligamento (fecha conexões com o banco etc.).
  app.enableShutdownHooks();
  return app;
}
