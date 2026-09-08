/**
 * Read-only Postgres access for the harness, through `psql`.
 *
 * ── WHY `psql` AND NOT A CLIENT LIBRARY ─────────────────────────────────────
 *
 * `pg`, `postgres` and `drizzle-orm` are all UNRESOLVABLE from `apps/backend`
 * under pnpm's strict layout — they exist only as transitives of
 * `@payloadcms/db-postgres`. The alternatives were: add a dependency to a
 * product `package.json` (out of scope for an eval), or boot a real Payload
 * instance (whose `onInit` seeds and starts janitors against the SHARED dev
 * database). Shelling out to `psql` needs neither, and it has a property both
 * alternatives lack: every statement this harness runs is a string you can
 * paste into a terminal and check.
 *
 * 🔴 EVERY CALL HERE IS A `SELECT`. The harness never writes to `edc_backend`
 * or `edc_ai`. Both are shared dev databases (see `sprint0/00-context.md`).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { EvalEnv } from './env'

const run = promisify(execFile)

/** ~48 MB of JSON is plenty for the biggest read here (191 documents' text). */
const MAX_BUFFER = 48 * 1024 * 1024

/**
 * Run one SELECT and return its rows as JSON.
 *
 * The statement is wrapped in `json_agg` so the transport is a single JSON
 * document rather than a delimiter-separated table — the corpus text contains
 * newlines, tabs and pipes, and every delimiter-based format loses to one of
 * them.
 */
export async function selectJson<T>(
  env: EvalEnv,
  database: string,
  statement: string,
): Promise<T[]> {
  const wrapped = `SELECT coalesce(json_agg(t), '[]'::json)::text FROM (\n${statement}\n) t`
  const { stdout } = await run(
    'psql',
    [
      '-h', env.pg.host,
      '-p', String(env.pg.port),
      '-U', env.pg.user,
      '-d', database,
      '-At',
      '-v', 'ON_ERROR_STOP=1',
      '-c', wrapped,
    ],
    { env: { ...process.env, PGPASSWORD: env.pg.password }, maxBuffer: MAX_BUFFER },
  )
  return JSON.parse(stdout.trim() || '[]') as T[]
}

/**
 * A rendered drizzle statement: `{ text, params }`.
 *
 * ⚠ This mirrors drizzle's own `sqlToQuery` and is copied from
 * `apps/backend/src/lib/graph/queries.test.ts`, which already keeps it as a way
 * of INSPECTING production code rather than as part of it. Same purpose here.
 */
export function renderSql(query: unknown): { text: string; params: unknown[] } {
  const params: unknown[] = []
  const walk = (node: { queryChunks: unknown[] }): string =>
    node.queryChunks
      .map((chunk) => {
        const name = (chunk as { constructor?: { name?: string } })?.constructor?.name
        if (name === 'StringChunk') return (chunk as { value: string[] }).value.join('')
        if (name === 'SQL') return walk(chunk as { queryChunks: unknown[] })
        params.push(chunk)
        return `$${params.length}`
      })
      .join('')
  return { text: walk(query as { queryChunks: unknown[] }), params }
}

/**
 * Substitute a rendered statement's placeholders with literals.
 *
 * 🔴 IT REFUSES ANYTHING THAT IS NOT AN INTEGER, or an array of integers. Every
 * parameter in the graph read path is an id, a threshold or a limit, so that
 * covers all of them — and it means this function cannot be the place a string
 * from a user reaches SQL. If a future statement binds text, this throws rather
 * than quoting it, and whoever added it has to come here and think.
 *
 * ⚠ An array renders as `ARRAY[…]`, which is what makes the harness able to run
 * `retrieveEdgesQuery` at all. See `graph.ts` — the shipped path cannot.
 */
export function inlineParams(text: string, params: readonly unknown[]): string {
  const literal = (value: unknown): string => {
    if (typeof value === 'number' && Number.isInteger(value)) return String(value)
    if (Array.isArray(value)) {
      const ints = value.map((v) => {
        if (typeof v !== 'number' || !Number.isInteger(v)) {
          throw new Error(`[eval] refusing to inline a non-integer array element: ${String(v)}`)
        }
        return String(v)
      })
      return `ARRAY[${ints.join(',')}]`
    }
    throw new Error(`[eval] refusing to inline a non-integer parameter: ${JSON.stringify(value)}`)
  }
  // Descending index so `$1` never eats the `$1` inside `$12`.
  let out = text
  for (let i = params.length; i >= 1; i -= 1) {
    out = out.split(`$${i}`).join(literal(params[i - 1]))
  }
  return out
}

/** Render a drizzle statement into a literal, directly executable SELECT. */
export function toExecutableSql(query: unknown): string {
  const { text, params } = renderSql(query)
  return inlineParams(text, params)
}
