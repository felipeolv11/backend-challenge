import { MikroORM } from '@mikro-orm/postgresql';
import baseConfig from '../../src/infrastructure/database/mikro-orm.config';

// DECISÃO: testes de integração usam o MESMO Postgres do docker-compose, mas num banco separado
//          (wagering_test), criado automaticamente e recriado do zero (migrations) a cada arquivo.
// POR QUÊ: banco real como o enunciado exige (seção 13), sem sujar o banco de desenvolvimento
//          e sem nenhuma dependência nova.
// ALTERNATIVA: Testcontainers (um container novo por execução) — não usei porque adiciona uma
//              dependência, deixa a inicialização mais lenta e tem mais pontos de falha no
//              Windows com Bun.
export const TEST_DATABASE_NAME = 'wagering_test';

export function testDatabaseUrl(): string {
  return databaseUrl(TEST_DATABASE_NAME);
}

function databaseUrl(databaseName: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function ensureTestDatabaseExists(): Promise<void> {
  // Conecta no banco administrativo "postgres" só para criar o banco de teste, se faltar.
  const admin = await MikroORM.init({ ...baseConfig, clientUrl: databaseUrl('postgres') });
  try {
    const existing = await admin.em.execute('SELECT 1 FROM pg_database WHERE datname = ?', [TEST_DATABASE_NAME]);
    if (existing.length === 0) {
      await admin.em.execute(`CREATE DATABASE ${TEST_DATABASE_NAME}`);
    }
  } finally {
    await admin.close(true);
  }
}

/**
 * Devolve um MikroORM conectado ao banco de teste com o schema recriado do zero.
 * DROP SCHEMA ... CASCADE apaga tudo, inclusive o ledger (os triggers de imutabilidade valem
 * para UPDATE/DELETE/TRUNCATE de linhas, não para remover a tabela inteira).
 */
export async function createTestOrm(): Promise<MikroORM> {
  await ensureTestDatabaseExists();
  const orm = await MikroORM.init({ ...baseConfig, clientUrl: databaseUrl(TEST_DATABASE_NAME) });
  await orm.em.execute('DROP SCHEMA public CASCADE');
  await orm.em.execute('CREATE SCHEMA public');
  await orm.migrator.up();
  return orm;
}
