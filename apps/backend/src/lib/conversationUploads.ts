/**
 * The uploads that belong ONLY to one conversation, and deleting them with it.
 *
 * Called from `Sessions.beforeDelete`. Before this existed, deleting a
 * conversation removed only the `documents_rels` attachment row, so every file
 * uploaded in the chat stayed in "Mis documentos": embedded, stored and owned,
 * attached to nothing. Rodrigo ruled that a bug on 2026-10-17 (one smoke PDF
 * per env was left that way).
 *
 * ── WHAT "BELONGS ONLY TO THIS CONVERSATION" MEANS ───────────────────────────
 *
 * There is no "save to my documents" action in this app: every document is
 * born inside a conversation (`POST /api/sessions/:id/documents`), and the
 * model records no origin. So the rule is built from facts the rows DO hold.
 * A document is deleted only when ALL of these are true:
 *
 *   1. It is attached to THIS conversation and no other (`documents.session`).
 *   2. It is still a `draft`. Anything published, or mid-publish, is part of
 *      the ecosistema's shared knowledge, which colleagues read.
 *   3. It is a `documento`. ⚠ Testimonios and conversaciones are NEVER
 *      cascade-deleted, in any status. This is the minimal safe default taken
 *      on 2026-10-17 pending Rodrigo's decision: they are gated, reviewed
 *      material, and deleting one is a decision of its own.
 *   4. Its uploader is the conversation's owner.
 *   5. It was created AFTER the conversation was. A document older than the
 *      conversation cannot have been uploaded into it, so it came from "Mis
 *      documentos" or from another conversation, and has a life of its own.
 *   6. Nothing else references it: no other conversation's `contextScope`, no
 *      surviving message's `contextRefs`, no `anonymisation-reviews` row (an
 *      append-only audit log of somebody else's decision).
 *
 * ⚠ ONE CASE THE MODEL CANNOT TELL APART. A document uploaded into a LATER
 * conversation B, attached to this older conversation A, and then left behind
 * when B was deleted, passes all six tests and is deleted with A. Telling it
 * apart needs an origin field on `documents`; there is none today.
 *
 * ── TWO HALVES: ROWS IN THE TRANSACTION, THE REST AFTER COMMIT ───────────────
 *
 * 🔴 Deleting a stored object and deleting an ai-service document cannot be
 * rolled back. If they ran inside the session delete's transaction and
 * anything later failed, the rows would come back pointing at a missing file
 * and missing chunks. So:
 *
 *   · IN the transaction (`deleteConversationUploadRows`): pick the uploads,
 *     read the transaction's id (`txid_current()`, on the transaction's own
 *     connection), put the document ids on a skip-list so their own
 *     `afterDelete` leaves ai-service alone, delete the `documents` rows, and
 *     hand a plan to `onPlan` — in a `finally`, so a delete that throws half
 *     way still hands over the rows it did delete.
 *   · AFTER commit (`finishUploadCleanupAfterCommit`): poll
 *     `txid_status(xid)` on a fresh connection. `committed` → delete the
 *     ai-service document of each planned row that is REALLY gone, and each
 *     planned `media` row no document points at any more. `aborted` → drop the
 *     plan. Still `in progress` when the budget runs out → give up and log
 *     every id.
 *
 * ⚠ WHY txid AND NOT "IS THE ROW GONE". A plan from a delete that rolled back
 * must never run, even if a later retry of the same delete removes the row.
 * The transaction's own outcome is the only fact that says which attempt the
 * plan belongs to. ⚠ And "`payload.delete` returned" is not "committed":
 * `@payloadcms/drizzle` 3.88.0 `transactions/commitTransaction.js` swallows a
 * failed COMMIT.
 *
 * ⚠ WHY PER-ROW CHECKS ON TOP. Payload's bulk delete
 * (`collections/operations/delete.js`, 3.88.0) collects a row's error and
 * still commits the shared transaction. So "committed" does not mean every
 * planned row went; each row is checked on its own.
 *
 * ⚠ NOTHING IS PASSED BETWEEN HOOKS THROUGH `req.context` KEYS. Bulk delete
 * runs the row hooks concurrently on one `req`, and every nested local-API
 * call with a `context` replaces `req.context` with a merged copy (payload
 * 3.88.0 `utilities/createLocalReq.js`). Each `beforeDelete` schedules its own
 * plan in a closure. The one shared thing, the skip-list, is a single map
 * object created synchronously at the start of the hook (spread copies keep
 * the reference), and each entry is consumed by the delete it was meant for.
 *
 * ⚠ A FAILURE AFTER COMMIT DOES NOT UNDO THE COMMIT. The rows are already gone;
 * a file or ai-service document that could not be deleted is an orphan, and
 * it is logged with ids so it can be removed by hand. Note that
 * `@payloadcms/plugin-cloud-storage` 3.88.0 `hooks/afterDelete.js` CATCHES
 * storage errors and only logs them, so a failed object delete does not even
 * throw here: the `media` row goes and the object may stay.
 *
 * ⚠ A FILE IS ONLY DELETED WHEN IT IS THE OWNER'S. The `media` row's
 * `uploadedBy` must be the conversation owner, and no surviving document may
 * point at it. A document pointing at someone else's media id never removes
 * their file.
 *
 * 🔴 PRIVACY: logs carry ids only, never a document name or any file content.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, PayloadRequest, Where } from 'payload'

import { relationId } from './permissions'

/**
 * `context` key for `payload.delete({ collection: 'sessions' })`: keep the
 * conversation's uploads.
 *
 * The session janitor sets it. An idle sweep reaps old conversations on a
 * schedule, and nobody asked it to delete the files in them; they land in
 * "Mis documentos" as loose documents instead, as they always did.
 */
export const KEEP_CONVERSATION_UPLOADS = 'keepConversationUploads'

/**
 * `req.context` key of the skip-list: `{ [documentId]: true }`. A listed
 * document's `afterDelete` leaves ai-service alone, because this module does
 * that half after commit. One-shot: `consumeCorpusCleanupSkip` removes the
 * entry it reads.
 */
export const SKIP_DOCUMENT_CORPUS_CLEANUP = 'skipDocumentCorpusCleanup'

type Id = number | string
type SkipList = Record<string, true>

/**
 * Create the skip-list on `req.context` if it is missing, and return it.
 * ⚠ Call it SYNCHRONOUSLY at the start of the hook, before any `await`, so
 * concurrent bulk-delete hooks share one map rather than racing to create two.
 */
export function corpusCleanupSkipList(req: PayloadRequest | undefined): SkipList | null {
  if (!req) return null
  req.context ??= {}
  const existing = req.context[SKIP_DOCUMENT_CORPUS_CLEANUP] as SkipList | undefined
  if (existing) return existing
  const created: SkipList = {}
  req.context[SKIP_DOCUMENT_CORPUS_CLEANUP] = created
  return created
}

/** For `Documents.afterDelete`: is this document's ai-service cleanup deferred? Consumes the entry. */
export function consumeCorpusCleanupSkip(context: unknown, documentId: unknown): boolean {
  const list = (context as Record<string, unknown> | undefined)?.[SKIP_DOCUMENT_CORPUS_CLEANUP] as
    | SkipList
    | undefined
  const key = String(documentId)
  if (!list?.[key]) return false
  delete list[key]
  return true
}

export interface UploadCleanupPlan {
  sessionId: Id
  /** The session delete's transaction (`txid_current()`), or null when there was none. */
  xid: string | null
  /** What `retireDeletedDocument` needs to name both corpora. */
  documents: Array<{ id: Id; organization: unknown; uploadedBy: unknown }>
  /** Candidate files: the owner's, and used by no document outside the plan. */
  mediaIds: Id[]
}

export interface ConversationUploadDeps {
  payload: Payload
  /** Passed through so every row delete joins the session delete's transaction. */
  req?: PayloadRequest
  /** Receives the plan, also when the row deletes throw part way. */
  onPlan?: (plan: UploadCleanupPlan) => void
}

interface SessionFacts {
  id: Id
  user?: unknown
  createdAt?: string | null
}

export interface UploadRow {
  id: Id
  session?: unknown
  contentKind?: string | null
  organization?: unknown
  uploadedBy?: unknown
  publicationStatus?: string | null
  createdAt?: string | null
  mediaFile?: unknown
}

const sameId = (a: unknown, b: unknown): boolean =>
  a != null && b != null && String(a) === String(b)

/** Rules 1–5 above: the facts on the row itself. Pure, so the rule reads in one place. */
export function isOwnDraftUpload(doc: UploadRow, session: SessionFacts): boolean {
  const attached = Array.isArray(doc.session) ? doc.session.map(relationId) : []
  if (attached.length !== 1 || !sameId(attached[0], session.id)) return false
  if (doc.publicationStatus !== 'draft') return false
  // A missing kind is not a documento: fail closed.
  if (doc.contentKind !== 'documento') return false
  if (!sameId(relationId(doc.uploadedBy), relationId(session.user))) return false

  // An undated row is kept: we never delete what we cannot place in time.
  const born = Date.parse(doc.createdAt ?? '')
  const opened = Date.parse(session.createdAt ?? '')
  if (Number.isNaN(born) || Number.isNaN(opened)) return false
  return born >= opened
}

/** Rule 6: does anything outside this conversation point at the document? */
async function isReferencedElsewhere(
  docId: Id,
  sessionId: Id,
  { payload, req }: ConversationUploadDeps,
): Promise<boolean> {
  // ⚠ Polymorphic object notation is the only form `@payloadcms/drizzle`
  // 3.88.0 accepts for `equals` on a polymorphic relationship
  // (`queries/sanitizeQueryValue.js`, read 2026-10-17).
  const asRef = { equals: { relationTo: 'documents', value: docId } }
  const checks: Array<{ collection: 'sessions' | 'messages' | 'anonymisation-reviews'; where: Where }> = [
    {
      collection: 'sessions',
      where: { and: [{ contextScope: asRef }, { id: { not_equals: sessionId } }] },
    },
    // This conversation's own messages are already deleted when this runs, so
    // any message still citing the document lives in another conversation.
    { collection: 'messages', where: { contextRefs: asRef } },
    { collection: 'anonymisation-reviews', where: { document: { equals: docId } } },
  ]
  for (const { collection, where } of checks) {
    const { totalDocs } = await payload.count({ collection, where, overrideAccess: true, req })
    if (totalDocs > 0) return true
  }
  return false
}

/** Is this file the owner's, and is no document outside the plan using it? */
async function mayDeleteMedia(
  mediaId: Id,
  ownerId: unknown,
  doomedIds: Id[],
  { payload, req }: ConversationUploadDeps,
): Promise<boolean> {
  const media = (await payload.findByID({
    collection: 'media',
    id: mediaId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
    req,
  })) as { uploadedBy?: unknown } | null
  if (!media || !sameId(relationId(media.uploadedBy), relationId(ownerId))) return false

  const { totalDocs: sharers } = await payload.count({
    collection: 'documents',
    where: { and: [{ mediaFile: { equals: mediaId } }, { id: { not_in: doomedIds } }] },
    overrideAccess: true,
    req,
  })
  return sharers === 0
}

/**
 * `txid_current()` on the transaction's OWN connection. Reaches into
 * `@payloadcms/drizzle` 3.88.0's session registry (`payload.db.sessions[id].db`,
 * `transactions/beginTransaction.js`), the only handle on that connection.
 * Null when there is no transaction or the handle is not there.
 */
async function currentTxid(req: PayloadRequest | undefined): Promise<string | null> {
  const raw = req?.transactionID
  const id = raw instanceof Promise ? await raw : raw
  if (!id) return null
  const sessions = (req?.payload?.db as unknown as {
    sessions?: Record<string, { db?: { execute(q: unknown): Promise<unknown> } }>
  })?.sessions
  const tx = sessions?.[String(id)]?.db
  if (!tx?.execute) return null
  const res = (await tx.execute(sql`SELECT txid_current()::text AS xid`)) as {
    rows?: Array<{ xid?: string }>
  }
  return res.rows?.[0]?.xid ?? null
}

/**
 * THE TRANSACTION HALF. Delete the `documents` rows of the uploads that belong
 * only to `sessionId`, and hand `onPlan` what to remove after commit. Returns
 * the plan too (null when there is nothing).
 *
 * Must run while the `documents_rels` rows still exist (that is how the
 * conversation's documents are found) and after its messages are gone (see
 * `isReferencedElsewhere`).
 */
export async function deleteConversationUploadRows(
  sessionId: Id,
  deps: ConversationUploadDeps,
): Promise<UploadCleanupPlan | null> {
  const { payload, req } = deps
  const skip = corpusCleanupSkipList(req)

  const attached = await payload.find({
    collection: 'documents',
    // `equals` on a hasMany relationship reads "contains this id".
    where: { session: { equals: sessionId } },
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
  })
  if (attached.docs.length === 0) return null

  const session = (await payload.findByID({
    collection: 'sessions',
    id: sessionId,
    depth: 0,
    overrideAccess: true,
    req,
  })) as unknown as SessionFacts

  const doomed: UploadRow[] = []
  for (const doc of attached.docs as unknown as UploadRow[]) {
    if (!isOwnDraftUpload(doc, session)) continue
    if (await isReferencedElsewhere(doc.id, sessionId, deps)) continue
    doomed.push(doc)
  }
  if (doomed.length === 0) return null

  const doomedIds = doomed.map((d) => d.id)
  const mediaIds: Id[] = []
  for (const doc of doomed) {
    const mediaId = relationId(doc.mediaFile)
    if (mediaId == null || mediaIds.some((m) => sameId(m, mediaId))) continue
    if (await mayDeleteMedia(mediaId, session.user, doomedIds, deps)) mediaIds.push(mediaId)
  }

  const plan: UploadCleanupPlan = {
    sessionId,
    xid: await currentTxid(req),
    documents: doomed.map((d) => ({ id: d.id, organization: d.organization, uploadedBy: d.uploadedBy })),
    mediaIds,
  }

  try {
    for (const doc of doomed) {
      const key = String(doc.id)
      if (skip) skip[key] = true
      try {
        await payload.delete({
          collection: 'documents',
          id: doc.id,
          depth: 0,
          overrideAccess: true,
          req,
          // No `req` to share a list through: scope the skip to this one call.
          ...(skip ? {} : { context: { [SKIP_DOCUMENT_CORPUS_CLEANUP]: { [key]: true } } }),
        })
      } finally {
        // Normally consumed by the document's afterDelete already. A delete
        // that failed before getting there must not leave it for a later one.
        if (skip) delete skip[key]
      }
    }
  } finally {
    deps.onPlan?.(plan)
  }
  return plan
}

export type TxOutcome = 'committed' | 'aborted' | 'gave-up'

export interface AfterCommitDeps {
  payload: Payload
  /** The ecosistema's admin ai-service client. Injected by tests. */
  corpusClient?: (organizationId: Id) => unknown
  /** `txid_status(xid)`. Injected by tests; defaults to a fresh-connection query. */
  txStatus?: (xid: string) => Promise<string | null>
  /**
   * How long to wait for the transaction to end. 240 × 250 ms = 60 s is a
   * chosen budget, not a measured one: a commit normally ends within
   * milliseconds of the hook returning.
   */
  attempts?: number
  intervalMs?: number
}

async function freshTxStatus(payload: Payload, xid: string): Promise<string | null> {
  // ⚠ `payload.db.drizzle`, not the transaction: a fresh pool connection.
  const db = (payload.db as unknown as { drizzle: { execute(q: unknown): Promise<unknown> } }).drizzle
  const res = (await db.execute(sql`SELECT txid_status(${xid}::bigint) AS s`)) as {
    rows?: Array<{ s?: string | null }>
  }
  return res.rows?.[0]?.s ?? null
}

async function waitForOutcome(xid: string, deps: AfterCommitDeps): Promise<TxOutcome> {
  const status = deps.txStatus ?? ((x: string) => freshTxStatus(deps.payload, x))
  const attempts = deps.attempts ?? 240
  const intervalMs = deps.intervalMs ?? 250
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    const s = await status(xid)
    if (s === 'committed') return 'committed'
    if (s === 'aborted') return 'aborted'
    // 'in progress', or null (xid too old to know) → keep waiting, then give up.
  }
  return 'gave-up'
}

async function rowExists(payload: Payload, collection: 'documents', id: Id): Promise<boolean> {
  const row = await payload.findByID({ collection, id, depth: 0, overrideAccess: true, disableErrors: true })
  return row != null
}

/**
 * THE AFTER-COMMIT HALF. Never throws: by now the rows are gone, and the only
 * thing left to do with a failure is log it.
 */
export async function finishUploadCleanupAfterCommit(
  plan: UploadCleanupPlan,
  deps: AfterCommitDeps,
): Promise<TxOutcome | 'no-transaction'> {
  const { payload } = deps
  const log = payload.logger
  const allIds = {
    sessionId: String(plan.sessionId),
    documentIds: plan.documents.map((d) => String(d.id)),
    mediaIds: plan.mediaIds.map(String),
  }

  let outcome: TxOutcome | 'no-transaction' = 'no-transaction'
  if (plan.xid) {
    outcome = await waitForOutcome(plan.xid, deps)
    if (outcome === 'aborted') {
      log.info(allIds, '[sessions] conversation delete rolled back; its uploads were left untouched')
      return outcome
    }
    if (outcome === 'gave-up') {
      log.warn(
        allIds,
        '[sessions] could not learn whether the conversation delete committed; these uploads were NOT cleaned up and may be orphans',
      )
      return outcome
    }
  }

  const { retireDeletedDocument } = await import('./publishDocument')
  const clientFor =
    deps.corpusClient ??
    (async (organizationId: Id) => (await import('./aiClient')).getAdminAIClient(organizationId))

  for (const doc of plan.documents) {
    try {
      // Bulk delete commits even when one row failed: check this row went.
      if (await rowExists(payload, 'documents', doc.id)) continue
      const organizationId = relationId(doc.organization)
      if (organizationId == null) continue
      const client = await clientFor(organizationId)
      await retireDeletedDocument({ payload, client: client as never }, doc as never)
    } catch (err) {
      log.warn(
        { sessionId: allIds.sessionId, documentId: String(doc.id), err: String(err) },
        '[sessions] could not delete a deleted upload from ai-service; its chunks may stay retrievable',
      )
    }
  }

  for (const mediaId of plan.mediaIds) {
    try {
      const { totalDocs } = await payload.count({
        collection: 'documents',
        where: { mediaFile: { equals: mediaId } },
        overrideAccess: true,
      })
      if (totalDocs > 0) continue
      await payload.delete({ collection: 'media', id: mediaId, depth: 0, overrideAccess: true })
    } catch (err) {
      log.warn(
        // The error NAME only: a storage error message can carry the object
        // key, which is the uploader's own filename.
        { sessionId: allIds.sessionId, mediaId: String(mediaId), err: err instanceof Error ? err.name : 'unknown' },
        '[sessions] could not delete a deleted upload’s stored file; it is now an orphan',
      )
    }
  }

  log.info(allIds, '[sessions] cleaned up the uploads that belonged only to this conversation')
  return outcome
}
