import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { validateProductionReadiness } from '../config/env.js';
import { rootLogger } from '../logger.js';
import { MIGRATIONS_CONFIG, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from './migrations-config.js';

// Run with: pnpm --filter @edc/ai-service db:migrate
async function main() {
  // 🔴 The production guard runs FIRST, before any DB module is even loaded.
  //
  // `Dockerfile` runs `db:migrate:prod && exec node dist/index.js`, so the
  // migration is the first thing a deploy executes and `src/index.ts` — which
  // is where this probe used to be called for the first time — only runs
  // AFTERWARDS. Without this call a container carrying `CALLBACK_ALLOW_PRIVATE=1` (or any
  // other forbidden flag) applies the whole schema, THEN exits 1 from
  // `index.ts` into a Coolify restart loop: the deploy fails but the database
  // has already moved. Refusing here means a bad-flag deploy never touches the
  // schema.
  //
  // `./client.js` is imported dynamically, after the probe, so that the
  // module-level `postgres(env.DATABASE_URL)` pool in that file is never even
  // constructed on the refusal path.
  validateProductionReadiness();

  const { createMigrationClient } = await import('./client.js');
  const client = createMigrationClient();
  const db = drizzle(client);
  console.log(
    `Running migrations from ./drizzle (ledger: ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}) ...`,
  );
  // ⚠ The ledger lives in `public`, not drizzle's `drizzle` default. Read the
  // rollout note in `migrations-config.ts` BEFORE deploying this to an
  // environment that already has data.
  await migrate(db, { migrationsFolder: './drizzle', ...MIGRATIONS_CONFIG });
  console.log('Migrations complete.');
  await client.end();
}

main().catch((err) => {
  // A failed migration is a database error: its message can quote a row. The
  // logger's `err` serializer (`errors/log-safe.ts`) keeps its class and code.
  rootLogger.fatal({ err }, 'Migration failed');
  process.exit(1);
});
