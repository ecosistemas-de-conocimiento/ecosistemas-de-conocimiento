// Vitest setup for the integration suite (vitest.integration.config.ts).
//
// This file runs INSIDE each worker, once per worker process. Everything that
// must happen once per RUN — provisioning, the throwaway guard, the ownership
// guard, migrations, the schema stamp and the once-per-run fixture wipe — lives
// in `integration-global-setup.ts` and `integration-database.ts`, because
// `globalSetup` runs before any worker forks and `setupFiles` do not.
//
// What is left here:
//   0. REFUSE to run unless the resolved target is unmistakably a test database
//      (name ends in `_test`) — before opening any connection. Cheap, and it
//      re-checks rather than trusting that globalSetup ran. See
//      `test-database-guard.ts` for why this is not optional.
//   1. Rebind DATABASE_URL / REDIS_URL onto `process.env` BEFORE any module
//      that touches `env.ts` imports. `globalSetup` has already populated
//      TEST_DATABASE_URL / TEST_REDIS_URL, either from the caller or from the
//      throwaway containers it started.
//   2. Assert Postgres reachability — open a one-shot connection and throw a
//      clear message if it fails, so vitest prints something actionable
//      instead of a cryptic stack from the first query.
//   3. Wire the PER-TEST wipe (`truncateAll`) into `beforeEach`, so every test
//      starts on a clean core.
//
// 🔴 THE PER-TEST WIPE IS AI-SERVICE'S OWN AND IS STRONGER THAN THE FLEET
// REFERENCE'S ONCE-PER-RUN WIPE. It is kept. What changed is only WHERE the
// table list is written: it now lives in the registry in
// `integration-database.ts`, beside the database this suite owns, so a reviewer
// sees "which tables does this suite start empty" in one screen instead of
// discovering it in a hook. The tables the per-test wipe cannot cheaply cover —
// `corpora`, `documents`, `ingest_requests`, `callback_deliveries`, which RAG
// fixtures seed in `beforeAll` — are emptied once per run by the same registry
// entry. Before that, nothing emptied them at all and they accumulated forever
// on any long-lived test database.

import { beforeAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { INTEGRATION_DATABASES, assertSafeTableNames } from './integration-database.js';
import { assertTestDatabase } from './test-database-guard.js';

// ── Where the URLs come from ───────────────────────────────────────────────
//
// There is NO hardcoded host:port default, and that is the whole point.
//
// The old code fell back to `localhost:55432` (Postgres) and `localhost:56379`
// (Redis) to match `docker-compose.yml`. Those are plain numbers on a shared
// workstation, and another product's LIVE database can hold them. The fallback
// URL named database `ai_service_test`, which satisfies the name guard, so the
// suite could run migrations and `TRUNCATE ... CASCADE` against a stranger's
// server.
//
// A default that reaches a server this suite did not start is unsafe no matter
// which number it names, so there is no such default. `globalSetup` resolves a
// database or throws; by the time this module runs, the variables are populated.

const SPEC = INTEGRATION_DATABASES.integration!;

function requireUrl(name: 'TEST_DATABASE_URL' | 'TEST_REDIS_URL'): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  throw new Error(
    `Integration setup: ${name} is not set.\n\n` +
      'It is normally provisioned by `globalSetup` ' +
      '(src/test/integration-global-setup.ts), which starts a throwaway ' +
      'container on a Docker-allocated port or provisions a separate database ' +
      'on the cluster DATABASE_URL names. Seeing this means globalSetup ' +
      'did not run — check `globalSetup` in vitest.integration.config.ts.\n\n' +
      'There is deliberately NO host:port fallback: on this fleet, port 55432 ' +
      "has been observed holding an unrelated product's LIVE Postgres, and " +
      '56379 is the live fleet Redis. Guessing a port risks migrating and ' +
      "truncating somebody else's database.",
  );
}

const TEST_DATABASE_URL = requireUrl('TEST_DATABASE_URL');
const TEST_REDIS_URL = requireUrl('TEST_REDIS_URL');

// GUARD (name) — runs before `assertPostgresReachable` opens a socket and long
// before `truncateAll` runs. Refusing here means refusing without ever
// connecting to, or modifying, the database it rejected. Deliberately repeated
// from globalSetup rather than assumed: a setup file that trusts an earlier
// phase is one refactor away from being the only thing standing.
assertTestDatabase(TEST_DATABASE_URL, 'integration test setup (TEST_DATABASE_URL)');

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
        `Run \`npm run db:up\` (and \`npm run db:migrate\` once) then retry. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

// Run once per vitest worker process. `setupFiles` are re-executed per worker,
// not per test file, so this is the right hook for setup that's expensive but
// idempotent. Migrations are NOT here any more — `globalSetup` ran them once,
// before this process existed, behind the staleness check.
beforeAll(async () => {
  await assertPostgresReachable(TEST_DATABASE_URL);
});

// Per-test wipe. We import the shared `db` lazily so the migration in
// globalSetup has definitively written the schema before any client connects.
beforeEach(async () => {
  const { db } = await import('../db/client.js');
  await truncateAll(db);
});

/**
 * Truncate this suite's per-test tables in one statement. `RESTART IDENTITY`
 * resets any sequences (none of our PKs are serial today, but cheap insurance);
 * `CASCADE` walks FKs so we don't have to maintain a hand-ordered list as the
 * schema evolves.
 *
 * The list comes from `INTEGRATION_DATABASES.integration.truncateEachTest` —
 * one registry entry that also declares the database this suite owns and the
 * tables it empties once per run. Keeping the two lists side by side is what
 * made it visible that the RAG tables were in NEITHER of them.
 *
 * GUARDED. This helper wipes nine tables, so it re-checks the target itself
 * rather than trusting that whoever called it came through the bootstrap above.
 * Any future caller — a new setup file, a script, a one-off repro — inherits
 * the protection for free.
 */
export async function truncateAll(db: {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<void> {
  assertTestDatabase(process.env.DATABASE_URL, 'truncateAll()');
  const tables = SPEC.truncateEachTest ?? [];
  if (tables.length === 0) return;
  assertSafeTableNames(tables);
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`),
  );
}

export const TEST_URLS = {
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: TEST_REDIS_URL,
};
