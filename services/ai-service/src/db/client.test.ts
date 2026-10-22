// Unit tests for the postgres.js options `src/db/client.ts` passes, and for the
// migration client's DATABASE_URL_DIRECT fallback. `postgres` is mocked to
// record its (url, options) calls, so nothing connects.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ url: string; opts: Record<string, unknown> }> = [];
vi.mock('postgres', () => ({
  default: (url: string, opts: Record<string, unknown>) => {
    calls.push({ url, opts });
    // drizzle reads `options.parsers` / `serializers` at construction.
    return { options: { parsers: {}, serializers: {} }, end: async () => undefined };
  },
}));

const POOLED = 'postgres://u:p@pgbouncer:6432/db';
const DIRECT = 'postgres://u:p@postgres:5432/db';

describe('db client', () => {
  let savedDirect: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    calls.length = 0;
    savedDirect = process.env.DATABASE_URL_DIRECT;
    delete process.env.DATABASE_URL_DIRECT;
    vi.stubEnv('DATABASE_URL', POOLED);
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('API_KEYS', '{}');
    vi.stubEnv('LOG_LEVEL', 'silent');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (savedDirect === undefined) delete process.env.DATABASE_URL_DIRECT;
    else process.env.DATABASE_URL_DIRECT = savedDirect;
  });

  it('app pool disables named prepared statements (PgBouncer transaction mode)', async () => {
    await import('./client.js');
    expect(calls[0]?.url).toBe(POOLED);
    expect(calls[0]?.opts.prepare).toBe(false);
  });

  // The crash fix. With `fetch_types` on, postgres.js starts an unhandled
  // internal query on every new connection, and a pooler FATAL on it kills
  // the process. The behaviour is proven against a real driver in
  // `pooler-login-failure.integration.test.ts`; this pins the option.
  it('app pool and migration client disable fetch_types (pooler FATAL crash)', async () => {
    const { createMigrationClient } = await import('./client.js');
    createMigrationClient();
    expect(calls[0]?.opts.fetch_types).toBe(false);
    expect(calls.at(-1)?.opts.fetch_types).toBe(false);
  });

  it('migration client falls back to DATABASE_URL when DATABASE_URL_DIRECT is unset', async () => {
    const { createMigrationClient } = await import('./client.js');
    createMigrationClient();
    const mig = calls.at(-1)!;
    expect(mig.url).toBe(POOLED);
    expect(mig.opts).toMatchObject({ max: 1, prepare: false });
  });

  it('migration client prefers DATABASE_URL_DIRECT; the app pool does not', async () => {
    vi.stubEnv('DATABASE_URL_DIRECT', DIRECT);
    const { createMigrationClient } = await import('./client.js');
    createMigrationClient();
    expect(calls[0]?.url).toBe(POOLED);
    expect(calls.at(-1)?.url).toBe(DIRECT);
  });
});
