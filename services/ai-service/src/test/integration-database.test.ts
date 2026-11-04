// GUARDS ON THE INTEGRATION-DATABASE MACHINERY ITSELF.
//
// These are pure-unit and open NO database, on purpose: they belong to the
// `npm test` suite, which runs with no Postgres, no Redis and no Docker. What
// they protect is the part of the integration setup that a reviewer cannot see
// by reading one file.
//
// 🔴 THE REGISTRY INVARIANTS ARE THE POINT. Two suites that share a database or
// an env var delete each other's fixtures mid-run — and the two entries sit far
// apart in the file, so git merges them WITHOUT A CONFLICT. A uniqueness assertion is the
// only thing that can see it.
//
// ⚠ With one suite in the registry several of these are vacuously true today.
// They are here so that suite number two is free rather than dangerous, and
// each one asserts it is looking at a non-empty set first.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { LiveSchemaRow, MigrationRecord, MigrationsManifest } from './integration-database.js';
import {
  EMPTY_SCHEMA_FINGERPRINT,
  INTEGRATION_DATABASES,
  MIGRATIONS_DIR,
  REPO_ROOT,
  THROWAWAY_DATABASE_NAME,
  assertSafeTableNames,
  assertThrowaway,
  compareManifests,
  databaseOf,
  fingerprintRows,
  journalPath,
  migrationsFingerprint,
  migrationsManifest,
  migrationsOnDisk,
  missingDatabaseMessage,
  plannedUrl,
  withDatabase,
} from './integration-database.js';
import { KNOWN_TEST_TABLES } from './test-database-guard.js';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from '../db/migrations-config.js';

// ── a fake drizzle/, so the fingerprint can be MUTATED and re-hashed ─────────
//
// 🔴 WHY A MOCK AND NOT A TEMP DIRECTORY. `migrationsFingerprint()` takes no
// directory argument — it is hardcoded to this repo's own `drizzle/`. The only
// two ways to hash a DIFFERENT set of bytes through the real exported function
// are to rewrite the repo's migrations mid-run, which would race every other
// test file that reads that directory, or to divert the reads. This diverts the
// reads, keyed by path RELATIVE to `drizzle/` so `meta/_journal.json` is part
// of the fake set and the journal fold can be proved by behaviour.
//
// The overlay is INERT unless `withFakeMigrations` is inside its callback, and
// every filesystem call outside `drizzle/` — `read()` above, the `walk('src')`
// scans below — reaches the real fs untouched.
const fake = vi.hoisted(() => ({ files: null as Record<string, string> | null }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const { fileURLToPath } = await import('node:url');
  const nodePath = await import('node:path');
  const DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

  /** The key `p` would have in the fake set, or null if it is outside drizzle/. */
  const keyOf = (p: unknown): string | null => {
    if (typeof p !== 'string') return null;
    const rel = nodePath.default.relative(DIR, p);
    if (rel === '' || rel.startsWith('..') || nodePath.default.isAbsolute(rel)) return null;
    return rel.split(nodePath.default.sep).join('/');
  };

  return {
    ...real,
    readdirSync: (p: unknown, options?: unknown) => {
      if (fake.files && options === undefined && String(p) === DIR)
        return Object.keys(fake.files)
          .filter((k) => !k.includes('/'))
          .sort();
      return (real.readdirSync as (...a: unknown[]) => unknown)(p, options);
    },
    readFileSync: (p: unknown, options?: unknown) => {
      const key = fake.files ? keyOf(p) : null;
      if (fake.files && key !== null) {
        const body = fake.files[key];
        if (body === undefined)
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${String(p)}'`), {
            code: 'ENOENT',
          });
        return options ? body : Buffer.from(body, 'utf8');
      }
      return (real.readFileSync as (...a: unknown[]) => unknown)(p, options);
    },
  };
});

/** Runs `fn` with `drizzle/` replaced by `files`, and always restores. */
function withFakeMigrations<T>(files: Record<string, string>, fn: () => T): T {
  const previous = fake.files;
  fake.files = files;
  try {
    return fn();
  } finally {
    fake.files = previous;
  }
}

const specs = Object.entries(INTEGRATION_DATABASES);
const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

describe('the registry describes a usable set', () => {
  it('is not empty — an empty registry would make every check below vacuous', () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  it('gives every suite its own database, and a name Postgres will not truncate', () => {
    const names = specs.map(([, s]) => s.database);
    expect(new Set(names).size, `duplicate database name in the registry: ${names}`).toBe(
      names.length,
    );
    for (const n of names) {
      // ⚠ Postgres truncates identifiers over 63 bytes SILENTLY, so two suites
      // differing only past byte 63 would share one database.
      expect(Buffer.byteLength(n), `"${n}" is over 63 bytes`).toBeLessThanOrEqual(63);
      expect(n, `"${n}" must end in _test — every destructive path checks it`).toMatch(/_test$/);
    }
  });

  it('gives every suite its own override variable', () => {
    const vars = specs.map(([, s]) => s.envVar);
    expect(new Set(vars).size, `duplicate envVar in the registry: ${vars}`).toBe(vars.length);
  });

  it('declares only table names that are safe to interpolate', () => {
    for (const [name, s] of specs) {
      const tables = [...(s.truncate ?? []), ...(s.truncateEachTest ?? [])];
      expect(tables.length, `${name} declares no tables at all`).toBeGreaterThan(0);
      expect(() => assertSafeTableNames(tables)).not.toThrow();
    }
  });

  it('🔴 never empties the migration ledger — that would make the schema look unbuilt', () => {
    for (const [name, s] of specs) {
      const tables = [...(s.truncate ?? []), ...(s.truncateEachTest ?? [])];
      expect(tables, `${name} truncates the drizzle ledger`).not.toContain('__drizzle_migrations');
    }
  });

  it('declares only tables the ownership guard already knows about', () => {
    // A table missing from KNOWN_TEST_TABLES makes `assertOnlyKnownTables`
    // refuse the whole run, so a truncate list may never name one.
    for (const [name, s] of specs) {
      for (const t of [...(s.truncate ?? []), ...(s.truncateEachTest ?? [])]) {
        expect(KNOWN_TEST_TABLES.has(t), `${name} truncates unknown table "${t}"`).toBe(true);
      }
    }
  });
});

describe('🔴 every table in the schema is accounted for', () => {
  // THIS IS THE TEST THAT FOUND THE GAP. Before the registry existed, the
  // per-test wipe covered nine tables and six — corpora, corpus_aliases,
  // documents, chunks, ingest_requests, callback_deliveries — were emptied by
  // nothing at all. `CASCADE` never reached them: none of them hangs off a
  // foreign key from the nine. On the docker path that is invisible, because
  // the container is new every run. On any long-lived test database the rows
  // accumulate forever, until a suite's own fresh row sorts past a `LIMIT 500`.

  /**
   * Tables emptied by `TRUNCATE ... CASCADE` from a table that IS declared.
   *
   * ⚠ Postgres's `TRUNCATE x CASCADE` empties every table holding a foreign key
   * REFERENCING `x`, regardless of the FK's `ON DELETE` action. Each entry below
   * names the reference that reaches it.
   */
  const CASCADE_COVERED: Record<string, string> = {
    // corpus_aliases.corpus_id -> corpora.id
    corpus_aliases: 'corpora',
    // chunks.document_id -> documents.id, chunks.corpus_id -> corpora.id
    chunks: 'documents',
  };

  /** The ledger. Emptying it would make the schema look unbuilt. */
  const NEVER_EMPTIED = new Set(['__drizzle_migrations']);

  it('leaves no table growing unbounded across runs', async () => {
    const schema = await import('../db/schema/index.js');
    const live = Object.values(schema)
      .map((v) => (v as unknown as Record<symbol, unknown>)[Symbol.for('drizzle:Name')])
      .filter((n): n is string => typeof n === 'string');

    expect(live.length, 'no pgTables found — this check would be vacuous').toBeGreaterThan(0);

    const declared = new Set(
      specs.flatMap(([, s]) => [...(s.truncate ?? []), ...(s.truncateEachTest ?? [])]),
    );
    const unaccounted = live
      .filter((t) => !declared.has(t))
      .filter((t) => !(t in CASCADE_COVERED))
      .filter((t) => !NEVER_EMPTIED.has(t))
      .sort();

    expect(
      unaccounted,
      'these tables are emptied by nothing: add them to a registry `truncate` list, ' +
        'or to CASCADE_COVERED above with the FK that reaches them',
    ).toEqual([]);
  });

  it('every CASCADE_COVERED table really hangs off a declared table', () => {
    const declared = new Set(
      specs.flatMap(([, s]) => [...(s.truncate ?? []), ...(s.truncateEachTest ?? [])]),
    );
    for (const [child, parent] of Object.entries(CASCADE_COVERED)) {
      expect(declared.has(parent), `${child} claims to cascade from undeclared "${parent}"`).toBe(
        true,
      );
    }
  });
});

describe('the throwaway guard refuses, rather than merely existing', () => {
  const spec = INTEGRATION_DATABASES.integration!;
  const base = 'postgres://ai_service:ai_service@127.0.0.1:55432/ai_service';

  it('🔴 refuses when the suite database IS the database DATABASE_URL names', () => {
    // ⚠ `ai_service` is now refused by the NAME allowlist first, which is why
    // this matches the shared prefix rather than one message.
    expect(() => assertThrowaway(spec, base, base)).toThrow(/REFUSING/);
  });

  it('🔴 …and still refuses it when the dev database has a throwaway-shaped name', () => {
    // The layer the allowlist cannot cover: a dev database someone named
    // `ai_service_shared_test`. Only the same-name-as-dev comparison sees that.
    const devLikeATest = withDatabase(base, 'ai_service_shared_test');
    expect(() => assertThrowaway(spec, devLikeATest, devLikeATest)).toThrow(
      /which is the database\nDATABASE_URL itself names/,
    );
  });

  // 🔴 A name that is merely NOT the dev database is not a name
  // this harness may destroy.
  it('🔴 refuses a database that is merely NOT the dev database', () => {
    expect(() => assertThrowaway(spec, withDatabase(base, 'precious_data'), base)).toThrow(
      /REFUSING TO TOUCH "precious_data"/,
    );
    // ⚠ A bare `_test` suffix is not enough — any product can
    // satisfy it, and `assertTestDatabase` is the check that only asks for that.
    expect(() => assertThrowaway(spec, withDatabase(base, 'edc_test'), base)).toThrow(
      /REFUSING TO TOUCH "edc_test"/,
    );
  });

  it('🔴 still refuses with NO base to compare against — no .env, no DATABASE_URL', () => {
    expect(() => assertThrowaway(spec, withDatabase(base, 'precious_data'), '')).toThrow(
      /REFUSING TO TOUCH/,
    );
    expect(() => assertThrowaway(spec, withDatabase(base, 'ai_service'), '')).toThrow(
      /REFUSING TO TOUCH/,
    );
  });

  it('refuses an unparseable connection URL rather than throwing a URL error', () => {
    expect(() => assertThrowaway(spec, 'not-a-url', '')).toThrow(/REFUSING TO TOUCH/);
  });

  it('🔴 has no environment variable that switches it off', () => {
    // Comments stripped first — the escape hatch is NAMED in the doc comment,
    // as the thing this repo deliberately did not copy from another client.
    const code = read('src/test/integration-database.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/ALLOW_UNKNOWN|allowUnknownName|SKIP_DB_GUARD|FORCE_DB/);
    expect(code).not.toMatch(/process\.env\[?\.?['"]?[A-Z_]*(ALLOW|SKIP|FORCE|UNSAFE|DANGER)/);
  });

  it('🔴 refuses a cluster-level database even with no dev config to compare against', () => {
    // `postgres` is where the admin connection lives; migrating it would break
    // every later CREATE DATABASE on the cluster.
    for (const db of ['postgres', 'template0', 'template1']) {
      expect(() => assertThrowaway(spec, withDatabase(base, db), '')).toThrow(/REFUSING TO RUN/);
    }
  });

  it('allows a genuinely separate database on the same cluster', () => {
    expect(() => assertThrowaway(spec, withDatabase(base, spec.database), base)).not.toThrow();
  });

  it('does not leak the password in its refusal', () => {
    let msg = '';
    try {
      assertThrowaway(spec, 'postgres://u:hunter2@h:5432/postgres', '');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain('hunter2');
    expect(msg).toContain('***');
  });
});

describe('the throwaway name allowlist', () => {
  it('accepts every database in the registry — otherwise no suite could run', () => {
    for (const [name, s] of specs) {
      expect(THROWAWAY_DATABASE_NAME.test(s.database), `${name}: ${s.database}`).toBe(true);
    }
  });

  it('🔴 refuses names that pass the bare `_test` suffix check', () => {
    for (const name of [
      'ai_service',
      'ai_service_dev',
      'edc_prod',
      'edc_test',
      'chat_access_test',
      'client_session_race_test',
      'postgres',
      'precious_data',
      '',
    ]) {
      expect(THROWAWAY_DATABASE_NAME.test(name), `allowlist accepted "${name}"`).toBe(false);
    }
  });

  it('🔴 accepts the database name CI creates in its service container', () => {
    // .github/workflows/test.yml boots a Postgres service with
    // POSTGRES_DB: ai_service_test and points TEST_DATABASE_URL at it. The
    // allowlist has to stay happy with that or CI refuses every run.
    const workflow = read('.github/workflows/test.yml');
    const match = /POSTGRES_DB:\s*(\S+)/.exec(workflow);
    expect(match, 'test.yml no longer declares POSTGRES_DB').not.toBeNull();
    expect(THROWAWAY_DATABASE_NAME.test(match![1]!)).toBe(true);
  });
});

describe('plannedUrl', () => {
  const spec = INTEGRATION_DATABASES.integration!;
  const withEnv = <T>(value: string | undefined, fn: () => T): T => {
    const before = process.env[spec.envVar];
    if (value === undefined) delete process.env[spec.envVar];
    else process.env[spec.envVar] = value;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env[spec.envVar];
      else process.env[spec.envVar] = before;
    }
  };

  it('lets an explicit override win over anything derived', () => {
    withEnv('postgres://u:p@h:1/explicit_test', () => {
      expect(plannedUrl(spec, 'postgres://u:p@h:1/base')).toBe('postgres://u:p@h:1/explicit_test');
    });
  });

  it("swaps the suite's own database into the cluster URL", () => {
    withEnv(undefined, () => {
      expect(databaseOf(plannedUrl(spec, 'postgres://u:p@h:5432/ai_service'))).toBe(spec.database);
    });
  });

  it('🔴 returns nothing when no cluster is named — the caller then FAILS, never skips', () => {
    withEnv(undefined, () => {
      expect(plannedUrl(spec, '')).toBe('');
    });
  });
});

describe('🔴 the missing-database message promises a failure, not a skip', () => {
  const spec = INTEGRATION_DATABASES.integration!;
  const msg = missingDatabaseMessage(spec);

  it('says so in words, and names the override variable', () => {
    expect(msg).toMatch(/FAILS rather than skipping/);
    expect(msg).toContain(spec.envVar);
    expect(msg).toContain(spec.database);
  });

  it('offers no opt-out variable anywhere in the module', () => {
    // A "SKIP_INTEGRATION_TESTS=1" escape hatch is the failure this whole file
    // exists to prevent. Scan the source rather than trusting the message.
    const src = read('src/test/integration-database.ts');
    expect(src).not.toMatch(/SKIP_[A-Z_]*(TEST|DB|DATABASE)/);
    expect(src).not.toMatch(/\b(describe|it|test)\.(skip|skipIf)\b/);
  });
});

describe('the migrations fingerprint', () => {
  it('sees the migrations, and ignores the drizzle-kit snapshots', () => {
    const files = migrationsOnDisk();
    expect(files.length, 'no migrations found — the fingerprint would be a constant').toBeGreaterThan(
      0,
    );
    expect(files.every((f) => f.endsWith('.sql'))).toBe(true);
    expect(files.some((f) => f.includes('snapshot'))).toBe(false);
  });

  // ── the fingerprint's own negative control ──────────────────────────
  //
  // 🔴 EVERY ASSERTION BELOW COMPARES TWO FINGERPRINTS OVER BYTES IT CHANGED.
  // The previous version compared the real fingerprint against a name-only hash
  // it computed itself, and grepped this module's SOURCE TEXT for
  // `journalPath()`. MEASURED by mutating `migrationsFingerprint`:
  // the name-only mutation was killed, but a function returning a HARDCODED
  // CONSTANT passed, and so did one that dropped the journal fold while leaving
  // the string `journalPath()` somewhere in the file. A regex over a file is a
  // claim about spelling, not about behaviour.

  const A = '0000_baseline.sql';
  const B = '0001_later.sql';
  const journalOf = (...tags: string[]) =>
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: tags.map((tag, idx) => ({ idx, version: '7', when: 1785398000000 + idx, tag })),
    });
  const fingerprintOf = (files: Record<string, string>) =>
    withFakeMigrations(files, migrationsFingerprint);

  it('the fake directory really is the one the fingerprint reads', () => {
    // Without this, a wrong path would leave the overlay unused and every
    // comparison below would silently hash the REAL drizzle/ twice — equal
    // hashes, and each `not.toBe` would fail for the wrong reason.
    expect(
      withFakeMigrations(
        { [A]: 'select 1;', 'meta/_journal.json': journalOf('0000_baseline') },
        migrationsOnDisk,
      ),
    ).toEqual([A]);
  });

  it('🔴 CHANGES when CONTENT changes under an UNCHANGED NAME', () => {
    // MEASURED in node_modules/drizzle-orm/pg-core/dialect.js: the migrator
    // reads ONE ledger row and compares journal `when` values. It stores a
    // sha256 of each migration and never reads it back. So editing a migration
    // in place — which is exactly what a ONE-BASELINE policy does —
    // leaves drizzle reporting "nothing pending" about somebody else's schema.
    const journal = journalOf('0000_baseline');
    expect(fingerprintOf({ [A]: 'create table a();', 'meta/_journal.json': journal })).not.toBe(
      fingerprintOf({ [A]: 'create table b();', 'meta/_journal.json': journal }),
    );
  });

  it('🔴 CHANGES when a migration is RENAMED with IDENTICAL bytes', () => {
    // The complement. Without it the hash is a content-only digest, and a
    // re-tagged migration carrying the same SQL reads as unchanged.
    const journal = journalOf('0000_baseline');
    expect(fingerprintOf({ [A]: 'select 1;', 'meta/_journal.json': journal })).not.toBe(
      fingerprintOf({ [B]: 'select 1;', 'meta/_journal.json': journal }),
    );
  });

  it('🔴 CHANGES when ONLY the journal moves — no `.sql` byte touched', () => {
    // `when` is the only thing drizzle compares, so a journal edit that
    // renumbers it changes which migrations the migrator considers applied with
    // no SQL moving at all. This is the journal fold, proved by behaviour.
    const before = fingerprintOf({ [A]: 'select 1;', 'meta/_journal.json': journalOf('0000_baseline') });
    const after = fingerprintOf({
      [A]: 'select 1;',
      'meta/_journal.json': JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [{ idx: 0, version: '7', when: 1999999999999, tag: '0000_baseline' }],
      }),
    });
    expect(after, 'the journal is not folded into the fingerprint').not.toBe(before);
  });

  it('is stable across calls on an unchanged directory — it is not a nonce', () => {
    const files = { [A]: 'select 1;', 'meta/_journal.json': journalOf('0000_baseline') };
    expect(fingerprintOf(files)).toBe(fingerprintOf(files));
  });

  it('changes when a migration is ADDED', () => {
    expect(
      fingerprintOf({ [A]: 'select 1;', 'meta/_journal.json': journalOf('0000_baseline') }),
    ).not.toBe(
      fingerprintOf({
        [A]: 'select 1;',
        [B]: 'select 2;',
        'meta/_journal.json': journalOf('0000_baseline', '0001_later'),
      }),
    );
  });

  it('does not collide when a name/content boundary shifts', () => {
    // Without the NUL separators, ("ab","c") and ("a","bc") hash the same.
    const journal = journalOf('x');
    expect(fingerprintOf({ 'ab.sql': 'c', 'meta/_journal.json': journal })).not.toBe(
      fingerprintOf({ 'a.sql': 'bc', 'meta/_journal.json': journal }),
    );
  });

  it('🔴 hashes the REAL drizzle/ to 16 hex, and every journal entry has its file', () => {
    const bodies = migrationsOnDisk().map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    expect(bodies.join('').length, 'a migration file was empty').toBeGreaterThan(100);
    expect(migrationsFingerprint()).toMatch(/^[0-9a-f]{16}$/);

    const journal = JSON.parse(readFileSync(journalPath(), 'utf8')) as {
      entries?: { tag?: string; when?: number }[];
    };
    expect(journal.entries?.length ?? 0).toBeGreaterThan(0);
    // Every journal entry must have a .sql file on disk, or the fingerprint and
    // the migrator disagree about what the schema is.
    const onDisk = new Set(migrationsOnDisk());
    for (const e of journal.entries ?? []) {
      expect(onDisk.has(`${e.tag}.sql`), `journal names missing file ${e.tag}.sql`).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('🔴 the fingerprint filter matches what drizzle actually applies', () => {
  // ⚠ ADDING `.js`/`.mjs`/`.cjs` HERE WOULD BE A DEFECT — measured,
  // both ways:
  //
  //   · `node_modules/drizzle-orm/migrator.js`'s `readMigrationFiles` reads
  //     `meta/_journal.json` and, per entry, exactly `<tag>.sql`. Nothing else.
  //   · empirically: a file `drizzle/0002_js_probe.js` containing
  //     `CREATE TABLE "lanec_js_probe" (...)` was dropped into the real
  //     migrations directory and `src/db/migrate.ts` run against a throwaway
  //     Postgres. It printed "Migrations complete.", left the database at 249
  //     columns, and `lanec_js_probe` did not exist.
  //
  // That widening fits Payload — it executes `migrations/*.ts` and
  // `*.js`. Here it would fold bytes drizzle never runs into a hash that
  // `scripts/schema-gate.mjs` uses to REFUSE A DEPLOY. A no-op file would take
  // an environment down. So the filter stays `.sql` + the journal, and these
  // two tests are what stops a well-meaning sweep from "fixing" it.

  const journal = JSON.stringify({
    version: '7',
    dialect: 'postgresql',
    entries: [{ idx: 0, version: '7', when: 1785398000000, tag: '0000_baseline' }],
  });
  const base = { '0000_baseline.sql': 'select 1;', 'meta/_journal.json': journal };
  const fp = (files: Record<string, string>) => withFakeMigrations(files, migrationsFingerprint);

  it('a .sql file drizzle could run DOES move the fingerprint', () => {
    expect(fp({ ...base, '0001_new.sql': 'select 2;' })).not.toBe(fp(base));
  });

  it('a .js / .mjs / .cjs file drizzle can never run does NOT move it', () => {
    for (const name of ['0001_x.js', '0001_x.mjs', '0001_x.cjs']) {
      expect(fp({ ...base, [name]: 'select 2;' }), `${name} moved the fingerprint`).toBe(fp(base));
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('🔴 the LIVE-SCHEMA half — the fingerprint that looks at the database', () => {
  // WHY THIS EXISTS, measured against a freshly
  // provisioned `ai_service_test` (249 columns / 16 base tables): dropping
  // `registry_audit` and five columns from `traces` took it to 234 / 15, and
  // `requireIntegrationDb` still returned `{ created: false, rebuilt: false }`
  // — "reused, schema stamp matches". The suite would then have run against a
  // database missing a whole table. With this half wired in, the same damage
  // returns `{ rebuilt: true, staleReason: 'schema' }` and the database is
  // rebuilt back to 249 / 16.

  type Row = Record<string, string | number | boolean | null>;

  // `fingerprintRows` is pure, so these assertions describe schemas directly.
  // The QUERY that produces these rows is proved separately, against a real
  // Postgres, in `live-schema-fingerprint.integration.test.ts` — the two
  // properties that need a live database (search_path-independent rendering,
  // and the type modifier) cannot be reached from a fixture.

  // Row shape = the `pg_catalog` query's output columns. NOT
  // `information_schema` — see `liveSchemaFingerprint`'s header for the
  // measurement that forced the move.
  const col = (over: Partial<Row> = {}): Row => ({
    nspname: 'public',
    relname: 'traces',
    attname: 'model',
    coltype: 'text',
    attnotnull: false,
    coldefault: '',
    ...over,
  });

  const SCHEMA = [
    col({ attname: 'id', coltype: 'uuid', attnotnull: true }),
    col({ attname: 'label' }),
    col({ attname: 'model' }),
    col({ relname: 'usage_logs', attname: 'tokens', coltype: 'integer' }),
  ];

  const fp = (rows: Row[]) => fingerprintRows(rows as unknown as LiveSchemaRow[]);

  it('🔴 an EMPTY database is a distinct value, never a hash', () => {
    // An unmigrated database must not be able to compare EQUAL to a migrated
    // one. A sha256 of "" is an ordinary hex string; this is not.
    expect(fp([])).toBe(EMPTY_SCHEMA_FINGERPRINT);
    expect(EMPTY_SCHEMA_FINGERPRINT).not.toMatch(/^[0-9a-f]{16}$/);
    expect(fp([])).not.toBe(fp(SCHEMA));
  });

  it('hashes a real schema to the same 16-hex shape as the migrations half', () => {
    // ONE convention in this repo, not two — the stamp carries both fields and
    // a reader must not have to know which is which to read them.
    expect(fp(SCHEMA)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across calls on an unchanged schema — it is not a nonce', () => {
    expect(fp(SCHEMA)).toBe(fp(SCHEMA));
  });

  it('🔴 CHANGES when a column is dropped', () => {
    expect(fp(SCHEMA.filter((c) => c.attname !== 'label'))).not.toBe(fp(SCHEMA));
  });

  it('🔴 CHANGES when a whole table is dropped', () => {
    expect(fp(SCHEMA.filter((c) => c.relname !== 'usage_logs'))).not.toBe(fp(SCHEMA));
  });

  it('🔴 CHANGES when only a DEFAULT moves — same tables, same columns', () => {
    // The case column counts and table names both miss. A dropped-and-re-added
    // default is a real schema change; measured on a live database, this is the
    // only signal that fires for it.
    const withDefault = SCHEMA.map((c) =>
      c.attname === 'model' ? { ...c, coldefault: "'x'::text" } : c,
    );
    expect(fp(withDefault)).not.toBe(fp(SCHEMA));
  });

  it('CHANGES when a column flips nullability, and when its type changes', () => {
    const nullable = SCHEMA.map((c) => (c.attname === 'id' ? { ...c, attnotnull: false } : c));
    const retyped = SCHEMA.map((c) =>
      c.attname === 'model' ? { ...c, coltype: 'character varying(20)' } : c,
    );
    expect(fp(nullable)).not.toBe(fp(SCHEMA));
    expect(fp(retyped)).not.toBe(fp(SCHEMA));
  });

  it('CHANGES when only a type MODIFIER moves — varchar(20) vs varchar(40)', () => {
    // `format_type` carries length/precision/scale, which is why the query
    // needs no separate columns for them. If it were `atttypid` alone, these
    // two schemas would hash alike.
    const a = SCHEMA.map((c) =>
      c.attname === 'model' ? { ...c, coltype: 'character varying(20)' } : c,
    );
    const b = SCHEMA.map((c) =>
      c.attname === 'model' ? { ...c, coltype: 'character varying(40)' } : c,
    );
    expect(fp(a)).not.toBe(fp(b));
  });

  it('does not collide when a field boundary shifts', () => {
    // Without a separator between fields, ("ab","c") and ("a","bc") hash alike
    // — a table renamed `a` with a column `bc` would read as unchanged.
    const left = [col({ relname: 'ab', attname: 'c' })];
    const right = [col({ relname: 'a', attname: 'bc' })];
    expect(fp(left)).not.toBe(fp(right));
  });

  it('separates two identically-named tables in different schemas', () => {
    // Deployed dev really does carry `drizzle.__drizzle_migrations` alongside
    // `public.__drizzle_migrations` (see migrations-config.ts's rollout note),
    // measured at 252 columns across both where a fresh local
    // database has 249 in one. A `public`-only fingerprint would hide that.
    const one = [col({ nspname: 'public', relname: 'ledger' })];
    const two = [col({ nspname: 'drizzle', relname: 'ledger' })];
    expect(fp(one)).not.toBe(fp(two));
  });

  it('🔴 reads pg_catalog, never the privilege-filtered information_schema', () => {
    // MEASURED in this repo: a role with CONNECT + USAGE and no
    // table grants sees 0 rows in `information_schema` on a healthy 249-column
    // database, and all 16 relations in `pg_catalog`. Zero rows is absorbed by
    // the ignorance rule; a PARTIAL grant is not — it is a plausible, non-zero,
    // WRONG hash, and the deployed gate would refuse to boot a healthy database
    // because a GRANT changed.
    //
    // ⚠ This one assertion IS about the query text, because the property is
    // "which catalog answered" and no fixture can stand in for a privilege
    // level. Everything else in this block is behaviour.
    const src = read(path.join('src', 'test', 'integration-database.ts'));
    const fn = src.slice(src.indexOf('export const liveSchemaFingerprint'));
    const body = fn.slice(0, fn.indexOf('\n};'));
    expect(body).toContain('pg_attribute');
    expect(body).not.toMatch(/FROM\s+information_schema/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────

describe('🔴 the PER-FILE half — appended vs edited', () => {
  // WHY THIS EXISTS, MEASURED: a deploy whose only change was an APPENDED
  // migration was rolled back. The live-schema half matched; the aggregate migrations half differed, because appending changes
  // it exactly as editing does. One hash cannot tell the two apart, so the gate
  // refused a healthy deploy. `migrationsManifest` + `compareManifests` are what
  // make the difference visible.

  const rec = (over: Partial<MigrationRecord> = {}): MigrationRecord => ({
    tag: '0000_baseline',
    when: 1000,
    breakpoints: true,
    sha256: 'a'.repeat(64),
    ...over,
  });

  const A = rec();
  const B = rec({ tag: '0001_second', when: 2000, sha256: 'b'.repeat(64) });
  const C = rec({ tag: '0002_third', when: 3000, sha256: 'c'.repeat(64) });
  const of = (...entries: MigrationRecord[]) => ({ entries });

  it('IDENTICAL when the lists are the same', () => {
    expect(compareManifests(of(A, B), of(A, B))).toMatchObject({
      verdict: 'identical',
      appended: [],
    });
  });

  it('🔴 APPENDED when the stamped list is a strict prefix — and names the new tags', () => {
    const result = compareManifests(of(A, B), of(A, B, C));
    expect(result.verdict).toBe('appended');
    expect(result.appended).toEqual(['0002_third']);
  });

  it('APPENDED from an empty stamped list, and identical for two empty ones', () => {
    // The degenerate ends of the range. Neither may throw, and neither may be
    // "diverged" — a stamp recording no migrations is a prefix of everything.
    expect(compareManifests(of(), of(A, B)).verdict).toBe('appended');
    expect(compareManifests(of(), of()).verdict).toBe('identical');
  });

  it('🔴 DIVERGED when a stamped file was EDITED IN PLACE — the prototype case', () => {
    // Same tag, same `when`, different bytes. This is the whole reason the gate
    // exists, and the prefix rule must not soften it.
    const edited = rec({ tag: '0001_second', when: 2000, sha256: 'f'.repeat(64) });
    const result = compareManifests(of(A, B), of(A, edited, C));
    expect(result.verdict).toBe('diverged');
    expect(result.appended).toEqual([]);
    expect(result.reason).toContain('0001_second');
    expect(result.reason).toContain('EDITED IN PLACE');
  });

  it('🔴 DIVERGED when a stamped migration is MISSING from the image', () => {
    const result = compareManifests(of(A, B, C), of(A, B));
    expect(result.verdict).toBe('diverged');
    expect(result.reason).toContain('0002_third');
    expect(result.reason).toContain('MISSING');
  });

  it('🔴 DIVERGED when a stamped migration is REMOVED FROM THE MIDDLE', () => {
    // Same LENGTH as an append would leave, so a length-only check passes it.
    const result = compareManifests(of(A, B, C), of(A, C, rec({ tag: '0003_x', when: 4000 })));
    expect(result.verdict).toBe('diverged');
    expect(result.reason).toContain('position 1');
  });

  it('🔴 DIVERGED when a stamped `when` MOVED, with identical bytes', () => {
    const moved = rec({ tag: '0001_second', when: 2500, sha256: 'b'.repeat(64) });
    const result = compareManifests(of(A, B), of(A, moved));
    expect(result.verdict).toBe('diverged');
    expect(result.reason).toContain('MOVED');
    expect(result.reason).toContain('2500');
  });

  it('🔴 DIVERGED when only `breakpoints` moved — drizzle reads that field', () => {
    // MEASURED in node_modules/drizzle-orm/migrator.js: `bps: journalEntry
    // .breakpoints` decides whether the file is split on
    // `--> statement-breakpoint`. Same SQL, different execution.
    const flipped = rec({ tag: '0001_second', when: 2000, sha256: 'b'.repeat(64), breakpoints: false });
    expect(compareManifests(of(A, B), of(A, flipped)).verdict).toBe('diverged');
  });

  it('🔴 DIVERGED when an APPENDED migration’s `when` does not increase', () => {
    // The trap in plan/open-drizzle-journal-when-trap.md, at the gate level.
    // Drizzle applies an entry only when its `when` beats the newest ledger
    // row, so allowing this would make the gate PROMISE an application that
    // never happens — and `stamp` would then record it as done.
    const stale = rec({ tag: '0002_third', when: 1500, sha256: 'c'.repeat(64) });
    const result = compareManifests(of(A, B), of(A, B, stale));
    expect(result.verdict).toBe('diverged');
    expect(result.reason).toContain('SKIP');
    expect(result.appended).toEqual([]);
  });

  it('…including when the SECOND of two appended entries goes backwards', () => {
    // The monotonicity has to hold ACROSS the appended run, not just against
    // the last stamped entry.
    const back = rec({ tag: '0003_fourth', when: 2500, sha256: 'd'.repeat(64) });
    expect(compareManifests(of(A, B), of(A, B, C, back)).verdict).toBe('diverged');
    expect(compareManifests(of(A, B), of(A, B, C, rec({ tag: '0003_fourth', when: 4000 }))).verdict).toBe(
      'appended',
    );
  });

  it('🔴 an APPEND and an EDIT in the SAME image is DIVERGED, not appended', () => {
    // The case that decides whether the prefix rule is a hole. Appending 0002
    // must not buy forgiveness for having also touched 0001.
    const edited = rec({ tag: '0001_second', when: 2000, sha256: 'f'.repeat(64) });
    expect(compareManifests(of(A, B), of(A, edited, C)).verdict).toBe('diverged');
  });
});

describe('🔴 the manifest reads the JOURNAL, and hashes real bytes', () => {
  const journalOf = (...entries: { tag: string; when: number; breakpoints?: boolean }[]) =>
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: entries.map((e, idx) => ({ idx, version: '7', breakpoints: true, ...e })),
    });

  it('follows JOURNAL ORDER, not the sorted directory listing', () => {
    // 🔴 The journal is what drizzle executes and in what order. Ordering by
    // filename would make "prefix" a claim about names rather than about what
    // runs — and drizzle-kit does not promise that the journal's order matches
    // a lexical sort of the tags.
    const manifest = withFakeMigrations(
      {
        '0000_a.sql': 'select 1;',
        '0001_b.sql': 'select 2;',
        'meta/_journal.json': journalOf({ tag: '0001_b', when: 2 }, { tag: '0000_a', when: 1 }),
      },
      migrationsManifest,
    );
    expect(manifest.entries.map((e) => e.tag)).toEqual(['0001_b', '0000_a']);
  });

  it('🔴 a `.sql` file NO journal entry names is invisible to it', () => {
    // Drizzle never applies such a file (readMigrationFiles walks the journal),
    // so folding it in would let a no-op file EXIT 1 a deploy.
    const withStray = withFakeMigrations(
      {
        '0000_a.sql': 'select 1;',
        '0009_stray.sql': 'drop table everything;',
        'meta/_journal.json': journalOf({ tag: '0000_a', when: 1 }),
      },
      migrationsManifest,
    );
    expect(withStray.entries.map((e) => e.tag)).toEqual(['0000_a']);
  });

  it('the per-file sha256 CHANGES with the bytes, and is the full 64 hex', () => {
    const one = withFakeMigrations(
      { '0000_a.sql': 'select 1;', 'meta/_journal.json': journalOf({ tag: '0000_a', when: 1 }) },
      migrationsManifest,
    );
    const two = withFakeMigrations(
      { '0000_a.sql': 'select 2;', 'meta/_journal.json': journalOf({ tag: '0000_a', when: 1 }) },
      migrationsManifest,
    );
    expect(one.entries[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(one.entries[0]!.sha256).not.toBe(two.entries[0]!.sha256);
  });

  it('🔴 the per-file sha256 IS the value drizzle stores in its ledger', () => {
    // MEASURED in node_modules/drizzle-orm/migrator.js (0.38.4):
    //   hash: crypto.createHash('sha256').update(query).digest('hex')
    // where `query` is the file read as a string. Matching it is what lets an
    // operator read a stamp against `__drizzle_migrations` with no
    // re-derivation, so it is asserted rather than assumed.
    const body = readFileSync(path.join(MIGRATIONS_DIR, `${migrationsManifest().entries[0]!.tag}.sql`));
    const drizzleWouldStore = createHash('sha256').update(body.toString()).digest('hex');
    expect(migrationsManifest().entries[0]!.sha256).toBe(drizzleWouldStore);
  });

  it('🔴 normalises `breakpoints` — absent and false are the same instruction', () => {
    // Drizzle uses it as plain truthiness. If `undefined` and `false` hashed
    // differently, a drizzle-kit version that stops writing the field would
    // refuse every deploy at once.
    const absent = withFakeMigrations(
      {
        '0000_a.sql': 'select 1;',
        'meta/_journal.json': JSON.stringify({
          version: '7',
          dialect: 'postgresql',
          entries: [{ idx: 0, version: '7', when: 1, tag: '0000_a' }],
        }),
      },
      migrationsManifest,
    );
    const explicitFalse = withFakeMigrations(
      {
        '0000_a.sql': 'select 1;',
        'meta/_journal.json': journalOf({ tag: '0000_a', when: 1, breakpoints: false }),
      },
      migrationsManifest,
    );
    expect(absent.entries[0]!.breakpoints).toBe(false);
    expect(explicitFalse.entries[0]!.breakpoints).toBe(false);
  });

  it('🔴 THROWS when a journal entry names a file that is not there', () => {
    // NOT a staleness verdict, and must never become one: precheck’s outer
    // catch turns it into "could not check, continuing" and the migrate step
    // right after throws `No file <tag>.sql found` properly.
    expect(() =>
      withFakeMigrations(
        { '0000_a.sql': 'select 1;', 'meta/_journal.json': journalOf({ tag: '0000_a', when: 1 }, { tag: '0001_gone', when: 2 }) },
        migrationsManifest,
      ),
    ).toThrow(/ENOENT|0001_gone/);
  });

  it('🔴 the REAL drizzle/ is a manifest the comparison calls identical to itself', () => {
    const real = migrationsManifest();
    expect(real.entries.length, 'no journal entries — every check above would be vacuous').toBeGreaterThan(0);
    expect(real.journalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(compareManifests(real, real).verdict).toBe('identical');
    // …and every prefix of it is an APPEND, which is the property the boot gate
    // depends on for every future migration this repo adds.
    for (let n = 0; n < real.entries.length; n++) {
      const result = compareManifests({ entries: real.entries.slice(0, n) }, real);
      expect(result.verdict, `prefix of length ${n} is not an append`).toBe('appended');
      expect(result.appended).toEqual(real.entries.slice(n).map((e) => e.tag));
    }
  });
});

describe('🔴 the deployed boot gate agrees with the test harness', () => {
  // WHY THIS IS A REAL TEST AND NOT AN INVENTORY CHECK. `scripts/schema-gate.
  // mjs` runs in the RUNTIME IMAGE, which ships `dist/`, `drizzle/`,
  // `package.json` and production `node_modules` — no TypeScript, no `tsx`. So
  // it carries its own copy of both fingerprints. If the two copies ever
  // disagree by one byte, the gate REFUSES TO BOOT a database this harness had
  // just blessed as current, in every deployed environment at once. The repo
  // already carries this shape for `drizzle.config.ts` vs
  // `src/db/migrations-config.ts`, guarded the same way.

  // ⚠ NOT cast. `scripts/schema-gate.d.mts` declares the two functions, so a
  // signature that drifts fails the typecheck instead of being asserted away.
  const gate = () => import('../../scripts/schema-gate.mjs');

  it('computes the same MIGRATIONS fingerprint over the real drizzle/', async () => {
    expect((await gate()).migrationsFingerprint()).toBe(migrationsFingerprint());
  });

  it('…and over a directory neither of them has ever seen', async () => {
    // The real directory agreeing could be luck if one of them ignored an input
    // the other one folds in. This moves the bytes.
    const files = {
      '0000_baseline.sql': 'create table a (b text);',
      '0001_later.sql': 'alter table a add column c int;',
      'meta/_journal.json': JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [
          { idx: 0, version: '7', when: 1785398000000, tag: '0000_baseline' },
          { idx: 1, version: '7', when: 1785600000000, tag: '0001_later' },
        ],
      }),
      'meta/0000_snapshot.json': '{"ignored":true}',
    };
    const theirs = (await gate()).migrationsFingerprint;
    expect(withFakeMigrations(files, theirs)).toBe(withFakeMigrations(files, migrationsFingerprint));
    // …and it is not the same hash as the real directory, i.e. the overlay
    // really applied to BOTH of them.
    expect(withFakeMigrations(files, theirs)).not.toBe(migrationsFingerprint());
  });

  it('computes the same LIVE-SCHEMA fingerprint from the same rows', async () => {
    const rows = [
      {
        nspname: 'public',
        relname: 'traces',
        attname: 'model',
        coltype: 'character varying(20)',
        attnotnull: false,
        coldefault: '',
      },
      {
        nspname: 'drizzle',
        relname: '__drizzle_migrations',
        attname: 'created_at',
        coltype: 'bigint',
        attnotnull: true,
        coldefault: "nextval('x'::regclass)",
      },
    ];
    expect((await gate()).fingerprintRows(rows)).toBe(fingerprintRows(rows));
  });

  it('🔴 and both agree that an empty database is not a hash', async () => {
    expect((await gate()).fingerprintRows([])).toBe(EMPTY_SCHEMA_FINGERPRINT);
    expect(fingerprintRows([])).toBe(EMPTY_SCHEMA_FINGERPRINT);
  });

  // ── the PER-FILE half ─────────────────────────────────
  //
  // 🔴 THIS HALF IS WHERE DRIFT WOULD BE WORST. The two aggregates only have to
  // agree on a hash; these two have to agree on a VERDICT. A gate that called
  // an append "diverged" where the harness called it "appended" would refuse
  // every deployed environment on the first additive migration — which is
  // exactly the change this branch makes possible.

  it('computes the same MANIFEST over the real drizzle/', async () => {
    expect((await gate()).migrationsManifest()).toEqual(migrationsManifest());
  });

  it('…and over a directory neither of them has ever seen', async () => {
    const files = {
      '0000_baseline.sql': 'create table a (b text);',
      '0001_later.sql': 'alter table a add column c int;',
      '0002_unlisted.sql': 'drop table a;',
      'meta/_journal.json': JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [
          { idx: 0, version: '7', when: 1785398000000, tag: '0000_baseline', breakpoints: true },
          { idx: 1, version: '7', when: 1785600000000, tag: '0001_later', breakpoints: false },
        ],
      }),
    };
    const theirs = (await gate()).migrationsManifest;
    expect(withFakeMigrations(files, theirs)).toEqual(withFakeMigrations(files, migrationsManifest));
    // …and the overlay really applied to BOTH: `0002_unlisted.sql` is on disk
    // and in NEITHER manifest, because no journal entry names it.
    expect(withFakeMigrations(files, theirs).entries.map((e) => e.tag)).toEqual([
      '0000_baseline',
      '0001_later',
    ]);
    expect(withFakeMigrations(files, theirs)).not.toEqual(migrationsManifest());
  });

  it('🔴 reaches the same VERDICT on every case the boot decision turns on', async () => {
    const theirs = (await gate()).compareManifests;
    const real = migrationsManifest();
    const first = real.entries[0]!;
    const cases: [string, { entries: MigrationRecord[] }, { entries: MigrationRecord[] }][] = [
      ['identical', real, real],
      ['appended', { entries: real.entries.slice(0, 1) }, real],
      [
        'edited in place',
        { entries: [{ ...first, sha256: 'f'.repeat(64) }, ...real.entries.slice(1)] },
        real,
      ],
      ['missing', { entries: [...real.entries, { ...first, tag: '9999_ghost', when: 9e12 }] }, real],
      ['when moved', { entries: [{ ...first, when: first.when + 1 }, ...real.entries.slice(1)] }, real],
      [
        'appended with a stale when',
        { entries: real.entries.slice(0, 1) },
        { entries: [first, { ...first, tag: '0001_stale', when: first.when - 1 }] },
      ],
      ['both empty', { entries: [] }, { entries: [] }],
    ];
    for (const [name, stamped, disk] of cases) {
      const ours = compareManifests(stamped, disk);
      // ⚠ THE WHOLE OBJECT, `reason` prose included. Comparing only the verdict
      // would let the two explanations drift apart, and the explanation is what
      // an operator reads at 3am: "does not match" and nothing else costs an hour.
      // Keeping them
      // byte-identical is cheaper than arguing about which wording is canonical.
      expect(theirs(stamped, disk), `the gate and the harness disagree on "${name}"`).toEqual(ours);
      // …and the case really exercised what it says it does, so a comparison
      // that always answered 'identical' could not pass this block.
      expect(ours.verdict, `case "${name}" produced no verdict`).toMatch(
        /^(identical|appended|diverged)$/,
      );
    }
    expect(new Set(cases.map(([, s, d]) => compareManifests(s, d).verdict))).toEqual(
      new Set(['identical', 'appended', 'diverged']),
    );
  });
});

describe('🔴 the boot gate knows where the migration LEDGER lives', () => {
  // WHY THIS IS A DRIFT TEST AND NOT A CONSTANT. `scripts/schema-gate.mjs`
  // reads `max(created_at)` out of the ledger before it will write a stamp —
  // that is the check that stops a stamp claiming migrations the database never
  // applied. It runs in the runtime image, which ships no TypeScript, so it
  // cannot import `src/db/migrations-config.ts` and carries its own copy of the
  // two literals.
  //
  // 🔴 IF THEY DRIFT THE CHECK GOES BLIND IN THE WORST WAY: pointed at a table
  // that does not exist, `to_regclass` returns null, the gate reads "nothing has
  // ever been applied" and REFUSES EVERY STAMP in every environment at once.
  // Pointed at drizzle-kit's `drizzle` default on a database whose real ledger
  // is in `public`, it reads a stale head and refuses just as hard.
  const gate = () => import('../../scripts/schema-gate.mjs');

  it('names the SAME schema and table as the runtime migrator', async () => {
    const theirs = await gate();
    expect(theirs.MIGRATIONS_SCHEMA).toBe(MIGRATIONS_SCHEMA);
    expect(theirs.MIGRATIONS_TABLE).toBe(MIGRATIONS_TABLE);
    // …and the pair is the required one, so a drift that
    // moved BOTH copies together still fails here.
    expect(theirs.MIGRATIONS_SCHEMA).toBe('public');
    expect(theirs.MIGRATIONS_SCHEMA).not.toBe('drizzle');
  });
});

describe('🔴 the boot log reports an aggregate it actually computed', () => {
  // N-2: on the per-file path the gate compares per-entry sha256s and never
  // looks at an aggregate, so the "is current" line used to print the STAMPED
  // `migrations` value — a number that boot had not verified, and that a stray
  // `.sql` silently invalidates. `manifestFingerprint` is the recomputed one,
  // over exactly the files the journal names.
  //
  // SABOTAGE (measured, and they kill DIFFERENT tests — which is
  // why both are here):
  //   · `manifestFingerprint` returning `migrationsFingerprint()` instead →
  //     the stray-file test goes RED; the "MOVES" test stays green, because
  //     the directory aggregate moves for those inputs too.
  //   · `unreferencedSqlFiles` returning `[]` → the naming test goes RED.
  //   · drifting `MIGRATIONS_SCHEMA` to `'drizzle'` → the ledger-location test
  //     above goes RED.
  const gate = () => import('../../scripts/schema-gate.mjs');

  const journalOf = (...tags: string[]) =>
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: tags.map((tag, idx) => ({ idx, version: '7', breakpoints: true, when: 100 + idx, tag })),
    });
  const base = {
    '0000_a.sql': 'create table a (b text);',
    'meta/_journal.json': journalOf('0000_a'),
  };

  it('is 16 hex over the real drizzle/, and stable', async () => {
    const { manifestFingerprint } = await gate();
    expect(manifestFingerprint(migrationsManifest())).toMatch(/^[0-9a-f]{16}$/);
    expect(manifestFingerprint(migrationsManifest())).toBe(manifestFingerprint(migrationsManifest()));
  });

  // ⚠ THE HASH IS TAKEN INSIDE THE OVERLAY, not outside it. Computed outside,
  // an implementation that ignored its argument and returned
  // `migrationsFingerprint()` over the REAL drizzle/ would answer the same
  // constant every time — and the stray-file assertion below, which is a
  // `toBe`, would pass on that constant. MEASURED by planting exactly that
  // mutation: with the call outside, only one of these two tests killed it.
  const of = (files: Record<string, string>, fp: (m: MigrationsManifest) => string) =>
    withFakeMigrations(files, () => fp(migrationsManifest()));

  it('MOVES when a journal file\u2019s bytes move, and when one is appended', async () => {
    const { manifestFingerprint } = await gate();
    const of_ = (files: Record<string, string>) => of(files, manifestFingerprint);
    expect(of_({ ...base, '0000_a.sql': 'create table b (c text);' })).not.toBe(of_(base));
    expect(
      of_({ ...base, '0001_b.sql': 'select 1;', 'meta/_journal.json': journalOf('0000_a', '0001_b') }),
    ).not.toBe(of_(base));
  });

  it('🔴 does NOT move for a stray .sql — where migrationsFingerprint DOES', async () => {
    // The exact asymmetry the log line depends on. The per-file comparison is
    // blind to `0009_stray.sql` (drizzle never runs it), so the number printed
    // beside that comparison must be blind to it too — while the aggregate the
    // LEGACY path compares is not, which is why they are two different numbers.
    const { manifestFingerprint } = await gate();
    const withStray = { ...base, '0009_stray.sql': 'drop table a;' };
    expect(
      of(withStray, manifestFingerprint),
      'the journal-files aggregate folded in a file no journal entry names',
    ).toBe(of(base, manifestFingerprint));
    expect(
      withFakeMigrations(withStray, migrationsFingerprint),
      'the directory aggregate ignored a .sql file — then this asymmetry is not real',
    ).not.toBe(withFakeMigrations(base, migrationsFingerprint));
  });

  it('names the stray file, so the boot log can say which one it is', async () => {
    const { unreferencedSqlFiles } = await gate();
    expect(
      withFakeMigrations({ ...base, '0009_stray.sql': 'drop table a;' }, () =>
        unreferencedSqlFiles(migrationsManifest()),
      ),
    ).toEqual(['0009_stray.sql']);
    // …and the REAL drizzle/ has none, or the deployed boot log carries a
    // warning nobody meant to ship.
    expect(unreferencedSqlFiles(migrationsManifest())).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────

/** Blank out comments while preserving line structure. */
const withoutComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

const SKIP_PATTERN = /^[ \t]*(?:describe|it|test)\.(skip|only|todo|skipIf|runIf)\b/gm;

const allIntegrationFiles = (): string[] => {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(child);
      } else if (entry.name.endsWith('.integration.test.ts')) {
        found.push(child);
      }
    }
  };
  walk('src');
  return found.sort();
};

describe('🔴 no integration suite can silently skip itself', () => {
  // A skipped integration test is indistinguishable from a passing one. The
  // CI's "tests actually ran" check (scripts/ci/assert-tests-ran.mjs) only
  // catches a suite where NOTHING ran; this catches one skip written into the
  // source, which a run with other passing tests would never show.
  //
  // ⚠ A file allowed to gate itself must SAY SO with a `skip-reason:` marker,
  // and must still actually be gated. Both are checked
  // per file below; adding an allowance is a visible diff in this file, not a
  // comment somewhere. The SIZE of this list is a curation decision, not a
  // software fact, so nothing asserts it.
  const ALLOWED_TO_GATE = ['src/eval/real-embedder-eval.integration.test.ts'];

  const files = allIntegrationFiles();

  it('found the integration suites to check (not vacuously green)', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(read(f).length, `${f} is empty — the scan below would be vacuous`).toBeGreaterThan(0);
    }
  });

  it('the skip scan can actually see a skip (it is not a regex that never matches)', () => {
    // ⚠ ASSEMBLED, not written literally, so this file's own source never
    // carries the marker it scans for.
    const marker = ['it', 'skip'].join('.');
    const planted = `describe('x', () => {\n  ${marker}('y', () => {})\n})\n`;
    expect([...planted.matchAll(SKIP_PATTERN)].length).toBe(1);
  });

  it('the comment stripper does not blind the scan to real code', () => {
    // ⚠ ASSEMBLED for the same reason as above.
    const marker = ['it', 'skip'].join('.');
    const src = `// ${marker}('in a comment', () => {})\n${marker}('real', () => {})\n`;
    expect([...withoutComments(src).matchAll(SKIP_PATTERN)].length).toBe(1);
  });

  it('none of them carries a skip, only or todo marker', () => {
    for (const f of files) {
      if (ALLOWED_TO_GATE.includes(f)) continue;
      const offenders = [...withoutComments(read(f)).matchAll(SKIP_PATTERN)].map((m) => m[0].trim());
      expect(offenders, `${f} disables part of itself: ${offenders.join(', ')}`).toEqual([]);
    }
  });

  it('🔴 every gated file explains itself with a skip-reason marker', () => {
    for (const f of ALLOWED_TO_GATE) {
      const src = read(f);
      expect(src, `${f} is on the allowance list but carries no skip-reason:`).toMatch(
        /skip-reason:/,
      );
      // It must actually still be gated — an allowance for a file that no longer
      // skips is dead weight that would later excuse a real skip.
      expect([...withoutComments(src).matchAll(SKIP_PATTERN)].length).toBeGreaterThan(0);
    }
  });

  it('every integration file on disk was checked by the scan above', () => {
    // Otherwise a new suite could be added and never checked. `allIntegrationFiles`
    // walks the tree, so this asserts the walk found the same set the runner does.
    const configured = read('vitest.integration.config.ts');
    expect(configured).toMatch(/include:\s*\[\s*'src\/\*\*\/\*\.integration\.test\.ts'/);
    expect(files.every((f) => f.startsWith(`src${path.sep}`))).toBe(true);
    for (const f of ALLOWED_TO_GATE) {
      expect(files, `${f} is allow-listed but no longer exists`).toContain(f);
    }
  });
});

describe('🔴 database-backed tests outside the integration lane stay visible', () => {
  // ⚠ FOUND WHILE PORTING THIS, AND NOT FIXED HERE. Two files in the UNIT lane
  // start a throwaway Postgres and gate themselves on `dockerAvailable()`:
  //
  //     src/routes/registry.test.ts
  //     src/routes/tenant-provision.test.ts
  //
  // On a machine without Docker they SKIP, which is the shape property 1 of
  // this design exists to forbid — and they are outside the
  // `*.integration.test.ts` scan above, so nothing else here sees them. In CI
  // they do run (ubuntu-latest ships a daemon) and both carry a `skip-reason:`
  // marker, so this is a latent hole rather than a live one.
  //
  // The real fix is to rename them `*.integration.test.ts` and move them into
  // the integration job. That moves files between two vitest configs and two CI
  // jobs, so it is deliberately left as its own change. What this block does is
  // make the hole a FIXED, ENUMERATED one: a THIRD such file cannot appear
  // without failing here.
  const DOCKER_GATED_UNIT_FILES = [
    path.join('src', 'routes', 'registry.test.ts'),
    path.join('src', 'routes', 'tenant-provision.test.ts'),
  ];

  // ⚠ ASSEMBLED, not written literally: the scan reads source files, and this
  // file is one of them. Spelled out, the needle matches THIS file and the
  // check fails on itself.
  const NEEDLE = ['startThrowaway', 'Pg'].join('');

  const unitFilesStartingPostgres = (): string[] => {
    const found: string[] = [];
    const walk = (rel: string): void => {
      for (const entry of readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
        const child = path.join(rel, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(child);
        } else if (
          entry.name.endsWith('.test.ts') &&
          !entry.name.endsWith('.integration.test.ts') &&
          withoutComments(read(child)).includes(NEEDLE)
        ) {
          found.push(child);
        }
      }
    };
    walk('src');
    return found.sort();
  };

  it('🔴 the list of docker-gated unit files is exactly the known two', () => {
    expect(
      unitFilesStartingPostgres(),
      'a unit test started needing a real Postgres. Either give it the ' +
        '.integration.test.ts suffix so the fail-not-skip scan covers it, or add it ' +
        'here on purpose with a skip-reason: marker.',
    ).toEqual(DOCKER_GATED_UNIT_FILES);
  });

  it('each of them explains its gate with a skip-reason marker', () => {
    for (const f of DOCKER_GATED_UNIT_FILES) {
      expect(read(f), `${f} gates itself with no skip-reason:`).toMatch(/skip-reason:/);
    }
  });
});

describe('🔴 the integration runner keeps the properties the wipe depends on', () => {
  const config = read('vitest.integration.config.ts');

  it('runs integration files sequentially', () => {
    // Every integration file shares ONE database and a GLOBAL beforeEach
    // truncate. In parallel, one file's truncate wipes another's mid-test rows.
    expect(config).toMatch(/fileParallelism:\s*false/);
    // 🔴 `fileParallelism: false` above is what keeps this safe, and always was —
      // the fork count never did. vitest 5 REMOVED `poolOptions`, so the old
      // `/singleFork:\s*true/` assertion pinned a key the runner had stopped
      // honouring: it passed while the option did nothing.
      expect(config).toMatch(/maxWorkers:\s*1/);
  });

  it('loads the global setup that provisions and guards the database', () => {
    expect(config).toMatch(/globalSetup/);
    expect(config).toContain('integration-global-setup');
  });

  it('loads the setup file that installs the per-test wipe', () => {
    expect(config).toMatch(/setupFiles/);
    expect(config).toContain('integration-setup');
  });

  it('🔴 provisioning happens in globalSetup, never in a per-worker setup file', () => {
    // globalSetup runs ONCE, in the main process, before any worker forks —
    // which is also the only moment DATABASE_URL still holds the DEV value the
    // throwaway guard needs to compare against.
    expect(read('src/test/integration-global-setup.ts')).toMatch(/requireIntegrationDb\(/);
    expect(read('src/test/integration-setup.ts')).not.toMatch(/requireIntegrationDb\(/);
  });
});
