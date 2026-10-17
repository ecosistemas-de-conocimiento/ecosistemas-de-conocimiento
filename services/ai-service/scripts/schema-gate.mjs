#!/usr/bin/env node
// SCHEMA GATE — the deployed-boot half of the fleet's schema stamp.
//
//   node scripts/schema-gate.mjs precheck   # BEFORE the migrate step
//   node scripts/schema-gate.mjs stamp      # AFTER the migrate step succeeds
//
//   node scripts/schema-gate.mjs adopt-append --expect <tag>[,<tag>...]
//                                             # OPERATOR ONLY, never in a deploy
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// 🔴 DRIZZLE'S LEDGER CANNOT SEE AN EDITED MIGRATION. MEASURED,
// drizzle-orm 0.38.4, `node_modules/drizzle-orm/pg-core/dialect.js`
// lines 56-62:
//
//     select id, hash, created_at from <ledger> order by created_at desc limit 1
//     ...
//     if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis)
//
// It reads ONE row, compares by the journal's `when`, and never reads back the
// sha256 it stored in `hash`. The measurement: a throwaway database migrated to
// 249 columns / 16 tables; `drizzle/0000_baseline.sql` then edited in place to
// append `CREATE TABLE "lanec_probe"`, journal untouched; `node dist/db/
// migrate.js` re-run. It printed "Migrations complete.", exited 0, and left the
// database at 249 columns / 16 tables with `lanec_probe` absent and the ledger
// byte-identical — still carrying the ORIGINAL file's hash.
//
// A dev-phase policy that regenerates the ONE baseline IN PLACE makes that the
// normal case, not a corner case.
//
// 🔴 NOT A NAME RULE. Rodrigo removed two of those. This compares CONTENT: a
// hash of the migration files, and a hash of the live schema read out of the
// database itself.
//
// ── THE STAMP ──────────────────────────────────────────────────────────────
//
// `COMMENT ON DATABASE`, read back with `shobj_description`. FIVE fields:
//
//   { stampedAt, migrations, schema, journalSha256, files: [ … ] }
//
//   · `migrations` — sha256 of the migration FILE BYTES plus `meta/_journal.
//     json`. Answers "did the files move under this database". KEPT, but no
//     longer the thing precheck decides on — see the append section below.
//   · `schema` — sha256 of the LIVE column list. Answers "did this database
//     move under its stamp". Without it, dropping a table and five columns from
//     a stamped database still reads as current — MEASURED in this repo's test
//     harness the same day: 249 → 234 columns, still "reused, stamp matches".
//   · `files` — ONE RECORD PER JOURNAL ENTRY, IN JOURNAL ORDER:
//     `{ tag, when, breakpoints, sha256 }`. This is what makes an APPEND
//     distinguishable from an EDIT.
//   · `journalSha256` — the journal's own bytes. Forensic only; it is NOT
//     compared, because an append necessarily moves it. What the gate compares
//     is the per-entry `tag`/`when`/`breakpoints` triple, which is EXACTLY what
//     drizzle reads out of the journal — MEASURED in
//     `node_modules/drizzle-orm/migrator.js`, drizzle-orm 0.38.4:
//     `readMigrationFiles` uses `journalEntry.tag` (to find the file),
//     `journalEntry.when` (as `folderMillis`) and `journalEntry.breakpoints`
//     (as `bps`). `idx`, `version` and `dialect` are read by nothing.
//
// ── APPENDED vs EDITED: WHY THE PER-FILE LIST EXISTS ───────────────────────
//
// 🔴 THE AGGREGATE `migrations` HASH CANNOT TELL THE TWO APART, and that cost a
// rollback: the schema half matched, the migrations half differed, the gate
// exited 1 and the deploy rolled back. The gate was
// right to be suspicious and wrong to be certain — "the bytes in ./drizzle are
// not the bytes I stamped" covers BOTH "somebody appended 0002" (normal, and
// the whole point of leaving the one-baseline dev phase) and "somebody edited
// 0001 in place" (the incident this file was built for).
//
// So the stamp records the entries individually and precheck asks a sharper
// question: is what I stamped a STRICT PREFIX of what this image carries?
//
//   · every stamped entry appears at the same position, with the same `tag`,
//     the same `when`, the same `breakpoints` and byte-identical SQL;
//   · anything extra is only ever at the END.
//
// Then, and only then, the extra entries are migrations this image is about to
// APPLY, which is a deploy, not drift.
//
// ⚠ THE APPENDED ENTRIES' `when` VALUES ARE CHECKED TOO, and this is not
// pedantry. Drizzle skips any entry whose `when` is not greater than the newest
// row in the ledger — `plan/open-drizzle-journal-when-trap.md` records this
// repo losing three deploys to it. Without the check the gate would
// print "migrate will apply them", drizzle would silently apply nothing, and
// `stamp` would then write a stamp claiming they HAD been applied. The gate
// would have manufactured the exact false green it exists to prevent.
//
// ⚠ Both halves are duplicated from `src/test/integration-database.ts` on
// purpose, and `src/test/integration-database.test.ts` FAILS if the two ever
// disagree. The reason for the duplication is the runtime image: it ships
// `dist/`, `drizzle/`, `package.json` and production `node_modules` — no
// TypeScript, no `tsx`. This file is plain `.mjs` importing only `node:*` and
// `postgres` (a runtime dependency), so it runs in the container exactly as it
// runs here. The repo already carries this shape for `drizzle.config.ts` vs
// `src/db/migrations-config.ts`, with the same kind of drift test.
//
// ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
//
// 🔴 THERE IS NO ESCAPE HATCH. No `FORCE=1`, no `SKIP_SCHEMA_GATE`. A guard an
// environment variable can switch off is a guard that gets switched off by
// whoever first hits it at 3am, in the exact situation it was built for. Two
// guards in this fleet died that way. If the gate refuses, the remedy is the
// remedy: wipe, migrate, reseed.
//
// ⚠ `adopt-append` IS NOT AN EXCEPTION TO THAT, and the difference is worth
// being precise about, because "it's only a one-time migration helper" is how
// the escape hatches got in elsewhere. It:
//
//   · is a VERB an operator types, never an env var a deploy can carry. Nothing
//     in the Dockerfile, `db:migrate:prod` or Coolify can reach it.
//   · takes the tags it is allowed to account for EXPLICITLY (`--expect`), so
//     the operator states the claim and the command checks it.
//   · REFUSES unless it can PROVE the old set byte-for-byte (see its own
//     header). It never takes the operator's word for anything.
//   · BLESSES NOTHING NEW. It rewrites an old aggregate-only stamp into the
//     per-file shape describing THE SAME OLD MIGRATION SET. After it runs, the
//     next `precheck` still has to reach the "strict prefix" verdict on its
//     own. It is a stamp-FORMAT upgrade, not an adoption.
//
// There is still no way to make a refusal go away by asserting it should.
//
// ⚠ `stamp` HAS ONE REFUSAL OF ITS OWN, and it is not a schema verdict: it
// reads `max(created_at)` out of the migration ledger and exits 1 without
// writing anything when that is not the last journal entry's `when` — i.e. when
// the migrate step did not actually apply what this image carries. Stamping
// there would freeze a false "current" in place. See its header.
//
// It also never exits 1 for a reason that is not staleness:
//   · cannot reach the database → the migrate step immediately after this one
//     produces that error properly; duplicating connection diagnostics here
//     would only make a network blip look like schema drift.
//   · `COMMENT ON DATABASE` refused → log loudly and continue. MEASURED
//     on all four deployed environments (dev/stage/prod/demo-0,
//     `data` box, port 5436/5437/5438/5447): the app's role is `ai_service`,
//     `rolsuper = t`, and `pg_database.datdba` is `ai_service` itself — so the
//     stamp IS permitted today. The branch exists for the day someone tightens
//     that, not because it fires now.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';
import postgres from 'postgres';

// Same as `src/config/env.ts`, so `npm run db:migrate` locally sees the same
// DATABASE_URL the migrate step it wraps will see. In the container there is no
// dotenv file and Coolify supplies real env vars, so this is a no-op there —
// but without it the gate would silently do nothing on a developer's machine
// while doing its job in production, which is exactly the per-environment
// divergence this fleet treats as a defect.
loadDotenv();

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** `<repo|/app>/drizzle` — present in the runtime image (`COPY --from=build /app/drizzle`). */
const MIGRATIONS_DIR = path.resolve(dirname, '..', 'drizzle');

/**
 * WHERE DRIZZLE'S MIGRATION LEDGER LIVES, duplicated from
 * `src/db/migrations-config.ts` for the same reason both fingerprints are: this
 * file is plain `.mjs` running in an image that ships no TypeScript, so it
 * cannot import the `.ts` source of truth. `src/test/integration-database.test.
 * ts` FAILS if the two ever disagree — the same shape `drizzle.config.ts`
 * already has, guarded by `src/db/migrations-config.test.ts`.
 *
 * 🔴 `public`, NOT drizzle-kit's own `drizzle` default. Read the rollout note
 * in `src/db/migrations-config.ts` before changing either literal: the runtime
 * migrator resumes from ONE row of this table, so pointing it somewhere else
 * makes a populated database look unmigrated.
 */
export const MIGRATIONS_SCHEMA = 'public';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * 🔴 The value for a database with NO VISIBLE base tables. Deliberately not a
 * hash, so an unmigrated database can never fingerprint-equal a migrated one —
 * and never treated as "differs", because zero rows means ignorance. See the
 * decision table on `precheck`.
 */
const EMPTY_SCHEMA_FINGERPRINT = 'empty-schema';

/**
 * ⚠ `.sql` ONLY, plus the journal — and that is COMPLETE for drizzle, not a
 * gap. The fleet spec's `.js`/`.mjs`/`.cjs` widening is a PAYLOAD fix: Payload
 * executes `migrations/*.ts` and `*.js`. Drizzle executes neither. MEASURED in
 * `node_modules/drizzle-orm/migrator.js`: `readMigrationFiles` reads
 * `meta/_journal.json` and, for each entry, exactly `<tag>.sql`. Widening the
 * filter here would hash files drizzle never applies — which in this script
 * means a no-op file could EXIT 1 a deploy. See the report in
 * `integration-database.test.ts` for the measurements.
 */
const migrationsOnDisk = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

const journalPath = () => path.join(MIGRATIONS_DIR, 'meta', '_journal.json');

/** sha256 of every migration file plus the journal, truncated to 16 hex chars. */
export const migrationsFingerprint = () => {
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
 * The PER-FILE half: one record per JOURNAL entry, in journal order.
 *
 * 🔴 DRIVEN BY THE JOURNAL, NOT BY `readdirSync`. The journal is what drizzle
 * executes and in what order — a `.sql` file no entry names is never applied,
 * and two entries could in principle name the same file. Ordering by the
 * directory listing would make "prefix" a claim about filenames; ordering by
 * the journal makes it a claim about what runs.
 *
 * ⚠ FULL 64-hex sha256 here, unlike the two 16-hex aggregate fingerprints, and
 * over the file BYTES. That is deliberate: it is byte-for-byte the value
 * drizzle itself stores in `__drizzle_migrations.hash` (MEASURED in
 * `node_modules/drizzle-orm/migrator.js`: `createHash('sha256').update(query)`
 * where `query` is the file read as a string — identical to hashing the bytes
 * for any valid UTF-8 file). So an operator debugging an incident can compare
 * this stamp against the ledger directly, with no re-derivation.
 *
 * ⚠ THROWS if a journal entry names a file that is not there. That is not a
 * staleness verdict and must never become one — `precheck`'s outer catch turns
 * it into "could not check, continuing", and the migrate step immediately after
 * throws `No file <tag>.sql found` properly. Same posture as an unreachable
 * database.
 */
export const migrationsManifest = () => {
  const journalBytes = readFileSync(journalPath());
  const parsed = JSON.parse(journalBytes.toString());
  const entries = (parsed.entries ?? []).map((e) => ({
    tag: String(e.tag),
    when: Number(e.when),
    // Normalised to a boolean: drizzle uses it as a plain truthiness test for
    // `--> statement-breakpoint` splitting, so `undefined` and `false` are the
    // same instruction and must not read as a change.
    breakpoints: e.breakpoints === true,
    sha256: createHash('sha256')
      .update(readFileSync(path.join(MIGRATIONS_DIR, `${String(e.tag)}.sql`)))
      .digest('hex'),
  }));
  return { journalSha256: createHash('sha256').update(journalBytes).digest('hex'), entries };
};

/**
 * AN AGGREGATE OVER EXACTLY THE FILES THE JOURNAL NAMES. For the boot log only
 * — nothing decides on it.
 *
 * ⚠ IT IS NOT `migrationsFingerprint()` AND MUST NEVER BE COMPARED AGAINST A
 * STAMPED `migrations` VALUE. That one folds in every `.sql` in the directory
 * (the same rule `adopt-append`'s byte proof reconstructs); this one folds in
 * the journal's entries and their hashes, so a stray unreferenced `.sql` moves
 * the first and not the second. They are different numbers on purpose, and the
 * log line that prints this one says which it is.
 *
 * WHY IT EXISTS: on the per-file path the stamped `migrations` value is not
 * checked at all — the per-entry sha256s are what decide — so printing it would
 * be printing a number this boot never verified. MEASURED: drop a stray
 * `0009_x.sql` into `drizzle/` and the stamped aggregate stops describing the
 * directory, while the boot log kept reporting it as if it did.
 */
export const manifestFingerprint = (manifest) => {
  const h = createHash('sha256');
  for (const e of manifest.entries ?? []) {
    h.update(e.tag);
    h.update('\0');
    h.update(e.sha256);
    h.update('\0');
  }
  h.update('journal\0');
  h.update(String(manifest.journalSha256 ?? ''));
  return h.digest('hex').slice(0, 16);
};

/**
 * `.sql` files sitting in `drizzle/` that NO journal entry names.
 *
 * Drizzle never applies one — `readMigrationFiles` walks the journal — so this
 * is INFORMATIONAL and never a refusal. It is worth a line in the boot log
 * anyway: such a file is invisible to the per-file comparison yet DOES move
 * `migrationsFingerprint()`, so it is the difference between the two aggregates
 * above and the most likely reason a `db:generate` went half-committed.
 */
export const unreferencedSqlFiles = (manifest) => {
  const named = new Set((manifest.entries ?? []).map((e) => `${e.tag}.sql`));
  return migrationsOnDisk().filter((f) => !named.has(f));
};

/**
 * IS `stamped` A PREFIX OF `disk`? The whole append-vs-edit decision, pure and
 * synchronous so both the unit suite and the harness can drive it with
 * fixtures and no database.
 *
 * Returns `{ verdict, appended, reason }`:
 *   · `'identical'` — same entries, same order, same bytes. Nothing to do.
 *   · `'appended'`  — every stamped entry matches at its own position and the
 *                     only difference is extra entries AT THE END, each with a
 *                     strictly increasing `when`. `appended` names their tags.
 *   · `'diverged'`  — anything else. `reason` says which entry and how, because
 *                     "the migrations half does not match" is the message that
 *                     turns a one-minute diagnosis into an hour.
 *
 * 🔴 EVERY NON-PREFIX SHAPE IS `diverged`, INCLUDING THE ONES THAT LOOK
 * HARMLESS. A stamped entry that reappears LATER in the list is not an append:
 * drizzle would run it against a database that already has it. A stamped entry
 * that is gone is not an append either — the database carries SQL this image no
 * longer describes. Both fall out of the position-by-position walk below, and
 * neither is special-cased.
 */
export const compareManifests = (stamped, disk) => {
  const s = stamped.entries ?? [];
  const d = disk.entries ?? [];
  const diverged = (reason) => ({ verdict: 'diverged', appended: [], reason });

  if (s.length > d.length) {
    const missing = s.slice(d.length).map((e) => e.tag);
    return diverged(
      `the stamp records ${s.length} migration(s) and this image carries only ${d.length}: ` +
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} MISSING from this image. ` +
        `A migration cannot be un-applied by deleting its file.`,
    );
  }

  for (let i = 0; i < s.length; i++) {
    const a = s[i];
    const b = d[i];
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

  // 🔴 THE `when` MONOTONICITY OF THE APPENDED RUN. See the header: without
  // this, the gate promises an application drizzle will silently not perform,
  // and `stamp` then records it as done.
  const appended = d.slice(s.length);
  let previous = s.length > 0 ? s[s.length - 1].when : Number.NEGATIVE_INFINITY;
  let previousTag = s.length > 0 ? s[s.length - 1].tag : '<nothing>';
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

/**
 * sha256 of the LIVE column list, read from `pg_catalog`.
 *
 * 🔴 `pg_catalog`, NOT `information_schema`, and the difference is the whole
 * point. `information_schema` is PRIVILEGE-FILTERED — it shows a role only what
 * it may touch. MEASURED against a healthy
 * `ai_service_test` (249 columns, 16 tables) as a role with CONNECT + USAGE and
 * no table grants: `information_schema` returned 0 columns, `pg_catalog`
 * returned all 16 relations. Zero rows can be absorbed by the ignorance rule
 * below; a PARTIAL grant cannot — it produces a plausible, non-zero, WRONG hash
 * and this script would refuse to boot a healthy database because somebody
 * changed a GRANT. `pg_catalog` is world-readable, so the hash does not depend
 * on who is asking.
 *
 * ⚠ Columns only — it must never read the migration ledger's ROWS, which are
 * the thing already known to lie. `format_type` already carries length,
 * precision and scale, so no extra columns for them. The DEFAULT is included on
 * purpose: a dropped-and-re-added default is a real schema change and nothing
 * else here would see it.
 */
/**
 * The SERIALISATION half, pure and synchronous. Split out so
 * `integration-database.test.ts` can compare it against the harness's copy with
 * fixtures, no database on either side.
 */
export const fingerprintRows = (rows) => {
  if (rows.length === 0) return EMPTY_SCHEMA_FINGERPRINT;
  const serialised = rows
    .map((r) =>
      [r.nspname, r.relname, r.attname, r.coltype, r.attnotnull, r.coldefault]
        .map((v) => (v === null || v === undefined ? '\\N' : String(v)))
        .join('\t'),
    )
    .join('\n');
  return createHash('sha256').update(serialised).digest('hex').slice(0, 16);
};

export const liveSchemaFingerprint = async (url) => {
  // 🔴 REFUSES A CALLER'S CONNECTION. Borrowing one would mean wrapping the
  // `search_path` pin in a transaction, and a blind `BEGIN … COMMIT` COMMITS a
  // transaction the caller already opened (Postgres does not nest — the inner
  // BEGIN only warns, the COMMIT commits the OUTER one, and the caller's
  // ROLLBACK becomes a no-op). A bare `SET LOCAL` inside their transaction
  // persists until it ends; a bare `SET` on a pooled connection returns to the
  // pool still set. This opens its own connection, pins it in the STARTUP
  // PACKET, runs one query and closes it — no transaction, nothing to nest.
  if (typeof url !== 'string') {
    throw new TypeError(
      'liveSchemaFingerprint() takes a connection URL, not a client or pool.',
    );
  }
  const client = pinnedClient(url);
  try {
    const rows = await client`
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

// ── plumbing ───────────────────────────────────────────────────────────────

const LABEL = '[schema-gate]';

const databaseUrl = () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Same posture as a connection failure: this is not staleness. The migrate
    // step next in the chain reports a missing DATABASE_URL properly.
    console.error(`${LABEL} DATABASE_URL is unset — nothing to check. Continuing.`);
    return null;
  }
  return url;
};

/**
 * 🔴 THE `search_path` PIN, IN THE CONNECTION STARTUP PACKET.
 *
 * `format_type()` and `pg_get_expr()` render a name QUALIFIED OR NOT depending
 * on the caller's `search_path`. MEASURED on this repo's own
 * 249-column schema: **17 of 249 rows differed** between a session with the
 * default `"$user", public` and one where `public` is not visible — every enum
 * type, every enum default, every `nextval(...)`. With the pin, 0 of 249.
 * Measured end-to-end: with the pin removed, two roles reading the SAME
 * unchanged database got opposite verdicts, `exit 1` and `exit 0`.
 *
 * ⚠ WHY NOT `SET search_path = pg_catalog`. A bare `SET` on a connection
 * CHECKED OUT OF A POOL goes back into the pool still set, so later queries on
 * that backend resolve unqualified names against `pg_catalog` — intermittently,
 * depending on which backend the pool hands out. `SET LOCAL` inside an explicit
 * transaction fixes that, but this is stronger and simpler: the parameter is
 * sent in the STARTUP PACKET, so it cannot be lost to a reconnect and cannot
 * land on the wrong backend — and the pool is DEDICATED to one fingerprint read
 * and closed straight after, so there is nothing to leak into.
 */
const pinnedClient = (url) =>
  postgres(url, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 2,
    connection: { search_path: 'pg_catalog', application_name: 'ai-service-schema-fingerprint' },
  });

/** The gate's own connection: stamp reads and writes. NOT the fingerprint's. */
const connect = (url) => postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 2 });

/** The stamp on the database this connection is attached to, or null. */
const readClaim = async (client) => {
  const rows = await client`
    select current_database() as db,
           shobj_description(oid, 'pg_database') as c
      from pg_database
     where datname = current_database()
  `;
  const db = rows[0]?.db ?? '<unknown>';
  const raw = rows[0]?.c;
  if (!raw) return { db, claim: null };
  try {
    const parsed = JSON.parse(String(raw));
    return { db, claim: parsed && parsed.migrations ? parsed : null };
  } catch {
    // An unparseable stamp is the same as no stamp: we cannot know.
    return { db, claim: null };
  }
};

/**
 * 🔴 THE MIGRATION LEDGER'S HEAD ROW — THE ONE THING THE STAMP CANNOT INFER.
 *
 * Both fingerprints read the DISK and the LIVE SCHEMA. Neither can see whether
 * the migrate step actually ran: a database can carry the right columns because
 * somebody built them by hand, and an image can carry four migration files
 * while the ledger holds two. `stamp` used to write down "four applied" purely
 * because four files existed.
 *
 * MEASURED in this repo, drizzle-orm 0.38.4 (`pg-core/dialect.js:62-67`):
 * drizzle writes `created_at = migration.folderMillis`, and `folderMillis` is
 * the journal entry's `when` (`migrator.js:22`). So on a database that has
 * applied everything this image carries, `max(created_at)` EQUALS the last
 * journal entry's `when` — exactly, not approximately. That equality is the
 * check.
 *
 * ⚠ `to_regclass` first, and it is name resolution rather than a privilege
 * test, so a role that may not SELECT the table throws from the query below
 * instead of reporting "absent". That throw is handled where it is raised: the
 * callers treat an unreadable ledger as "could not check", never as a refusal —
 * same posture as an unreachable database.
 */
const ledgerHead = async (client) => {
  const qualified = `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`;
  const present = await client`select to_regclass(${qualified}) is not null as present`;
  if (!present[0]?.present) return { present: false, when: null, rows: 0 };
  const rows = await client.unsafe(
    `select count(*)::text as n, max(created_at)::text as m ` +
      `from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`,
  );
  const max = rows[0]?.m;
  return {
    present: true,
    // `created_at` is a bigint of epoch MILLISECONDS, so every real value is
    // far inside Number's exact-integer range; `::text` keeps the driver from
    // deciding the representation for us.
    when: max === null || max === undefined ? null : Number(max),
    rows: Number(rows[0]?.n ?? 0),
  };
};

/**
 * Does the ledger agree that `expected` is the newest migration APPLIED to this
 * database? `null` when it does; otherwise the sentence that says how it does
 * not, naming both numbers.
 *
 * `expected` is `null` for an empty journal — an image with no migrations
 * claims nothing, so there is nothing to disagree with.
 */
const ledgerDisagreement = (head, expected) => {
  const table = `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`;
  if (expected === null) return null;
  if (!head.present)
    return (
      `the migration ledger ${table} DOES NOT EXIST, so nothing has ever been applied to ` +
      `this database — but the journal's last entry is "${expected.tag}" (when=${expected.when}).`
    );
  if (head.when === null)
    return (
      `the migration ledger ${table} exists but is EMPTY (0 rows), so nothing has been ` +
      `applied — but the journal's last entry is "${expected.tag}" (when=${expected.when}).`
    );
  if (head.when !== expected.when)
    return (
      `the ledger's newest created_at is ${head.when} (${table}, ${head.rows} row(s)), but ` +
      `the journal's last entry "${expected.tag}" has when=${expected.when}.\n    ` +
      `Drizzle stores created_at = the journal's "when" (measured, dialect.js:67), so on a ` +
      `database that has applied everything this image carries these two numbers are EQUAL.`
    );
  return null;
};

/** The last journal entry as `{ tag, when }`, or `null` for an empty journal. */
const lastJournalEntry = (manifest) => {
  const entries = manifest.entries ?? [];
  return entries.length === 0 ? null : entries[entries.length - 1];
};

const remedy = (db) =>
  `\n  REMEDY — in this order, no other order works:\n` +
  `    1. WIPE    the database (drop it, or drop schema public cascade) on ${db}\n` +
  `    2. MIGRATE it from the migrations in this image\n` +
  `    3. RESEED  whatever content that environment needs\n\n` +
  `  There is deliberately no variable that lets this boot continue.`;

// ── precheck ───────────────────────────────────────────────────────────────

/**
 * | what we can see                        | meaning                          | action |
 * |----------------------------------------|----------------------------------|--------|
 * | stamp absent                           | never stamped; we cannot know    | ADOPT  |
 * | NO base tables visible                 | wiped, or grants hide it         | ADOPT  |
 * | per-file list IDENTICAL to disk        | current                          | silent |
 * | per-file list is a STRICT PREFIX       | migrations appended; a deploy    | ALLOW  |
 * | a stamped file's BYTES moved           | edited in place                  | EXIT 1 |
 * | a stamped file is missing / reordered  | the db has SQL this image lacks  | EXIT 1 |
 * | a stamped `when`/`breakpoints` moved   | drizzle's ordering changed       | EXIT 1 |
 * | an appended `when` is not increasing   | drizzle would SKIP it            | EXIT 1 |
 * | LEGACY stamp, aggregate matches        | current                          | silent |
 * | LEGACY stamp, aggregate differs        | cannot prove which; see below    | EXIT 1 |
 * | `schema` differs                       | the db moved under its stamp     | EXIT 1 |
 *
 * ⚠ A `.sql` file on disk that NO journal entry names produces a WARN and
 * changes no verdict — drizzle never applies one. It is logged because it is
 * invisible to every comparison in this table while still moving
 * `migrationsFingerprint()`.
 *
 * 🔴 THE TWO HALVES ARE INDEPENDENT AND BOTH ALWAYS RUN. An ALLOWED append does
 * NOT excuse the live-schema half: a deploy that appends 0002 to a database
 * somebody hand-altered still exits 1, on the schema half. "Appended" is a
 * verdict about the FILES only.
 *
 * 🔴 A LEGACY STAMP WHOSE AGGREGATE DIFFERS EXITS 1, AND THAT IS THE SAFE
 * READING RATHER THAN A CONSERVATIVE ONE. Stamps written before this change
 * carry only `{ stampedAt, migrations, schema }` — one hash over the whole
 * migration set. From one hash there is NO WAY to tell an appended set from an
 * edited one: both simply differ. Refusing is the only verdict the evidence
 * supports.
 *
 * ⚠ THE COST, STATED: `ai_service_dev` is in exactly that position. It was
 * stamped 2026-09-08T11:41Z with `migrations 9f9571378be35c6e` over {0000, 0001}
 * and the next image carries {0000 … 0003}, so it exits 1 on this branch. The
 * remedy is NOT a wipe: `adopt-append` converts that stamp to the per-file shape
 * after PROVING the old set is byte-identical. See its header, and
 * `plan/schema-gate-additive-migrations.md` for the operator runbook.
 *
 * ⚠ Every environment that is UNSTAMPED (stage, prod, demo-0, measured)
 * is unaffected: it adopts, migrates, and is stamped in the new
 * shape on its very next deploy. So does any legacy-stamped database whose files
 * have not moved. `adopt-append` exists for one database, once.
 *
 * 🔴 "NO BASE TABLES VISIBLE" MUST NEVER EXIT 1, AND IT IS CHECKED FIRST.
 * Both halves of that were MEASURED, and the first
 * version of this script got both wrong:
 *
 *   · The first version read `information_schema`, which is PRIVILEGE-FILTERED.
 *     A role holding CONNECT plus USAGE on `public` but no table grants read
 *     ZERO columns from a healthy 249-column / 16-table `ai_service_test`, and
 *     this script REFUSED TO BOOT on it. The query now reads `pg_catalog`,
 *     which is world-readable and returned all 16 relations to that same role —
 *     so a PARTIAL grant can no longer produce a plausible wrong hash either.
 *     (`assertDatabaseIsOurs` in the test harness already read `pg_class` for
 *     the same reason and was never foolable this way.) This rule survives the
 *     move because a genuinely wiped database still reads zero.
 *   · The stamp SURVIVES `DROP SCHEMA public CASCADE` byte-for-byte: it lives in
 *     the cluster-wide `pg_shdescription`, not in the database's own schema.
 *     Measured: stamp identical before and after the wipe, zero tables left.
 *     So a freshly-wiped database is INDISTINGUISHABLE from a privilege-starved
 *     one — and the gate refused the boot at step 2 of the very
 *     wipe → migrate → reseed remedy its own error message prints. The whole
 *     remedy chain exited 1 and the migration could never run.
 *
 * An empty-or-invisible database has nothing to protect: the migrate step is
 * about to build it from scratch, which is what would have happened with no
 * gate at all. So emptiness short-circuits BOTH comparisons — including the
 * migrations half, because the operator who just wiped very likely wiped
 * BECAUSE the baseline changed, and refusing there would block the remedy just
 * as hard.
 *
 * ⚠ THE COST, stated: a database whose role cannot see its own tables is not
 * protected by this gate at all. That is the status quo, not a regression, and
 * the log line says so on every boot.
 *
 * 🔴 ADOPT, NOT REFUSE, on an unstamped database. This is the load-bearing
 * safety decision and it is not a softening. Refusing "unstamped" would take
 * down every currently-working deployed environment on the very next deploy —
 * and MEASURED, all four of ai-service's (dev, stage, prod, demo-0)
 * carry NO stamp right now, so a refusal would be a four-environment outage on
 * first ship. "Unstamped ⇒ stale ⇒ act" is also the exact inference that
 * destroyed a real database.
 *
 * ⚠ THE HONEST COST, stated rather than hidden: if a deployed database is
 * ALREADY stale the moment this first ships, adoption blesses that staleness.
 * The gate starts protecting from the SECOND deploy onward.
 */
const precheck = async () => {
  const url = databaseUrl();
  if (!url) return 0;

  let client;
  try {
    client = connect(url);
    const { db, claim } = await readClaim(client);

    if (!claim) {
      console.error(
        `${LABEL} ADOPTING "${db}": it carries no schema stamp, so there is nothing to ` +
          `compare against.\n` +
          `${LABEL} This boot continues and will stamp the database after migrating. ` +
          `⚠ If "${db}" is ALREADY stale right now, this blesses that. The gate protects ` +
          `from the next deploy onward.`,
      );
      return 0;
    }

    // 🔴 EMPTINESS FIRST — see the table above. This read must happen before
    // either comparison, and neither comparison may run when it comes back
    // empty.
    const expectedSchema = await liveSchemaFingerprint(url);
    if (expectedSchema === EMPTY_SCHEMA_FINGERPRINT || claim.schema === EMPTY_SCHEMA_FINGERPRINT) {
      console.error(
        `${LABEL} ADOPTING "${db}": no base tables are visible on it, so there is nothing to ` +
          `compare. Either it was just wiped (the stamp outlives DROP SCHEMA — it lives in ` +
          `pg_shdescription), or this role lacks the grants to see them.\n` +
          `${LABEL} ⚠ This boot continues and will re-stamp after migrating. The gate is NOT ` +
          `protecting "${db}" while this line keeps appearing.`,
      );
      return 0;
    }

    let appended = [];
    /**
     * What the closing "is current" line reports about the migrations half.
     *
     * 🔴 IT DIFFERS BY PATH, AND THAT IS THE POINT. The per-file path never
     * compares an aggregate at all — the per-entry sha256s decide — so printing
     * the STAMPED `migrations` value there would print a number this boot did
     * not verify, and one that a stray unreferenced `.sql` silently invalidates.
     */
    let migrationsLine = '';

    if (Array.isArray(claim.files)) {
      // THE PER-FILE PATH — the only one that can tell an append from an edit.
      const diskManifest = migrationsManifest();

      // ⚠ INFORMATIONAL, exit 0. Drizzle never applies a file no journal entry
      // names, so this cannot be a refusal — but it is invisible to every
      // comparison below while still moving `migrationsFingerprint()`, so it is
      // the one thing about ./drizzle a reader of this log would otherwise miss.
      const stray = unreferencedSqlFiles(diskManifest);
      if (stray.length > 0) {
        console.error(
          `${LABEL} ⚠ ${stray.length} .sql file(s) in ./drizzle are named by NO journal ` +
            `entry: ${stray.join(', ')}. Drizzle will never apply them (readMigrationFiles ` +
            `walks meta/_journal.json), so this changes no verdict — but a half-committed ` +
            `db:generate looks exactly like this.`,
        );
      }

      const comparison = compareManifests({ entries: claim.files }, diskManifest);
      if (comparison.verdict === 'diverged') {
        console.error(
          `${LABEL} 🔴 REFUSING TO BOOT — the MIGRATIONS half of the stamp does not match.\n\n` +
            `  database:  ${db}\n` +
            `  half:      migrations (the files in ./drizzle changed under a stamped database)\n` +
            `  stamped:   ${claim.stampedAt ?? 'at an unknown time'}, ` +
            `${claim.files.length} migration(s)\n` +
            `  this image carries ${diskManifest.entries.length} migration(s)\n\n` +
            `  WHAT MOVED:  ${comparison.reason}\n\n` +
            `  This is NOT the appended-migration case, which this gate allows: appending is ` +
            `every\n  stamped entry still present, in order, byte-identical, with the new ones ` +
            `only at the END.` +
            remedy(db),
        );
        return 1;
      }
      appended = comparison.appended;
      migrationsLine =
        `journal-files ${manifestFingerprint(diskManifest)} over ` +
        `${diskManifest.entries.length} journal entr${diskManifest.entries.length === 1 ? 'y' : 'ies'}`;
    } else if (claim.migrations !== migrationsFingerprint()) {
      // THE LEGACY PATH — one aggregate hash, so "appended" and "edited" are
      // indistinguishable and the only supportable verdict is refusal.
      const expectedMigrations = migrationsFingerprint();
      console.error(
        `${LABEL} 🔴 REFUSING TO BOOT — the MIGRATIONS half of the stamp does not match.\n\n` +
          `  database:  ${db}\n` +
          `  half:      migrations (the files in ./drizzle changed under a stamped database)\n` +
          `  expected:  ${expectedMigrations}   (this image's migration files)\n` +
          `  found:     ${claim.migrations}   (stamped ${claim.stampedAt ?? 'at an unknown time'})\n\n` +
          `  ⚠ THIS STAMP PREDATES THE PER-FILE LIST. It carries ONE hash over the whole ` +
          `migration\n  set, so an APPENDED migration and an EDITED one both simply "differ" ` +
          `and cannot be told\n  apart from here. Refusing is the only verdict this evidence ` +
          `supports.\n\n` +
          `  Drizzle will NOT fix this for you. It compares only the newest ledger row's ` +
          `created_at\n  against each migration's journal "when", so a baseline edited in ` +
          `place is skipped\n  and reported as success — measured in this repo.\n\n` +
          `  IF, AND ONLY IF, THE ONLY CHANGE IS APPENDED MIGRATIONS, there is a remedy that ` +
          `does\n  not wipe. It PROVES the older files are byte-identical to what was stamped, ` +
          `then\n  rewrites the stamp in the per-file shape describing that SAME old set:\n\n` +
          `      node scripts/schema-gate.mjs adopt-append --expect <tag>,<tag>\n\n` +
          `  It refuses if it cannot prove it. If it does refuse, the remedy below is the ` +
          `remedy.` +
          remedy(db),
      );
      return 1;
    } else {
      // The legacy aggregate MATCHED the disk, so it does describe this image
      // and printing it is honest.
      migrationsLine = `migrations ${claim.migrations}`;
    }

    if (claim.schema === undefined) {
      console.error(
        `${LABEL} ADOPTING the LIVE-SCHEMA half on "${db}": its stamp predates that field ` +
          `(two-field stamp, ${claim.stampedAt ?? 'unknown time'}), so there is nothing to ` +
          `compare against. The migrations half matched. This boot will rewrite the stamp ` +
          `with both halves.`,
      );
      return 0;
    }
    if (claim.schema !== expectedSchema) {
      console.error(
        `${LABEL} 🔴 REFUSING TO BOOT — the LIVE-SCHEMA half of the stamp does not match.\n\n` +
          `  database:  ${db}\n` +
          `  half:      schema (the database changed out from under its own stamp)\n` +
          `  expected:  ${claim.schema}   (what was stamped ${claim.stampedAt ?? 'at an unknown time'})\n` +
          `  found:     ${expectedSchema}   (what the database's columns hash to right now)\n\n` +
          `  The migration files are unchanged, so this is not a pending migration: ` +
          `something\n  altered this database directly, or a previous deploy applied a ` +
          `migration this image\n  does not have.` +
          remedy(db),
      );
      return 1;
    }

    if (appended.length > 0) {
      // 🔴 THE ALLOW LINE. It NAMES the tags, because "the gate let something
      // through" must never be a silent event in a boot log — the next person
      // reading it after an incident has to be able to see exactly what this
      // deploy was permitted to add.
      console.error(
        `${LABEL} "${db}": ${appended.length} migration(s) appended: ${appended.join(', ')}; ` +
          `migrate will apply them and re-stamp. Everything already stamped is present, in ` +
          `order and byte-identical (schema ${claim.schema}).`,
      );
      return 0;
    }

    console.error(`${LABEL} "${db}" is current (${migrationsLine}, schema ${claim.schema}).`);
    return 0;
  } catch (err) {
    // ⚠ NOT A REFUSAL. A database we cannot reach is not a stale database, and
    // the migrate step that runs next reports connection failures properly.
    console.error(
      `${LABEL} could not check the schema stamp, so it is NOT refusing the boot: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  } finally {
    if (client) await client.end({ timeout: 5 }).catch(() => undefined);
  }
};

// ── stamp ──────────────────────────────────────────────────────────────────

/**
 * Recompute BOTH halves and write the stamp. Runs only after the migrate step
 * has succeeded, so the live half describes the schema we now have — never the
 * one we were about to replace.
 *
 * ── 🔴 IT READS THE LEDGER FIRST, AND REFUSES ──────────────────────────────
 *
 * Both fingerprints look at the DISK and at the LIVE SCHEMA. Neither can see
 * whether the migrate step ran. MEASURED on a throwaway in this repo's harness:
 * `0004_never` appended to the journal, `precheck` correctly ALLOWED it, then
 * `stamp` run WITHOUT migrating — the stamp recorded FIVE migrations while the
 * ledger held four, every later `precheck` read "current" forever, and the
 * migration that had never run failed on an already-existing type when it was
 * finally attempted.
 *
 * The deploy chain (`precheck && migrate && stamp`) does not reach that today:
 * `&&` propagates the migrate step's exit 1, and drizzle 0.38.4 runs the whole
 * apply inside ONE transaction, so a failed migrate leaves nothing half-done.
 * But `db:gate stamp` is a verb an operator can type, and the next edit to that
 * chain — a `;`, a `|| true`, a retry wrapper — makes it reachable. A guard
 * that depends on the punctuation in a package script is not a guard.
 *
 * So: `max(created_at)` in the ledger must EQUAL the last journal entry's
 * `when`, or nothing is written and this exits 1. There is no escape hatch here
 * either, and the refusal is not a schema-drift verdict — it says the migrate
 * step did not happen.
 *
 * ⚠ AN EXIT 1 HERE DOES STOP THE CONTAINER, and that is the intended cost. The
 * only way to reach it is a database that has NOT applied the migrations this
 * image carries, which is precisely the state a false "current" stamp would
 * freeze in place. Booting is the worse outcome.
 *
 * Every OTHER failure still exits 0. A stamp that could not be WRITTEN leaves
 * the next `precheck` comparing against the old stamp (or adopting, if there
 * was none); taking the container down over a failed comment would be the gate
 * causing the outage it exists to prevent.
 */
const stamp = async () => {
  const url = databaseUrl();
  if (!url) return 0;

  let client;
  /** Whether this database already carried a stamp — see the catch below. */
  let hadStamp = null;
  try {
    client = connect(url);
    const { db, claim: existing } = await readClaim(client);
    hadStamp = existing !== null;
    const manifest = migrationsManifest();

    // ── THE LEDGER CHECK, BEFORE ANYTHING IS WRITTEN ──────────────────────
    const disagreement = ledgerDisagreement(await ledgerHead(client), lastJournalEntry(manifest));
    if (disagreement !== null) {
      console.error(
        `${LABEL} 🔴 REFUSING TO STAMP "${db}" — THE LEDGER SAYS THE MIGRATIONS IN THIS ` +
          `IMAGE HAVE NOT ALL BEEN APPLIED.\n\n` +
          `  ${disagreement}\n\n` +
          `  A stamp written now would record ${manifest.entries.length} migration(s) as ` +
          `applied when they are not.\n  The NEXT precheck would then read that stamp, find ` +
          `the files byte-identical, and report\n  "is current" — forever. The migration that ` +
          `never ran would surface later as a failure\n  on an object that already exists, or ` +
          `not at all.\n\n` +
          `  THIS IS NOT A SCHEMA-DRIFT VERDICT and the wipe/migrate/reseed remedy is not the ` +
          `remedy.\n  The migrate step did not run, or did not apply everything. Run it, then ` +
          `stamp:\n\n` +
          `      npm run db:migrate        (precheck && migrate && stamp, in that order)\n\n` +
          `  Nothing was written. "${db}" is exactly as it was.`,
      );
      return 1;
    }

    const claim = {
      stampedAt: new Date().toISOString(),
      migrations: migrationsFingerprint(),
      schema: await liveSchemaFingerprint(url),
      journalSha256: manifest.journalSha256,
      files: manifest.entries,
    };
    const literal = JSON.stringify(claim).replace(/'/g, "''");
    await client.unsafe(`COMMENT ON DATABASE "${db.replace(/"/g, '""')}" IS '${literal}'`);
    if (claim.schema === EMPTY_SCHEMA_FINGERPRINT) {
      // The migrate step just ran. If nothing is visible NOW, this role cannot
      // see its own schema — so the stamp records ignorance, and every future
      // precheck will adopt rather than protect. Say it out loud.
      console.error(
        `${LABEL} ⚠ stamped "${db}" with schema=${EMPTY_SCHEMA_FINGERPRINT}: no base tables ` +
          `were visible even after migrating. This role cannot see its own schema, so the ` +
          `live-schema half of the gate is inert for this database. Grant it SELECT on its ` +
          `tables, or run the migrate step as the database owner.`,
      );
      return 0;
    }
    console.error(
      `${LABEL} stamped "${db}": ${claim.files.length} migration(s) ` +
        `(${claim.files.map((f) => f.tag).join(', ')}), migrations ${claim.migrations}, ` +
        `schema ${claim.schema}.`,
    );
    return 0;
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    const why =
      code === '42501'
        ? `this role may not COMMENT ON DATABASE (it must own the database)`
        : `${err instanceof Error ? err.message : String(err)}`;
    // ⚠ THE CONSEQUENCE DEPENDS ON WHETHER THERE WAS ALREADY A STAMP, and
    // saying "will ADOPT whatever it finds" unconditionally was FALSE for the
    // stamped case: the OLD stamp is untouched by a failed write and survives,
    // so the next precheck compares against it rather than adopting.
    const consequence =
      hadStamp === true
        ? `the OLD stamp survives untouched and now describes this database as it was ` +
          `BEFORE this migrate. The next precheck compares against THAT, so if this migrate ` +
          `changed the schema it will exit 1 on the live-schema half — a refusal caused by ` +
          `this failed write, not by drift.`
        : `the next deploy has nothing to compare against and will ADOPT whatever it finds. ` +
          `Schema drift will not be caught here until this is fixed.`;
    console.error(
      `${LABEL} ⚠ COULD NOT STAMP THE DATABASE — ${why}.\n` +
        `${LABEL} ⚠ The service is starting anyway, but ${consequence}`,
    );
    return 0;
  } finally {
    if (client) await client.end({ timeout: 5 }).catch(() => undefined);
  }
};

// ── adopt-append ───────────────────────────────────────────────────────────

/**
 * ONE-TIME CONVERSION OF A PRE-PER-FILE STAMP, and nothing else.
 *
 *   node scripts/schema-gate.mjs adopt-append --expect 0002_a,0003_b
 *   node scripts/schema-gate.mjs adopt-append --expect 0002_a --old-journal <path>
 *
 * ── WHAT IT IS FOR ─────────────────────────────────────────────────────────
 *
 * A stamp written before the per-file list carries ONE aggregate hash. When the
 * files move, that hash cannot say whether they were appended or edited, so
 * `precheck` refuses — correctly, on the evidence it has. This command adds the
 * evidence, from the operator plus the disk, and re-states the SAME OLD stamp in
 * the new shape. It does not advance the stamp, does not touch the schema half,
 * and does not apply anything.
 *
 * ── THE PROOF, IN FULL ─────────────────────────────────────────────────────
 *
 * It refuses unless ALL of these hold:
 *
 *   1. The database carries a stamp, and that stamp is LEGACY (no `files`). A
 *      stamp that already has the list needs nothing: precheck handles it.
 *   2. The stamp has a `schema` half, base tables are VISIBLE, and the live
 *      column hash EQUALS it. 🔴 This is what proves the stamp describes THIS
 *      database. Without it the command would happily convert a stamp belonging
 *      to a database that has since been hand-altered.
 *   3. `--expect` names a NON-EMPTY set of tags that is exactly the TRAILING
 *      run of this image's journal, in order. Naming an interior migration is
 *      refused: the thing being claimed is "these were appended", and an
 *      interior entry was not.
 *   4. THE BYTE PROOF. Reconstruct the OLD input to the aggregate hash:
 *        · old `.sql` set = every `.sql` on disk MINUS the expected tags' files
 *          (the same "all .sql, sorted" rule the aggregate itself uses, so a
 *          stray non-journal `.sql` present then and now cancels out);
 *        · old journal bytes = `--old-journal`'s file if given, else the current
 *          journal re-serialised with the trailing entries dropped
 *          (`JSON.stringify(…, null, 2)`, which is byte-exact for a
 *          drizzle-kit-written journal — VERIFIED against this repo's own
 *          journal at commit fc0619c: 340 bytes, identical).
 *      Recompute `migrationsFingerprint()` over exactly that, and require it to
 *      EQUAL the stamped `migrations`.
 *
 *      🔴 THIS IS THE LOAD-BEARING STEP. The aggregate folds in every filename,
 *      every file's bytes and the journal's bytes. Reproducing it from the files
 *      ON DISK TODAY proves that the older files were NOT touched: change one
 *      byte of `0001` and the reconstruction no longer matches, and this command
 *      refuses exactly where `precheck` did. That edit is still caught.
 *
 *      ⚠ THE HONEST LIMIT: the aggregate is sha256 TRUNCATED TO 16 HEX. So the
 *      proof is a 64-bit one. An accidental collision is not a thing that
 *      happens; a DELIBERATE one is out of scope, because anyone who can write
 *      to `./drizzle` can equally write to the stamp itself.
 *   5. The old journal (reconstructed or supplied) must PARSE and its trailing
 *      entries must be the ones being kept, so the list written out describes
 *      the journal that was actually proved.
 *
 * ── WHAT IT WRITES ─────────────────────────────────────────────────────────
 *
 * `migrations` and `schema` UNCHANGED — they already describe the old set — plus
 * `files` for the OLD entries only and the OLD journal's hash. The very next
 * `precheck` therefore has to reach "strict prefix" on its own merits, and will
 * name the appended tags in the boot log like any other append.
 */
const adoptAppend = async () => {
  const args = process.argv.slice(3);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const usage =
    `${LABEL} usage: node scripts/schema-gate.mjs adopt-append --expect <tag>[,<tag>…] ` +
    `[--old-journal <path>]\n` +
    `  --expect       the migrations this image has that the stamped database does NOT.\n` +
    `                 They must be the LAST entries of drizzle/meta/_journal.json, in order.\n` +
    `  --old-journal  the exact journal bytes the database was stamped with, when the\n` +
    `                 reconstruction below cannot reproduce them. Recover them with e.g.\n` +
    `                   git show <commit>:drizzle/meta/_journal.json > /tmp/old-journal.json`;

  const unknown = args.filter(
    (a, i) =>
      a.startsWith('--') &&
      a !== '--expect' &&
      a !== '--old-journal' &&
      !(i > 0 && (args[i - 1] === '--expect' || args[i - 1] === '--old-journal')),
  );
  if (unknown.length > 0) {
    console.error(`${LABEL} 🔴 unrecognised option(s): ${unknown.join(', ')}\n${usage}`);
    return 2;
  }

  const expect = (flag('--expect') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (expect.length === 0) {
    console.error(`${LABEL} 🔴 --expect is required and must name at least one tag.\n${usage}`);
    return 2;
  }

  const url = databaseUrl();
  if (!url) {
    // 🔴 Unlike precheck, a missing DATABASE_URL here is a FAILURE. There is no
    // migrate step behind this to report it, and exiting 0 would look like the
    // conversion succeeded.
    console.error(`${LABEL} 🔴 DATABASE_URL is unset — nothing to convert.`);
    return 1;
  }

  const refuse = (why) => {
    console.error(`${LABEL} 🔴 REFUSING TO CONVERT THE STAMP.\n\n  ${why}\n`);
    return 1;
  };

  let client;
  try {
    client = connect(url);
    const { db, claim } = await readClaim(client);

    if (!claim) return refuse(`"${db}" carries no readable stamp. precheck ADOPTS an unstamped database, so there is nothing here to convert.`);
    if (Array.isArray(claim.files))
      return refuse(
        `"${db}"'s stamp ALREADY carries a per-file list (${claim.files.length} entries, ` +
          `stamped ${claim.stampedAt ?? 'at an unknown time'}). precheck can tell an append ` +
          `from an edit by itself. Nothing to do — run precheck.`,
      );
    if (claim.schema === undefined)
      return refuse(
        `"${db}"'s stamp has no live-schema half (a two-field stamp from before 2026-09-03). ` +
          `There is no way to prove the stamp describes THIS database, and this command will ` +
          `not convert one it cannot tie to the database in front of it.`,
      );

    const live = await liveSchemaFingerprint(url);
    if (live === EMPTY_SCHEMA_FINGERPRINT)
      return refuse(
        `no base tables are visible on "${db}" — it is empty, or this role lacks the grants. ` +
          `An empty database needs no conversion: precheck adopts it and the migrate step ` +
          `builds it from scratch.`,
      );
    if (claim.schema !== live)
      return refuse(
        `the LIVE-SCHEMA half does not match, so this stamp does not describe "${db}" as it ` +
          `is now.\n    stamped:  ${claim.schema}\n    live now: ${live}\n  ` +
          `Something altered this database directly. Converting the stamp would bless that. ` +
          `${remedy(db).trim()}`,
      );

    // ── the journal, and the suffix claim ──────────────────────────────────
    const journalBytes = readFileSync(journalPath());
    const journal = JSON.parse(journalBytes.toString());
    const entries = journal.entries ?? [];
    const tags = entries.map((e) => String(e.tag));
    const suffix = tags.slice(-expect.length);
    if (expect.length >= tags.length || suffix.join(',') !== expect.join(','))
      return refuse(
        `--expect must be the LAST ${expect.length} entries of drizzle/meta/_journal.json, ` +
          `in order.\n    --expect names: ${expect.join(', ')}\n    the journal ends: ` +
          `${suffix.join(', ')}\n    the journal is:  ${tags.join(', ')}\n  ` +
          `An interior migration was not appended, so this command will not treat it as one.`,
      );

    const keptEntries = entries.slice(0, entries.length - expect.length);

    const expectedFiles = new Set(expect.map((t) => `${t}.sql`));
    const oldSqlFiles = migrationsOnDisk().filter((f) => !expectedFiles.has(f));

    // ── the old journal bytes ──────────────────────────────────────────────
    const oldJournalPath = flag('--old-journal');
    const oldJournalBytes = oldJournalPath
      ? readFileSync(path.resolve(oldJournalPath))
      : Buffer.from(JSON.stringify({ ...journal, entries: keptEntries }, null, 2), 'utf8');
    const source = oldJournalPath
      ? `${oldJournalPath} (${oldJournalBytes.length} bytes)`
      : `reconstructed from this image's journal minus the ${expect.length} expected ` +
        `entr${expect.length === 1 ? 'y' : 'ies'} (${oldJournalBytes.length} bytes)`;

    let oldJournal;
    try {
      oldJournal = JSON.parse(oldJournalBytes.toString());
    } catch (err) {
      return refuse(`the old journal does not parse as JSON: ${err.message}\n  Source: ${source}`);
    }
    const oldTags = (oldJournal.entries ?? []).map((e) => String(e.tag));
    if (oldTags.join(',') !== keptEntries.map((e) => String(e.tag)).join(','))
      return refuse(
        `the old journal's entries are not the ones being kept.\n    old journal: ` +
          `${oldTags.join(', ') || '<none>'}\n    keeping:     ` +
          `${keptEntries.map((e) => String(e.tag)).join(', ') || '<none>'}\n  Source: ${source}`,
      );

    // ── THE BYTE PROOF ─────────────────────────────────────────────────────
    const h = createHash('sha256');
    for (const f of oldSqlFiles) {
      h.update(f);
      h.update('\0');
      h.update(readFileSync(path.join(MIGRATIONS_DIR, f)));
      h.update('\0');
    }
    h.update('journal\0');
    h.update(oldJournalBytes);
    const reconstructed = h.digest('hex').slice(0, 16);

    if (reconstructed !== claim.migrations)
      return refuse(
        `THE OLD MIGRATION SET COULD NOT BE PROVED.\n\n` +
          `    stamped aggregate:       ${claim.migrations}\n` +
          `    reconstructed aggregate: ${reconstructed}\n` +
          `    old .sql files used:     ${oldSqlFiles.join(', ') || '<none>'}\n` +
          `    old journal:             ${source}\n\n` +
          `  This means at least one of: a file older than the appended ones was EDITED ` +
          `(the case\n  this gate exists for — do NOT convert), or the journal's old bytes ` +
          `differ from the\n  reconstruction, or --expect is wrong.\n\n` +
          `  If you believe only the journal's formatting differs, supply its exact old bytes:\n` +
          `      git show <commit>:drizzle/meta/_journal.json > /tmp/old-journal.json\n` +
          `      node scripts/schema-gate.mjs adopt-append --expect ${expect.join(',')} ` +
          `--old-journal /tmp/old-journal.json\n\n` +
          `  Otherwise this is real drift and the remedy is the remedy.${remedy(db)}`,
      );

    // ── THE LEDGER MUST STILL BE AT THE OLD SET ────────────────────────────
    //
    // ⚠ DELIBERATELY LAST, after the byte proof. Both refusals exit 1, so the
    // order only decides which sentence the operator reads first — and for a
    // wrong `--expect` the byte proof is the more important one, because it is
    // the check that catches an edited older file. This one
    // then catches what the byte proof cannot see: a database that has already
    // MOVED PAST the old set.
    //
    // 🔴 THE ASYMMETRY IS THE POINT, and it is the opposite of `stamp`'s.
    // `--expect` names migrations that are UNAPPLIED BY DEFINITION — requiring
    // them in the ledger would refuse every case this command exists for. What
    // must be in the ledger is the OLD set: its last entry's `when` has to be
    // the newest `created_at`.
    //
    // Without this the command converts a stamp on a database that has ALREADY
    // applied 0002/0003, the next precheck announces "2 migration(s) appended;
    // migrate will apply them", drizzle applies NOTHING (their `when` no longer
    // beats the ledger head), and `stamp` then records them as done. That is
    // the same manufactured false green as N-1, through a different door.
    const keptLast = keptEntries.length === 0 ? null : keptEntries[keptEntries.length - 1];
    const behind = ledgerDisagreement(await ledgerHead(client), {
      tag: String(keptLast?.tag ?? ''),
      when: Number(keptLast?.when ?? 0),
    });
    if (keptLast && behind !== null)
      return refuse(
        `THE LEDGER DOES NOT AGREE THAT "${db}" IS STILL AT THE OLD MIGRATION SET.\n\n    ` +
          `${behind}\n\n  --expect claims ${expect.join(', ')} ` +
          `${expect.length === 1 ? 'is' : 'are'} NOT YET APPLIED, so the newest ledger row ` +
          `must be the\n  entry just before them ("${String(keptLast.tag)}", ` +
          `when=${Number(keptLast.when)}). Converting anyway would make the next\n  precheck ` +
          `announce an append that drizzle will then silently NOT apply — it applies an entry ` +
          `only\n  when its "when" beats the newest ledger row. See ` +
          `plan/open-drizzle-journal-when-trap.md.`,
      );

    // ── write the SAME old set, in the new shape ───────────────────────────
    const files = keptEntries.map((e) => ({
      tag: String(e.tag),
      when: Number(e.when),
      breakpoints: e.breakpoints === true,
      sha256: createHash('sha256')
        .update(readFileSync(path.join(MIGRATIONS_DIR, `${String(e.tag)}.sql`)))
        .digest('hex'),
    }));
    const next = {
      stampedAt: claim.stampedAt,
      migrations: claim.migrations,
      schema: claim.schema,
      journalSha256: createHash('sha256').update(oldJournalBytes).digest('hex'),
      files,
      converted: {
        at: new Date().toISOString(),
        from: 'aggregate-only',
        expect,
        oldJournal: oldJournalPath ? 'supplied' : 'reconstructed',
      },
    };
    const literal = JSON.stringify(next).replace(/'/g, "''");
    await client.unsafe(`COMMENT ON DATABASE "${db.replace(/"/g, '""')}" IS '${literal}'`);

    console.error(
      `${LABEL} converted "${db}"'s stamp to the per-file shape. NOTHING WAS APPLIED and the ` +
        `stamp still describes the SAME ${files.length} migration(s):\n` +
        files.map((f) => `${LABEL}   ${f.tag}  when=${f.when}  sha256=${f.sha256}`).join('\n') +
        `\n${LABEL} proof: aggregate ${reconstructed} reproduced from the files on disk ` +
        `(old journal ${oldJournalPath ? 'supplied' : 'reconstructed'}), and the live-schema ` +
        `half matched (${claim.schema}).\n` +
        `${LABEL} The next precheck must now find ${expect.join(', ')} appended, on its own.`,
    );
    return 0;
  } catch (err) {
    // 🔴 Unlike precheck, this FAILS on an unreachable database. It is an
    // operator command run by hand; "could not check, continuing" would leave
    // the operator believing a conversion happened.
    console.error(
      `${LABEL} 🔴 adopt-append FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    if (client) await client.end({ timeout: 5 }).catch(() => undefined);
  }
};

// ── entry point ────────────────────────────────────────────────────────────

const VERBS = { precheck, stamp, 'adopt-append': adoptAppend };

const main = async () => {
  const verb = process.argv[2];
  const run = VERBS[verb];
  if (!run) {
    console.error(
      `${LABEL} usage: node scripts/schema-gate.mjs <precheck|stamp|adopt-append>\n` +
        `  precheck      runs BEFORE the migrate step and refuses a stale database.\n` +
        `                Appended migrations are ALLOWED; an edited one is not.\n` +
        `  stamp         runs AFTER the migrate step and records both fingerprints\n` +
        `                plus the per-file list. REFUSES (exit 1, nothing written)\n` +
        `                if the ledger says the migrations were not all applied.\n` +
        `  adopt-append  OPERATOR ONLY, never in a deploy. Converts a pre-per-file\n` +
        `                stamp to the new shape after PROVING the older migration\n` +
        `                files are byte-identical to what was stamped. Requires\n` +
        `                --expect <tag>[,<tag>…]. Applies nothing.`,
    );
    return 2;
  }
  return run();
};

// Only run when invoked as a program; the drift test imports the two
// fingerprint functions from this same file.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
