import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '../config/env.js';
import * as schema from './schema/index.js';

// 🔴 `fetch_types: false` IS A CRASH FIX, not a tuning knob. Every pool in
// this file passes it.
//
// postgres.js (3.4.9, the latest release on 2026-10-17) runs an internal
// "which array types exist" query as the first query on EVERY new connection
// when `fetch_types` is on (its default). It starts that query from
// `ReadyForQuery` as a fire-and-forget `async fetchArrayTypes()`
// (`node_modules/postgres/src/connection.js`), so if that query fails, the
// rejection has no handler and node exits.
//
// A direct Postgres connection never reaches that point when the database is
// down: the login itself fails, before `ReadyForQuery`. A pooler is
// different. PgBouncer completes the CLIENT login on its own, then fails the
// first query with `FATAL 08P01 server login has been failing`. That first
// query is the driver's type query, so the FATAL escapes as an unhandled
// rejection. MEASURED on dev 2026-10-17/18 (SECURITY_OPEN §49.2: 2 container
// restarts in one 18 s Postgres outage) and reproduced locally on 2026-10-18
// against `edoburu/pgbouncer:v1.26.0-p0` in transaction mode; the same repro
// with `fetch_types: false` survived. Regression test:
// `src/db/pooler-login-failure.integration.test.ts`.
//
// What `false` costs: the driver no longer learns the array OIDs, so a
// Postgres array RESULT column would arrive as its text form (`{a,b}`). The
// service reads no array columns (no `.array()` in the schema, no array
// results in raw SQL; checked 2026-10-18), and drizzle's own array columns
// parse the text form themselves. Array PARAMETERS are unaffected here: we
// pass none (see the json-param note in `workers/ingest.worker.ts`).
const POOL_SAFETY = { prepare: false, fetch_types: false } as const;

// Single shared connection pool for the service.
const queryClient = postgres(env.DATABASE_URL, {
  ...POOL_SAFETY,
  max: 10,
  // PgBouncer transaction-mode compatibility. postgres.js defaults to NAMED
  // prepared statements, which live on one server backend; behind a
  // transaction-mode pooler the next query can land on another backend and
  // fail with "prepared statement does not exist". `prepare: false` (in
  // POOL_SAFETY) sends unnamed statements (still parameterised, still the
  // extended protocol).
  // pgvector needs no special parser at the SQL level; we read/write vectors as text.
  // A transaction left
  // open while the service awaits something else (an HTTP call, a provider)
  // holds its connection and row locks until a restart. Postgres kills any
  // session idle inside a transaction for 30 s, freeing the connection.
  // Sent as a startup parameter. statement_timeout is deliberately NOT set: it
  // is pool-wide and would kill long migrations and backfills. The migration
  // client below does not get it either.
  connection: {
    idle_in_transaction_session_timeout: 30_000,
  },
  // Fail loudly instead of waiting forever for a connection (postgres.js: seconds).
  connect_timeout: 10,
});

export const db = drizzle(queryClient, { schema });
export type Db = typeof db;

export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}

// Convenience for migration scripts that want a one-shot connection.
// Prefers the DIRECT (non-pooled) URL when one is configured; unset falls back
// to `DATABASE_URL`. `prepare: false` too, so a deploy WITHOUT a direct URL can
// still migrate through a transaction-mode pooler. Migrations are one-shot, so
// the per-statement cost of unnamed statements is irrelevant here.
export function migrationDatabaseUrl(): string {
  return env.DATABASE_URL_DIRECT ?? env.DATABASE_URL;
}

export function createMigrationClient() {
  return postgres(migrationDatabaseUrl(), { ...POOL_SAFETY, max: 1 });
}

