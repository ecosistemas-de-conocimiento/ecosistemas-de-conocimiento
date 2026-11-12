/**
 * 🔴 RETENIDO POR CONSENTIMIENTO (owner decision 2026-11-10). A document whose
 * authors have not consented is never re-ingested, re-embedded, re-gated,
 * graphed or published. Nothing is deleted: the row, its text and whatever
 * copy it already has stay as they are, and nothing new is sent anywhere.
 *
 * `documents.consentHeld` (migration `20261110_181621_consent_held_reviews_keep`)
 * is NOT NULL, default false. No API writes it (`gateWritesOnly`); the only
 * writer is {@link holdForConsent}, through `scripts/hold-for-consent.ts`.
 * There is no release path in code: lifting a hold is an owner decision and a
 * hand-written `UPDATE`.
 *
 * 🔴 A REVISION INHERITS ITS ORIGINAL'S HOLD (audit 2026-11-10, A1). A
 * "Publicar cambios" row (`revisionOf`, `lib/studentNotes.ts`) is hidden
 * staging that `promoteRevision` later swaps over the note, so a revision of a
 * held note is held too: every helper here answers for the original as well.
 * The hold is written on the original only ({@link holdForConsent}), so lifting
 * it stays one `UPDATE`. An original that cannot be read holds its revision
 * (the FK cascades, so that is a partial row, never a real orphan).
 *
 * ⚠ The single source. `lib/graph/consentHold.ts` re-exports from here.
 *
 * Guarded in `collections/Documents.ts` (the ingest hook, `runExtractAndIngest`,
 * `enqueueIngestForDoc`, `scheduleGraphExtractionForDoc`, the publish, retry,
 * graph-retry and note endpoints) and `lib/publishDocument.ts` (`beginPublish`,
 * `unpublish` retires without re-embedding). Every sweep that ends in one of
 * those functions inherits the guard.
 */

// ⚠ `sql` is imported lazily, in the async functions: `lib/publishDocument.ts`
// imports this file, and a top-level `@payloadcms/db-postgres` put the adapter
// in front of every module that imports it (measured 2026-11-10: six suites
// that import `collections/Documents.ts` went past vitest's 5 s budget).
import type { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest, Where } from 'payload'

type Id = number | string
type Sql = ReturnType<typeof sql>
const drizzleSql = async () => (await import('@payloadcms/db-postgres')).sql

/** Structural: Payload's `db.drizzle`, or the test harness's drizzle handle. */
export interface ConsentDb {
  execute(query: Sql): Promise<unknown>
}

/** The loose row the sync check reads: a Payload row at any depth, or a hand-built slice. */
export interface ConsentRow {
  consentHeld?: unknown
  /** The original's id (depth 0) or the original itself (depth ≥ 1). Absent: not known to be a revision. */
  revisionOf?: unknown
  /** The original's hold, when the caller read it apart (`readConsentHeld` does it in SQL). */
  revisionOfConsentHeld?: unknown
}

/**
 * 🔴 Only `true` holds. Missing or null (a row read before the migration, a partial row) is false.
 *
 * ⚠ THE SYNC CHECK INHERITS ONLY WHAT IT IS HANDED. A revision is held through
 * its original when `revisionOf` is POPULATED (depth ≥ 1) or the caller passes
 * `revisionOfConsentHeld`. When `revisionOf` is a bare id (depth 0), this
 * answers the row's OWN flag: it cannot read the original. A caller holding a
 * depth-0 revision that needs the original's hold uses {@link isConsentHeldNow}
 * or {@link readConsentHeld}, which read the table (owner ruling 2026-11-10:
 * a fail-closed sync answer held every depth-0 revision and blocked
 * "Publicar cambios" for free notes).
 */
export function isConsentHeld(row: ConsentRow | null | undefined): boolean {
  if (row?.consentHeld === true) return true
  const original = row?.revisionOf
  if (original === null || typeof original !== 'object') return row?.revisionOfConsentHeld === true
  return (original as { consentHeld?: unknown }).consentHeld !== false
}

/**
 * {@link isConsentHeld}, with a revision's original read now when the row
 * carries only its id. An original that cannot be read holds the revision
 * (fail closed), and so does a handle with no `db.drizzle` (a unit-test fake).
 *
 * ⚠ FROM A HOOK, PASS `req`: the read runs on the write's own connection.
 * `db.drizzle` is a second pool checkout while the write holds the first
 * (see `findAll` in `lib/permissions.ts`).
 */
export async function isConsentHeldNow(
  payload: unknown,
  row: ConsentRow | null | undefined,
  req?: PayloadRequest,
): Promise<boolean> {
  const original = row?.revisionOf
  if (row?.consentHeld === true || (typeof original !== 'number' && typeof original !== 'string')) return isConsentHeld(row)
  if (typeof row?.revisionOfConsentHeld === 'boolean') return isConsentHeld(row)
  const tx = req?.transactionID ? await (await import('./conversationUploads')).transactionHandle(req) : null
  const db = tx ?? drizzleOf(payload)
  if (!db) return true
  const sql = await drizzleSql()
  const rows = rowsOf(await db.execute(sql`SELECT consent_held FROM documents WHERE id = ${asId(original)}`))
  return rows[0]?.consent_held !== false
}

/**
 * Payload `where`: the rows a sweep may touch. AND it into the sweep's own query.
 * Not held, and not a revision of a held row: `{ or: [held, revisionOf.held] }`
 * negated, since a `where` has no NOT. A revision whose original does not join
 * fails `revisionOf.consentHeld` and is left out.
 *
 * ⚠ For server reads (`overrideAccess: true`), which the relation-filter hooks
 * leave as they are (`constrainGatedQueriesAt`). A user's query would have its
 * `revisionOf.` crossing narrowed to rows that user may read.
 */
export const NOT_CONSENT_HELD: Where = {
  and: [
    { consentHeld: { not_equals: true } },
    { or: [{ revisionOf: { exists: false } }, { 'revisionOf.consentHeld': { equals: false } }] },
  ],
}

/**
 * The same predicate as SQL text on `documents`, for raw queries: splice it
 * with `sql.raw(...)`. `alias` is the table alias the query uses (`d` in
 * `SELECT … FROM documents d`); a constant, never user input. Without one the
 * columns are qualified `documents.`, so the query must not alias the table.
 */
export function notConsentHeldSql(alias?: string): string {
  if (alias !== undefined && !/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`not a table alias: ${alias}`)
  const t = alias ?? 'documents'
  return (
    `(${t}.consent_held IS NOT TRUE AND (${t}.revision_of_id IS NULL OR EXISTS (` +
    `SELECT 1 FROM documents consent_original WHERE consent_original.id = ${t}.revision_of_id ` +
    `AND consent_original.consent_held IS NOT TRUE)))`
  )
}

/** Spanish, because the endpoints return it and the UI shows it verbatim. */
export const CONSENT_HELD_MESSAGE =
  'Este documento está retenido hasta tener el consentimiento de sus autores. No se puede procesar ni publicar.'

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  ((result as { rows?: Record<string, unknown>[] })?.rows ?? []) as Record<string, unknown>[]

const asId = (id: Id): Id => (typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id)

const drizzleOf = (payload: unknown): ConsentDb | null => {
  const db = (payload as { db?: { drizzle?: ConsentDb } } | null)?.db?.drizzle
  return db && typeof db.execute === 'function' ? db : null
}

/**
 * The stored flag, read now, the original's included ({@link notConsentHeldSql}).
 * For a caller holding a row that may predate the hold, or a hand-built slice
 * without the column (`ingestRecovery`'s audio drive).
 *
 * ⚠ A handle with no `db.drizzle` is a unit-test fake (a real Payload always
 * has one): it answers false, and the caller's own `isConsentHeld(row)` is the
 * check left. A row that does not exist answers false: there is nothing to send.
 */
export async function readConsentHeld(payload: unknown, id: Id): Promise<boolean> {
  const db = drizzleOf(payload)
  if (!db) return false
  const sql = await drizzleSql()
  const rows = rowsOf(
    await db.execute(sql`SELECT ${sql.raw(notConsentHeldSql('d'))} AS free FROM documents d WHERE d.id = ${asId(id)}`),
  )
  return rows[0] !== undefined && rows[0].free !== true
}

// ── The hold itself: `scripts/hold-for-consent.ts` ──────────────────────────

export interface ConsentHoldSelection {
  /** Required: every id must belong to it, and a filter never leaves it. */
  organizationId: Id
  /** Explicit ids. An id of another ecosistema, or missing, is refused, not held. */
  ids?: Id[]
  /** Filter mode (with no `ids`): every row of the ecosistema matching ALL of these. */
  publicationStatus?: string
  uploadedBy?: Id
  /** Only rows with an uploaded file (`media_file_id`): not the in-app notes. */
  hasFile?: boolean
  idFrom?: number
  idTo?: number
}

export interface ConsentHoldRow {
  id: number
  publicationStatus: string | null
  contentKind: string | null
  alreadyHeld: boolean
}

export interface ConsentHoldReport {
  apply: boolean
  rows: ConsentHoldRow[]
  /** Ids named explicitly that were not held: missing or another ecosistema's. */
  refused: string[]
  /** Rows written by this run (0 on a dry run). */
  held: number
  /** Selected rows that are not drafts: still in the shared corpus until unpublished. */
  notDraft: number[]
  /**
   * "Publicar cambios" revisions of the selected rows. Never written: each is
   * held through its original ({@link isConsentHeld}), so lifting the hold
   * stays one `UPDATE` on the original.
   */
  revisions: number[]
}

/** Why this selection may not run, or null. */
export function selectionError(sel: ConsentHoldSelection): string | null {
  if (!/^\d+$/.test(String(sel.organizationId))) return 'the ecosistema id must be a number'
  if (sel.ids && sel.ids.length > 0) {
    if (sel.ids.some((id) => !/^\d+$/.test(String(id)))) return 'ids must be numbers'
    return null
  }
  const filters = [sel.publicationStatus, sel.uploadedBy, sel.hasFile, sel.idFrom, sel.idTo].filter(
    (v) => v !== undefined && v !== false,
  )
  // 🔴 A whole ecosistema is never one typo away.
  if (filters.length === 0) return 'name ids, or at least one filter: a whole ecosistema is not a selection'
  if (sel.uploadedBy !== undefined && !/^\d+$/.test(String(sel.uploadedBy))) return 'uploadedBy must be a user id'
  return null
}

function whereOf(sql: Awaited<ReturnType<typeof drizzleSql>>, sel: ConsentHoldSelection): Sql {
  const org = Number(sel.organizationId)
  const parts: Sql[] = [sql`organization_id = ${org}`, sql`revision_of_id IS NULL`]
  if (sel.ids && sel.ids.length > 0) {
    parts.push(sql`id IN (${sql.join(sel.ids.map((id) => sql`${Number(id)}`), sql`, `)})`)
  } else {
    if (sel.publicationStatus) parts.push(sql`publication_status = ${sel.publicationStatus}`)
    if (sel.uploadedBy !== undefined) parts.push(sql`uploaded_by_id = ${Number(sel.uploadedBy)}`)
    if (sel.hasFile) parts.push(sql`media_file_id IS NOT NULL`)
    if (sel.idFrom !== undefined) parts.push(sql`id >= ${sel.idFrom}`)
    if (sel.idTo !== undefined) parts.push(sql`id <= ${sel.idTo}`)
  }
  return sql.join(parts, sql` AND `)
}

/**
 * Select, and with `apply`, set `consent_held = true` on every selected row in
 * ONE `UPDATE` (no Payload hooks: a hook is what would start an ingest).
 *
 * 🔴 DRY RUN unless `apply` is true: it reads only.
 * ⚠ It does not unpublish. A selected row that is not a draft is listed in
 * `notDraft`: unpublish it after (`unpublish` on a held row retires the shared
 * copy and re-embeds nothing).
 */
export async function holdForConsent(
  db: ConsentDb,
  sel: ConsentHoldSelection,
  opts: { apply: boolean },
): Promise<ConsentHoldReport> {
  const error = selectionError(sel)
  if (error) throw new Error(`hold-for-consent: ${error}`)
  const sql = await drizzleSql()
  const where = whereOf(sql, sel)
  const found = rowsOf(
    await db.execute(
      sql`SELECT id, publication_status, content_kind, consent_held FROM documents WHERE ${where} ORDER BY id`,
    ),
  ).map((r) => ({
    id: Number(r.id),
    publicationStatus: (r.publication_status as string | null) ?? null,
    contentKind: (r.content_kind as string | null) ?? null,
    alreadyHeld: r.consent_held === true,
  }))
  const foundIds = new Set(found.map((r) => String(r.id)))
  const refused = (sel.ids ?? []).map(String).filter((id) => !foundIds.has(id))
  const notDraft = found.filter((r) => r.publicationStatus !== 'draft').map((r) => r.id)
  const revisions =
    found.length === 0
      ? []
      : rowsOf(
          await db.execute(
            sql`SELECT id FROM documents
                WHERE revision_of_id IN (${sql.join(found.map((r) => sql`${r.id}`), sql`, `)}) ORDER BY id`,
          ),
        ).map((r) => Number(r.id))

  let held = 0
  if (opts.apply && found.length > 0) {
    const ids = found.filter((r) => !r.alreadyHeld).map((r) => sql`${r.id}`)
    if (ids.length > 0) {
      held = rowsOf(
        await db.execute(
          sql`UPDATE documents SET consent_held = true, updated_at = ${new Date().toISOString()}
              WHERE id IN (${sql.join(ids, sql`, `)}) AND organization_id = ${Number(sel.organizationId)}
              RETURNING id`,
        ),
      ).length
    }
  }
  return { apply: opts.apply, rows: found, refused, held, notDraft, revisions }
}

/** A line of an ids file that names a row NOT to hold. */
export const NOT_TO_HOLD_MARK = 'EXTRA-NO-TALLER'

/**
 * Ids from a tab-separated list (`id<TAB>origin<TAB>note`): `#` lines and
 * blank lines skipped, and any line marked {@link NOT_TO_HOLD_MARK} left out.
 * A first column that is not a number is an error, never a silent skip.
 */
export function parseConsentIdsFile(text: string): string[] {
  const ids: string[] = []
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.includes(NOT_TO_HOLD_MARK)) continue
    const id = line.split('\t')[0]!.trim()
    if (!/^\d+$/.test(id)) throw new Error(`line ${i + 1}: first column is not an id`)
    ids.push(id)
  }
  return [...new Set(ids)]
}
