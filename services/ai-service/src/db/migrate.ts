import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { createMigrationClient } from './client.js';
import { MIGRATIONS_CONFIG, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from './migrations-config.js';

// Run with: pnpm --filter @edc/ai-service db:migrate
async function main() {
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
  console.error('Migration failed:', err);
  process.exit(1);
});
