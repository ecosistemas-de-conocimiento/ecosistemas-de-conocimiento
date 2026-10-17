// INTEGRATION DATABASE — provisioning, schema staleness and guards.
//
// 🔴 A MISSING DATABASE MUST NOT LOOK LIKE SUCCESS.
//
// This repo's 16 `*.integration.test.ts` files prove behaviour that only exists
// against a REAL Postgres — pgvector similarity, FK cascades on document
// delete, budget fail-closed, worker retry bookkeeping. A run that cannot reach
// a database must therefore FAIL. There is no skip, no opt-out variable and no
// "warn and continue": a skipped integration test is indistinguishable from a
// passing one, and this fleet has a recorded case of 29 silently-skipped tests
// leaving a suite green.
//
// ── WHAT THIS FILE IS, AND WHAT IT IS NOT ──────────────────────────────────
//
// It is an integration-database harness for a service that is NOT a Payload
// app: Fastify + Drizzle + BullMQ + pgvector. Two properties to know:
//
//   1. `test-database-guard.ts` — the `_test` NAME suffix check AND an
//      OWNERSHIP check (`assertOnlyKnownTables`) that reads the target's real
//      table list and refuses a database holding tables ai-service does not
//      own. `assertThrowaway` can only compare a name against another name it
//      was given; it cannot tell you WHICH SERVER answered. A foreign LIVE
//      Postgres on a default port would pass every name-based check for a URL
//      naming `ai_service_test`. Only the table list,
//      which comes back FROM the server, can see that.
//
//      ⚠ BOTH HALVES WERE STRENGTHENED, after each was MEASURED
//      failing:
//        · the name check is now a positive ALLOWLIST
//          (`THROWAWAY_DATABASE_NAME`) rather than a `_test` suffix plus a
//          list of names to refuse;
//        · the ownership check reads EVERY schema and EVERY relation kind, not
//          `public` BASE TABLEs. A database whose data sat in a schema called
//          `precious_stuff` reported zero public base tables, passed, and was
//          dropped whole while 7 tests reported green;
//        · and it now runs BEFORE `CREATE DATABASE` as well as before every
//          destructive step — with the target absent, `CREATE DATABASE` used
//          to run on whatever cluster answered with nothing checking whose it
//          was (`assertClusterIsOurs`).
//   2. `docker-pg.ts` / `docker-redis.ts` — this suite STARTS ITS OWN
//      throwaway containers on Docker-allocated ephemeral ports, and a server
//      we started cannot be somebody else's. The reference provisions a
//      database on a cluster named by `DATABASE_URI`. Docker stays the
//      DEFAULT here; the cluster-derived path below is the fallback, not the
//      other way round.
//
// ⚠ DELIBERATELY NOT PORTED, because it is Payload machinery with no analogue:
//
//   · `bootPayloadForSuite` / per-suite `getPayload` cache keys — those exist
//     because `getPayload` memoises on `options.key` and `payload.config`
//     builds its adapter at module-evaluation time. ai-service's `db/client.ts`
//     is a plain postgres.js pool read from `process.env` at import; the
//     equivalent ordering hazard is already handled by rebinding
//     `process.env.DATABASE_URL` in `integration-setup.ts` before any dynamic
//     import, which every integration file already relies on.
//   · `closePayloadDb` — the checked-out-client pool leak is a defect in
//     `@payloadcms/db-postgres`'s `connectWithReconnect`. postgres.js has no
//     such boot-time checkout, and this suite's `client.end({ timeout })` calls
//     already settle.
//   · `assertConnectedTo` (`SELECT current_database()`) — its purpose is to
//     catch a SECOND suite in the same process receiving the FIRST suite's
//     already-initialised Payload instance. This repo runs one database for the
//     whole integration lane in one fork, so there is no second instance to
//     confuse. It becomes necessary the day the registry below grows a second
//     entry, and the invariant test says so.
//   · per-worktree database suffixing, per-organization Postgres roles and
//     object-storage sweeps — those fit a service that executes MODEL-GENERATED
//     SQL and needs Postgres itself to enforce the tenant boundary. Nothing here
//     issues a query it did not write, and the docker path already isolates
//     worktrees at the CONTAINER level, which is stronger than name suffixing.
//   · a `ppid`-derived `runId` — it fits a setup where every test file is its own
//     process, so "empty the fixture tables at startup" would fire per file and
//     file two would delete file one's rows. This repo's integration config is
//     `fileParallelism: false` with `singleFork`, and this module is called ONCE
//     from `globalSetup` before any worker forks. One call, one truncate. No run
//     id needed.
//
// ── SCOPE, HONESTLY ────────────────────────────────────────────────────────
//
// On the DOCKER path this file buys little: the container is new every run, so
// there is nothing stale to detect. It earns its keep on the two paths where
// the database OUTLIVES the run:
//
//   · `TEST_DATABASE_URL` pointed at a long-lived database — the CI service
//     container, or a developer who attached psql to a real cluster;
//   · the `DATABASE_URL`-derived fallback below.
//
// On those, a database built from ANOTHER BRANCH's schema is rebuilt rather
// than trusted, and the RAG tables stop accumulating a year of rows.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

import {
  assertOnlyKnownTables,
  assertTestDatabase,
  redactUrl,
  TEST_DATABASE_SUFFIX,
} from './test-database-guard.js';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

/** The repository root — ai-service is its own git root, so there is one path. */
export const REPO_ROOT = path.resolve(dirname, '../..');
/** Where drizzle keeps the applied SQL and its journal. */
export const MIGRATIONS_DIR = path.resolve(REPO_ROOT, 'drizzle');

// ── the registry ────────────────────────────────────────────────────────────

export type IntegrationDbSpec = {
  /** Explicit override, e.g. `TEST_DATABASE_URL`. Named in every failure. */
  envVar: string;
  /** The throwaway database provisioned on whichever cluster we resolve. */
  database: string;
  /** Does this suite need the drizzle schema, or does it build its own tables? */
  schema: 'migrated' | 'empty';
  /**
   * 🔴 TABLES THIS SUITE STARTS FROM EMPTY. Declared here, not in a hook.
   *
   * A suite that never deletes its rows accumulates every row every run has
   * ever written, and a long-lived test database keeps them for months. That is
   * harmless right up until one assertion depends on the GLOBAL row population
   * — and then the suite goes red at a wall-clock instant, on every branch at
   * once, with no commit to blame: a suite that writes ~16 rows per run and
   * deletes none reaches a 500th leftover, and its own fresh row sorts past a
   * `LIMIT 500`.
   *
   * ⚠ THIS REPO HAD THAT GAP. `truncateAll()` wiped nine tables per test and
   * left six — `corpora`, `corpus_aliases`, `documents`, `chunks`,
   * `ingest_requests`, `callback_deliveries` (and now `ingest_jobs`) — untouched, and none of them
   * hangs off a foreign key that `CASCADE` reaches from the nine. Invisible on
   * the docker path (fresh container), permanent on any long-lived database.
   */
  truncate?: string[];
  /**
   * Tables emptied before EVERY TEST, not once per run.
   *
   * ⚠ THIS IS AI-SERVICE'S OWN, AND IT IS STRONGER THAN THE REFERENCE'S
   * once-per-run wipe — every test starts from a known-empty core rather than
   * from whatever the previous test left. It is affordable because the tables
   * are small and the lane is serial. Kept deliberately; the once-per-run
   * `truncate` list above is an ADDITION for the tables this one cannot wipe
   * cheaply (`chunks` carries embeddings, and per-test truncation of it would
   * fight the RAG fixtures that seed in `beforeAll`).
   */
  truncateEachTest?: string[];
};

type IntegrationDbTemplate = IntegrationDbSpec;

const TEMPLATES: Record<string, IntegrationDbTemplate> = {
  /**
   * The whole integration lane. ONE entry, on purpose.
   *
   * `vitest.integration.config.ts` runs `fileParallelism: false` with a single
   * fork because EVERY integration file shares this one database and a GLOBAL
   * `beforeEach` truncate: running files in parallel lets one file's truncate
   * wipe another file's mid-test rows. Giving each file its own database would
   * remove that constraint — and would also multiply provisioning by the file
   * count, for a suite whose files do not fight over fixtures today. Revisit
   * when one does.
   */
  integration: {
    envVar: 'TEST_DATABASE_URL',
    database: 'ai_service_test',
    schema: 'migrated',
    // Once per run, before any test: the tables the per-test wipe leaves alone.
    // ⚠ `chunks` and `corpus_aliases` are absent because `CASCADE` from
    // `documents`/`corpora` reaches them; listing them would be harmless but
    // misleading about what actually holds the rows.
    truncate: [
      'corpora',
      'documents',
      'ingest_requests',
      // No FK reaches `ingest_jobs` (the batch id is a plain uuid column), so
      // CASCADE from `ingest_requests` does NOT empty it — it needs its own entry.
      'ingest_jobs',
      'callback_deliveries',
    ],
    // Before every test. ⚠ `__drizzle_migrations` is deliberately absent —
    // emptying it would make the schema look unbuilt.
    truncateEachTest: [
      'generation_jobs',
      'generation_requests',
      'traces',
      'usage_logs',
      'registry_audit',
      'registry_entries',
      'project_configs',
      'budget_state',
      // Hangs off NO foreign key (`org` is an opaque tag, `job_id`/`trace_id`
      // are plain text), so CASCADE from `budget_state` does not reach it.
      'budget_reservations',
      'llm_configs',
    ],
  },
};

/**
 * 🔴 THE NAMES THIS HARNESS IS ALLOWED TO DESTROY. A POSITIVE ALLOWLIST.
 *
 * ⚠ This is TIGHTER than `assertTestDatabase`'s `_test` suffix, deliberately.
 * That check answers "does this name end in _test", which every product on this
 * fleet can satisfy; this one answers "is this OUR test database". Both run —
 * the suffix check first, because it is the one `integration-setup.ts` repeats
 * inside each worker.
 *
 * The polarity is the point: refuse everything except a name we recognise,
 * rather than accept everything except the few we happen to know. A
 * name-comparison guard can destroy a database while the suite reports green.
 *
 * ⚠ THERE IS NO ESCAPE HATCH, AND ADDING ONE WOULD UNDO THIS. A guard an environment variable can disable is a guard that gets
 * disabled by whoever first hits it at 3am, in the exact situation it was built
 * for. If you need a scratch database, RENAME IT — `ai_service_<whatever>_test`.
 */
export const THROWAWAY_DATABASE_NAME = /^ai_service(?:_[a-z0-9_]+)?_test$/;

/**
 * A database name that plausibly belongs to ai-service AT ALL — the dev
 * database, a test database, anything the service itself would create. Used
 * only by `assertClusterIsOurs` to judge whether a CLUSTER is ours before we
 * create a database on it. Deliberately looser than the allowlist above,
 * because a cluster legitimately holds the dev database next to the test one.
 */
const OUR_DATABASE_ON_A_CLUSTER = /^ai_service(?:_[a-z0-9_]+)?$/;

/** Never counted against a cluster: every Postgres cluster has these. */
const CLUSTER_LEVEL_DATABASES = ['postgres', 'template0', 'template1'];

const resolveSpec = (t: IntegrationDbTemplate): IntegrationDbSpec => {
  // 🔴 The registry and the allowlist must not be allowed to drift. A new suite
  // whose database name the guard would refuse fails HERE, at module load, in
  // every unit run — not at the moment someone finally needs that suite.
  if (!THROWAWAY_DATABASE_NAME.test(t.database)) {
    throw new Error(
      `integration database name "${t.database}" is not a recognised ai-service throwaway ` +
        `(expected ${THROWAWAY_DATABASE_NAME}). Rename the database; do not widen the guard.`,
    );
  }
  // ⚠ Postgres truncates identifiers over 63 bytes SILENTLY. Two suites whose
  // names differ only past byte 63 would then share one database.
  if (Buffer.byteLength(t.database) > 63) {
    throw new Error(
      `integration database name "${t.database}" is ${Buffer.byteLength(t.database)} bytes; ` +
        'Postgres truncates identifiers at 63 and does it silently.',
    );
  }
  return t;
};

export const INTEGRATION_DATABASES: Record<string, IntegrationDbSpec> = Object.fromEntries(
  Object.entries(TEMPLATES).map(([k, t]) => [k, resolveSpec(t)]),
);

export type IntegrationSuiteName = keyof typeof TEMPLATES & string;

// ── finding a cluster ───────────────────────────────────────────────────────

const dotenvValue = (file: string, key: string): string => {
  if (!existsSync(file)) return '';
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1 || line.slice(0, eq).trim() !== key) continue;
    // ⚠ Values in this fleet's dotenv files are sometimes QUOTED. An unstripped
    // quote produces a connection string that fails in a way that looks like a
    // wrong password.
    return line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return '';
};

/** `process.env` first, then the repo-root dotenv files vitest does not load. */
export const envValue = (name: string): string => {
  const live = process.env[name];
  if (live) return live;
  for (const f of ['.env.local', '.env']) {
    const v = dotenvValue(path.join(REPO_ROOT, f), name);
    if (v) return v;
  }
  return '';
};

/**
 * The DEV database's identity — used for its HOST and CREDENTIALS only, and to
 * refuse a test database that turns out to BE it.
 *
 * 🔴 READ THIS ONLY FROM `globalSetup`, AND ONLY BEFORE THE REBIND.
 * `integration-setup.ts` assigns `process.env.DATABASE_URL = TEST_DATABASE_URL`
 * at module scope in every worker, so inside a worker this function would
 * return the TEST url and `assertThrowaway` would compare a value with itself —
 * refusing every run, and then being deleted by whoever hit it. chat-backend
 * has that exact trap on record and works around it by reading dotenv only.
 * Here `globalSetup` runs in the main process BEFORE any worker forks and
 * before any rebind, so `process.env` is still the developer's own.
 */
export const baseDatabaseUrl = (): string => envValue('DATABASE_URL');

export const withDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

export const databaseOf = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
};

/** The same cluster, connected to `postgres`, for CREATE DATABASE and catalog reads. */
const adminUrl = (url: string): string => withDatabase(url, 'postgres');

/**
 * Where this suite's database WOULD be. No network.
 *
 * Order, and it matters:
 *   1. `spec.envVar` — set explicitly by CI, by a developer attaching psql, or
 *      by `integration-global-setup.ts` once it has started a container.
 *   2. Derived from `DATABASE_URL` — a SEPARATE database on the cluster the
 *      developer already named. Used only when Docker is unavailable.
 *   3. Nothing — the caller then FAILS with `missingDatabaseMessage`.
 *
 * ⚠ There is still NO host:port default, and there never will be. The old code
 * fell back to `localhost:55432`, which on this workstation was held by an
 * unrelated product's LIVE Postgres. Deriving from `DATABASE_URL` is different
 * in kind: it is a cluster the developer named on purpose, it creates a new
 * empty database rather than reusing one, and `assertThrowaway` refuses if the
 * two ever resolve to the same name.
 */
export const plannedUrl = (spec: IntegrationDbSpec, baseUrl = baseDatabaseUrl()): string => {
  const override = process.env[spec.envVar];
  if (override) return override;
  if (!baseUrl) return '';
  try {
    return withDatabase(baseUrl, spec.database);
  } catch {
    return '';
  }
};

export const missingDatabaseMessage = (spec: IntegrationDbSpec): string =>
  `This suite needs a Postgres database and cannot find one, so it FAILS rather than skipping.\n\n` +
  `A skipped integration test that reports green is indistinguishable from a passing one. There\n` +
  `is no opt-out variable, and adding one would be a defect.\n\n` +
  `Give it one of these and re-run:\n` +
  `  • Start Docker. This suite then starts its own throwaway Postgres + Redis on\n` +
  `    Docker-allocated ephemeral ports and needs nothing else. This is the normal path.\n` +
  `  • ${spec.envVar}=postgres://…/${spec.database}   — point it at a specific database.\n` +
  `    ⚠ TEST_REDIS_URL is required alongside it; this suite uses BullMQ.\n` +
  `  • DATABASE_URL=postgres://user:pass@host:port/db   — it provisions "${spec.database}"\n` +
  `    on that same cluster, once, and refuses if the two resolve to the same database.\n\n` +
  `⚠ Do NOT hand-write a host:port you did not start. On this workstation 55432 has been\n` +
  `observed holding an unrelated product's LIVE Postgres, and 56379 is the live fleet Redis.`;

/**
 * 🔴 Refuse to run against the database `DATABASE_URL` itself names, or against
 * a cluster-level database.
 *
 * This suite migrates and truncates. Deriving the test database name from
 * `DATABASE_URL` is one typo away from pointing all of that at the shared dev
 * database.
 *
 * ⚠ This is the WEAKER of the two guards in this repo and it runs FIRST because
 * it is free. `assertOnlyKnownTables`, called once we are connected, is the one
 * that can tell which SERVER answered. Neither replaces the other.
 *
 * `baseUrl` is injectable ONLY so a unit test can watch this guard refuse.
 */
export const assertThrowaway = (
  spec: IntegrationDbSpec,
  url: string,
  baseUrl: string = baseDatabaseUrl(),
): void => {
  const database = databaseOf(url);

  // Cluster-level databases, refused with or without a base to compare against.
  // `postgres` is where the admin connection lives; migrating it would break
  // every later `CREATE DATABASE` on the cluster.
  if (CLUSTER_LEVEL_DATABASES.includes(database)) {
    throw new Error(
      `REFUSING TO RUN: "${spec.envVar}" resolves to the cluster-level database "${database}".\n` +
        `This suite runs migrations and TRUNCATE. Point it at a throwaway.\n` +
        `  Resolved target: ${redactUrl(url)}`,
    );
  }

  // 🔴 THE ALLOWLIST. Needs nothing from the environment, so it holds in a
  // fresh worktree with no `.env` — and it refuses by default rather than
  // accepting by default.
  if (!THROWAWAY_DATABASE_NAME.test(database)) {
    throw new Error(
      `REFUSING TO TOUCH "${database || '<unparseable connection URL>'}": it is not a recognised\n` +
        `ai-service throwaway database (expected ${THROWAWAY_DATABASE_NAME}).\n\n` +
        `This suite runs migrations, DROP DATABASE and TRUNCATE. Refusing every name it does not\n` +
        `recognise is the only version of this check that cannot be beaten by a database nobody\n` +
        `thought of — the sibling repos' name-COMPARISON guards were measured on 2026-09-02\n` +
        `destroying real databases while their suites reported green.\n\n` +
        `  Resolved target: ${redactUrl(url)}\n\n` +
        `Unset ${spec.envVar} and let the suite start its own throwaway container, or name the\n` +
        `database ai_service_<something>_test. There is deliberately no variable that turns\n` +
        `this off.`,
    );
  }

  // ⚠ NO `if (!baseUrl) return` HERE ANY MORE. It used to sit above this line
  // and switch the remaining checks off whenever nothing named a dev database —
  // which is a fresh worktree with no `.env`, i.e. the normal state. Only THIS
  // refusal ever depended on configuration, and now it is the only one that does.
  if (baseUrl && database !== '' && database === databaseOf(baseUrl)) {
    throw new Error(
      `REFUSING TO RUN: "${spec.envVar}" resolves to "${database}", which is the database\n` +
        `DATABASE_URL itself names. This suite runs migrations and TRUNCATE against it.\n` +
        `Point it at a throwaway — unset ${spec.envVar} and let the suite start its own\n` +
        `container, or name a database ending in "${TEST_DATABASE_SUFFIX}" that nothing else uses.\n` +
        `  Resolved target: ${redactUrl(url)}`,
    );
  }
};

// ── schema ──────────────────────────────────────────────────────────────────

/**
 * ⚠ `.sql` only. `drizzle/meta/*_snapshot.json` is an input to `drizzle-kit
 * generate`, never applied, so it stays out. `meta/_journal.json` IS applied
 * logic and is folded into the fingerprint separately below.
 */
export const migrationsOnDisk = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

/** The journal drizzle reads to decide what to apply, and in what order. */
export const journalPath = (): string => path.join(MIGRATIONS_DIR, 'meta', '_journal.json');

/**
 * 🔴 DRIZZLE'S LEDGER IS WEAKER THAN PAYLOAD'S, NOT STRONGER.
 *
 * Payload's `payload_migrations` keys on a migration's NAME, which is already
 * enough to run a suite green against another branch's schema. MEASURED HERE in
 * `node_modules/drizzle-orm/pg-core/dialect.js:56-62`, drizzle-orm 0.38.x:
 *
 *     select id, hash, created_at from <ledger> order by created_at desc limit 1
 *     ...
 *     if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis)
 *
 * It reads ONE row — the newest — and compares by `folderMillis`, which is the
 * `when` field in `drizzle/meta/_journal.json`. It STORES a sha256 of the SQL
 * in the `hash` column and NEVER READS IT BACK. So:
 *
 *   · edit `0000_baseline.sql` and leave its `when` alone → drizzle applies
 *     nothing and reports success;
 *   · the fleet's ONE-BASELINE policy regenerates baselines IN PLACE, which is
 *     exactly that case;
 *   · a database at `when` N ignores every migration numbered below N, so a
 *     migration inserted out of order is silently skipped forever.
 *
 * Hence: hash migration CONTENT plus the journal, stamp it on the database, and
 * treat an UNSTAMPED database as stale until proven otherwise.
 */
export const migrationsFingerprint = (): string => {
  const h = createHash('sha256');
  for (const f of migrationsOnDisk()) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(path.join(MIGRATIONS_DIR, f)));
    h.update('\0');
  }
  // ⚠ NOT optional. `when` is the ONLY thing drizzle compares, so a journal
  // edit is a schema change even when no `.sql` byte moved.
  h.update('journal\0');
  h.update(readFileSync(journalPath()));
  return h.digest('hex').slice(0, 16);
};

/**
 * One migration as the stamp records it.
 *
 * ⚠ `sha256` is the FULL 64-hex digest of the FILE BYTES, not this repo's usual
 * 16-hex truncation, and that is on purpose: it is byte-for-byte the value
 * drizzle writes into `__drizzle_migrations.hash` (MEASURED in
 * `node_modules/drizzle-orm/migrator.js`, 0.38.4 — `createHash('sha256')
 * .update(query)` over the file read as a string, which is the same digest as
 * over the bytes for any valid UTF-8 file). An operator reading a stamp during
 * an incident can compare it to the ledger directly.
 */
export type MigrationRecord = {
  tag: string;
  when: number;
  breakpoints: boolean;
  sha256: string;
};

export type MigrationsManifest = { journalSha256: string; entries: MigrationRecord[] };

/**
 * 🔴 THE PER-FILE HALF, AND WHY THE AGGREGATE ABOVE IS NOT ENOUGH ON ITS OWN.
 *
 * `migrationsFingerprint()` collapses the whole migration set to one hash, so
 * "somebody appended 0002" and "somebody edited 0001 in place" both read as
 * "differs". That can cost a rollback: the live-schema half
 * matches, the migrations half does not, the deployed gate exits 1 — on a deploy whose only change was an APPENDED migration.
 *
 * This records the entries individually, IN JOURNAL ORDER (not directory
 * order — the journal is what drizzle executes), so `compareManifests` can ask
 * the sharper question: is the stamped list a STRICT PREFIX of this image's?
 *
 * ⚠ DUPLICATED IN `scripts/schema-gate.mjs`, like the other two fingerprints,
 * and `integration-database.test.ts` fails if the two ever disagree. The reason
 * is the runtime image: it ships no TypeScript.
 */
export const migrationsManifest = (): MigrationsManifest => {
  const journalBytes = readFileSync(journalPath());
  const parsed = JSON.parse(journalBytes.toString()) as {
    entries?: { tag?: unknown; when?: unknown; breakpoints?: unknown }[];
  };
  const entries = (parsed.entries ?? []).map((e) => ({
    tag: String(e.tag),
    when: Number(e.when),
    // Normalised: drizzle reads it as plain truthiness, so `undefined` and
    // `false` are the same instruction and must not read as a change.
    breakpoints: e.breakpoints === true,
    sha256: createHash('sha256')
      .update(readFileSync(path.join(MIGRATIONS_DIR, `${String(e.tag)}.sql`)))
      .digest('hex'),
  }));
  return { journalSha256: createHash('sha256').update(journalBytes).digest('hex'), entries };
};

export type ManifestComparison = {
  verdict: 'identical' | 'appended' | 'diverged';
  appended: string[];
  reason: string;
};

/**
 * IS `stamped` A PREFIX OF `disk`? Pure, so it is driven by fixtures.
 *
 * `'appended'` requires EVERY stamped entry at its own position with the same
 * `tag`, `when`, `breakpoints` and byte-identical SQL, extras only at the END,
 * and each extra's `when` strictly increasing — that last one because drizzle
 * SKIPS an entry whose `when` does not exceed the newest ledger row, so without
 * it the gate would promise an application that silently never happens
 * (`plan/open-drizzle-journal-when-trap.md`).
 *
 * ⚠ DUPLICATED IN `scripts/schema-gate.mjs`. See `migrationsManifest`.
 */
export const compareManifests = (
  stamped: { entries: readonly MigrationRecord[] },
  disk: { entries: readonly MigrationRecord[] },
): ManifestComparison => {
  const s = stamped.entries ?? [];
  const d = disk.entries ?? [];
  const diverged = (reason: string): ManifestComparison => ({
    verdict: 'diverged',
    appended: [],
    reason,
  });

  if (s.length > d.length) {
    const missing = s.slice(d.length).map((e) => e.tag);
    return diverged(
      `the stamp records ${s.length} migration(s) and this image carries only ${d.length}: ` +
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} MISSING from this image. ` +
        `A migration cannot be un-applied by deleting its file.`,
    );
  }

  for (let i = 0; i < s.length; i++) {
    const a = s[i]!;
    const b = d[i]!;
    if (a.tag !== b.tag) {
      return diverged(
        `position ${i} of the journal is "${b.tag}" in this image but "${a.tag}" in the stamp. ` +
          `Migrations were reordered, renamed or removed — not appended.`,
      );
    }
    if (a.when !== b.when) {
      return diverged(
        `"${a.tag}" kept its name but its journal "when" MOVED: stamped ${a.when}, ` +
          `this image ${b.when}. "when" is the only ordering drizzle has, so this changes ` +
          `which migrations it considers applied.`,
      );
    }
    if (a.breakpoints !== b.breakpoints) {
      return diverged(
        `"${a.tag}" kept its name and its "when", but its journal "breakpoints" flag moved: ` +
          `stamped ${a.breakpoints}, this image ${b.breakpoints}. That changes how drizzle ` +
          `splits the file into statements.`,
      );
    }
    if (a.sha256 !== b.sha256) {
      return diverged(
        `"${a.tag}" WAS EDITED IN PLACE — same name, same "when", DIFFERENT BYTES.\n` +
          `             stamped sha256 ${a.sha256}\n` +
          `             this image     ${b.sha256}\n` +
          `             Drizzle will not re-apply it: it compares the newest ledger row's ` +
          `created_at against\n             the journal "when", and never reads back the hash ` +
          `it stored. This database is running\n             the OLD text of "${a.tag}".`,
      );
    }
  }

  if (s.length === d.length) return { verdict: 'identical', appended: [], reason: '' };

  const appended = d.slice(s.length);
  let previous = s.length > 0 ? s[s.length - 1]!.when : Number.NEGATIVE_INFINITY;
  let previousTag = s.length > 0 ? s[s.length - 1]!.tag : '<nothing>';
  for (const e of appended) {
    if (!(e.when > previous)) {
      return diverged(
        `"${e.tag}" is appended but its journal "when" (${e.when}) is not greater than ` +
          `"${previousTag}"'s (${previous}). Drizzle applies an entry only when its "when" ` +
          `exceeds the newest ledger row, so it would SKIP "${e.tag}" and report success. ` +
          `See plan/open-drizzle-journal-when-trap.md.`,
      );
    }
    previous = e.when;
    previousTag = e.tag;
  }

  return { verdict: 'appended', appended: appended.map((e) => e.tag), reason: '' };
};

type JournalEntry = { tag: string; when: number };

const journalEntries = (): JournalEntry[] => {
  const parsed = JSON.parse(readFileSync(journalPath(), 'utf8')) as {
    entries?: { tag?: unknown; when?: unknown }[];
  };
  return (parsed.entries ?? []).map((e) => ({ tag: String(e.tag), when: Number(e.when) }));
};

/** sha256 of a migration's SQL, computed the way drizzle computes it. */
const sqlHash = (tag: string): string =>
  createHash('sha256')
    .update(readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`)).toString())
    .digest('hex');

/**
 * Migrations whose exact (hash, when) pair is NOT recorded in the ledger.
 *
 * ⚠ This is deliberately STRICTER than drizzle's own applicability test. Drizzle
 * asks "is your `when` newer than the single newest row"; this asks "is the
 * content I have on disk the content this database recorded". A database
 * carrying another branch's baseline answers yes to drizzle and no to this.
 */
export const pendingMigrations = async (url: string): Promise<string[]> => {
  const { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } = await import('../db/migrations-config.js');
  const client = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 1 });
  try {
    const rows = await client<{ hash: string; created_at: string }[]>`
      select hash, created_at
        from ${client(MIGRATIONS_SCHEMA)}.${client(MIGRATIONS_TABLE)}
    `;
    const applied = new Set(rows.map((r) => `${r.hash}:${Number(r.created_at)}`));
    return journalEntries()
      .filter((e) => !applied.has(`${sqlHash(e.tag)}:${e.when}`))
      .map((e) => e.tag);
  } catch (err) {
    // 42P01 = the ledger table does not exist, i.e. nothing has ever applied.
    if ((err as { code?: string }).code === '42P01') return journalEntries().map((e) => e.tag);
    throw err;
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
};

/**
 * Run drizzle's migrator, then VERIFY — exiting without throwing is not proof
 * the rows landed, and with drizzle it is not even proof the SQL ran (see
 * `migrationsFingerprint`).
 */
export const ensureSchema = async (url: string): Promise<void> => {
  assertTestDatabase(url, 'ensureSchema()');
  // Import lazily — drizzle-orm/postgres-js loads pg parsers eagerly.
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const { MIGRATIONS_CONFIG } = await import('../db/migrations-config.js');
  const client = postgres(url, { max: 1 });
  try {
    const db = drizzle(client);
    // Same ledger location as production (`public`, not `drizzle`) so the
    // integration DB is shaped like a deployed one.
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR, ...MIGRATIONS_CONFIG });
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }

  const still = await pendingMigrations(url);
  if (still.length > 0) {
    throw new Error(
      `drizzle's migrator returned without error, but ${still.length} migration(s) are still ` +
        `unrecorded on ${databaseOf(url)}: ${still.join(', ')}.\n\n` +
        `This is drizzle's documented weakness, not a fluke: it compares only the NEWEST ledger ` +
        `row's created_at against each migration's journal "when", and never reads the hash it ` +
        `stored. A migration inserted below the high-water mark, or edited in place, is skipped ` +
        `and reported as success. Rebuild the database rather than trusting it.`,
    );
  }
};

// ── the LIVE schema, read out of the database itself ────────────────────────

/**
 * 🔴 The value for a database with NO VISIBLE base tables.
 *
 * Deliberately not a hash: an empty database must never fingerprint-EQUAL a
 * migrated one, and a sha256 of the empty string is a perfectly ordinary hex
 * string that a future refactor could accidentally produce for a real schema.
 * This string cannot be a 16-char hex digest, so the confusion is unavailable.
 *
 * ⚠ "VISIBLE", not "present". Zero rows means IGNORANCE — the database was
 * wiped, or this connection cannot see it. Consumers must treat it as "nothing
 * to compare", never as a schema that differs. `scripts/schema-gate.mjs`
 * short-circuits on it rather than refusing a boot; this harness rebuilds,
 * which is its safe direction.
 */
export const EMPTY_SCHEMA_FINGERPRINT = 'empty-schema';

/**
 * 🔴 THE `search_path` PIN. Every connection used to read the live schema MUST
 * be created through here, and the pin is a CONNECTION-STARTUP parameter rather
 * than a `SET` statement on purpose.
 *
 * `format_type()` and `pg_get_expr()` do not return fixed strings. They render
 * a type or expression QUALIFIED OR NOT depending on whether the object is
 * visible in the CALLER'S `search_path`. MEASURED against
 * this repo's own 249-column `ai_service_test`, one connection with the default
 * `"$user", public` and one with `search_path = ''`:
 *
 *     17 of 249 rows differed.
 *       callback_delivery_source            vs  public.callback_delivery_source
 *       'pending'::callback_delivery_status vs  'pending'::public.callback_delivery_status
 *       nextval('…_id_seq'::regclass)       vs  nextval('public.…_id_seq'::regclass)
 *
 *     With the pin: 0 of 249.
 *
 * So an unpinned fingerprint is a function of WHO IS ASKING, and the gate would
 * refuse to boot a healthy database the day somebody ran
 * `ALTER ROLE <app> SET search_path = …` or revoked the default `USAGE` on
 * `public` from `PUBLIC`. Enums and `nextval` defaults are exactly what this
 * schema is made of, so it is not a corner case here.
 *
 * ⚠ WHY A STARTUP PARAMETER AND NOT `SET search_path = pg_catalog`. A `SET` is
 * per-backend: a pool may answer the `SET` on one connection and the query on
 * another, and a reconnect silently drops it. `connection: {}` is sent in the
 * STARTUP PACKET, so every backend this pool ever opens carries the pin and
 * there is no statement that can land in the wrong place.
 *
 * ⚠ The pin makes every name render QUALIFIED (`public.mood`, not `mood`) for
 * everyone. That is not a cosmetic choice — it is the only rendering that does
 * not depend on the caller.
 */
const pinnedClient = (url: string): postgres.Sql =>
  postgres(url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    connection: { search_path: 'pg_catalog', application_name: FINGERPRINT_APPLICATION_NAME },
  });

/**
 * Names the fingerprint's own backend in `pg_stat_activity`, so a test can prove
 * the connection was DEDICATED and CLOSED rather than borrowed from a pool.
 */
export const FINGERPRINT_APPLICATION_NAME = 'ai-service-schema-fingerprint';

/** One row of the live-schema query. */
export type LiveSchemaRow = {
  nspname: string;
  relname: string;
  attname: string;
  coltype: string;
  attnotnull: boolean;
  coldefault: string | null;
};

/**
 * The SERIALISATION half, pure and synchronous.
 *
 * Split out from the query so the deployed gate's copy can be compared against
 * this one with fixtures, without either side needing a database — and so the
 * connection handling below has exactly ONE shape with no caller-supplied
 * variant to get wrong.
 */
export const fingerprintRows = (rows: readonly LiveSchemaRow[]): string => {
  // 🔴 Zero rows is IGNORANCE, not a fingerprint — see the header.
  if (rows.length === 0) return EMPTY_SCHEMA_FINGERPRINT;
  const serialised = rows
    .map((r) =>
      [r.nspname, r.relname, r.attname, r.coltype, r.attnotnull, r.coldefault]
        // `\N` for NULL, so a NULL value and the literal string "" differ.
        .map((v) => (v === null || v === undefined ? '\\N' : String(v)))
        .join('\t'),
    )
    .join('\n');
  // Same algorithm and same truncation as `migrationsFingerprint` — one
  // convention in this repo, not two.
  return createHash('sha256').update(serialised).digest('hex').slice(0, 16);
};

/**
 * 🔴 THE HALF THAT LOOKS AT THE DATABASE. Fleet-shared shape — see the wave spec.
 *
 * `migrationsFingerprint()` hashes FILE BYTES. It answers "did the migrations
 * change under a stamped database". It cannot answer the other direction: "did
 * the DATABASE change under its stamp". MEASURED against a
 * freshly provisioned `ai_service_test` (249 columns / 16 base tables): dropping
 * `registry_audit` and five columns from `traces` took it to 234 / 15, and
 * `requireIntegrationDb` still returned `{ created: false, rebuilt: false }` —
 * "reused, schema stamp matches" — and left the suite pointed at a database
 * missing a whole table. That is the fleet's defect 3, reproduced in this repo.
 *
 * 🔴 IT READS `pg_catalog`, NOT `information_schema`, AND THAT IS THE WHOLE
 * POINT. `information_schema` is PRIVILEGE-FILTERED: it shows a role only what
 * it may touch. MEASURED against a healthy
 * `ai_service_test` (249 columns, 16 tables), connecting as a role holding
 * CONNECT plus USAGE on `public` and no table grants:
 *
 *     information_schema  →   0 columns
 *     pg_catalog          →  16 relations, full column list
 *
 * Zero rows can be handled with an "ignorance, not emptiness" rule. A PARTIAL
 * grant cannot: it yields a plausible, non-zero, WRONG hash, and the deployed
 * gate would refuse to boot a healthy database because somebody changed a
 * GRANT. `pg_catalog` is world-readable, so the hash does not depend on who is
 * asking. (This is also why `assertDatabaseIsOurs` below reads `pg_class`.)
 *
 * ⚠ RULES, and they are load-bearing:
 *   · COLUMNS ONLY. It must never read the migration ledger's ROWS — the ledger
 *     is what we already know lies (see `migrationsFingerprint`). Reading
 *     `pg_attribute` gets that for free; do not "improve" it into reading rows.
 *   · `format_type(atttypid, atttypmod)` already carries length, precision and
 *     scale (`varchar(20)`, `numeric(10,2)`). Do not add separate columns.
 *   · `relkind IN ('r','p')` — ordinary plus partitioned tables, which is what
 *     `information_schema` called BASE TABLE. Views stay out.
 *   · The DEFAULT is IN on purpose. A dropped-and-re-added default is a real
 *     schema change and nothing else here would see it.
 *   · EVERY non-catalog schema, not just `public`. Deployed dev still carries
 *     the legacy `drizzle.__drizzle_migrations` alongside the `public` one (see
 *     `migrations-config.ts`'s rollout note) — MEASURED: 252 columns
 *     across both schemas where a fresh local database has 249 in one. Those
 *     three are the legacy ledger, not drift; a `public`-only query would have
 *     hidden the difference instead of explaining it.
 *
 * ⚠ HANDED A URL it opens a `search_path`-pinned connection (see
 * `pinnedClient`) and closes it before returning. HANDED A CLIENT it trusts the
 * caller to have pinned it — `scripts/schema-gate.mjs` does, and
 * `live-schema-fingerprint.integration.test.ts` goes red if either pin is
 * removed. Measured: this repo has NO `pg_stat_activity` guard
 * anywhere (`grep pg_stat_activity src scripts drizzle` → 0 hits), and
 * `dropDatabase` uses `WITH (FORCE)`, so a lingering session could not block a
 * rebuild either. If such a guard is ever added, it must run AFTER this call
 * returns — a sibling repo turned a legitimate rebuild into a false refusal
 * exactly that way.
 *
 * Accepts a URL (opens and closes its own connection) or a live client, so the
 * deployed boot gate can reuse the connection it already has.
 */
export const liveSchemaFingerprint = async (url: string): Promise<string> => {
  // 🔴 REFUSES A CALLER'S CONNECTION AT RUNTIME, not just in the type system.
  //
  // This is the whole reason the transaction hazards below cannot reach this
  // repo. A fingerprint that accepts someone else's connection has to wrap its
  // `search_path` pin in something, and every wrapping has a measured way to
  // destroy data or break the caller:
  //
  //   · a blind `BEGIN … COMMIT` COMMITS a transaction the caller already
  //     opened — Postgres does not nest, so the inner BEGIN only warns and the
  //     COMMIT commits the OUTER transaction. The caller's later ROLLBACK is
  //     then a no-op and its changes are permanent. Reproduced elsewhere in
  //     this fleet: a dropped column survived its own ROLLBACK.
  //   · a bare `SET LOCAL` inside someone else's transaction persists until
  //     THEIR transaction ends, breaking their later queries.
  //   · a bare `SET` on a POOLED connection goes back into the pool still set.
  //
  // None of that is mitigated here. It is made unreachable: this function opens
  // its own connection, pins it in the startup packet, uses it for one query,
  // and closes it. There is no transaction at all, so there is nothing to
  // nest, leak or commit.
  if (typeof url !== 'string') {
    throw new TypeError(
      'liveSchemaFingerprint() takes a connection URL, not a client or pool. It opens and ' +
        'closes its own `search_path`-pinned connection on purpose: borrowing a caller\'s ' +
        'connection would mean wrapping the pin in a transaction, and a blind BEGIN/COMMIT ' +
        "commits the caller's open transaction while a bare SET leaks into their session.",
    );
  }
  const client = pinnedClient(url);
  try {
    const rows = await client<LiveSchemaRow[]>`
      SELECT n.nspname, c.relname, a.attname,
             format_type(a.atttypid, a.atttypmod)          AS coltype,
             a.attnotnull,
             coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS coldefault
        FROM pg_attribute a
        JOIN pg_class     c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE c.relkind IN ('r', 'p')
         AND a.attnum > 0
         AND NOT a.attisdropped
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg\\_toast%'
       ORDER BY 1, 2, 3
    `;
    return fingerprintRows(rows);
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
};

// ── the claim stamped on the database ───────────────────────────────────────

/**
 * The stamp written with `COMMENT ON DATABASE`. TWO fingerprints, not one:
 * `migrations` is the FILES, `schema` is the DATABASE. Either differing means
 * stale — see `liveSchemaFingerprint` for what the second one buys.
 */
export type DatabaseClaim = {
  stampedAt: string;
  migrations: string;
  schema: string;
  /** The journal's own bytes. Forensic: an append necessarily moves it, so it is never compared. */
  journalSha256: string;
  /** One record per journal entry, IN ORDER — what tells an APPEND from an EDIT. */
  files: MigrationRecord[];
};

/**
 * What a stamp READ BACK off a database may be. `schema` is optional here and
 * only here: stamps written by older versions have two fields. A stamp without
 * it cannot prove the live schema, so it is stale — see `requireIntegrationDb`.
 */
export type ReadDatabaseClaim = Omit<DatabaseClaim, 'schema' | 'journalSha256' | 'files'> & {
  schema?: string;
  journalSha256?: string;
  files?: MigrationRecord[];
};

/**
 * ⚠ MEASURED on postgres:16 (pgvector/pgvector:pg16): `COMMENT ON DATABASE` may
 * be issued from ANOTHER database on the same cluster, and `shobj_description`
 * reads it back from anywhere — the comment lives in the cluster-wide
 * `pg_shdescription`. So one admin connection does both, and we never open a
 * second pool.
 */
const readClaim = async (
  admin: postgres.Sql,
  database: string,
): Promise<ReadDatabaseClaim | null> => {
  const rows = await admin<{ c: string | null }[]>`
    select shobj_description(oid, 'pg_database') as c from pg_database where datname = ${database}
  `;
  const raw = rows[0]?.c;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw)) as Partial<DatabaseClaim>;
    return parsed.migrations ? (parsed as ReadDatabaseClaim) : null;
  } catch {
    return null;
  }
};

/**
 * 🔴 `url` is required, and the LIVE half is computed HERE — i.e. AFTER the
 * migration step, never before. Stamping a fingerprint taken before `migrate()`
 * would record the schema we are about to replace.
 */
const stampClaim = async (
  admin: postgres.Sql,
  database: string,
  url: string,
): Promise<DatabaseClaim> => {
  const manifest = migrationsManifest();
  const claim: DatabaseClaim = {
    stampedAt: new Date().toISOString(),
    migrations: migrationsFingerprint(),
    schema: await liveSchemaFingerprint(url),
    journalSha256: manifest.journalSha256,
    files: manifest.entries,
  };
  const literal = JSON.stringify(claim).replace(/'/g, "''");
  await admin.unsafe(`COMMENT ON DATABASE "${database.replace(/"/g, '""')}" IS '${literal}'`);
  return claim;
};

// ── cleanup ─────────────────────────────────────────────────────────────────

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Assert a list of table names is safe to interpolate. Exported for the unit test. */
export const assertSafeTableNames = (tables: readonly string[]): void => {
  for (const t of tables) {
    if (!SAFE_IDENTIFIER.test(t)) throw new Error(`unsafe table name: "${t}"`);
  }
};

/**
 * Empty this suite's declared tables. Run at suite START, never at the end, so
 * growth stays bounded even when a run is killed — and so the last run's rows
 * are still there to look at afterwards.
 */
export const truncateFixtureTables = async (
  url: string,
  spec: IntegrationDbSpec,
): Promise<string[]> => {
  if (!spec.truncate?.length) return [];
  assertTestDatabase(url, 'truncateFixtureTables()');
  // ⚠ NAME CHECKS ONLY WERE NOT ENOUGH, and this function is exported, so it
  // cannot rely on `requireIntegrationDb` having checked first. TRUNCATE
  // destroys rows; ask the server whose database this is before issuing one.
  await assertDatabaseIsOurs(url, 'truncateFixtureTables()');
  assertSafeTableNames(spec.truncate);
  const client = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 1 });
  const emptied: string[] = [];
  try {
    await client.unsafe('SET statement_timeout = 30000');
    for (const t of spec.truncate) {
      try {
        await client.unsafe(`TRUNCATE TABLE "${t}" CASCADE`);
        emptied.push(t);
      } catch (err) {
        // A table that does not exist yet is fine; anything else is not.
        if ((err as { code?: string }).code !== '42P01') throw err;
      }
    }
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
  return emptied;
};

// ── guards that need a connection ───────────────────────────────────────────

/**
 * GUARD 2 (ownership) — read the target's table list and refuse if it holds
 * anything ai-service does not own.
 *
 * This is what every name-based check cannot do. The database name travels in
 * the connection string WE wrote; it proves nothing about which server
 * answered. The tables come back FROM the server, so they do. A fresh throwaway
 * database is empty and passes; a foreign live database fails before we drop,
 * migrate or truncate anything.
 */
export const assertDatabaseIsOurs = async (url: string, context: string): Promise<void> => {
  const client = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 1 });
  try {
    // ⚠ EVERY SCHEMA AND EVERY RELATION KIND, not `public` BASE TABLEs.
    //
    // The narrow version was MEASURED failing: a database whose
    // data lived in a schema called `precious_stuff`, with one view in
    // `public`, reported ZERO public base tables — so the ownership check
    // passed, the stamp was missing, the database was judged stale, and
    // `dropDatabase` took the whole thing, `precious_stuff` included. Seven
    // tests passed. `DROP DATABASE` does not care which schema the data was in,
    // so neither may the check that authorises it.
    //
    // Anything outside `public` is reported as `schema.name`, which
    // `assertOnlyKnownTables` cannot match against its bare table names — so a
    // stranger's schema is foreign by construction, with no list to maintain.
    // A real ai-service test database holds 16 relations, all `public` base
    // tables, all known (verified against a provisioned database).
    const rows = await client<{ schema: string; name: string }[]>`
      select n.nspname as schema, c.relname as name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p', 'v', 'm', 'f')
         and n.nspname not in ('pg_catalog', 'information_schema')
         and n.nspname not like 'pg\\_toast%'
       order by 1, 2
    `;
    assertOnlyKnownTables(
      rows.map((r) => (r.schema === 'public' ? r.name : `${r.schema}.${r.name}`)),
      url,
      context,
    );
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
};

/**
 * GUARD 3 (cluster ownership) — asked BEFORE `CREATE DATABASE`, because that is
 * the one moment `assertDatabaseIsOurs` cannot help.
 *
 * 🔴 THE HOLE THIS CLOSES. `assertDatabaseIsOurs` ran
 * only when the target already existed. With the target ABSENT, `CREATE
 * DATABASE` ran on whatever cluster answered and NOTHING checked whose cluster
 * it was: pointed at a server holding `edc_prod` and `cide_registry`, the suite
 * created and migrated `ai_service_test` there and reported 7 tests passed.
 *
 * ⚠ HONEST ABOUT WHAT THIS IS. That path POLLUTES a stranger's cluster; it does
 * not destroy their data, because everything destructive downstream runs
 * against the database we just created. The reason to refuse it anyway is that
 * a stray database is how the NEXT run becomes destructive — it exists now, so
 * the next run takes the `!created` branch, and the check that matters there is
 * only as good as the state we left behind. Unowned scratch databases accumulate
 * exactly this way.
 *
 * The rule, and it is an allowlist like every other check here: every database
 * on the cluster must be one of ours by name, the cluster's own, or the dev
 * database the developer named in `DATABASE_URL`. A fresh throwaway container
 * holds only `postgres` and passes trivially, which is the default path.
 */
export const assertClusterIsOurs = async (
  admin: postgres.Sql,
  url: string,
  baseUrl: string,
  context: string,
): Promise<void> => {
  const rows = await admin<{ datname: string }[]>`
    select datname from pg_database where not datistemplate order by 1
  `;
  const baseName = baseUrl ? databaseOf(baseUrl) : '';
  const foreign = rows
    .map((r) => r.datname)
    .filter(
      (n) =>
        !CLUSTER_LEVEL_DATABASES.includes(n) &&
        !OUR_DATABASE_ON_A_CLUSTER.test(n) &&
        !(baseName !== '' && n === baseName),
    );
  if (foreign.length === 0) return;

  const shown = foreign.slice(0, 12);
  const more = foreign.length > shown.length ? `, … (+${foreign.length - shown.length} more)` : '';
  throw new Error(
    `REFUSED: ${context} was about to CREATE a database on a cluster that is not ai-service's.\n\n` +
      `  Resolved target: ${redactUrl(url)}\n` +
      `  Databases found: ${shown.join(', ')}${more}\n\n` +
      `A cluster holding databases ai-service would never create is somebody else's server. On\n` +
      `2026-08-21 an unrelated product's LIVE Postgres was found on host port 55432, the port\n` +
      `this suite used to default to; on 2026-09-02 this code path was measured creating and\n` +
      `migrating "ai_service_test" on a cluster holding edc_prod and cide_registry, and\n` +
      `reporting 7 tests passed.\n\n` +
      `Nothing was created or modified. Start Docker and let the suite bring up its own\n` +
      `throwaway Postgres on a Docker-allocated port — that is the normal path and a server we\n` +
      `started cannot be somebody else's.`,
  );
};

// ── the single entry point ──────────────────────────────────────────────────

/**
 * 🔴 THE ONLY PLACE A TEST DATABASE COMES INTO EXISTENCE.
 *
 * Kept as one small function so that swapping in `CREATE DATABASE ... TEMPLATE`
 * later is a change HERE and nowhere else — including for the rebuild path,
 * which drops and re-creates through this same call. We do not use a template
 * today: this repo has two migrations that apply in well under a second, so a
 * template would save almost nothing and cost a template-rebuild-and-staleness
 * mechanism forever. That arithmetic changes when the schema or the suite count
 * grows.
 */
const provisionDatabase = async (
  admin: postgres.Sql,
  database: string,
): Promise<{ created: boolean }> => {
  const exists = await admin`select 1 from pg_database where datname = ${database}`;
  if (exists.length > 0) return { created: false };
  await admin.unsafe(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
  return { created: true };
};

/**
 * Drop a stale database so `provisionDatabase` can rebuild it from nothing.
 *
 * ⚠ `WITH (FORCE)` (Postgres 13+) terminates other sessions. That is correct
 * here and only here: this runs in `globalSetup`, before any worker has forked,
 * so the only connections that could exist are leftovers from a killed run.
 *
 * Preferred over `DROP SCHEMA public CASCADE` because it also clears the
 * `vector` extension, any leftover sequence, and anything a hand-run script
 * created outside `public` — and because it keeps creation in ONE function.
 */
const dropDatabase = async (admin: postgres.Sql, database: string): Promise<void> => {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}" WITH (FORCE)`);
};

export type ProvisionResult = {
  url: string;
  /** The database did not exist and was created. */
  created: boolean;
  /** The database existed with a different (or missing) schema stamp and was rebuilt. */
  rebuilt: boolean;
  /** Tables emptied by the once-per-run wipe. */
  truncated: string[];
  /** The migrations-FILE fingerprint now stamped on the database. */
  fingerprint: string;
  /** The LIVE-SCHEMA fingerprint now stamped on the database, read after migrating. */
  schemaFingerprint: string;
  /**
   * Which half said "stale", when one did. `null` when the database was reused
   * or freshly created. Named rather than inferred so the run log can say WHY
   * it rebuilt — "the files moved" and "the database moved" are different
   * incidents with different remedies.
   */
  staleReason: 'unstamped' | 'migrations' | 'schema' | null;
};

/**
 * Resolve, guard, provision, migrate, stamp and clean this suite's database.
 *
 * Called ONCE from `integration-global-setup.ts`, in the main process, before
 * any worker forks.
 */
export const requireIntegrationDb = async (
  spec: IntegrationDbSpec,
  { baseUrl = baseDatabaseUrl() }: { baseUrl?: string } = {},
): Promise<ProvisionResult> => {
  const url = plannedUrl(spec, baseUrl);
  if (!url) throw new Error(missingDatabaseMessage(spec));

  // GUARD 1a (name) — free, and it refuses without opening a socket.
  assertTestDatabase(url, `integration test setup (${spec.envVar})`);
  // GUARD 1b (throwaway) — refuses the dev database and the cluster databases.
  assertThrowaway(spec, url, baseUrl);

  const database = databaseOf(url);
  const fingerprint = migrationsFingerprint();
  let admin: postgres.Sql | undefined;
  let created: boolean;
  let rebuilt = false;
  let staleReason: ProvisionResult['staleReason'] = null;

  try {
    admin = postgres(adminUrl(url), { max: 1, connect_timeout: 5, idle_timeout: 1 });
    // ⚠ Only a CONNECTION failure means "no database to be found". A failed
    // CREATE is a real error and must surface as itself: a broad catch can report a
    // provisioning race as a configuration problem while the tally says `fail 0`.
    await admin`select 1`;
  } catch (err) {
    await admin?.end({ timeout: 5 }).catch(() => undefined);
    throw new Error(
      `${missingDatabaseMessage(spec)}\n\nPostgres said: ${(err as Error).message}`,
    );
  }

  let truncated: string[] = [];
  let stamped: DatabaseClaim;
  try {
    // 🔴 OWNERSHIP IS SETTLED BEFORE ANYTHING IS CREATED, DROPPED, MIGRATED OR
    // TRUNCATED — including the CREATE itself, which is what used to slip
    // through. `provisionDatabase` no longer runs first, so there is no longer
    // an ordering in which a write precedes a check.
    const exists =
      (await admin`select 1 from pg_database where datname = ${database}`).length > 0;

    if (exists) {
      // GUARD 2 (ownership of the DATABASE). A database that holds relations
      // ai-service never creates is not ours, no matter what the URL calls it.
      await assertDatabaseIsOurs(url, `integration test setup (${spec.envVar})`);
    } else {
      // GUARD 3 (ownership of the CLUSTER). We are about to CREATE. There is no
      // database to inspect yet, so the only thing that can be asked is whose
      // server this is.
      await assertClusterIsOurs(admin, url, baseUrl, `integration test setup (${spec.envVar})`);
    }

    ({ created } = await provisionDatabase(admin, database));

    if (spec.schema === 'migrated') {
      // 🔴 An UNSTAMPED database is stale until proven otherwise. `readClaim`
      // returns null both for "never stamped" and for "stamp unparseable", and
      // both mean the same thing: we cannot prove this schema is ours.
      const previous = created ? null : await readClaim(admin, database);
      // 🔴 BOTH HALVES. The files may have moved under a stamped database
      // (`migrations`), or the database may have moved under its stamp
      // (`schema`). Either is stale. Reading the live half here — before
      // `ensureSchema` — is the point: it describes the database we are
      // deciding about, not the one we are about to build.
      const liveBefore = created ? null : await liveSchemaFingerprint(url);
      if (!created) {
        staleReason = !previous
          ? 'unstamped'
          : previous.migrations !== fingerprint
            ? 'migrations'
            : previous.schema !== liveBefore
              ? 'schema'
              : null;
      }
      rebuilt = staleReason !== null;
      if (rebuilt) {
        await dropDatabase(admin, database);
        await provisionDatabase(admin, database);
      }
      await ensureSchema(url);
    }

    // Clear what the LAST run left behind, before this one adds to it. Skipped
    // when we just built the database — there is nothing in it.
    if (!created && !rebuilt) truncated = await truncateFixtureTables(url, spec);

    stamped = await stampClaim(admin, database, url);
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined);
  }

  return {
    url,
    created,
    rebuilt,
    truncated,
    fingerprint,
    schemaFingerprint: stamped.schema,
    staleReason,
  };
};
