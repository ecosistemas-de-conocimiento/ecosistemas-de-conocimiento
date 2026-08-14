// Text-search config (Postgres `regconfig`) whitelist + validation.
//
// WHY THIS EXISTS. The wire carries the lexical `language` for a corpus (and,
// additively, per-document) so the ingest worker can build `chunks.text_search`
// and the hybrid retrieve leg can parse queries with the right stemming. That
// value is cast `::regconfig` in raw SQL, and an unknown name (e.g. `'es'`,
// which is NOT a regconfig) makes `'es'::regconfig` THROW — bricking ingest
// (the tsvector build) and hybrid retrieve (the query parse).
//
// DECISION (Rodrigo). The wire speaks Postgres regconfig names DIRECTLY —
// `'simple'`, `'spanish'`, `'english'`, … — not ISO locale codes. There is no
// `es → spanish` translation layer: the ugly (Postgres) name IS the contract.
// This module's whole job is the validation gate that keeps a bad value from
// ever reaching `::regconfig`:
//   - `isValidTextSearchConfig` — the validation-time whitelist check (reject
//     an unknown name BEFORE it can hit the DB); used by the Zod schemas.
//   - `resolveTextSearchConfig` — total, safe map to a VALID regconfig for the
//     ingest write path (defense-in-depth + the `null`/absent → neutral default).
//
// The whitelist is the set of text-search configurations Postgres ships in
// `pg_catalog` — verified against `pg_ts_config` on the deployed DB (the stock
// snowball set + `simple`; no custom configs are installed). Any of these is a
// valid regconfig that casts without throwing, so accepting the whole set is
// safe. Only Spanish and English get real production use today; the dense
// multilingual embedding model carries cross-language semantic matching for the
// rest, and `'simple'` (no stemming) is the neutral default. Installing a
// custom TS config later is a one-line addition here — no migration.
//
// Exported whole so the corpus-CRUD route surface reuses the SAME whitelist
// instead of re-deriving it (which is how index/query configs drift apart).

/**
 * Postgres text-search configuration names installed on the deployment —
 * mirrors the default `pg_ts_config` set (verified against the live DB). This
 * IS the wire whitelist: a corpus/document `language` must be one of these.
 */
export const TEXT_SEARCH_CONFIGS: ReadonlySet<string> = new Set([
  'simple',
  'arabic',
  'armenian',
  'basque',
  'catalan',
  'danish',
  'dutch',
  'english',
  'finnish',
  'french',
  'german',
  'greek',
  'hindi',
  'hungarian',
  'indonesian',
  'irish',
  'italian',
  'lithuanian',
  'nepali',
  'norwegian',
  'portuguese',
  'romanian',
  'russian',
  'serbian',
  'spanish',
  'swedish',
  'tamil',
  'turkish',
  'yiddish',
]);

/** Neutral, no-stemming regconfig — the safe default for content-agnostic corpora. */
export const NEUTRAL_REGCONFIG = 'simple';

/**
 * True iff `name` is an installed Postgres text-search config (a valid
 * `regconfig`). Case-sensitive: Postgres regconfig names are lower-case and
 * that is what consumers send. Rejects ISO codes like `'es'` (the whole point:
 * a value that would throw at `::regconfig` never gets there).
 */
export function isValidTextSearchConfig(name: string): boolean {
  return TEXT_SEARCH_CONFIGS.has(name);
}

/**
 * Resolve a wire `language` to a regconfig to STORE on a corpus. TOTAL and
 * SAFE: returns a value that is always a valid regconfig, so the result is safe
 * to cast `::regconfig`. `null`/`undefined`/unrecognised → `'simple'`. (The Zod
 * schema already rejects an unrecognised value up front; this fallback is
 * defense-in-depth for any non-wire caller.)
 */
export function resolveTextSearchConfig(name: string | null | undefined): string {
  if (!name) return NEUTRAL_REGCONFIG;
  return TEXT_SEARCH_CONFIGS.has(name) ? name : NEUTRAL_REGCONFIG;
}
