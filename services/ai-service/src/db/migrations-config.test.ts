// Drift guard for the migration-ledger location.
//
// The ledger schema is declared in TWO places that cannot import each other:
//   - `src/db/migrations-config.ts` — the runtime migrator (what actually runs
//     on deploy, via `dist/db/migrate.js` in the image CMD).
//   - `drizzle.config.ts` — drizzle-kit's CLI (`drizzle-kit migrate` / `up`).
// drizzle-kit loads its config with a CJS/esbuild-register loader that can't
// follow the app's `.js`-extension imports, so the literals are duplicated.
//
// If they drift, the CLI and the runtime write to DIFFERENT ledgers, and one of
// them will re-apply the non-idempotent `0000_baseline.sql` against a populated
// database. These tests fail instead. They read the config as TEXT on purpose —
// importing it would execute drizzle-kit's loader and require a live
// DATABASE_URL.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS_CONFIG, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from './migrations-config.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

describe('migration ledger location', () => {
  it('is `public`, matching the repo-wide "drop schema public" invariant', () => {
    // Payload-based products keep `payload_migrations` in `public`. Drizzle
    // defaults to a separate `drizzle` schema, which survives
    // `DROP SCHEMA public CASCADE` and leaves the DB believing it is migrated.
    expect(MIGRATIONS_SCHEMA).toBe('public');
    expect(MIGRATIONS_SCHEMA).not.toBe('drizzle');
    expect(MIGRATIONS_CONFIG).toEqual({
      migrationsTable: MIGRATIONS_TABLE,
      migrationsSchema: MIGRATIONS_SCHEMA,
    });
  });

  it('drizzle.config.ts declares the SAME schema and table as the runtime migrator', () => {
    const config = read('drizzle.config.ts');
    const block = /migrations:\s*\{([^}]*)\}/.exec(config);
    expect(block, 'drizzle.config.ts must declare a `migrations: { ... }` block').not.toBeNull();

    const schema = /schema:\s*['"]([^'"]+)['"]/.exec(block![1]!);
    const table = /table:\s*['"]([^'"]+)['"]/.exec(block![1]!);
    expect(schema?.[1]).toBe(MIGRATIONS_SCHEMA);
    expect(table?.[1]).toBe(MIGRATIONS_TABLE);
  });

  it('every runtime `migrate()` call passes the shared config', () => {
    // A new migrate() call site that forgets this would write to the `drizzle`
    // schema and silently re-run the baseline. Cheap to check, expensive to miss.
    for (const rel of ['src/db/migrate.ts', 'src/test/integration-setup.ts']) {
      const source = read(rel);
      expect(source, `${rel} calls migrate()`).toMatch(/migrate\(/);
      expect(source, `${rel} must spread MIGRATIONS_CONFIG`).toMatch(
        /\.\.\.MIGRATIONS_CONFIG/,
      );
    }
  });
});
