import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Standalone of `src/config/env.ts` on purpose: drizzle-kit loads this file with
// its own (CJS/esbuild-register) loader, which can't follow the `.js`-extension
// imports the app code uses — and we don't want the app's `process.exit`-on-bad-
// env behaviour in a CLI tool. Just the one var drizzle-kit needs.
loadDotenv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set (see .env.example) to run drizzle-kit.');
}

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: databaseUrl },
  // Migration ledger in `public`, NOT drizzle-kit's `drizzle` default, so
  // "drop schema public" means the same thing here as in the fleet's
  // Payload-based products (which keep `payload_migrations` in `public`).
  //
  // ⚠ These two literals are duplicated from `src/db/migrations-config.ts`,
  // which is the source of truth and carries the ROLLOUT NOTE — read it before
  // deploying this to a database that already has data. They are duplicated
  // because drizzle-kit loads this file with its own CJS/esbuild-register
  // loader, which cannot follow the app's `.js`-extension imports. A test
  // (`src/db/migrations-config.test.ts`) fails if the two ever drift.
  migrations: { schema: 'public', table: '__drizzle_migrations' },
  // pgvector lives outside Drizzle's introspection; the extension is created by an
  // explicit SQL migration (drizzle/0000_*.sql).
  verbose: true,
  strict: true,
});
