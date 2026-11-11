/**
 * The Postgres pool's checkout timeout. Without one (pg's default is 0: wait
 * forever) a starved pool hangs every request for good; with one, a request
 * that cannot get a connection fails, its transaction rolls back, and the
 * pool recovers. 16 concurrent `/api/miembros` adds on the deadlock that
 * `findAll` in `lib/permissions.ts` describes: hung past 60 s with no
 * timeout; 7 landed and 9 answered 500 with 5 s or 30 s, and the next query
 * answered (measured 2026-11-10 on torre, real Postgres).
 *
 * 10 s: the longest a normal checkout waited was 1.9 s, at 40 concurrent adds
 * by one manager (p99 1.5-1.8 s, two runs, same host). 10 s is about 5× that
 * (inferred margin). pg's default `max`, 10, stays.
 */
export const DB_POOL_CONNECTION_TIMEOUT_MS = 10_000
