/**
 * WRITE ONLY THE COLUMNS YOU OWN.
 *
 * 🔴 WHY THIS FILE EXISTS. `payload.update` does not write the fields you pass.
 * It reads the row, merges your `data` over it, and writes EVERY column back.
 * A background writer that touches one column therefore also re-writes all the
 * others with whatever it read a few milliseconds earlier.
 *
 * Measured on the fake-provider e2e stack with Postgres statement logs: the
 * ai-service callback wrote `ingest_status = 'ready'`; 6 ms later the corpus
 * graph's status write (`graph_status = 'extracting'`) wrote the row back with
 * the `ingest_status = 'embedding'` it had read before the callback. The upload
 * sat at `embedding` forever and the e2e "reaches ready" test timed out for
 * both PDF and DOCX.
 *
 * {@link updateDocumentColumns} is one `UPDATE documents SET <only these> WHERE
 * id = … [AND <guard>]`. Two writers that own different columns can no longer
 * erase each other, and a guard is checked by the same statement that writes,
 * so there is no read-then-write window at all.
 *
 * ⚠ WHAT IT SKIPS: Payload's hooks and validation. That is the point for a
 * status write, which already passed `__skipDocsExtract` to turn the ingest
 * hook off. Do not use it for a write whose hooks must run — `contentKind`
 * changes (`invalidateGraphOnContentKindChange`), or anything a user typed.
 *
 * ⚠ `updated_at` IS BUMPED, in milliseconds like Payload's own writes. The
 * sweeps read "nobody touched this row since the cutoff" from it.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Where } from 'payload'

/** A drizzle SQL fragment. `@payloadcms/db-postgres` re-exports `sql` but not its type. */
type Sql = ReturnType<typeof sql>

/** Structural, so a test can hand in one function instead of a Payload instance. */
export interface DocumentColumnsPayload {
  db: { drizzle: { execute(query: Sql): Promise<unknown> } }
}

/**
 * The `documents` fields a background writer may set or guard on, and their
 * columns. An allowlist on purpose: a name outside it is a bug in the caller,
 * and the column name is spliced into SQL as an identifier.
 */
const COLUMNS = {
  id: 'id',
  kind: 'kind',
  contentKind: 'content_kind',
  publicationStatus: 'publication_status',
  publicationError: 'publication_error',
  ingestStatus: 'ingest_status',
  ingestError: 'ingest_error',
  ingestId: 'ingest_id',
  graphStatus: 'graph_status',
  graphError: 'graph_error',
  graphPromptVersion: 'graph_prompt_version',
  graphExtractedAt: 'graph_extracted_at',
  anonymisationStatus: 'anonymisation_status',
  anonymisationError: 'anonymisation_error',
  anonymisationReport: 'anonymisation_report',
  anonymisationSurvivors: 'anonymisation_survivors',
  redactedText: 'redacted_text',
  heldText: 'held_text',
  updatedAt: 'updated_at',
} as const

export type DocumentColumnField = keyof typeof COLUMNS

function column(field: string): Sql {
  const name = (COLUMNS as Record<string, string>)[field]
  if (!name) throw new Error(`updateDocumentColumns: no column for field "${field}"`)
  return sql.identifier(name) as unknown as Sql
}

/**
 * A value as a bound parameter. Objects and arrays go in as JSON text: drizzle
 * would otherwise expand an array into `($1, $2, …)`.
 */
function param(value: unknown): Sql {
  if (value === undefined || value === null) return sql`NULL`
  if (value instanceof Date) return sql`${value.toISOString()}`
  if (typeof value === 'object') return sql`${JSON.stringify(value)}`
  return sql`${value}`
}

/**
 * One Payload-style clause, `{ field: { op: value } }`, as SQL.
 *
 * Supports the operators the sweeps use and nothing more: `equals`, `in`,
 * `exists`, `less_than`. `exists: false` is `IS NULL`, as in Payload's own
 * postgres adapter.
 */
function clause(where: Where): Sql {
  const entries = Object.entries(where)
  if (entries.length !== 1) {
    throw new Error(`updateDocumentColumns: one field per guard clause, got ${entries.length}`)
  }
  const [field, ops] = entries[0] as [string, Record<string, unknown>]
  const col = column(field)
  const opEntries = Object.entries(ops ?? {})
  if (opEntries.length !== 1) {
    throw new Error(`updateDocumentColumns: one operator per guard clause on "${field}"`)
  }
  const [op, value] = opEntries[0]
  switch (op) {
    case 'equals':
      return value === null ? sql`${col} IS NULL` : sql`${col} = ${param(value)}`
    case 'in': {
      const values = Array.isArray(value) ? value : [value]
      if (values.length === 0) return sql`FALSE`
      return sql`${col} IN (${sql.join(values.map(param), sql`, `)})`
    }
    case 'exists':
      return value === true || value === 'true' ? sql`${col} IS NOT NULL` : sql`${col} IS NULL`
    case 'less_than':
      return sql`${col} < ${param(value)}`
    default:
      throw new Error(`updateDocumentColumns: unsupported operator "${op}" on "${field}"`)
  }
}

/** The rows-changed count out of a `db.drizzle.execute()`, whatever the driver returned. */
function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length
  const r = result as { rowCount?: unknown; rows?: unknown } | null
  if (typeof r?.rowCount === 'number') return r.rowCount
  if (Array.isArray(r?.rows)) return r.rows.length
  return 0
}

export interface UpdateDocumentColumnsArgs {
  id: number | string
  /** Only these columns are written. Keys must be in the allowlist above. */
  data: Partial<Record<DocumentColumnField, unknown>>
  /**
   * Extra conditions, ANDed with `id`, in Payload's `Where` shape so a sweep
   * can pass the very predicate it found the row with. Checked by the UPDATE
   * itself.
   */
  where?: Where[]
}

/**
 * Write `data` to one `documents` row and nothing else.
 *
 * Returns how many rows changed: 1, or 0 when the row is gone or the guard no
 * longer matches (a late callback won, which is the point of the guard).
 */
export async function updateDocumentColumns(
  payload: DocumentColumnsPayload,
  args: UpdateDocumentColumnsArgs,
): Promise<number> {
  const sets = Object.entries(args.data)
    .filter(([field]) => field !== 'id' && field !== 'updatedAt')
    .map(([field, value]) => sql`${column(field)} = ${param(value)}`)
  if (sets.length === 0) return 0
  sets.push(sql`${column('updatedAt')} = ${new Date().toISOString()}`)

  const id = typeof args.id === 'string' && /^\d+$/.test(args.id) ? Number(args.id) : args.id
  const conditions = [sql`${column('id')} = ${id}`, ...(args.where ?? []).map(clause)]

  const result = await payload.db.drizzle.execute(
    sql`UPDATE documents SET ${sql.join(sets, sql`, `)} WHERE ${sql.join(conditions, sql` AND `)} RETURNING id`,
  )
  return rowCount(result)
}
