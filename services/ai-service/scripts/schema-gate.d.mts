// Types for `schema-gate.mjs`, so `src/test/integration-database.test.ts` can
// import the two fingerprints and prove the deployed gate agrees with the test
// harness. The script itself stays plain `.mjs` on purpose: it runs inside the
// runtime image, which ships no TypeScript and no `tsx`.
//
// ⚠ Only the pure/read functions are declared. `precheck` and `stamp` are not
// exported — they talk to a database and exit; the test lane must not be able
// to reach for them by accident.

/** sha256 of every `drizzle/*.sql` plus `meta/_journal.json`, first 16 hex chars. */
export declare const migrationsFingerprint: () => string;

/**
 * WHERE THE DRIZZLE LEDGER LIVES, duplicated from `src/db/migrations-config.ts`
 * because this script runs in an image with no TypeScript. Declared here so
 * `integration-database.test.ts` can fail the build if the two ever drift.
 */
export declare const MIGRATIONS_SCHEMA: string;
export declare const MIGRATIONS_TABLE: string;

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
 * The serialisation half, pure. `'empty-schema'` for zero rows — that is
 * IGNORANCE (wiped, or invisible to this role), never a hash.
 */
export declare const fingerprintRows: (rows: readonly LiveSchemaRow[]) => string;

/**
 * Opens its OWN `search_path`-pinned connection to `url`, reads the live column
 * list, and closes it. Never takes a caller's client — see the script's header
 * for the measurement that forced that.
 */
export declare const liveSchemaFingerprint: (url: string) => Promise<string>;

/**
 * One migration as the stamp records it. `sha256` is the FULL 64-hex digest of
 * the file bytes — byte-for-byte the value drizzle stores in
 * `__drizzle_migrations.hash`, so a stamp can be read against the ledger with
 * no re-derivation.
 */
export type MigrationRecord = {
  tag: string;
  when: number;
  breakpoints: boolean;
  sha256: string;
};

/** The per-file half: the journal's own hash, and one record per journal entry IN ORDER. */
export type MigrationsManifest = {
  journalSha256: string;
  entries: MigrationRecord[];
};

/**
 * Reads `drizzle/meta/_journal.json` and, for each entry IN ORDER, hashes
 * `<tag>.sql`. THROWS if an entry names a file that is not there.
 */
export declare const migrationsManifest: () => MigrationsManifest;

/**
 * A 16-hex aggregate over EXACTLY the journal's entries and their hashes — for
 * the boot log only.
 *
 * ⚠ NOT `migrationsFingerprint()` and never comparable to a stamped
 * `migrations` value: that one folds in every `.sql` in the directory, this one
 * only the files the journal names.
 */
export declare const manifestFingerprint: (manifest: {
  journalSha256: string;
  entries: readonly MigrationRecord[];
}) => string;

/**
 * `.sql` files on disk that no journal entry names. Drizzle never applies one,
 * so this is informational — it never changes a verdict.
 */
export declare const unreferencedSqlFiles: (manifest: {
  entries: readonly MigrationRecord[];
}) => string[];

/**
 * `'identical'` (same entries), `'appended'` (the stamped list is a STRICT
 * PREFIX of the disk list and every extra entry's `when` strictly increases),
 * or `'diverged'` (everything else — edited in place, missing, reordered,
 * `when`/`breakpoints` moved). `reason` names which entry and how.
 *
 * Pure: both arguments are plain data, so the unit suite drives it with
 * fixtures and no database.
 */
export declare const compareManifests: (
  stamped: { entries: readonly MigrationRecord[] },
  disk: { entries: readonly MigrationRecord[] },
) => {
  verdict: 'identical' | 'appended' | 'diverged';
  appended: string[];
  reason: string;
};
