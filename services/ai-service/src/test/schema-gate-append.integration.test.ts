// THE BOOT GATE'S APPEND RULE, DEMONSTRATED AGAINST A REAL POSTGRES.
//
// 🔴 WHAT THIS FILE IS FOR. ai-service left the
// one-baseline dev phase: migrations are ADDITIVE from here. That makes an
// APPENDED migration the normal case, and the boot gate used to refuse it —
// its `migrations` half was one aggregate hash, which moves identically whether
// you appended 0002 or edited 0001 in place. MEASURED:
// schema half matched, migrations half differed, gate exited 1, the deploy
// rolled back.
//
// So the gate has to make a distinction it could not make before, and BOTH
// sides of it are load-bearing:
//
//   · it must ALLOW an append, or every additive deploy is an outage;
//   · it must still REFUSE an edit, or the incident it exists for walks
//     straight through.
//
// A unit test over `compareManifests` proves the decision function. It cannot
// prove the thing that actually runs in the container: `node
// scripts/schema-gate.mjs precheck`, reading a stamp out of `pg_shdescription`,
// against a database whose ledger and columns are real. That is this file.
//
// ── WHY IT BUILDS ITS OWN DATABASE ─────────────────────────────────────────
//
// It needs a database that has genuinely had only SOME of the migrations
// applied — not one that has had them all and been told otherwise. So it
// migrates a throwaway from a TEMPORARY migrations folder holding just the
// first `STAMPED_PREFIX`, then lets the REAL folder's remaining migrations land
// on top. It also drops a column on purpose. Neither may happen to the shared
// integration database: `TEST_DATABASE_URL` is used only as the CLUSTER address
// here.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseOnCluster, type TestPostgres } from './docker-pg.js';
import {
  MIGRATIONS_DIR,
  REPO_ROOT,
  type MigrationRecord,
  compareManifests,
  ensureSchema,
  liveSchemaFingerprint,
  migrationsFingerprint,
  migrationsManifest,
} from './integration-database.js';
import { assertTestDatabase } from './test-database-guard.js';

const GATE = path.join(REPO_ROOT, 'scripts', 'schema-gate.mjs');

/** The database this file owns outright. Not the shared integration one. */
const DATABASE = 'ai_service_gate_test';

const clusterUrl = (): string => {
  const u = process.env.TEST_DATABASE_URL;
  // 🔴 No skip. globalSetup either resolved a database or threw.
  if (!u) throw new Error('TEST_DATABASE_URL is unset — globalSetup did not run.');
  return u;
};

let owned: TestPostgres;
let url = '';
/** The real journal's entries, read fresh on every call. */
const disk = () => migrationsManifest();

// ── EVERYTHING BELOW IS DERIVED FROM THE JOURNAL AT RUNTIME ────────────────
//
// 🔴 WHY, MEASURED. This file used to name `0002_ingest_jobs` and
// `0003_budget_reservations` as literals and assert "2 migration(s) appended".
// Appending `0004_chunks_scope_deps` turned six assertions red — and because
// `deploy-dev` declares `needs: [integration]`, a green gate-rule test blocked
// the deploy over a fact about the journal's LENGTH, not about the gate.
//
// The gate's rules are RELATIONSHIPS: "the appended set is what the stamp does
// not cover", "--expect must be the journal's TRAILING run". So the tests state
// them as relationships. A tag name written literally here is an assertion
// about today's repo, and it rots on the next `drizzle-kit generate`.

/**
 * How many migrations the LEGACY-stamp fixtures pretend are already applied.
 *
 * ⚠ THE ONE DELIBERATE LITERAL. `ai_service_dev` was really stamped
 * 2026-09-08T11:41Z with an aggregate over exactly the first TWO migrations and
 * a two-entry journal (see `DEV_LEGACY_AGGREGATE` and case 5). That prefix
 * length is a fact about THAT DATABASE, so it cannot be derived from the
 * journal — but everything else here is derived RELATIVE to it, so appending a
 * migration needs no edit in this file.
 */
const STAMPED_PREFIX = 2;

/**
 * 🔴 NOT DECORATION. `ai_service_dev`'s real stamped `migrations` hash. If the
 * fixture stops reproducing it, the operator runbook in
 * `plan/schema-gate-additive-migrations.md` describes a database that does not
 * exist, and case 5 proves nothing about the deploy it was written for.
 */
const DEV_LEGACY_AGGREGATE = '9f9571378be35c6e';

/** Every tag on disk, in journal order. */
const allTags = (): string[] => disk().entries.map((e) => e.tag);

/** What a `STAMPED_PREFIX`-old stamp describes. */
const stampedTags = (): string[] => allTags().slice(0, STAMPED_PREFIX);

/**
 * THE APPENDED SET: everything the disk carries that such a stamp does not.
 * This is the gate's own definition, so it tracks any future append for free.
 */
const appendedTags = (): string[] => allTags().slice(STAMPED_PREFIX);

/** The phrase `precheck` prints for that set — count derived, not written. */
const appendedCountPhrase = (): string => `${appendedTags().length} migration(s) appended`;

/** `--expect` in the shape `adopt-append` accepts: the journal's trailing run. */
const expectArg = (): string => appendedTags().join(',');

/**
 * A run that is NOT the journal's trailing run. It stops one short of the end,
 * so it can never equal a suffix of its own length — the wrongness is
 * structural, not a matter of which tags happen to exist today.
 */
const interiorRun = (): string[] => allTags().slice(1, -1);

/**
 * A run that IS trailing but is SHORTER than the real appended set: it drops
 * the oldest appended tag, so the reconstruction then folds that migration into
 * the old aggregate and the byte proof misses.
 */
const shortTrailingRun = (): string[] => appendedTags().slice(1);

/** A tag no journal entry carries. Asserted absent where it is used. */
const ABSENT_TAG = '9999_not_in_any_journal';

/** A temporary `drizzle/` holding only the first `n` migrations. */
const partialMigrationsDir = (n: number): { dir: string; journalBytes: Buffer } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ai-svc-gate-'));
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const kept = journal.entries.slice(0, n);
  const journalBytes = Buffer.from(JSON.stringify({ ...journal, entries: kept }, null, 2), 'utf8');
  execFileSync('mkdir', ['-p', path.join(dir, 'meta')]);
  for (const e of kept) copyFileSync(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  writeFileSync(path.join(dir, 'meta', '_journal.json'), journalBytes);
  return { dir, journalBytes };
};

/** The aggregate `migrations` hash over an arbitrary file set — the LEGACY half. */
const aggregateOf = (tags: string[], journalBytes: Buffer): string => {
  const h = createHash('sha256');
  for (const f of tags.map((t) => `${t}.sql`).sort()) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(path.join(MIGRATIONS_DIR, f)));
    h.update('\0');
  }
  h.update('journal\0');
  h.update(journalBytes);
  return h.digest('hex').slice(0, 16);
};

/** Run the REAL CLI the container runs, and report its raw exit code + stderr. */
const runGate = (...argv: string[]): { status: number; out: string } => {
  // ⚠ `spawnSync`, not `execFileSync`. The gate writes EVERY line to stderr,
  // including the ones it prints when it exits 0 — and `execFileSync` hands
  // back stdout on success and stderr only on the throw. Read one way, every
  // ALLOW/ADOPT message in this file would assert against an empty string and
  // pass for the wrong reason.
  const run = spawnSync(process.execPath, [GATE, ...argv], {
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
  if (run.error) throw run.error;
  return {
    status: run.status ?? 1,
    out: `${run.stdout ?? ''}${run.stderr ?? ''}`,
  };
};

const sql = <T>(fn: (client: postgres.Sql) => Promise<T>): Promise<T> => {
  const client = postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 2 });
  return fn(client).finally(() => void client.end({ timeout: 5 }).catch(() => undefined));
};

const writeStamp = async (claim: Record<string, unknown>): Promise<void> => {
  assertTestDatabase(url, 'schema-gate-append.integration.test.ts');
  const literal = JSON.stringify(claim).replace(/'/g, "''");
  await sql((c) => c.unsafe(`COMMENT ON DATABASE "${DATABASE}" IS '${literal}'`));
};

const readStamp = async (): Promise<Record<string, unknown> | null> => {
  const rows = await sql(
    (c) => c<{ c: string | null }[]>`
      select shobj_description(oid, 'pg_database') as c from pg_database where datname = ${DATABASE}
    `,
  );
  const raw = rows[0]?.c;
  return raw ? (JSON.parse(String(raw)) as Record<string, unknown>) : null;
};

const clearStamp = (): Promise<unknown> =>
  sql((c) => c.unsafe(`COMMENT ON DATABASE "${DATABASE}" IS NULL`));

/** Rebuild the throwaway from scratch and migrate it FULLY. */
const rebuildFull = async (): Promise<void> => {
  await owned.stop();
  owned = await createDatabaseOnCluster(clusterUrl(), DATABASE);
  url = owned.url;
  await ensureSchema(url);
};

/** Rebuild the throwaway and migrate it to the FIRST `n` migrations only. */
const rebuildPartial = async (n: number): Promise<Buffer> => {
  await owned.stop();
  owned = await createDatabaseOnCluster(clusterUrl(), DATABASE);
  url = owned.url;
  const { dir, journalBytes } = partialMigrationsDir(n);
  try {
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const { MIGRATIONS_CONFIG } = await import('../db/migrations-config.js');
    const client = postgres(url, { max: 1 });
    try {
      await migrate(drizzle(client), { ...MIGRATIONS_CONFIG, migrationsFolder: dir });
    } finally {
      await client.end({ timeout: 5 }).catch(() => undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return journalBytes;
};

/** The per-file stamp a database at the first `n` migrations should carry. */
const stampFor = async (n: number, journalBytes: Buffer): Promise<Record<string, unknown>> => ({
  stampedAt: new Date().toISOString(),
  migrations: aggregateOf(
    disk().entries.slice(0, n).map((e) => e.tag),
    journalBytes,
  ),
  schema: await liveSchemaFingerprint(url),
  journalSha256: createHash('sha256').update(journalBytes).digest('hex'),
  files: disk().entries.slice(0, n),
});

beforeAll(async () => {
  owned = await createDatabaseOnCluster(clusterUrl(), DATABASE);
  url = owned.url;
}, 120_000);

afterAll(async () => {
  await owned?.stop();
});

// ───────────────────────────────────────────────────────────────────────────

describe('🔴 0. the journal these cases derive from is the right SHAPE', () => {
  // 🔴 THE DERIVATION'S OWN GUARD. Every case below computes its fixtures off
  // the journal, and two of them need slack to stay WRONG: the interior run
  // (case 5) needs a tag that is neither first nor last, and the short trailing
  // run needs at least two appended migrations to be able to drop one. On a
  // journal too short, those two lists would quietly become VALID `--expect`
  // arguments and the refusal cases would pass for the wrong reason. This fails
  // loudly instead.
  it('carries enough entries for the deliberately-wrong --expect lists to stay wrong', () => {
    expect(
      allTags().length,
      `the deliberately-wrong \`--expect\` fixtures need ≥ ${STAMPED_PREFIX + 2} journal entries`,
    ).toBeGreaterThanOrEqual(STAMPED_PREFIX + 2);
    expect(appendedTags().length, 'nothing to append — case 1 would be vacuous').toBeGreaterThan(1);
    expect(interiorRun().length, 'the interior run is empty').toBeGreaterThan(0);
    expect(shortTrailingRun().length, 'the short trailing run is empty').toBeGreaterThan(0);
    expect(allTags(), 'ABSENT_TAG is in the journal after all').not.toContain(ABSENT_TAG);
  });
});

describe('🔴 1. an APPENDED migration is allowed, end to end', () => {
  it('runs the REAL CLI: precheck allows, migrate applies, stamp re-records, precheck goes quiet', async () => {
    // A database that genuinely has only the STAMPED_PREFIX oldest applied.
    const journalBytes = await rebuildPartial(STAMPED_PREFIX);
    await writeStamp(await stampFor(STAMPED_PREFIX, journalBytes));

    // ── the ledger really is short, or the rest of this proves nothing ──
    const before = await sql(
      (c) => c<{ n: string }[]>`select count(*)::text as n from public.__drizzle_migrations`,
    );
    expect(
      Number(before[0]!.n),
      `the partial migrate did not stop at ${STAMPED_PREFIX}`,
    ).toBe(STAMPED_PREFIX);

    const first = runGate('precheck');
    expect(first.status, `precheck refused an APPEND:\n${first.out}`).toBe(0);
    // The COUNT comes off the journal, not off a number typed here — but it is
    // the gate that has to arrive at the same one from the stamp it read.
    expect(first.out).toContain(appendedCountPhrase());
    for (const tag of appendedTags()) expect(first.out, `it did not name ${tag}`).toContain(tag);
    expect(first.out).toContain('migrate will apply them and re-stamp');

    // ── the migrate step the container runs next ──
    await ensureSchema(url);
    const after = await sql(
      (c) => c<{ n: string }[]>`select count(*)::text as n from public.__drizzle_migrations`,
    );
    expect(Number(after[0]!.n), 'drizzle did not apply the appended migrations').toBe(
      disk().entries.length,
    );

    expect(runGate('stamp').status).toBe(0);
    const written = (await readStamp()) as { files: MigrationRecord[] };
    expect(written.files.map((f) => f.tag)).toEqual(disk().entries.map((e) => e.tag));

    // ── and the deploy AFTER this one is silent ──
    const second = runGate('precheck');
    expect(second.status, second.out).toBe(0);
    expect(second.out).toContain('is current');
    expect(second.out).not.toContain('appended');
  }, 180_000);
});

describe('🔴 2. a migration EDITED IN PLACE is still refused — the prototype case', () => {
  beforeAll(async () => {
    await rebuildFull();
  }, 120_000);

  /** The migration these two cases pretend was edited: an OLD one, never the last. */
  const edited = () => disk().entries[1]!;

  it('runs the REAL CLI: exit 1, naming the tag whose bytes moved', async () => {
    // Same names, same `when`s, one byte of an OLD migration different.
    // Byte-for-byte the shape of the incident: only the FILE moved, the
    // database did not.
    const entries = disk().entries.map((e) =>
      e.tag === edited().tag
        ? { ...e, sha256: `${e.sha256.slice(0, 63)}${e.sha256.endsWith('f') ? '0' : 'f'}` }
        : e,
    );
    await writeStamp({
      stampedAt: new Date().toISOString(),
      migrations: migrationsFingerprint(),
      schema: await liveSchemaFingerprint(url),
      journalSha256: disk().journalSha256,
      files: entries,
    });

    const result = runGate('precheck');
    expect(result.status, `an EDITED migration was allowed through:\n${result.out}`).toBe(1);
    expect(result.out).toContain('REFUSING TO BOOT');
    expect(result.out).toContain(edited().tag);
    expect(result.out).toContain('EDITED IN PLACE');
    expect(result.out).toContain('WIPE');
  });

  it('…and an EDIT hiding behind an APPEND is refused too', async () => {
    // The question the prefix rule has to answer correctly or it is a hole:
    // appending the trailing migrations must buy no forgiveness for having also
    // touched one of the older ones the stamp covers.
    const kept = disk().entries.slice(0, STAMPED_PREFIX);
    const tampered = [...kept.slice(0, -1), { ...kept[kept.length - 1]!, sha256: 'f'.repeat(64) }];
    await writeStamp({
      stampedAt: new Date().toISOString(),
      migrations: 'irrelevant-legacy',
      schema: await liveSchemaFingerprint(url),
      journalSha256: disk().journalSha256,
      files: tampered,
    });
    const result = runGate('precheck');
    expect(result.status).toBe(1);
    expect(result.out).toContain(kept[kept.length - 1]!.tag);
    expect(result.out).toContain('EDITED IN PLACE');
  });
});

describe('🔴 3. removed, reordered and re-timed migrations are refused', () => {
  beforeAll(async () => {
    await rebuildFull();
  }, 120_000);

  const stampWith = async (files: MigrationRecord[]): Promise<void> =>
    writeStamp({
      stampedAt: new Date().toISOString(),
      migrations: migrationsFingerprint(),
      schema: await liveSchemaFingerprint(url),
      journalSha256: disk().journalSha256,
      files,
    });

  /** A migration the stamp claims but the image does not carry — derived, so it
   *  stays one-past-the-end however long the journal grows. */
  const ghost = () => {
    const last = disk().entries[disk().entries.length - 1]!;
    return {
      tag: `${String(disk().entries.length).padStart(4, '0')}_deleted_from_the_image`,
      when: last.when + 1,
      breakpoints: true,
      sha256: 'e'.repeat(64),
    };
  };

  it('a stamped migration DELETED from the image → exit 1', async () => {
    // The database ran SQL this image no longer carries. Nothing can undo that,
    // so it is drift, not an append.
    expect(allTags(), 'the ghost tag exists on disk').not.toContain(ghost().tag);
    await stampWith([...disk().entries, ghost()]);
    const result = runGate('precheck');
    expect(result.status).toBe(1);
    expect(result.out).toContain(ghost().tag);
    expect(result.out).toContain('MISSING');
  });

  it('a stamped migration REMOVED FROM THE MIDDLE → exit 1', async () => {
    // Everything except the entry at index 1 — the first divergence is therefore
    // at position 1 for any journal of three or more entries.
    const entries = disk().entries;
    await stampWith([entries[0]!, ...entries.slice(2)]);
    const result = runGate('precheck');
    expect(result.status).toBe(1);
    expect(result.out).toContain('position 1');
  });

  it('a stamped `when` that MOVED, bytes untouched → exit 1', async () => {
    const moved = disk().entries[1]!;
    const entries = disk().entries.map((e, i) => (i === 1 ? { ...e, when: e.when + 1 } : e));
    await stampWith(entries);
    const result = runGate('precheck');
    expect(result.status).toBe(1);
    expect(result.out).toContain(moved.tag);
    expect(result.out).toContain('MOVED');
  });
});

describe('🔴 4. the live-schema half is untouched by any of this', () => {
  beforeAll(async () => {
    await rebuildFull();
  }, 120_000);

  it('migrations IDENTICAL + a column dropped live → exit 1 (the existing behaviour)', async () => {
    expect(runGate('stamp').status).toBe(0);
    expect(runGate('precheck').status, 'the gate refused a database it had just stamped').toBe(0);

    await sql((c) => c.unsafe('ALTER TABLE traces DROP COLUMN IF EXISTS label'));
    const result = runGate('precheck');
    expect(result.status, `a dropped column was not caught:\n${result.out}`).toBe(1);
    expect(result.out).toContain('LIVE-SCHEMA half');
  });

  it('🔴 an APPEND does NOT mask live-schema drift → still exit 1', async () => {
    // The question that decides whether the new ALLOW path is a hole. The
    // migrations half says "appended, fine"; the schema half must still fire.
    const stamped = disk().entries.slice(0, STAMPED_PREFIX);
    await writeStamp({
      stampedAt: new Date().toISOString(),
      migrations: 'legacy-unused-when-files-present',
      // The schema half of a database that has since had a column dropped.
      schema: 'deadbeefdeadbeef',
      journalSha256: disk().journalSha256,
      files: stamped,
    });
    // Prove the migrations half really did say "appended", so the exit 1 below
    // can only be coming from the schema half.
    expect(compareManifests({ entries: stamped }, disk()).verdict).toBe('appended');

    const result = runGate('precheck');
    expect(result.status).toBe(1);
    expect(result.out).toContain('LIVE-SCHEMA half');
    expect(result.out).not.toContain('MIGRATIONS half');
  });
});

describe('🔴 5. a LEGACY aggregate-only stamp, and the one-time conversion', () => {
  let legacyJournal: Buffer;

  beforeAll(async () => {
    legacyJournal = await rebuildPartial(STAMPED_PREFIX);
  }, 120_000);

  const writeLegacy = async (over: Record<string, unknown> = {}): Promise<void> =>
    writeStamp({
      stampedAt: '2026-09-08T11:41:00.000Z',
      migrations: aggregateOf(stampedTags(), legacyJournal),
      schema: await liveSchemaFingerprint(url),
      ...over,
    });

  it('the fixture reproduces ai_service_dev’s REAL stamped hash', async () => {
    // 🔴 THE OTHER DELIBERATE LITERAL, and it must NOT be derived. It is the
    // hash `ai_service_dev` actually carries. If the fixture stops reproducing
    // it, the operator runbook in `plan/schema-gate-additive-migrations.md`
    // describes a different database than the one that exists, and case 5
    // proves nothing about the deploy it was written for.
    //
    // ⚠ Appending a migration must NOT move this. The aggregate is over the
    // first `STAMPED_PREFIX` files and the `STAMPED_PREFIX`-entry journal only,
    // so a 0004 (or 0005) leaves it alone — and this case is what says so.
    expect(aggregateOf(stampedTags(), legacyJournal)).toBe(DEV_LEGACY_AGGREGATE);
  });

  it('a legacy stamp that MATCHES the disk is silent — no conversion needed', async () => {
    // Every legacy-stamped database whose files have NOT moved self-upgrades on
    // its next ordinary deploy. Only a diverged one needs the command.
    await rebuildFull();
    await writeStamp({
      stampedAt: '2026-09-08T11:41:00.000Z',
      migrations: migrationsFingerprint(),
      schema: await liveSchemaFingerprint(url),
    });
    const result = runGate('precheck');
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('is current');

    expect(runGate('stamp').status).toBe(0);
    const written = (await readStamp()) as { files?: unknown[] };
    expect(Array.isArray(written.files), 'stamp did not self-upgrade to the per-file shape').toBe(true);
    legacyJournal = await rebuildPartial(STAMPED_PREFIX);
  }, 180_000);

  it('a legacy stamp that DIFFERS exits 1 — one hash cannot prove a prefix', async () => {
    await writeLegacy();
    const result = runGate('precheck');
    expect(result.status).toBe(1);
    expect(result.out).toContain(DEV_LEGACY_AGGREGATE);
    expect(result.out).toContain('PREDATES THE PER-FILE LIST');
    expect(result.out).toContain('adopt-append');
  });

  it('🔴 adopt-append with the proof satisfied converts the stamp, and precheck then allows', async () => {
    await writeLegacy();
    const convert = runGate('adopt-append', '--expect', expectArg());
    expect(convert.status, `the conversion refused a provable case:\n${convert.out}`).toBe(0);

    const written = (await readStamp()) as {
      files: MigrationRecord[];
      migrations: string;
      schema: string;
    };
    // 🔴 IT BLESSED NOTHING NEW: the stamp still describes the OLD set only.
    expect(written.files.map((f) => f.tag)).toEqual(stampedTags());
    expect(written.migrations).toBe(DEV_LEGACY_AGGREGATE);
    expect(written.files).toEqual(disk().entries.slice(0, STAMPED_PREFIX));

    // …and the very next precheck has to reach "appended" on its own merits.
    const after = runGate('precheck');
    expect(after.status, after.out).toBe(0);
    expect(after.out).toContain(appendedCountPhrase());
  }, 120_000);

  it('🔴 refuses a WRONG --expect list', async () => {
    await writeLegacy();

    // ── (a) NOT THE TRAILING RUN. An interior migration was not appended, and
    // naming one must not work. `interiorRun` stops one short of the journal's
    // end, so it is never a suffix — assert that, or a shrinking journal could
    // turn this fixture into a VALID argument and the case would pass while
    // proving the opposite.
    const interior = interiorRun();
    expect(interior, 'the interior run degenerated into the trailing run').not.toEqual(
      allTags().slice(-interior.length),
    );
    const interiorResult = runGate('adopt-append', '--expect', interior.join(','));
    expect(interiorResult.status).toBe(1);
    expect(interiorResult.out).toContain('must be the LAST');

    // ── (b) TRAILING BUT TOO SHORT. Dropping the oldest appended tag leaves a
    // genuine suffix, so it clears the trailing-run check — and then the
    // reconstruction folds that migration into the old set and the byte proof
    // misses. Both halves have to hold for this to be the case it claims.
    const tooFew = shortTrailingRun();
    expect(tooFew, 'the short run is not a suffix — it would fail the wrong check').toEqual(
      allTags().slice(-tooFew.length),
    );
    expect(tooFew.length, 'the short run is not shorter than the appended set').toBeLessThan(
      appendedTags().length,
    );
    const tooFewResult = runGate('adopt-append', '--expect', tooFew.join(','));
    expect(tooFewResult.status).toBe(1);
    expect(tooFewResult.out).toContain('COULD NOT BE PROVED');

    // ── (c) A tag that is not in the journal at all.
    expect(allTags()).not.toContain(ABSENT_TAG);
    const nonsense = runGate('adopt-append', '--expect', ABSENT_TAG);
    expect(nonsense.status).toBe(1);
  });

  it('🔴 refuses when an OLD file was mutated — the prototype case, through this door too', async () => {
    // The conversion must not become a way around the edit check. Here the
    // stamped aggregate belongs to a DIFFERENT 0001, so the reconstruction from
    // the files on disk cannot reproduce it.
    await writeLegacy({ migrations: 'a1b2c3d4e5f60718' });
    const result = runGate('adopt-append', '--expect', expectArg());
    expect(result.status).toBe(1);
    expect(result.out).toContain('COULD NOT BE PROVED');
    expect(result.out).toContain('was EDITED');
    expect(result.out).toContain('WIPE');
  });

  it('🔴 refuses when the LIVE SCHEMA moved under the stamp', async () => {
    await writeLegacy({ schema: 'deadbeefdeadbeef' });
    const result = runGate('adopt-append', '--expect', expectArg());
    expect(result.status).toBe(1);
    expect(result.out).toContain('LIVE-SCHEMA half does not match');
  });

  it('accepts the exact old journal bytes via --old-journal', async () => {
    // The escape route for a journal whose old bytes the reconstruction cannot
    // reproduce (a hand-formatted one, say). Same proof, supplied input.
    await writeLegacy();
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'ai-svc-journal-')), 'old.json');
    writeFileSync(file, legacyJournal);
    const result = runGate('adopt-append', '--expect', expectArg(), '--old-journal', file);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('supplied');
  });

  it('🔴 refuses a stamp that ALREADY carries the per-file list', async () => {
    // Nothing to convert, and converting anyway would let the command move a
    // modern stamp backwards.
    await writeStamp(await stampFor(STAMPED_PREFIX, legacyJournal));
    const result = runGate('adopt-append', '--expect', expectArg());
    expect(result.status).toBe(1);
    expect(result.out).toContain('ALREADY carries a per-file list');
  });

  it('🔴 refuses an UNSTAMPED database rather than inventing a stamp', async () => {
    await clearStamp();
    const result = runGate('adopt-append', '--expect', expectArg());
    expect(result.status).toBe(1);
    expect(result.out).toContain('no readable stamp');
  });

  it('🔴 refuses with no --expect at all', () => {
    const result = runGate('adopt-append');
    expect(result.status).toBe(2);
    expect(result.out).toContain('--expect is required');
  });
});

describe('🔴 6. unstamped and empty databases still ADOPT', () => {
  it('an UNSTAMPED, fully migrated database adopts — a refusal here is a fleet outage', async () => {
    // An environment can carry NO stamp. Refusing "unstamped" would take it down
    // on its first deploy.
    await rebuildFull();
    await clearStamp();
    const result = runGate('precheck');
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('ADOPTING');
    expect(result.out).toContain('no schema stamp');
  }, 120_000);

  it('🔴 an EMPTY database adopts even while carrying a DIVERGED stamp', async () => {
    // The stamp outlives DROP SCHEMA — it lives in the cluster-wide
    // pg_shdescription. So step 2 of the gate's own wipe→migrate→reseed remedy
    // meets a database with no tables and a stale stamp, and refusing there
    // would block the remedy the error message prints.
    await writeStamp({
      stampedAt: new Date().toISOString(),
      migrations: 'not-this-one',
      schema: 'nor-this-one',
      journalSha256: 'x'.repeat(64),
      files: [{ tag: '0000_gone', when: 1, breakpoints: true, sha256: 'a'.repeat(64) }],
    });
    await sql((c) => c.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public'));

    const survived = (await readStamp()) as { migrations: string };
    expect(survived.migrations, 'the stamp did not survive the wipe').toBe('not-this-one');

    const result = runGate('precheck');
    expect(result.status, `the gate blocked its own remedy:\n${result.out}`).toBe(0);
    expect(result.out).toContain('no base tables are visible');
  }, 120_000);
});

describe('🔴 7. stamp refuses a database the LEDGER says was never migrated', () => {
  // 🔴 WHAT THIS CLOSES. Both fingerprints read the DISK and the LIVE SCHEMA.
  // Neither can see whether the migrate step actually ran, so `stamp` used to
  // write "four migrations applied" purely because four files existed.
  //
  // MEASURED before the fix, on this very harness: a database at 0000/0001 with
  // a matching per-file stamp; `precheck` correctly ALLOWED the appended
  // 0002/0003; `stamp` was then run WITHOUT migrating and recorded all four.
  // Every later `precheck` read "is current" — forever — against a database
  // missing two migrations, and the first attempt to apply them failed on an
  // already-existing type.
  //
  // SABOTAGE (measured): replacing the ledger verdict in `stamp`
  // with a hardcoded `null` turns the first two cases below RED —
  // "stamp recorded migrations that were never applied" and "a missing ledger
  // was stamped over". Disabling the ledger check in `adopt-append` the same way
  // turns the third RED and leaves the other 23 green, so the three cases are
  // independent rather than one check asserted three times.
  //
  // ⚠ NOT REACHABLE THROUGH THE DEPLOY CHAIN TODAY: `precheck && migrate &&
  // stamp` propagates the migrate step's exit 1, and drizzle 0.38.4 applies
  // everything in ONE transaction. It IS reachable through `npm run db:gate
  // stamp`, and through the next edit to that chain. A guard that depends on
  // the punctuation in a package script is not a guard.

  it('runs the REAL CLI: precheck ALLOWS, stamp WITHOUT migrating exits 1 and writes nothing', async () => {
    const journalBytes = await rebuildPartial(STAMPED_PREFIX);
    const original = await stampFor(STAMPED_PREFIX, journalBytes);
    await writeStamp(original);

    /** The newest migration the database actually applied. */
    const ledgerHead = disk().entries[STAMPED_PREFIX - 1]!;
    /** The newest migration the IMAGE carries — the journal's last entry. */
    const diskHead = disk().entries[disk().entries.length - 1]!;

    // The ledger really is short — otherwise the refusal below proves nothing.
    const before = await sql(
      (c) => c<{ n: string; m: string }[]>`
        select count(*)::text as n, max(created_at)::text as m from public.__drizzle_migrations
      `,
    );
    expect(
      Number(before[0]!.n),
      `the partial migrate did not stop at ${STAMPED_PREFIX}`,
    ).toBe(STAMPED_PREFIX);
    expect(
      Number(before[0]!.m),
      'drizzle does not store the journal `when` as created_at — the whole check rests on this',
    ).toBe(ledgerHead.when);

    // ── precheck says APPEND, exactly as it should. The hole is what came next.
    const allowed = runGate('precheck');
    expect(allowed.status, allowed.out).toBe(0);
    expect(allowed.out).toContain(appendedCountPhrase());

    // ── and stamp, run WITHOUT the migrate step in between, must refuse ──
    const stamped = runGate('stamp');
    expect(stamped.status, `stamp recorded migrations that were never applied:\n${stamped.out}`).toBe(1);
    expect(stamped.out).toContain('REFUSING TO STAMP');
    expect(stamped.out).toContain('HAVE NOT ALL BEEN APPLIED');
    // It names BOTH numbers, or an operator cannot tell which side is behind:
    // the ledger's newest `created_at`, and the journal's last `when`.
    expect(stamped.out, 'it did not name the LEDGER head').toContain(String(ledgerHead.when));
    expect(stamped.out, 'it did not name the DISK head').toContain(String(diskHead.when));
    expect(stamped.out, 'it did not name the journal’s last tag').toContain(diskHead.tag);
    // 🔴 And it is NOT dressed as schema drift: the wipe remedy is the wrong
    // remedy here and printing it would send the operator to destroy a database
    // that only needed `npm run db:migrate`.
    expect(stamped.out).toContain('NOT A SCHEMA-DRIFT VERDICT');
    expect(stamped.out).not.toContain('WIPE    the database');

    // 🔴 THE STAMP IS BYTE-FOR-BYTE WHAT IT WAS. A refusal that had already
    // written would be the failure itself, just with an angry log line.
    expect(await readStamp()).toEqual(original);

    // ── migrate, THEN stamp: the same command now succeeds ──
    await ensureSchema(url);
    const after = runGate('stamp');
    expect(after.status, `stamp refused a database that HAD been migrated:\n${after.out}`).toBe(0);
    const written = (await readStamp()) as { files: MigrationRecord[] };
    expect(written.files.map((f) => f.tag)).toEqual(disk().entries.map((e) => e.tag));

    // …and the deploy after this one is quiet, which is the state the false
    // stamp used to counterfeit.
    const quiet = runGate('precheck');
    expect(quiet.status, quiet.out).toBe(0);
    expect(quiet.out).toContain('is current');
  }, 240_000);

  it('🔴 refuses when the ledger TABLE is gone — not "nothing to compare"', async () => {
    // `to_regclass` returning null means no migration has ever been recorded.
    // Treating that as ignorance would let the one database most obviously
    // unmigrated be stamped as fully migrated.
    await rebuildFull();
    await sql((c) => c.unsafe('DROP TABLE public.__drizzle_migrations'));
    const result = runGate('stamp');
    expect(result.status, `a missing ledger was stamped over:\n${result.out}`).toBe(1);
    expect(result.out).toContain('DOES NOT EXIST');
    expect(await readStamp(), 'it wrote a stamp anyway').toBeNull();
  }, 180_000);

  it('🔴 adopt-append refuses when the ledger has ALREADY applied the --expect tags', async () => {
    // THE ASYMMETRY, asserted. `stamp` requires the NEW tags to be in the
    // ledger; `adopt-append` must NOT — they are unapplied by definition — but
    // it must require the OLD set's last `when` to BE the ledger head.
    //
    // Here every proof adopt-append already made passes: the stamp is legacy,
    // the live schema matches, and the byte reconstruction reproduces the old
    // aggregate. Only the ledger disagrees — it holds all four. Converting would
    // make the next precheck announce "2 appended, migrate will apply them",
    // drizzle would apply NOTHING (their `when` no longer beats the head), and
    // stamp would record them as done.
    await rebuildFull();
    const { dir, journalBytes } = partialMigrationsDir(STAMPED_PREFIX);
    rmSync(dir, { recursive: true, force: true });
    const legacy = {
      stampedAt: '2026-09-08T11:41:00.000Z',
      migrations: aggregateOf(stampedTags(), journalBytes),
      schema: await liveSchemaFingerprint(url),
    };
    await writeStamp(legacy);
    expect(legacy.migrations, 'the fixture stopped reproducing the real dev stamp').toBe(
      DEV_LEGACY_AGGREGATE,
    );

    const result = runGate('adopt-append', '--expect', expectArg());
    expect(result.status, `a converted-onto-an-applied-ledger stamp was allowed:\n${result.out}`).toBe(1);
    expect(result.out).toContain('LEDGER DOES NOT AGREE');
    // It names the entry the ledger head SHOULD have been — the last of the old set.
    expect(result.out).toContain(stampedTags()[STAMPED_PREFIX - 1]!);
    // 🔴 IT IS THE LEDGER TALKING, NOT THE OTHER TWO PROOFS. If either of those
    // fired instead, this case would be passing for a reason it does not test.
    expect(result.out).not.toContain('COULD NOT BE PROVED');
    expect(result.out).not.toContain('LIVE-SCHEMA half does not match');
    // And nothing was written: the stamp is still the legacy one.
    expect(await readStamp()).toEqual(legacy);
  }, 180_000);
});
