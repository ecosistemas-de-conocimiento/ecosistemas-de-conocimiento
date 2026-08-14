// Vitest setup for the integration suite (vitest.integration.config.ts).
//
// Responsibilities:
//   1. Pick TEST_DATABASE_URL / TEST_REDIS_URL out of env (with fallbacks
//      that match the root docker-compose.yml) and rebind DATABASE_URL / REDIS_URL
//      onto `process.env` BEFORE any module that touches `env.ts` imports.
//   2. Assert Postgres reachability — open a one-shot connection, throw a
//      clear message if it fails (so `vitest` prints "is docker compose up?"
//      instead of a cryptic stack).
//   3. Run drizzle migrations against the test DB. Idempotent: drizzle skips
//      already-applied SQL files based on the `_journal` it stores.
//   4. Export a `truncateAll(db)` helper that wipes the seven core tables in
//      the right FK order, and wire it into `beforeEach` so every integration
//      test starts on a clean slate.
//
// NOT in scope: RAG tables (corpora / documents / chunks) — those land in M4
// and aren't migrated against by this suite yet.

import { beforeAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://ai_service:ai_service@localhost:55432/ai_service';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:56379';

// Expose to the app's env loader BEFORE any code reads it. `src/config/env.ts`
// validates `process.env` once at module-import time, so this MUST run before
// `src/db/client.ts`, `src/server.ts`, etc. are dynamically imported below.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL = TEST_REDIS_URL;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';

// Reachability probe — short timeouts so a missing docker-compose surfaces
// quickly with an actionable error instead of a 30 s vitest hang.
async function assertPostgresReachable(url: string): Promise<void> {
  const client = postgres(url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
  });
  try {
    await client`select 1`;
  } catch (err) {
    throw new Error(
      `Integration setup: cannot reach Postgres at ${url}. ` +
        `Run \`pnpm infra:up\` at the repo root (and \`pnpm --filter @edc/ai-service db:migrate\` once) then retry. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function runMigrations(url: string): Promise<void> {
  // Import lazily — drizzle-orm/postgres-js loads pg parsers eagerly.
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const { MIGRATIONS_CONFIG } = await import('../db/migrations-config.js');
  const client = postgres(url, { max: 1 });
  try {
    const db = drizzle(client);
    // Same ledger location as production (`public`, not `drizzle`) so the
    // integration DB is shaped like a deployed one.
    await migrate(db, { migrationsFolder: './drizzle', ...MIGRATIONS_CONFIG });
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

// Run once per vitest worker process. `setupFiles` are re-executed per worker,
// not per test file, so this is the right hook for setup that's expensive but
// idempotent.
beforeAll(async () => {
  await assertPostgresReachable(TEST_DATABASE_URL);
  await runMigrations(TEST_DATABASE_URL);
});

// Per-test wipe. We import the shared `db` lazily so the migration above has
// definitively written the schema before any client connects.
beforeEach(async () => {
  const { db } = await import('../db/client.js');
  await truncateAll(db);
});

/**
 * Truncate the seven core tables in one statement. `RESTART IDENTITY` resets
 * any sequences (none of our PKs are serial today, but cheap insurance);
 * `CASCADE` walks FKs so we don't have to maintain a hand-ordered list as the
 * schema evolves.
 *
 * RAG tables (corpora / documents / chunks) intentionally absent — they land
 * in M4 and integration tests for them will extend this list at that point.
 */
export async function truncateAll(db: {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      generation_jobs,
      generation_requests,
      traces,
      usage_logs,
      registry_audit,
      registry_entries,
      project_configs,
      budget_state,
      llm_configs
    RESTART IDENTITY CASCADE
  `);
}

export const TEST_URLS = {
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: TEST_REDIS_URL,
};
