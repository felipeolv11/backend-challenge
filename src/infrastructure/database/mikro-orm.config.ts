import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { allEntities } from './entities';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  // Melhor falhar logo na subida do que conectar num banco errado sem perceber.
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');
}

const migrationsPath = './src/infrastructure/database/migrations';

export default defineConfig({
  clientUrl: databaseUrl,
  entities: allEntities,
  extensions: [Migrator],
  migrations: {
    tableName: 'mikro_orm_migrations',
    // O Bun roda TypeScript direto, então o caminho "compilado" e o "TS" são o mesmo.
    path: migrationsPath,
    pathTs: migrationsPath,
    // Cada migration roda dentro de uma transação: se falhar no meio, nada fica pela metade.
    transactional: true,
    // As migrations são escritas à mão em SQL; o snapshot automático só serve para gerá-las.
    snapshot: false,
    snapshotOnMigrate: false,
  },
});
