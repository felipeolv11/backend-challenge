import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config';

// DECISÃO: script próprio para rodar as migrations (bun run migration:up / down / status).
// POR QUÊ: chama a API do Migrator direto (orm.migrator), roda igual no Windows e no Linux
//          e não depende de configurar a CLI do MikroORM para rodar dentro do Bun.
// ALTERNATIVA: CLI oficial (`mikro-orm migration:up`) — não usei porque ela precisa de
//              configuração extra para achar o arquivo de config e rodar TypeScript no Bun.

const command = process.argv[2];
const orm = await MikroORM.init(config);

try {
  if (command === 'up') {
    const applied = await orm.migrator.up();
    console.log(`Applied ${applied.length} migration(s):`, applied.map((m) => m.name));
  } else if (command === 'down') {
    // Desfaz só a última migration, para não apagar o schema inteiro por engano.
    const reverted = await orm.migrator.down();
    console.log(`Reverted ${reverted.length} migration(s):`, reverted.map((m) => m.name));
  } else if (command === 'status') {
    const executed = await orm.migrator.getExecuted();
    const pending = await orm.migrator.getPending();
    console.log('Executed:', executed.map((m) => m.name));
    console.log('Pending:', pending.map((m) => m.name));
  } else {
    console.error('Usage: bun run src/infrastructure/database/migrate.ts <up|down|status>');
    process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
