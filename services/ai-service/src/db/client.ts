import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '../config/env.js';
import * as schema from './schema/index.js';

// Single shared connection pool for the service.
const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  // pgvector needs no special parser at the SQL level; we read/write vectors as text.
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
