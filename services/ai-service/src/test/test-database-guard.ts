// Structural guard against destructive test tooling hitting a live database.
//
// WHY THIS EXISTS
// ---------------
// `npm run test:integration` once truncated a live local database. The integration suite calls `truncateAll()` in
// `beforeEach`, and `src/test/integration-setup.ts` carried a hardcoded
// fallback pointing at `localhost:55432/ai_service` — the same host, port AND
// database name the live local stack used at the time. The
// connection string therefore carried NO signal distinguishing "throwaway test
// DB" from "live DB", so nothing in the code could have caught it.
//
// The fix is two-part, and this file is the enforcement half:
//   1. ai-service's own `docker-compose.yml` now provisions the test database
//      as `ai_service_test`, so the NAME carries the meaning.
//   2. Every destructive path asserts that name before it connects.
//
// Deliberately NOT an opt-in "I promise this is safe" env var. A footgun
// defused by remembering to set a flag is not defused.
//
// Zero dependencies and no I/O by design: the guard must be able to refuse
// BEFORE anything opens a socket, and it must be unit-testable in the
// dependency-free `npm test` suite.

/** Every destructive path requires the target database name to end in this. */
export const TEST_DATABASE_SUFFIX = '_test';

/**
 * Every table ai-service's own migrations create, plus drizzle's ledger.
 *
 * This is the second half of the guard, and it exists because the name check
 * alone is not sufficient. Once an unrelated product's live Postgres
 * was found occupying host port 55432 —
 * the exact port the integration suite defaulted to. The old default URL named
 * database `ai_service_test`, so `assertTestDatabase` would have PASSED while
 * pointing at a stranger's server: the name travels in the connection string
 * we wrote, not from the server we reached. Only a role-name mismatch
 * (`ai_service` vs `edc`) stopped it, which is luck, not a guard.
 *
 * A name cannot prove which server answered. The tables can: a database that
 * holds tables ai-service never creates is not ai-service's test database, no
 * matter what the URL calls it.
 *
 * ⚠ Keep in sync with `src/db/schema/index.ts`. A new `pgTable` that is not
 * added here makes the integration suite refuse to run — loudly, at setup,
 * with the offending name printed. That is the intended failure direction:
 * fail closed and make someone look, rather than silently widen the guard.
 */
export const KNOWN_TEST_TABLES: ReadonlySet<string> = new Set([
  // drizzle migration ledger (public schema — see db/migrations-config.ts)
  '__drizzle_migrations',
  // core
  'llm_configs',
  'project_configs',
  'registry_entries',
  'registry_audit',
  'generation_requests',
  'generation_jobs',
  'traces',
  'usage_logs',
  'budget_state',
  'budget_reservations',
  // RAG
  'corpora',
  'corpus_aliases',
  'documents',
  'chunks',
  'ingest_requests',
  'ingest_jobs',
  // callbacks
  'callback_deliveries',
]);

/**
 * Refuse to proceed when the target database holds tables ai-service does not
 * own — i.e. when we have reached somebody else's database.
 *
 * Pure and I/O-free on purpose: the caller queries `information_schema` and
 * hands the names in, so this stays unit-testable in the dependency-free
 * `npm test` suite alongside the rest of the guard.
 *
 * An EMPTY list passes: a freshly created throwaway database legitimately has
 * no tables yet, and that is the normal path.
 *
 * @throws Error naming the foreign tables it refused.
 */
export function assertOnlyKnownTables(
  tableNames: readonly string[],
  url: string | undefined,
  context: string,
): void {
  const foreign = tableNames.filter((t) => !KNOWN_TEST_TABLES.has(t)).sort();
  if (foreign.length === 0) return;

  const shown = foreign.slice(0, 12);
  const andMore = foreign.length > shown.length ? `, … (+${foreign.length - shown.length} more)` : '';

  throw new Error(
    `REFUSED: ${context} reached a database holding ${foreign.length} table(s) ` +
      `ai-service does not own.\n\n` +
      `  Resolved target: ${url === undefined ? '<unknown>' : redactUrl(url)}\n` +
      `  Foreign tables:  ${shown.join(', ')}${andMore}\n\n` +
      `This operation destroys data (TRUNCATE / DELETE / migrations), so it ` +
      `refuses any database that is not recognisably ai-service's own.\n\n` +
      `The database NAME cannot prove this on its own — it travels in the ` +
      `connection string we wrote, not from the server that answered. On ` +
      `2026-08-21 an unrelated product's live Postgres was found on host port ` +
      `55432, the port this suite used to default to, where a URL naming ` +
      `"ai_service_test" would have passed the name check and truncated it.\n\n` +
      `If you set TEST_DATABASE_URL, it is pointing somewhere unexpected. ` +
      `Unset it to let the suite start its own throwaway container instead ` +
      `(nothing was connected to destructively, or modified).`,
  );
}

/**
 * Pull the database name out of a Postgres connection URL.
 *
 * Returns `null` when the URL is unparseable or carries no database path, so
 * callers can treat "I cannot prove this is a test database" the same as
 * "this is not a test database" — the guard fails closed.
 */
export function databaseNameFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // `postgres://user:pass@host:5432/dbname?sslmode=require` → pathname `/dbname`.
  // `URL` strips the query string for us; decode so `%5F` etc. compare correctly.
  let name: string;
  try {
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
  return name.length > 0 ? name : null;
}

/** True only when the URL names a database ending in `_test`. Fails closed. */
export function isTestDatabaseUrl(url: string): boolean {
  const name = databaseNameFromUrl(url);
  return name !== null && name.endsWith(TEST_DATABASE_SUFFIX);
}

/**
 * Strip the password out of a connection URL so the refusal message is safe to
 * print, log and paste into a bug report.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    // Unparseable: show nothing rather than risk leaking a credential.
    return '<unparseable connection URL>';
  }
}

/**
 * Refuse to proceed unless `url` unmistakably names a test database.
 *
 * MUST be called before opening any connection that could mutate — migrations,
 * TRUNCATE, DELETE. `context` names the operation being refused so the message
 * is actionable ("integration test setup", "truncateAll()", ...).
 *
 * @throws Error naming the database it refused and why.
 */
export function assertTestDatabase(url: string | undefined, context: string): void {
  if (!url) {
    throw new Error(
      `REFUSED: ${context} has no database URL to check.\n\n` +
        `This operation destroys data and will only run against a database ` +
        `whose name ends in "${TEST_DATABASE_SUFFIX}". Set TEST_DATABASE_URL ` +
        `(see .env.example) and retry.`,
    );
  }

  const name = databaseNameFromUrl(url);
  if (name !== null && name.endsWith(TEST_DATABASE_SUFFIX)) return;

  const named = name === null ? '<none — unparseable URL>' : `"${name}"`;
  throw new Error(
    `REFUSED: ${context} targets database ${named}, which is not a test database.\n\n` +
      `This operation destroys data (TRUNCATE / DELETE / migrations). It will ` +
      `only run against a database whose name ends in "${TEST_DATABASE_SUFFIX}".\n\n` +
      `  Resolved target: ${redactUrl(url)}\n` +
      `  Database name:   ${named}\n\n` +
      `On 2026-07-27 this exact code path truncated a live local database, ` +
      `because the live DB and the test DB shared the name "ai_service". The ` +
      `test database is now named "ai_service_test" so the name itself carries ` +
      `the meaning.\n\n` +
      `To fix: UNSET TEST_DATABASE_URL and let the integration suite start its ` +
      `own throwaway container on a Docker-allocated port. Do not hand-write a ` +
      `host:port — port 55432 has been observed holding an unrelated product's ` +
      `LIVE Postgres on this fleet.\n\n` +
      `(If you meant to target a real database, you did not — nothing was ` +
      `connected to or modified.)`,
  );
}
