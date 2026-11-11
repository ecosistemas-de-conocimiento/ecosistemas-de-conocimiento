/**
 * 🔴 STORED REASON COLUMNS (`ingestError`, `publicationError`…) NEVER SERVE A
 * ROW'S TEXT. Audit 2026-11-11.
 *
 * Since 2026-11-10 every write goes through `safeErrMessage`. Rows written
 * before that can still hold drizzle's `Failed query: <sql>\nparams: <params>`,
 * which quotes the row being written (a testimony, names included). Two
 * guards, one rule ({@link safeStoredReason}):
 *   · on read: {@link withholdRowText}, an `afterRead` field hook on every such
 *     column, so REST, GraphQL and the Local API all get the safe value;
 *   · at rest: {@link cleanStoredReasons} (`scripts/clean-stored-errors.ts`).
 *
 * 🔴 NO PLATFORM-ADMIN EXCEPTION. The cleanup rewrites these values for
 * everyone, so a raw read for admins would only last until it runs; the
 * failure itself is in the logs at the time (as a summary since P-07), and the
 * text is not a debugging aid an admin lacks: it is the row, which an admin
 * reads where it is gated, not through an error column.
 *
 * Not `safeErrMessage` itself: that truncates every value (a valid row would
 * change) and drops the leading `code:` the web maps to Spanish copy.
 */

import type { FieldHook } from 'payload'

import type { ConsentDb } from './consentHold'
import { REDACTED } from './errorSummary'

/**
 * Text that can only come from a database error, in a string. drizzle's shape
 * (also when a wrapper copied it), plus Postgres messages and details that
 * quote a value: `Key (email)=(…)`, `Failing row contains (…)`,
 * `invalid input syntax for type integer: "…"`, and constraint violations.
 * ⚠ Valid as both a JS and a Postgres (ARE) regex: the SQL prefilter is this
 * same source. No `\b`, which is a backspace in Postgres.
 */
export const ROW_TEXT_SOURCE =
  'Failed query:|\\nparams:|Key \\(.*\\)=\\(|Failing row contains \\(|invalid input syntax for type|violates (unique|foreign key|not-null|check|exclusion) constraint'
const ROW_TEXT = new RegExp(ROW_TEXT_SOURCE)

/** The `code: ` our writers put first (`ingest_failed`, `verify`, `content`). */
const CODE_PREFIX = /^([a-z][a-z0-9_.-]{0,40}): /

export function quotesRow(value: string): boolean {
  return ROW_TEXT.test(value)
}

/**
 * The value, unchanged, unless it is database error text: then its leading
 * `code:` (if any) and {@link REDACTED}. Idempotent; non-strings pass.
 */
export function safeStoredReason(value: unknown): unknown {
  if (typeof value !== 'string' || !quotesRow(value)) return value
  const code = CODE_PREFIX.exec(value)?.[1]
  return code ? `${code}: ${REDACTED}` : REDACTED
}

export const withholdRowText: FieldHook = ({ value }) => safeStoredReason(value)

/** Every stored reason column, by table. Each has an `afterRead` {@link withholdRowText}. */
export const REASON_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'documents', column: 'ingest_error' },
  { table: 'documents', column: 'publication_error' },
  { table: 'documents', column: 'anonymisation_error' },
  { table: 'documents', column: 'graph_error' },
  { table: 'messages', column: 'corpus_error' },
  { table: 'anonymisation_reviews', column: 'gate_reason' },
  { table: 'eval_runs', column: 'error' },
]

export interface StoredReasonReport {
  apply: boolean
  /** Per `table.column`: matching ids (dry run) or ids rewritten (apply). */
  columns: Array<{ table: string; column: string; ids: number[] }>
}

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  ((result as { rows?: Record<string, unknown>[] })?.rows ?? []) as Record<string, unknown>[]

/**
 * 🔴 DRY RUN UNLESS `apply`. Finds every row whose reason column matches
 * {@link ROW_TEXT_SOURCE}, a keyset batch at a time. With `apply`, each row is
 * set to {@link safeStoredReason} of its value, guarded on the value read (a
 * row that changed since is left for the next run). Ids only are reported,
 * never the text. No Payload hooks, `updated_at` untouched: this is not an
 * edit of the row. Idempotent: a cleaned value no longer matches.
 */
export async function cleanStoredReasons(
  db: ConsentDb,
  opts: { apply: boolean; batchSize?: number },
): Promise<StoredReasonReport> {
  const { sql } = await import('@payloadcms/db-postgres')
  const batchSize = opts.batchSize ?? 200
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('clean-stored-errors: batch must be a positive number')
  const report: StoredReasonReport = { apply: opts.apply, columns: [] }
  for (const { table, column } of REASON_COLUMNS) {
    const ids: number[] = []
    let after = 0
    for (;;) {
      const batch = rowsOf(
        await db.execute(
          sql`SELECT id, ${sql.identifier(column)} AS v FROM ${sql.identifier(table)}
              WHERE id > ${after} AND ${sql.identifier(column)} ~ ${ROW_TEXT_SOURCE}
              ORDER BY id LIMIT ${batchSize}`,
        ),
      )
      for (const row of batch) {
        const id = Number(row.id)
        const value = row.v
        if (typeof value !== 'string' || !quotesRow(value)) continue
        if (!opts.apply) {
          ids.push(id)
          continue
        }
        const written = rowsOf(
          await db.execute(
            sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${safeStoredReason(value) as string}
                WHERE id = ${id} AND ${sql.identifier(column)} = ${value} RETURNING id`,
          ),
        )
        if (written.length > 0) ids.push(id)
      }
      if (batch.length < batchSize) break
      after = Number(batch[batch.length - 1]!.id)
    }
    report.columns.push({ table, column, ids })
  }
  return report
}
