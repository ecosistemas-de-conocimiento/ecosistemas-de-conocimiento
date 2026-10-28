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
 * born inside a conversation (`POST /api/sessions/:id/documents`). Since
 * 2026-10-17 the row records which one (`documents.uploadedInSession`); rows
 * older than that column do not. A document is deleted only when ALL of these
 * are true:
 *
 *   1. It is attached to THIS conversation and no other (`documents.session`).
 *   2. It is still a `draft`. Anything published, or mid-publish, is part of
 *      the ecosistema's shared knowledge, which colleagues read. And no
 *      reviewer has decided on it: `anonymisationStatus` `approved` or
 *      `rejected` is kept, whatever review rows exist.
 *      🔴 Decided under a row lock (`lockDocumentRows`): a publish or an
 *      approval racing the delete either lands first and is seen, or waits.
 *   3. It is a `documento` or a `testimonio`. Rodrigo ruled on 2026-10-17 that
 *      testimonio DRAFTS go too, including ones the anonymisation gate HELD
 *      for review. ⚠ Conversaciones are NEVER cascade-deleted, in any status,
 *      and neither is a row with no kind.
 *   4. Its uploader is the conversation's owner.
 *   5. It was uploaded IN this conversation:
 *        · `uploadedInSession` set → it must be this conversation;
 *        · NULL on a row created BEFORE the column existed → the old guess:
 *          created after this conversation was (a document older than the
 *          conversation cannot have been uploaded into it);
 *        · NULL on a row created AFTER the column existed → kept. Its origin
 *          was not a chat upload, or its origin conversation was deleted
 *          (the foreign key is `ON DELETE SET NULL`); either way, not here.
 *      "When the column existed" is the `payload_migrations` row of the
 *      migration that added it, read from the database itself. No row (a
 *      database built by push, or a test that ran the SQL by hand) → every
 *      NULL gets the old guess.
 *   6. Nothing else references it: no other conversation's `contextScope`, no
 *      surviving message's `contextRefs`, no `anonymisation-reviews` row (an
 *      append-only audit log of somebody else's decision).
 *      ⚠ EXCEPT a HELD document: its review rows (left by an earlier decision
 *      before it was held again) are deleted with it, so no reviewer item
 *      dangles. The review QUEUE is not a table: it is `documents` filtered on
 *      `anonymisationStatus = 'held'` (`lib/holdReview.ts`), so the row going
 *      is the queue entry going. A `rejected` or `approved` document is
 *      kept by rule 2 already.
 *
 * ⚠ ONE CASE THE MODEL STILL CANNOT TELL APART, and only on rows older than
 * `uploadedInSession`. A document uploaded into a LATER conversation B,
 * attached to this older conversation A, and then left behind when B was
 * deleted, passes all six tests and is deleted with A.
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
 * ── A DOCUMENT DELETED ON ITS OWN ────────────────────────────────────────────
 *
 * Deleting one document (Mis documentos, the admin panel, a bulk delete) runs
 * the same two halves for its stored file: `planDocumentMediaCleanup` in the
 * document's `beforeDelete`, `finishUploadCleanupAfterCommit` after commit.
 * Its ai-service half stays where it was, in `Documents.afterDelete`.
 * ⚠ A document a conversation delete is removing is skipped (it is on the
 * skip-list): that plan already covers its file, and two plans would delete
 * it twice.
 *
 * ⚠ A FILE IS ONLY DELETED WHEN IT IS THE OWNER'S. The `media` row's
 * `uploadedBy` must be the conversation owner, and no surviving document may
 * point at it. A document pointing at someone else's media id never removes
 * their file. "No document points at it" is checked again AFTER commit, on
 * every path. ⚠ For a document deleted on its own it is checked ONLY after
 * commit: a bulk delete runs every row's hook concurrently, so inside the
 * transaction two documents sharing one file would each still see the other,
 * and neither would plan to delete it.
 *
 * ⚠ THE STORED OBJECT IS CHECKED AFTER ITS ROW GOES. The plugin swallows a
 * failed object delete (above), so with object storage configured the cleanup
 * asks the bucket whether the object is still there, and logs the ids when it
 * is.
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
 * document is being deleted by a conversation delete, which does its
 * post-commit half itself: its `afterDelete` leaves ai-service alone, and its
 * `beforeDelete` plans no file cleanup of its own. One-shot:
 * `consumeCorpusCleanupSkip` (in `afterDelete`) removes the entry it reads.
 */
export const SKIP_DOCUMENT_CORPUS_CLEANUP = 'skipDocumentCorpusCleanup'

/** The migration that added `documents.uploadedInSession`. Rule 5 reads when it ran. */
export const UPLOADED_IN_SESSION_MIGRATION = '20261017_231817_documents_uploaded_in_session'

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

const skipListOf = (context: unknown): SkipList | undefined =>
  (context as Record<string, unknown> | undefined)?.[SKIP_DOCUMENT_CORPUS_CLEANUP] as SkipList | undefined

/** For `Documents.afterDelete`: is this document's ai-service cleanup deferred? Consumes the entry. */
export function consumeCorpusCleanupSkip(context: unknown, documentId: unknown): boolean {
  const list = skipListOf(context)
  const key = String(documentId)
  if (!list?.[key]) return false
  delete list[key]
  return true
}

/**
 * For `Documents.beforeDelete`: is a conversation delete removing this
 * document? Reads the entry WITHOUT consuming it; `afterDelete` still needs it.
 */
export function isHandledByConversationDelete(context: unknown, documentId: unknown): boolean {
  return skipListOf(context)?.[String(documentId)] === true
}

export interface UploadCleanupPlan {
  /** The conversation being deleted; null for a document deleted on its own. */
  sessionId: Id | null
  /** That document, when `sessionId` is null. For the logs. */
  documentId?: Id
  /** The delete's transaction (`txid_current()`), or null when there was none. */
  xid: string | null
  /** What `retireDeletedDocument` needs to name both corpora. */
  documents: Array<{ id: Id; organization: unknown; uploadedBy: unknown }>
  /** Candidate files: the owner's. Whether nothing else uses one is checked after commit. */
  mediaIds: Id[]
  /** `anonymisation-reviews` rows deleted in the transaction with a held document. For the logs. */
  reviewIds?: Id[]
}

export interface ConversationUploadDeps {
  payload: Payload
  /** Passed through so every row delete joins the session delete's transaction. */
  req?: PayloadRequest
  /** Receives the plan, also when the row deletes throw part way. */
  onPlan?: (plan: UploadCleanupPlan) => void
  /**
   * When `documents.uploadedInSession` started being recorded (rule 5).
   * Injected by tests; `undefined` reads it from `payload_migrations`.
   */
  originRecordedSince?: string | null
}

interface SessionFacts {
  id: Id
  user?: unknown
  createdAt?: string | null
}

export interface UploadRow {
  id: Id
  session?: unknown
  uploadedInSession?: unknown
  contentKind?: string | null
  anonymisationStatus?: string | null
  organization?: unknown
  uploadedBy?: unknown
  publicationStatus?: string | null
  createdAt?: string | null
  mediaFile?: unknown
}

const sameId = (a: unknown, b: unknown): boolean =>
  a != null && b != null && String(a) === String(b)

/** Rule 2b: the anonymisation states a reviewer's decision leaves behind. */
const REVIEWED_STATES: ReadonlyArray<string> = ['approved', 'rejected']

/** Rule 3. A missing kind is in neither list: fail closed. */
const CASCADABLE_KINDS: ReadonlyArray<string> = ['documento', 'testimonio']

/**
 * Rules 1–5 above: the facts on the row itself. Pure, so the rule reads in one
 * place. `originRecordedSince` is when `uploadedInSession` started being
 * recorded, or null when that is not known.
 */
export function isOwnDraftUpload(
  doc: UploadRow,
  session: SessionFacts,
  originRecordedSince: string | null = null,
): boolean {
  const attached = Array.isArray(doc.session) ? doc.session.map(relationId) : []
  if (attached.length !== 1 || !sameId(attached[0], session.id)) return false
  if (doc.publicationStatus !== 'draft') return false
  // A reviewer decided on it: an approved one is on its way to the corpus, a
  // rejected one is the record of a refusal. Neither is a loose upload.
  if (REVIEWED_STATES.includes(doc.anonymisationStatus ?? '')) return false
  if (!CASCADABLE_KINDS.includes(doc.contentKind ?? '')) return false
  if (!sameId(relationId(doc.uploadedBy), relationId(session.user))) return false

  // An undated row is kept: we never delete what we cannot place in time.
  const born = Date.parse(doc.createdAt ?? '')
  const opened = Date.parse(session.createdAt ?? '')
  if (Number.isNaN(born) || Number.isNaN(opened)) return false

  const origin = relationId(doc.uploadedInSession)
  if (origin != null) return sameId(origin, session.id) && born >= opened

  // No recorded origin. On a row born after recording began, that means it
  // was not a chat upload or its origin conversation is gone: not this one.
  const recordedSince = Date.parse(originRecordedSince ?? '')
  if (!Number.isNaN(recordedSince) && born >= recordedSince) return false
  return born >= opened
}

/**
 * When this database started recording `uploadedInSession`: the
 * `payload_migrations` row of the migration that added it. Null when there is
 * none (push, or a hand-built test database).
 */
async function readOriginRecordedSince({ payload, req }: ConversationUploadDeps): Promise<string | null> {
  const { docs } = await payload.find({
    collection: 'payload-migrations',
    where: { name: { equals: UPLOADED_IN_SESSION_MIGRATION } },
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
  })
  return ((docs[0] as { createdAt?: string } | undefined)?.createdAt ?? null) || null
}

const isHeld = (doc: UploadRow): boolean => doc.anonymisationStatus === 'held'

/** Rule 6: does anything outside this conversation point at the document? */
async function isReferencedElsewhere(
  doc: UploadRow,
  sessionId: Id,
  { payload, req }: ConversationUploadDeps,
): Promise<boolean> {
  // ⚠ Polymorphic object notation is the only form `@payloadcms/drizzle`
  // 3.88.0 accepts for `equals` on a polymorphic relationship
  // (`queries/sanitizeQueryValue.js`, read 2026-10-17).
  const asRef = { equals: { relationTo: 'documents', value: doc.id } }
  const checks: Array<{ collection: 'sessions' | 'messages' | 'anonymisation-reviews'; where: Where }> = [
    {
      collection: 'sessions',
      where: { and: [{ contextScope: asRef }, { id: { not_equals: sessionId } }] },
    },
    // This conversation's own messages are already deleted when this runs, so
    // any message still citing the document lives in another conversation.
    { collection: 'messages', where: { contextRefs: asRef } },
  ]
  // A held document's review rows go with it (rule 6's exception).
  if (!isHeld(doc)) {
    checks.push({ collection: 'anonymisation-reviews', where: { document: { equals: doc.id } } })
  }
  for (const { collection, where } of checks) {
    const { totalDocs } = await payload.count({ collection, where, overrideAccess: true, req })
    if (totalDocs > 0) return true
  }
  return false
}

/** Is this media row the given person's? A missing row is nobody's. */
async function isOwnersMedia(
  mediaId: Id,
  ownerId: unknown,
  { payload, req }: Pick<ConversationUploadDeps, 'payload' | 'req'>,
): Promise<boolean> {
  const media = (await payload.findByID({
    collection: 'media',
    id: mediaId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
    req,
  })) as { uploadedBy?: unknown } | null
  return media != null && sameId(relationId(media.uploadedBy), relationId(ownerId))
}

/** Is this file the owner's, and is no document outside the plan using it? */
async function mayDeleteMedia(
  mediaId: Id,
  ownerId: unknown,
  doomedIds: Id[],
  deps: ConversationUploadDeps,
): Promise<boolean> {
  if (!(await isOwnersMedia(mediaId, ownerId, deps))) return false
  const { totalDocs: sharers } = await deps.payload.count({
    collection: 'documents',
    where: { and: [{ mediaFile: { equals: mediaId } }, { id: { not_in: doomedIds } }] },
    overrideAccess: true,
    req: deps.req,
  })
  return sharers === 0
}

type TxHandle = { execute(q: unknown): Promise<unknown> }

/**
 * The transaction's OWN connection. Reaches into `@payloadcms/drizzle`
 * 3.88.0's session registry (`payload.db.sessions[id].db`,
 * `transactions/beginTransaction.js`), the only handle on that connection.
 * Null when there is no transaction or the handle is not there.
 */
export async function transactionHandle(req: PayloadRequest | undefined): Promise<TxHandle | null> {
  const raw = req?.transactionID
  const id = raw instanceof Promise ? await raw : raw
  if (!id) return null
  const sessions = (req?.payload?.db as unknown as {
    sessions?: Record<string, { db?: TxHandle }>
  })?.sessions
  const tx = sessions?.[String(id)]?.db
  if (!tx?.execute) {
    // ⚠ LOUD, because the failure is otherwise silent: there IS a transaction,
    // but the adapter's registry no longer looks like 3.88.0's. Every cleanup
    // would then be skipped (orphans, nothing wrongly deleted), and the row
    // lock below could not be taken. Guarded by
    // `conversationUploads.adapterShape.test.ts` and the real-Postgres suite.
    req?.payload?.logger?.error(
      { transactionID: String(id) },
      '[uploads] cannot reach the transaction: payload.db.sessions[transactionID].db is missing — has @payloadcms/drizzle changed? Upload files will NOT be cleaned up.',
    )
    return null
  }
  return tx
}

/** `txid_current()` on the transaction's own connection; null without one. */
export async function currentTxid(req: PayloadRequest | undefined): Promise<string | null> {
  const tx = await transactionHandle(req)
  if (!tx) return null
  const res = (await tx.execute(sql`SELECT txid_current()::text AS xid`)) as {
    rows?: Array<{ xid?: string }>
  }
  return res.rows?.[0]?.xid ?? null
}

/**
 * 🔴 `SELECT … FOR UPDATE` on these `documents` rows, in the delete's own
 * transaction, IN ID ORDER. Returns the ids it locked (a row deleted
 * meanwhile is simply absent), or null when there is no transaction to lock in.
 *
 * WHY. The cascade decides from a row's status and then deletes it. Without a
 * lock, a publish (`lib/publishDocument.ts` sets `publishing`) or a reviewer's
 * approval (`lib/holdReview.ts` inserts a review row, then moves
 * `anonymisationStatus`) landing between the two was deleted anyway: shown on
 * a real Postgres by the 2026-10-17 audit. Under the lock:
 *
 *   · a write that COMMITTED before the lock is seen, because the rows are
 *     read again after it (Postgres READ COMMITTED: each statement sees what
 *     has committed so far);
 *   · a write that comes AFTER waits for this transaction. Both paths write
 *     with single statements that block on it: an `UPDATE documents` needs the
 *     row lock, and an `INSERT INTO anonymisation_reviews` takes `FOR KEY
 *     SHARE` on the document for its foreign key, which conflicts with
 *     `FOR UPDATE`. Once this commits the row is gone: the UPDATE matches
 *     nothing and the INSERT fails its foreign key.
 *
 * ⚠ ID ORDER, so two deletes locking overlapping rows cannot deadlock on each
 * other. Every other writer of `documents` touches one row per statement.
 */
async function lockDocumentRows(ids: Id[], req: PayloadRequest | undefined): Promise<Set<string> | null> {
  const tx = await transactionHandle(req)
  if (!tx) return null
  const sorted = [...ids].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return new Set()
  const res = (await tx.execute(
    sql`SELECT id FROM documents WHERE id IN (${sql.join(
      sorted.map((id) => sql`${id}`),
      sql`, `,
    )}) ORDER BY id FOR UPDATE`,
  )) as { rows?: Array<{ id: unknown }> }
  return new Set((res.rows ?? []).map((r) => String(r.id)))
}

/**
 * THE TRANSACTION HALF. Delete the `documents` rows of the uploads that belong
 * only to `sessionId` (and the review rows of the held ones), and hand
 * `onPlan` what to remove after commit. Returns the plan too (null when there
 * is nothing).
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

  const findAttached = async () =>
    (
      await payload.find({
        collection: 'documents',
        // `equals` on a hasMany relationship reads "contains this id".
        where: { session: { equals: sessionId } },
        depth: 0,
        overrideAccess: true,
        pagination: false,
        req,
      })
    ).docs as unknown as UploadRow[]
  const found = await findAttached()
  if (found.length === 0) return null

  // 🔴 Lock, then decide from what is read UNDER the lock (`lockDocumentRows`).
  // A row attached meanwhile is not locked, so it is left out.
  const locked = await lockDocumentRows(
    found.map((d) => d.id),
    req,
  )
  const rows = locked === null ? found : (await findAttached()).filter((d) => locked.has(String(d.id)))
  if (rows.length === 0) return null

  const session = (await payload.findByID({
    collection: 'sessions',
    id: sessionId,
    depth: 0,
    overrideAccess: true,
    req,
  })) as unknown as SessionFacts

  // Read only when a row needs it: one query per conversation delete at most.
  const recordedSince =
    deps.originRecordedSince !== undefined
      ? deps.originRecordedSince
      : rows.some((d) => relationId(d.uploadedInSession) == null)
        ? await readOriginRecordedSince(deps)
        : null

  const doomed: UploadRow[] = []
  for (const doc of rows) {
    if (!isOwnDraftUpload(doc, session, recordedSince)) continue
    if (await isReferencedElsewhere(doc, sessionId, deps)) continue
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
      if (isHeld(doc)) await deleteReviewRows(doc.id, plan, deps)
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

/**
 * A held document's `anonymisation-reviews` rows, in the transaction. They
 * are append-only to every API caller (`collections/AnonymisationReviews.ts`);
 * this is the one server-side exception, ruled by Rodrigo on 2026-10-17.
 * (The foreign key is `ON DELETE cascade` too, baseline migration; deleting
 * them here does not depend on it and puts their ids in the logs.)
 */
async function deleteReviewRows(documentId: Id, plan: UploadCleanupPlan, deps: ConversationUploadDeps): Promise<void> {
  const result = (await deps.payload.delete({
    collection: 'anonymisation-reviews',
    where: { document: { equals: documentId } },
    depth: 0,
    overrideAccess: true,
    req: deps.req,
  })) as { docs?: Array<{ id: Id }>; errors?: unknown[] }
  // A bulk delete collects per-row failures instead of throwing.
  if (result.errors?.length) {
    throw new Error(
      `[sessions] could not delete ${result.errors.length} anonymisation-review row(s) of document ${String(documentId)}; the conversation was left intact.`,
    )
  }
  const ids = (result.docs ?? []).map((d) => d.id)
  if (ids.length > 0) plan.reviewIds = [...(plan.reviewIds ?? []), ...ids]
}

/**
 * THE TRANSACTION HALF FOR A DOCUMENT DELETED ON ITS OWN. Called from the
 * document's `beforeDelete`: names its stored file for deletion after commit.
 * Null when there is nothing to plan:
 *
 *   · a conversation delete is removing it (its plan covers the file);
 *   · it has no file, or the file is not its uploader's (a document pointing
 *     at someone else's media id never removes their file).
 *
 * ⚠ Whether another document still uses the file is NOT asked here; see the
 * header ("A FILE IS ONLY DELETED WHEN IT IS THE OWNER'S").
 */
export async function planDocumentMediaCleanup(
  documentId: Id,
  { payload, req }: { payload: Payload; req?: PayloadRequest },
): Promise<UploadCleanupPlan | null> {
  if (isHandledByConversationDelete(req?.context, documentId)) return null
  const doc = (await payload.findByID({
    collection: 'documents',
    id: documentId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
    req,
  })) as unknown as UploadRow | null
  const mediaId = relationId(doc?.mediaFile)
  if (!doc || mediaId == null) return null
  if (!(await isOwnersMedia(mediaId, doc.uploadedBy, { payload, req }))) return null
  return { sessionId: null, documentId, xid: await currentTxid(req), documents: [], mediaIds: [mediaId] }
}

/** What every log line of a plan carries: ids only. */
function planIds(plan: UploadCleanupPlan): Record<string, unknown> {
  return {
    ...(plan.sessionId != null ? { sessionId: String(plan.sessionId) } : {}),
    ...(plan.documentId != null ? { documentId: String(plan.documentId) } : {}),
    documentIds: plan.documents.map((d) => String(d.id)),
    mediaIds: plan.mediaIds.map(String),
    ...(plan.reviewIds?.length ? { reviewIds: plan.reviewIds.map(String) } : {}),
  }
}

const tagOf = (plan: UploadCleanupPlan): string => (plan.sessionId != null ? '[sessions]' : '[documents]')

/**
 * Start the irreversible half — stored files, ai-service documents — in the
 * background. It waits for THIS transaction's outcome (`txid_status`) before
 * doing anything.
 *
 * ⚠ Scheduled from the `beforeDelete` hook, in a closure, and NOT handed to an
 * `afterDelete` through `req.context`: a bulk delete runs these hooks
 * concurrently on one `req`, and a row whose hook throws never reaches
 * `afterDelete` even though the bulk transaction still commits what it did
 * delete.
 */
export function scheduleUploadCleanup(payload: Payload, plan: UploadCleanupPlan): void {
  // Logged BEFORE the wait: a restart while it polls loses the closure, and
  // this line is then the only trace of which files and ai-service documents
  // became orphans.
  const { sessionId, documentId, ...rest } = planIds(plan)
  payload.logger.info(
    {
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(documentId !== undefined ? { documentId } : {}),
      xid: plan.xid,
      ...rest,
    },
    `${tagOf(plan)} scheduled post-commit upload cleanup`,
  )
  void finishUploadCleanupAfterCommit(plan, { payload }).catch((err) => {
    payload.logger.warn(
      { ...planIds(plan), err: String(err) },
      `${tagOf(plan)} post-commit upload cleanup failed; these uploads may be orphans`,
    )
  })
}

export type TxOutcome = 'committed' | 'aborted' | 'gave-up'

export interface AfterCommitDeps {
  payload: Payload
  /** The ecosistema's admin ai-service client. Injected by tests. */
  corpusClient?: (organizationId: Id) => unknown
  /** `txid_status(xid)`. Injected by tests; defaults to a fresh-connection query. */
  txStatus?: (xid: string) => Promise<string | null>
  /**
   * Is a deleted media row's object still in the bucket? Injected by tests.
   * Defaults to a HEAD when object storage is configured, and to `false` on
   * local disk, where Payload's own file delete throws on failure.
   */
  objectStillStored?: (media: { filename?: string | null; prefix?: string | null }) => Promise<boolean>
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

/**
 * Poll `txid_status(xid)` until the transaction ends or the budget runs out.
 * Exported for `lib/conversationTurnErasure.ts`, which waits the same way.
 */
export async function waitForOutcome(
  xid: string,
  deps: Pick<AfterCommitDeps, 'payload' | 'txStatus' | 'attempts' | 'intervalMs'>,
): Promise<TxOutcome> {
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

/** Is the row still there, on a fresh connection? Exported for the turn erasure. */
export async function rowExists(
  payload: Payload,
  collection: 'documents' | 'sessions' | 'media' | 'messages',
  id: Id,
): Promise<boolean> {
  const row = await payload.findByID({ collection, id, depth: 0, overrideAccess: true, disableErrors: true })
  return row != null
}

async function defaultObjectStillStored(media: { filename?: string | null; prefix?: string | null }): Promise<boolean> {
  const { isStorageConfigured, objectExists } = await import('./storage/client')
  if (!isStorageConfigured() || !media.filename) return false
  // Same key as `locateMedia` in `collections/Documents.ts`.
  const prefix = (media.prefix ?? '').replace(/^\/+|\/+$/g, '')
  return objectExists(prefix ? `${prefix}/${media.filename}` : media.filename)
}

const isNotFound = (err: unknown): boolean => (err as { status?: number } | null)?.status === 404

/**
 * THE AFTER-COMMIT HALF. Never throws: by now the rows are gone, and the only
 * thing left to do with a failure is log it.
 */
export async function finishUploadCleanupAfterCommit(
  plan: UploadCleanupPlan,
  deps: AfterCommitDeps,
): Promise<TxOutcome | 'no-transaction' | 'session-survived'> {
  const { payload } = deps
  const log = payload.logger
  const tag = tagOf(plan)
  const allIds = planIds(plan)

  let outcome: TxOutcome | 'no-transaction' = 'no-transaction'
  if (plan.xid) {
    outcome = await waitForOutcome(plan.xid, deps)
    if (outcome === 'aborted') {
      log.info(allIds, `${tag} delete rolled back; its uploads were left untouched`)
      return outcome
    }
    if (outcome === 'gave-up') {
      log.warn(
        allIds,
        `${tag} could not learn whether the delete committed; these uploads were NOT cleaned up and may be orphans`,
      )
      return outcome
    }
  }

  // 🔴 The SESSION must be gone too. A bulk delete commits the rest when one
  // row's own delete throws (Payload 3.88, measured in the round-3 audit): that
  // conversation survives, but its upload rows were already deleted in the
  // shared transaction. Its files and ai-service documents stay, so the
  // surviving conversation's uploads can still be restored by hand.
  if (plan.sessionId != null && (await rowExists(payload, 'sessions', plan.sessionId))) {
    log.warn(
      allIds,
      '[sessions] the conversation survived its delete; its uploads were NOT cleaned up (rows may be gone, files and ai-service documents kept)',
    )
    return 'session-survived'
  }

  const { retireDeletedDocument } = await import('./publishDocument')
  const clientFor =
    deps.corpusClient ??
    (async (organizationId: Id) => (await import('./aiClient')).getAdminAIClient(organizationId))
  const stillStored = deps.objectStillStored ?? defaultObjectStillStored

  const cleanedDocumentIds: string[] = []
  const deletedMediaIds: string[] = []

  for (const doc of plan.documents) {
    try {
      // Bulk delete commits even when one row failed: check this row went.
      if (await rowExists(payload, 'documents', doc.id)) continue
      const organizationId = relationId(doc.organization)
      if (organizationId == null) continue
      const client = await clientFor(organizationId)
      await retireDeletedDocument({ payload, client: client as never }, doc as never)
      cleanedDocumentIds.push(String(doc.id))
    } catch (err) {
      log.warn(
        { ...allIds, documentId: String(doc.id), err: String(err) },
        `${tag} could not delete a deleted upload from ai-service; its chunks may stay retrievable`,
      )
    }
  }

  for (const mediaId of plan.mediaIds) {
    // The error NAME only: a storage error message can carry the object key,
    // which is the uploader's own filename.
    const errName = (err: unknown) => (err instanceof Error ? err.name : 'unknown')
    let deleted: { filename?: string | null; prefix?: string | null }
    try {
      // Also what keeps a document that survived (a failed bulk row, a
      // rolled-back sibling) from losing its file.
      const { totalDocs } = await payload.count({
        collection: 'documents',
        where: { mediaFile: { equals: mediaId } },
        overrideAccess: true,
      })
      if (totalDocs > 0) continue
      deleted = (await payload.delete({ collection: 'media', id: mediaId, depth: 0, overrideAccess: true })) as never
      deletedMediaIds.push(String(mediaId))
    } catch (err) {
      // Another plan got there first: two documents that shared the file were
      // deleted together. Seen on the real-Postgres suite as a 404 or, when
      // both deletes ran at once, a `TypeError` from inside Payload's delete
      // (2026-10-17). Either way the row is gone, and that plan checks the
      // object.
      if (isNotFound(err) || !(await rowExists(payload, 'media', mediaId).catch(() => true))) continue
      log.warn(
        { ...allIds, mediaId: String(mediaId), err: errName(err) },
        `${tag} could not delete a deleted upload’s stored file; it is now an orphan`,
      )
      continue
    }
    try {
      if (await stillStored(deleted ?? {})) {
        log.warn(
          { ...allIds, mediaId: String(mediaId) },
          `${tag} the media row is gone but its stored object is still in the bucket (the storage plugin swallowed the error); it is now an orphan`,
        )
      }
    } catch (err) {
      log.warn(
        { ...allIds, mediaId: String(mediaId), err: errName(err) },
        `${tag} could not check whether a deleted upload’s stored object is gone; it may be an orphan`,
      )
    }
  }

  // Says what was DONE, not what was planned: a skipped row or a failed call
  // shows up as a planned id missing from these lists.
  log.info({ ...allIds, cleanedDocumentIds, deletedMediaIds }, `${tag} post-commit upload cleanup finished`)
  return outcome
}
