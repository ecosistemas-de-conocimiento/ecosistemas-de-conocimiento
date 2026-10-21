// Lives in its own module, NOT in `client.ts`: many unit suites
// `vi.mock('../db/client.js', () => ({ db: ... }))`, and the /v1 error handler
// must keep working under those mocks. Importing this file opens no pool.
// ── "The database is unreachable", as opposed to "this query is wrong" ──────
//
// The /v1 error handler (`src/server.ts`) answers these with a 503 instead of
// the generic 500, so a caller's retry logic sees a transient outage. Every
// 5xx except 501 is already retryable in `@edc/ai-client`, so the 500 to
// 503 change does not break a consumer.
//
// Only connection-level failures belong here. A FATAL that is about the
// session itself (25P03, the idle-in-transaction timeout `client.ts` sets) is a bug in
// our code, not an outage, and stays a 500.
// postgres.js's own connection errors (`postgres/src/errors.js`). These names
// are the driver's; no other client in the service uses them, so the code
// alone identifies the database. Some are rejected without the `query` tag
// below (`CONNECTION_ENDED` / `CONNECTION_DESTROYED` in `postgres/src/index.js`).
const DRIVER_CONNECTION_CODES: ReadonlySet<string> = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'CONNECT_TIMEOUT',
]);

// node socket errors. These are NOT database-specific: an OpenRouter DNS
// failure on `/v1/embed` is a `fetch failed` TypeError with an ENOTFOUND
// `cause`. So they count only on an error postgres.js itself rejected a query
// with. Its `queryError` (`postgres/src/connection.js`) defines an own `query`
// property on every such error. MEASURED 2026-10-18 on postgres 3.4.9:
// ECONNREFUSED and ENOTFOUND from the driver carry it, and undici's fetch
// error and its `cause` do not.
const SOCKET_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

// Postgres SQLSTATEs that mean "no usable server": class 08 (connection
// exception; PgBouncer reports its own failures as 08P01), 57P01-57P03
// (shutdown / starting up), 53300 (too many connections).
const SERVER_UNAVAILABLE_SQLSTATES: ReadonlySet<string> = new Set([
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

export function isDatabaseUnavailableError(err: unknown): boolean {
  // drizzle 0.38 rethrows the driver error as is; newer drizzle wraps it in
  // `DrizzleQueryError` with the driver error as `cause`. Walk a few links.
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const e = cur as { name?: unknown; code?: unknown; cause?: unknown };
    if (typeof e.code === 'string') {
      if (DRIVER_CONNECTION_CODES.has(e.code)) return true;
      if (SOCKET_CODES.has(e.code) && Object.hasOwn(e, 'query')) return true;
      if (
        e.name === 'PostgresError' &&
        (e.code.startsWith('08') || SERVER_UNAVAILABLE_SQLSTATES.has(e.code))
      ) {
        return true;
      }
    }
    cur = e.cause;
  }
  return false;
}
