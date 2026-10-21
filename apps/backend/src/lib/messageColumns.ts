/**
 * THE GUARDED CLAIM AND THE PER-RUN TOKEN, for one chat turn.
 *
 * The same two rules `anonymiseDocumentText` follows on a `documents` row
 * (`GATE_CLAIM_GUARD`, `GATE_RUNNING_CODE` in `./anonymiseDocument`):
 *
 *   1. CLAIM IN ONE STATEMENT. `UPDATE messages SET corpus_status =
 *      'embedding', corpus_error = <token> WHERE id = … AND corpus_status IN
 *      (<runnable>)`. Two conversation runs (the question's and the answer's
 *      `afterChange` hooks fire seconds apart) cannot both claim a turn, in one
 *      process or in two. A Payload `find` + `update` left a window.
 *   2. EVERY LATER WRITE OF THE RUN IS GUARDED on `embedding` + its token. The
 *      stalled-turn sweep (`sweepStalledMessages`) moves a stuck turn to
 *      `failed` and overwrites `corpus_error`, so a run that outlived the sweep
 *      cannot write its stale verdict over a newer run's.
 *
 * Writes only the named columns (see `./documentColumns` for why a whole-row
 * `payload.update` is wrong for a background status write), and skips the
 * `afterChange` hook, so a status write never starts another ingest run.
 */

import { sql } from '@payloadcms/db-postgres'

type Sql = ReturnType<typeof sql>

export interface MessageColumnsPayload {
  db: { drizzle: { execute(query: Sql): Promise<unknown> } }
}

/** The `messages` fields a conversation run may write. Spliced in as identifiers. */
const COLUMNS = {
  corpusStatus: 'corpus_status',
  corpusError: 'corpus_error',
  corpusIngestId: 'corpus_ingest_id',
  redactedText: 'redacted_text',
  anonymisationReport: 'anonymisation_report',
} as const

export type MessageColumnField = keyof typeof COLUMNS

/** Prefix of `corpusError` while a run holds a turn, followed by the run's token. */
export const TURN_RUNNING_CODE = 'gate_running'

function param(value: unknown): Sql {
  if (value === undefined || value === null) return sql`NULL`
  if (typeof value === 'object') return sql`${JSON.stringify(value)}`
  return sql`${value}`
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length
  const r = result as { rowCount?: unknown; rows?: unknown } | null
  if (typeof r?.rowCount === 'number') return r.rowCount
  if (Array.isArray(r?.rows)) return r.rows.length
  return 0
}

function numericId(id: number | string): number | string {
  return typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id
}

/**
 * Claim one turn for this run: `embedding` + the token, only from a runnable
 * state. True when this run owns the turn now.
 */
export async function claimTurn(
  payload: MessageColumnsPayload,
  id: number | string,
  token: string,
  runnable: readonly string[],
): Promise<boolean> {
  if (runnable.length === 0) return false
  const result = await payload.db.drizzle.execute(
    sql`UPDATE messages SET corpus_status = 'embedding', corpus_error = ${token}, updated_at = ${new Date().toISOString()} WHERE id = ${numericId(id)} AND corpus_status IN (${sql.join(
      runnable.map((s) => sql`${s}`),
      sql`, `,
    )}) RETURNING id`,
  )
  return rowCount(result) > 0
}

/**
 * One write of the run that claimed the turn, guarded on `embedding` + its
 * token. False when the run no longer owns the turn (a sweep or a newer run
 * took it over): nothing was written.
 */
export async function finishTurn(
  payload: MessageColumnsPayload,
  id: number | string,
  token: string,
  data: Partial<Record<MessageColumnField, unknown>>,
): Promise<boolean> {
  const sets = Object.entries(data).map(([field, value]) => {
    const name = (COLUMNS as Record<string, string>)[field]
    if (!name) throw new Error(`finishTurn: no column for field "${field}"`)
    return sql`${sql.identifier(name)} = ${param(value)}`
  })
  if (sets.length === 0) return false
  sets.push(sql`updated_at = ${new Date().toISOString()}`)
  const result = await payload.db.drizzle.execute(
    sql`UPDATE messages SET ${sql.join(sets, sql`, `)} WHERE id = ${numericId(id)} AND corpus_status = 'embedding' AND corpus_error = ${token} RETURNING id`,
  )
  return rowCount(result) > 0
}
