import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '../config/env.js';
import * as schema from './schema/index.js';

// Single shared connection pool for the service.
const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
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
export function createMigrationClient() {
  return postgres(env.DATABASE_URL, { max: 1 });
}
