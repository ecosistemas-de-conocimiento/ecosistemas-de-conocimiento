// Single source of truth for WHERE the drizzle migration ledger lives.
//
// ── Why this is not the default ───────────────────────────────────────────
// drizzle-kit puts `__drizzle_migrations` in its own `drizzle` schema
// (`node_modules/drizzle-orm/pg-core/dialect.js:46`). Payload-based products in
// the CMS keeps `payload_migrations` in `public`. That split means
// `DROP SCHEMA public CASCADE` wipes the ledger on a Payload product but
// silently LEAVES IT BEHIND on ai-service — the DB then looks empty while
// drizzle believes every migration is already applied, so the next boot applies
// nothing and the service starts against a schema-less database. That has
// already cost a cycle. Pinning the ledger to `public` makes "drop schema
// public" mean the same thing in every product.
//
// ⚠ Keep in sync with `drizzle.config.ts` (root). It cannot import this module:
// drizzle-kit loads that file with its own CJS/esbuild-register loader, which
// can't follow the `.js`-extension imports the app code uses. The drift is
// covered by `migrations-config.test.ts`.
//
// ── 🔴 ROLLOUT: this is a migration-STATE change on live databases ────────
// The runtime migrator resumes by reading the single newest ledger row
// (`select ... order by created_at desc limit 1`) and skipping every migration
// whose `folderMillis` is not greater. It does NOT look in the old schema. So
// on a database whose ledger still lives in `drizzle`, the first boot after
// this change creates an EMPTY `public.__drizzle_migrations` and tries to
// re-apply `0000_baseline.sql` from scratch.
//
// That baseline is NOT idempotent (bare `CREATE TYPE` / `CREATE TABLE`, only
// one `IF NOT EXISTS` in the whole file), so it fails on the first
// `CREATE TYPE "public"."budget_enforcement"`. The whole apply loop runs inside
// ONE transaction, so it rolls back: **no data is touched and nothing is
// dropped**. The failure mode is the container refusing to start — the image
// runs `node dist/db/migrate.js && exec node dist/index.js` — not data loss.
// An outage, in other words, not a disaster. But it must not be deployed blind.
//
// BEFORE deploying this change to any environment that already has data, move
// the ledger. Pure metadata: it touches no application table, and in particular
// does not go near `chunks` (dev holds ~1.9k embedded chunks, demo-0 ~2.2k —
// re-embedding them costs real money).
//
//   CREATE TABLE IF NOT EXISTS public.__drizzle_migrations (
//     id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
//   );
//   INSERT INTO public.__drizzle_migrations (hash, created_at)
//   SELECT hash, created_at FROM drizzle.__drizzle_migrations
//   WHERE NOT EXISTS (SELECT 1 FROM public.__drizzle_migrations);
//   -- verify: both tables report the same max(created_at), then deploy.
//   -- after a clean boot, optionally: DROP SCHEMA drizzle CASCADE;
//
// The `WHERE NOT EXISTS` makes the copy safe to re-run. Keep `drizzle` around
// until the deploy is confirmed green — it is the rollback.
//
// A FRESH database (local docker, CI, a brand-new environment) needs none of
// this: `public.__drizzle_migrations` is created empty, every migration applies
// in order, and the `drizzle` schema is never created at all. That is the
// end state we want everywhere.
//
// ⚠ This is a per-environment step, not a one-shot. Any environment that
// redeploys ai-service from this commit without the copy above will fail to
// boot — including ones nobody is actively working on.

/** Ledger table name. Drizzle's default; named here so the pair is explicit. */
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * Ledger schema. `public`, NOT drizzle's `drizzle` default — see the header.
 * Repo-wide invariant: "drop schema public" means the same thing in every
 * product, whether it migrates with drizzle or with Payload.
 */
export const MIGRATIONS_SCHEMA = 'public';

/** Spread into `migrate(db, { migrationsFolder, ...MIGRATIONS_CONFIG })`. */
export const MIGRATIONS_CONFIG = {
  migrationsTable: MIGRATIONS_TABLE,
  migrationsSchema: MIGRATIONS_SCHEMA,
} as const;
