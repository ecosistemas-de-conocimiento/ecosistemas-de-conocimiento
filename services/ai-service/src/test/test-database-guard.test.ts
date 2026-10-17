// Regression tests for the destructive-operation database guard.
//
// This guard exists because a hardcoded connection-string fallback once let
// `npm run test:integration` truncate a live database. These tests
// are the reason it cannot silently regress: if someone widens the predicate or
// drops the check, one of these fails.
//
// Zero-dependency by design — part of the `npm test` suite, no DB required.

import { describe, expect, it } from 'vitest';

import {
  assertOnlyKnownTables,
  assertTestDatabase,
  KNOWN_TEST_TABLES,
  databaseNameFromUrl,
  isTestDatabaseUrl,
  redactUrl,
  TEST_DATABASE_SUFFIX,
} from './test-database-guard.js';

const LIVE_URL = 'postgres://ai_service:ai_service@localhost:55432/ai_service';
const TEST_URL = 'postgres://ai_service:ai_service@localhost:55432/ai_service_test';

describe('databaseNameFromUrl', () => {
  it('extracts the database name from a standard Postgres URL', () => {
    expect(databaseNameFromUrl(LIVE_URL)).toBe('ai_service');
    expect(databaseNameFromUrl(TEST_URL)).toBe('ai_service_test');
  });

  it('ignores query parameters', () => {
    expect(databaseNameFromUrl('postgres://h:5432/ai_service_test?sslmode=require')).toBe(
      'ai_service_test',
    );
  });

  it('handles the postgresql:// scheme and credential-free URLs', () => {
    expect(databaseNameFromUrl('postgresql://localhost:5432/ai_service_test')).toBe(
      'ai_service_test',
    );
  });

  it('returns null when there is no database path', () => {
    expect(databaseNameFromUrl('postgres://localhost:5432')).toBeNull();
    expect(databaseNameFromUrl('postgres://localhost:5432/')).toBeNull();
  });

  it('returns null for an unparseable URL rather than guessing', () => {
    expect(databaseNameFromUrl('not a url')).toBeNull();
    expect(databaseNameFromUrl('')).toBeNull();
  });
});

describe('isTestDatabaseUrl', () => {
  it('accepts a database whose name ends in the test suffix', () => {
    expect(isTestDatabaseUrl(TEST_URL)).toBe(true);
    expect(isTestDatabaseUrl('postgres://localhost:5432/anything_test')).toBe(true);
  });

  it('rejects the exact URL that caused the 2026-07-27 data loss', () => {
    expect(isTestDatabaseUrl(LIVE_URL)).toBe(false);
  });

  it('rejects a live-looking database on the test port', () => {
    // The port carries no meaning — only the name does.
    expect(isTestDatabaseUrl('postgres://u:p@localhost:55432/ai_service')).toBe(false);
  });

  it('rejects a name that merely contains "test" without ending in the suffix', () => {
    expect(isTestDatabaseUrl('postgres://localhost:5432/test_ai_service')).toBe(false);
    expect(isTestDatabaseUrl('postgres://localhost:5432/ai_service_testing')).toBe(false);
    expect(isTestDatabaseUrl('postgres://localhost:5432/ai_service-test')).toBe(false);
  });

  it('fails closed on an unparseable URL', () => {
    expect(isTestDatabaseUrl('garbage')).toBe(false);
  });

  it('uses an underscore-prefixed suffix so it cannot match a bare prod name', () => {
    expect(TEST_DATABASE_SUFFIX).toBe('_test');
  });
});

describe('redactUrl', () => {
  it('removes the password', () => {
    const out = redactUrl(LIVE_URL);
    expect(out).not.toContain('ai_service:ai_service@');
    expect(out).toContain('***');
    expect(out).toContain('ai_service');
  });

  it('never echoes an unparseable URL back (could be a credential)', () => {
    expect(redactUrl('garbage')).toBe('<unparseable connection URL>');
  });
});

describe('assertTestDatabase', () => {
  it('passes for a test database', () => {
    expect(() => assertTestDatabase(TEST_URL, 'unit test')).not.toThrow();
  });

  it('throws for the live database URL from the incident', () => {
    expect(() => assertTestDatabase(LIVE_URL, 'truncateAll()')).toThrow(/REFUSED/);
  });

  it('names the refused database and the calling context in the message', () => {
    let message = '';
    try {
      assertTestDatabase(LIVE_URL, 'truncateAll()');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // Actionable: says what was refused, which DB, and how to fix it.
    expect(message).toContain('truncateAll()');
    expect(message).toContain('"ai_service"');
    expect(message).toContain(TEST_DATABASE_SUFFIX);
    expect(message).toContain('TEST_DATABASE_URL');
    expect(message).toContain('nothing was connected to or modified');
  });

  it('does not leak the password in the refusal message', () => {
    let message = '';
    try {
      assertTestDatabase('postgres://user:hunter2@localhost:5432/ai_service', 'migrations');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain('hunter2');
    expect(message).toContain('***');
  });

  it('throws when the URL is undefined rather than defaulting to anything', () => {
    expect(() => assertTestDatabase(undefined, 'truncateAll()')).toThrow(/REFUSED/);
    expect(() => assertTestDatabase('', 'truncateAll()')).toThrow(/REFUSED/);
  });

  it('throws for an unparseable URL', () => {
    expect(() => assertTestDatabase('not-a-url', 'migrations')).toThrow(/REFUSED/);
  });
});

// ---------------------------------------------------------------------------
// Ownership guard — the half the NAME check cannot do.
//
// The database name travels in the connection string we wrote; it proves
// nothing about which server answered. Once an unrelated product's
// live Postgres was found on host port 55432 — the port the
// integration suite defaulted to — where a URL naming `ai_service_test` would
// have passed `assertTestDatabase` and truncated it. The table list comes back
// FROM the server, so it can tell the two apart.
// ---------------------------------------------------------------------------

describe('assertOnlyKnownTables', () => {
  const OURS = [
    '__drizzle_migrations',
    'generation_jobs',
    'generation_requests',
    'traces',
    'usage_logs',
    'budget_state',
    'corpora',
    'chunks',
  ];

  it('passes for a database holding only ai-service tables', () => {
    expect(() => assertOnlyKnownTables(OURS, TEST_URL, 'setup')).not.toThrow();
  });

  it('passes for a brand-new EMPTY database', () => {
    // The normal path: a freshly started throwaway container has no tables
    // yet, and migrations are about to create them.
    expect(() => assertOnlyKnownTables([], TEST_URL, 'setup')).not.toThrow();
  });

  it('REFUSES a foreign database even when the URL names a _test database', () => {
    // The exact near-miss: right name, wrong server.
    const foreign = ['users', 'sessions', 'documentos', 'organizaciones'];
    expect(() => assertOnlyKnownTables(foreign, TEST_URL, 'setup')).toThrow(/REFUSED/);
  });

  it('refuses when even ONE foreign table is present among ours', () => {
    expect(() => assertOnlyKnownTables([...OURS, 'payload_migrations'], TEST_URL, 'setup')).toThrow(
      /REFUSED/,
    );
  });

  it('names the foreign tables so the refusal is actionable', () => {
    let msg = '';
    try {
      assertOnlyKnownTables([...OURS, 'edc_articles'], TEST_URL, 'setup');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('edc_articles');
    // and does NOT accuse our own tables
    expect(msg).not.toContain('generation_jobs');
  });

  it('redacts the password out of the refusal message', () => {
    let msg = '';
    try {
      assertOnlyKnownTables(['users'], 'postgres://u:hunter2@127.0.0.1:5432/x_test', 'setup');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain('hunter2');
    expect(msg).toContain('***');
  });

  it('every table in the live drizzle schema is registered as known', async () => {
    // Fails closed BY DESIGN: adding a `pgTable` without adding it to
    // KNOWN_TEST_TABLES makes the integration suite refuse to run. This test
    // turns that into a clear unit failure at the moment the table is added,
    // instead of a confusing setup refusal later.
    const schema = await import('../db/schema/index.js');
    const live = Object.values(schema)
      .map((v) => {
        const name = (v as unknown as Record<symbol, unknown>)[
          Symbol.for('drizzle:Name')
        ];
        return typeof name === 'string' ? name : null;
      })
      .filter((n): n is string => n !== null);

    expect(live.length).toBeGreaterThan(0);
    const unregistered = live.filter((t) => !KNOWN_TEST_TABLES.has(t)).sort();
    expect(unregistered).toEqual([]);
  });
});
