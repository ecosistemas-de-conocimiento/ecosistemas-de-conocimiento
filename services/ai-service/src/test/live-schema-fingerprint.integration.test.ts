// LIVE-SCHEMA FINGERPRINT — the properties that only a real Postgres can prove.
//
// 🔴 WHY THIS FILE EXISTS AND WHY IT CANNOT BE A UNIT TEST.
//
// `integration-database.test.ts` proves the fingerprint's SERIALISATION against
// fixture rows. That is most of it, and it is cheap. But two properties are
// about what POSTGRES RETURNS, not about how we join it up, and no fixture can
// stand in for them:
//
//   1. `format_type()` and `pg_get_expr()` render a name QUALIFIED OR NOT
//      depending on the caller's `search_path`. MEASURED on this
//      repo's own 249-column schema, one session with the default
//      `"$user", public` and one with `search_path = ''`: **17 of 249 rows
//      differed** — every enum type, every enum default, every `nextval(...)`.
//      Unpinned, the fingerprint is a function of WHO IS ASKING. Measured
//      end-to-end on the deployed gate: with the pin removed, two roles reading
//      the SAME unchanged database returned opposite verdicts — `exit 1` and
//      `exit 0`.
//
//   2. `format_type(atttypid, atttypmod)` carries the type MODIFIER.
//      A mutant that reads bare `atttypid` passes every fixture test in the
//      unit file, because the fixtures supply `coltype` ready-made. Only a
//      live `varchar(20) -> varchar(40)` can kill it.
//
// ⚠ This file deliberately mutates the shared integration database — a scratch
// table, and the database-level `search_path` default. Both are restored in
// `finally`/`afterAll`, and both are safe to leak: a leftover scratch table
// makes the NEXT run's stamp mismatch, which REBUILDS. That is this harness's
// safe direction, never a refusal.
//
// ⚠ NO `CREATE ROLE`. An earlier draft made a second role to get a divergent
// `search_path`; that needs CREATEROLE, which a restricted `TEST_DATABASE_URL`
// may not have, and it leaves a CLUSTER-global object behind. `ALTER DATABASE
// ... SET search_path` needs only the database ownership this harness already
// has to create and drop the thing, and it is scoped to the throwaway.

import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import postgres from 'postgres';

import {
  EMPTY_SCHEMA_FINGERPRINT,
  FINGERPRINT_APPLICATION_NAME,
  REPO_ROOT,
  liveSchemaFingerprint,
} from './integration-database.js';
import { assertTestDatabase } from './test-database-guard.js';

const url = (): string => {
  const u = process.env.TEST_DATABASE_URL;
  // 🔴 No skip. globalSetup either resolved a database or threw; if this is
  // unset the runner is broken and the suite must say so, not pass quietly.
  if (!u) throw new Error('TEST_DATABASE_URL is unset — globalSetup did not run.');
  // Belt and braces: everything below issues DDL.
  assertTestDatabase(u, 'live-schema-fingerprint.integration.test.ts');
  return u;
};

/**
 * Run `fn` on a connection whose STARTUP `search_path` is `path`, then close.
 *
 * ⚠ `path` MUST NOT BE `''`. MEASURED: postgres.js silently DROPS an
 * empty startup parameter, and the session falls back to the database default —
 * so a "hide everything" case written as `''` is not hidden at all, and the
 * comparison below quietly compares a schema with itself. The first draft of
 * this file did exactly that; the vacuity guard in the first test is what
 * caught it. Use `'pg_catalog'` for "public is not visible".
 *
 *     requested=""            actual="$user", public   render=callback_delivery_source
 *     requested="pg_catalog"  actual=pg_catalog        render=public.callback_delivery_source
 */
const withSearchPath = async <T>(
  path: string,
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> => {
  const sql = postgres(url(), { max: 1, connection: { search_path: path } });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
};

/**
 * The fingerprint's own query, UNPINNED, run verbatim so the test can watch the
 * rendering move. Kept separate from the real one on purpose: this is the
 * negative control, and it must not accidentally inherit the fix.
 */
const rawRows = (sql: postgres.Sql): Promise<{ row: string }[]> => sql<{ row: string }[]>`
  SELECT n.nspname || E'\t' || c.relname || E'\t' || a.attname || E'\t'
      || format_type(a.atttypid, a.atttypmod) || E'\t' || a.attnotnull || E'\t'
      || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS row
    FROM pg_attribute a
    JOIN pg_class     c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
   WHERE c.relkind IN ('r', 'p')
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\\_toast%'
   ORDER BY n.nspname, c.relname, a.attname
`;

/** `ALTER DATABASE <this one> SET search_path = …`, affecting NEW connections. */
const setDatabaseSearchPath = async (value: string | null): Promise<void> => {
  const sql = postgres(url(), { max: 1 });
  try {
    const db = (await sql<{ d: string }[]>`select current_database() as d`)[0]!.d;
    const quoted = `"${db.replace(/"/g, '""')}"`;
    await sql.unsafe(
      value === null
        ? `ALTER DATABASE ${quoted} RESET search_path`
        : `ALTER DATABASE ${quoted} SET search_path = ${value === '' ? "''" : `'${value}'`}`,
    );
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
};

const SCRATCH = 'lane_c_typemod_probe';

const ddl = async (statement: string): Promise<void> => {
  const sql = postgres(url(), { max: 1 });
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
};

describe('🔴 the live-schema fingerprint does not depend on who is asking', () => {
  afterAll(async () => {
    await setDatabaseSearchPath(null);
  });

  it('the schema really does contain renderings that MOVE — the control is not vacuous', async () => {
    // If this repo's schema had no enums and no sequence defaults, the pin
    // would be untestable here and the assertion below would pass for the wrong
    // reason. Measured: 17 of 249 rows move. Assert it still does.
    const visible = await withSearchPath('public', async (sql) => rawRows(sql));
    // 'pg_catalog', never '' — see `withSearchPath`.
    const hidden = await withSearchPath('pg_catalog', async (sql) => rawRows(sql));

    expect(visible.length, 'no columns found — the whole comparison would be vacuous').toBeGreaterThan(
      0,
    );
    expect(hidden.length).toBe(visible.length);

    const moved = visible.filter((r, i) => r.row !== hidden[i]!.row).length;
    expect(
      moved,
      'no rendering moved between two search_paths, so this file cannot prove the pin does ' +
        'anything. Either the schema lost every enum and every sequence default, or the raw ' +
        'control above stopped being raw.',
    ).toBeGreaterThan(0);
  });

  it('🔴 returns the SAME fingerprint whatever the connection default search_path is', async () => {
    // THE CONTROL. `liveSchemaFingerprint` pins `search_path` in the connection
    // STARTUP PACKET, so the database-level default below must not reach it.
    // Remove that pin and these two values differ — which is exactly the bug
    // that made the deployed gate give two roles opposite verdicts on one
    // unchanged database.
    await setDatabaseSearchPath('public');
    const withPublicVisible = await liveSchemaFingerprint(url());

    await setDatabaseSearchPath('');
    const withNothingVisible = await liveSchemaFingerprint(url());

    expect(withPublicVisible).toMatch(/^[0-9a-f]{16}$/);
    expect(
      withNothingVisible,
      'the fingerprint changed when only the connection default search_path changed. The ' +
        'schema did not move — the RENDERING did (format_type/pg_get_expr qualify names ' +
        'relative to search_path). Restore the `connection: { search_path }` pin.',
    ).toBe(withPublicVisible);
  });

  it('🔴 CHANGES when only a type MODIFIER moves — varchar(20) to varchar(40)', async () => {
    // Kills the mutant that reads bare `atttypid`: the OID is identical across
    // these two, only `atttypmod` moves. No fixture can prove this, because a
    // fixture supplies the rendered type ready-made.
    await setDatabaseSearchPath(null);
    await ddl(`DROP TABLE IF EXISTS "${SCRATCH}"`);
    try {
      await ddl(`CREATE TABLE "${SCRATCH}" (id integer, label varchar(20))`);
      const narrow = await liveSchemaFingerprint(url());

      // ⚠ The relation name is SCHEMA-QUALIFIED: this connection's search_path
      // is pg_catalog, so a bare name does not resolve.
      const oidBefore = await withSearchPath('pg_catalog', async (sql) =>
        sql<{ t: number }[]>`
          select a.atttypid::int as t from pg_attribute a
           where a.attrelid = ${`public.${SCRATCH}`}::regclass and a.attname = 'label'`,
      );
      await ddl(`ALTER TABLE "${SCRATCH}" ALTER COLUMN label TYPE varchar(40)`);
      const oidAfter = await withSearchPath('pg_catalog', async (sql) =>
        sql<{ t: number }[]>`
          select a.atttypid::int as t from pg_attribute a
           where a.attrelid = ${`public.${SCRATCH}`}::regclass and a.attname = 'label'`,
      );
      const wide = await liveSchemaFingerprint(url());

      // The premise: the type OID did NOT move, so only `atttypmod` can carry
      // the difference. Without this the test would pass even if the fix were
      // "hash the OID", which is the mutant it exists to kill.
      expect(oidBefore[0]!.t, 'the type OID moved, so this proves nothing about atttypmod').toBe(
        oidAfter[0]!.t,
      );
      expect(
        wide,
        'widening varchar(20) to varchar(40) did not move the fingerprint. The query is ' +
          'reading the type OID without its modifier — restore format_type(atttypid, atttypmod).',
      ).not.toBe(narrow);
    } finally {
      await ddl(`DROP TABLE IF EXISTS "${SCRATCH}"`);
    }
  });

  it('🔴 the DEPLOYED gate carries the same pin — two search_paths, one verdict', async () => {
    // The drift test in `integration-database.test.ts` hands BOTH implementations
    // the same fake client, so it can prove they serialise alike but NOT that
    // `scripts/schema-gate.mjs` pins the connection it opens for itself. This
    // does, by running the real script the way the container runs it.
    //
    // MEASURED BY HAND before the fix: with the pin removed, the
    // owner exited 1 and a role with a divergent search_path exited 0 — two
    // opposite verdicts on one unchanged database. This is that, automated.
    const gate = path.resolve(REPO_ROOT, 'scripts', 'schema-gate.mjs');
    const runGate = (verb: string): number => {
      try {
        execFileSync(process.execPath, [gate, verb], {
          env: { ...process.env, DATABASE_URL: url() },
          stdio: 'pipe',
        });
        return 0;
      } catch (err) {
        return typeof (err as { status?: number }).status === 'number'
          ? (err as { status: number }).status
          : 1;
      }
    };

    // Stamp under one default, verify under the opposite one.
    await setDatabaseSearchPath('public');
    expect(runGate('stamp'), 'the gate could not stamp the test database').toBe(0);

    await setDatabaseSearchPath('pg_catalog');
    expect(
      runGate('precheck'),
      'the deployed gate refused a database that did not change — only the connection ' +
        "default search_path did. scripts/schema-gate.mjs lost its `connection: { search_path }` " +
        'pin. Unpinned, the gate gives different roles different verdicts on one database.',
    ).toBe(0);
  });

  it('🔴 uses its OWN connection and closes it — it never touches a pooled session', async () => {
    // 🔴 THE LEAK CONTROL. A bare `SET search_path = pg_catalog` on a connection
    // CHECKED OUT OF A POOL returns to the pool still set, so later queries that
    // land on that backend resolve unqualified names against `pg_catalog`
    // instead of `public` — intermittently, by which backend the pool hands
    // out. This asserts the two properties that make that impossible here:
    //
    //   (a) the fingerprint's connection is DEDICATED and CLOSED — no backend
    //       of its own is left behind for anything to be handed;
    //   (b) an unrelated pooled session is byte-identical afterwards — same
    //       backend, same search_path — so nothing was set on somebody else's
    //       connection.
    //
    // Reverting to a bare `SET` on a caller-supplied client breaks (b). Reusing
    // a shared pool instead of opening one breaks (a).
    const pool = postgres(url(), { max: 1 });
    try {
      const before = (
        await pool<{ pid: number; sp: string }[]>`
          select pg_backend_pid() as pid, current_setting('search_path') as sp`
      )[0]!;

      const fingerprint = await liveSchemaFingerprint(url());
      expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);

      const after = (
        await pool<{ pid: number; sp: string }[]>`
          select pg_backend_pid() as pid, current_setting('search_path') as sp`
      )[0]!;

      // Same backend, or the comparison proves nothing about leakage.
      expect(after.pid, 'the pool handed out a different backend — (b) proves nothing').toBe(
        before.pid,
      );
      expect(
        after.sp,
        "an unrelated pooled session's search_path changed while the fingerprint ran. " +
          'Something issued a bare `SET search_path` on a connection it did not own. Pin it in ' +
          'the connection startup packet on a dedicated pool instead.',
      ).toBe(before.sp);

      // (a) — nothing of ours is still connected, checked IMMEDIATELY.
      //
      // 🔴 NO RETRY LOOP HERE, AND THAT IS THE POINT. The first version of this
      // assertion polled for up to 2 s, and MEASURED that made it
      // useless: the fingerprint's pool carries `idle_timeout: 1`, so a version
      // that never calls `.end()` still drops its backend after about a second
      // and the poll waited long enough to watch it happen.
      //
      //     with .end()      immediately=0  +300ms=0  +1800ms=0
      //     without .end()   immediately=1  +300ms=1  +1800ms=0
      //
      // Read immediately and it is deterministic in both directions. A retry
      // loop around a leak check turns the leak into a pass — the exact species
      // of masking this wave exists to remove.
      const leftOver = Number(
        (
          await pool<{ n: string }[]>`
            select count(*) as n from pg_stat_activity
             where application_name = ${FINGERPRINT_APPLICATION_NAME}`
        )[0]!.n,
      );
      expect(
        leftOver,
        `a ${FINGERPRINT_APPLICATION_NAME} backend was still connected when the fingerprint ` +
          'returned. Its connection is meant to be dedicated and CLOSED, not left for an ' +
          'idle timeout to reap.',
      ).toBe(0);
    } finally {
      await pool.end({ timeout: 5 }).catch(() => undefined);
    }
  });

  it("🔴 leaves the caller's OPEN TRANSACTION alone — its ROLLBACK still rolls back", async () => {
    // 🔴 THE CONSEQUENCE CONTROL. Postgres does not nest transactions: a blind
    // `BEGIN … COMMIT` issued on a connection that is ALREADY inside one only
    // warns on the BEGIN, then COMMITS THE CALLER'S transaction — after which
    // their `ROLLBACK` is a no-op and their changes are permanent. Reproduced
    // elsewhere in this fleet: a dropped column survived its own ROLLBACK.
    //
    // Reading `SHOW search_path` cannot see any of that. This asserts the
    // consequence: open a transaction, change the schema in it, fingerprint,
    // roll back, and the change must be GONE.
    //
    // It passes here because `liveSchemaFingerprint` refuses a caller's
    // connection outright and opens its own — there is no transaction anywhere
    // in it. It goes red the moment someone reintroduces a borrowed connection
    // and wraps the pin in `BEGIN`/`COMMIT`.
    //
    // ⚠ `max: 1` is what makes this a real transaction: MEASURED,
    // postgres.js keeps every statement on one backend at that size, so an
    // explicit BEGIN/ROLLBACK issued through `unsafe` is genuinely scoped.
    // ⚠ RESET FIRST, AND SCHEMA-QUALIFY BELOW. Earlier tests in this file leave
    // a database-level `search_path` behind, and an unqualified CREATE TABLE
    // then resolves against it — MEASURED here as
    // `permission denied to create "pg_catalog.lane_c_txn_rollback_probe"`,
    // which is the same failure a stray `SET LOCAL` inflicts on somebody else's
    // transaction. Fitting, and worth leaving written down.
    await setDatabaseSearchPath(null);
    const caller = postgres(url(), { max: 1 });
    const observer = postgres(url(), { max: 1 });
    const probe = 'lane_c_txn_rollback_probe';
    const seen = async (sql: postgres.Sql): Promise<number> =>
      Number(
        (await sql<{ n: string }[]>`select count(*) as n from pg_class where relname = ${probe}`)[0]!
          .n,
      );
    try {
      await caller.unsafe('BEGIN');
      await caller.unsafe(`CREATE TABLE public."${probe}" (id integer)`);
      expect(await seen(caller), 'the setup failed — the probe table was never created').toBe(1);
      expect(await seen(observer), 'an uncommitted table was visible outside its transaction').toBe(
        0,
      );

      // 🔴 HAND IT THE CALLER'S OWN CONNECTION — that is the only call shape
      // that can commit the caller's transaction, so it is the only one this
      // control may use. Today it REJECTS, which is why the rollback below
      // still works. Swap in a version that borrows the connection and wraps
      // the pin in `BEGIN … COMMIT` and this test goes red at the last
      // assertion, with the probe table permanently created.
      //
      // The rejection is swallowed on purpose: this test is about the
      // CONSEQUENCE, not the mechanism. `REFUSES a caller-supplied connection`
      // below is what pins the mechanism.
      await (liveSchemaFingerprint as unknown as (c: unknown) => Promise<string>)(caller).catch(
        () => undefined,
      );

      await caller.unsafe('ROLLBACK');

      expect(
        await seen(observer),
        "the caller's ROLLBACK did not roll back. Something committed a transaction it did " +
          'not open — a blind BEGIN/COMMIT on a borrowed connection does exactly this, and the ' +
          "caller's changes become permanent.",
      ).toBe(0);
    } finally {
      await caller.unsafe('ROLLBACK').catch(() => undefined);
      await caller.unsafe(`DROP TABLE IF EXISTS public."${probe}"`).catch(() => undefined);
      await caller.end({ timeout: 5 }).catch(() => undefined);
      await observer.end({ timeout: 5 }).catch(() => undefined);
    }
  });

  it('🔴 REFUSES a caller-supplied connection instead of borrowing it', async () => {
    // The guarantee above is only structural while this stays true. Typed as
    // `string`, but asserted at RUNTIME too: a JS caller, or a future overload
    // added "just for the gate", would otherwise reopen the whole class.
    const pool = postgres(url(), { max: 1 });
    try {
      await expect(
        (liveSchemaFingerprint as unknown as (c: unknown) => Promise<string>)(pool),
      ).rejects.toThrow(/connection URL, not a client or pool/);
    } finally {
      await pool.end({ timeout: 5 }).catch(() => undefined);
    }
  });

  it('a database with a real schema never reads as empty', async () => {
    // The ignorance sentinel must not be reachable on a migrated database — if
    // it were, the boot gate would silently stop protecting this environment.
    expect(await liveSchemaFingerprint(url())).not.toBe(EMPTY_SCHEMA_FINGERPRINT);
  });
});
