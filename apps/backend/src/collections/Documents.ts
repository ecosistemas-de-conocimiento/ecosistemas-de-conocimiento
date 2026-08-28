import type {
  Access,
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  Endpoint,
  Where,
} from 'payload'
import { ValidationError } from 'payload'

import { isPlatformAdminUser } from '../access'
import { ANONYMISATION_STATES } from '../lib/anonymiseDocument'
import {
  CONTENT_KINDS,
  chunkMetadata,
  contentKindOf,
  titleFor,
  DEFAULT_CONTENT_KIND,
  isContentKind,
  type ContentKind,
} from '../lib/contentKind'
import { assertSessionOwnedBy, SessionNotOwnedError } from '../lib/corpus'
import {
  organizationIdsForUser,
  organizationIdsForUserWithPermission,
  PERMISSIONS,
  relationId,
} from '../lib/permissions'
import {
  beginPublish,
  NotPublishableError,
  PUBLICATION_STATES,
  unpublish,
  type PublicationState,
} from '../lib/publishDocument'

/**
 * Session-scoped documents. Unifies markdown working-docs (M4) and uploaded
 * PDF/DOCX corpora (M6). Plan §D2.
 *
 * For markdown (`kind: 'markdown'`), `bodyMarkdown` holds the source text
 * and `mode` defaults to `full-text` (the chat-FE BFF inlines it as prompt
 * context when `isPinned` is true).
 *
 * For PDF/DOCX (`kind: 'pdf' | 'docx'`), the `afterChange` hook below:
 *   1. extracts text via `unpdf` / `mammoth` (inline; v1 size limit ~10MB);
 *   2. persists the result to `extractedText`;
 *   3. enqueues an ingest with ai-service via @edc/ai-client, passing
 *      a `callbackUrl` so the receiver at /api/ai-service/callback (M5)
 *      flips `ingestStatus` to `ready` / `failed` as events arrive.
 *
 * The hook is idempotent on extraction (skipped if `extractedText` already
 * set) and on enqueue (skipped if `ingestId` already set). To force a
 * re-run, clear both fields then save the doc.
 *
 * ── AUDIO (`kind: 'audio'`) ──────────────────────────────────────────────────
 *
 * 🔴 AUDIO IS NOT A SECOND PIPELINE. It is a slower way of producing
 * `extractedText` on the SAME row. Step 1 above is replaced by a round-trip to
 * `services/audio-service`; steps 2 and 3 are the identical code, called
 * unchanged from the `transcribe.completed` handler in the callback route:
 *
 *   afterChange → startTranscription → audio-service → transcribe.completed
 *                                                    → extractedText
 *                                                    → enqueueIngestForDoc  ← same fn
 *
 * Everything the ecosistema model already does to a document — draft privacy,
 * publish (which re-embeds into the shared corpus), unpublish, retrieval
 * scoping — therefore works on a transcript for free. If you find yourself
 * writing a second function that talks to `/v1/ingest`, or naming a second
 * corpus, stop: that is the wrong turn this design exists to prevent.
 *
 * ⚠ Transcription runs at roughly REAL TIME on CPU. A one-hour recording is a
 * one-hour job. Nothing in this file may imply otherwise, and no state may be
 * left dangling with no terminal transition — see the `ingestStatus` field.
 */

/**
 * 🔴 THE VISIBILITY RULE, and the only place it is written.
 *
 *   · A DRAFT is visible to the person who uploaded it, and to nobody else.
 *     Membership in the ecosistema is NOT enough — same-ecosistema,
 *     cross-person leakage is the risk this model introduces that a purely
 *     per-tenant scheme did not have.
 *   · A PUBLISHED document is visible to every member of its ecosistema.
 *
 * ⚠ THE UPLOADER CLAUSE COMES FIRST AND IS UNCONDITIONAL, so a document
 * mid-transition (`publishing` / `unpublishing`) never disappears from the
 * person who owns it. Only `published` is shared; every other state is private.
 * That is what makes a crash between publish steps safe rather than a data-loss
 * report.
 *
 * ⚠ Returns a WHERE CONSTRAINT, never a boolean, so it reaches the query: a
 * list comes back already filtered, and asking for a document by id that you
 * may not see 404s instead of 403-ing.
 */
export const visibleToCaller: Access = async ({ req }) => {
  const user = req.user
  if (!user) return false
  if (isPlatformAdminUser(user)) return true

  const organizationIds = await organizationIdsForUser(req.payload, user.id)

  const mine: Where = { uploadedBy: { equals: user.id } }
  // ⚠ No memberships ⇒ only your own documents. NOT an empty `in: []`, which
  // an ORM may optimise away into "no constraint" — and the failure mode there
  // is every ecosistema's documents returned to someone in none.
  if (organizationIds.length === 0) return mine

  return {
    or: [
      mine,
      {
        and: [
          { publicationStatus: { equals: 'published' } },
          { organization: { in: organizationIds } },
        ],
      },
    ],
  } satisfies Where
}

/** Only the uploader edits or removes a document. */
/** Admin-panel labels. Exhaustive by type, so a new state forces a label. */
/** Admin-panel labels. Exhaustive by type, so a new content kind forces one. */
const CONTENT_KIND_LABELS: Record<ContentKind, string> = {
  documento: 'Documento — una fuente subida por su autor',
  testimonio: 'Testimonio (Voz) — palabras de otra persona, siempre anónimas',
  conversacion: 'Conversación — un turno de chat ingerido al corpus',
}

/** Admin-panel labels for the gate's states. See the field for what they mean. */
const ANONYMISATION_LABELS: Record<(typeof ANONYMISATION_STATES)[number], string> = {
  'n/a': 'N/A — not gated content',
  pending: 'Pending — the gate is running',
  held: 'HELD — refused, not ingested',
  ready: 'Ready — cleared the gate',
}

const PUBLICATION_LABELS: Record<PublicationState, string> = {
  draft: 'Draft — only you can see it',
  publishing: 'Publishing…',
  published: 'Published — shared with the ecosistema',
  unpublishing: 'Unpublishing…',
}

const uploaderOnly: Access = ({ req: { user } }) => {
  if (!user) return false
  if (isPlatformAdminUser(user)) return true
  return { uploadedBy: { equals: user.id } } satisfies Where
}

/**
 * 🔴 THE UPLOAD GATE. Bind a new document to an ecosistema and an uploader,
 * both derived server-side, and refuse anything the caller may not touch.
 *
 * ⚠ THIS CLOSES A REAL CROSS-TENANT WRITE. `create` access on this collection
 * is "any signed-in user", because Payload's create-time access check has no
 * document to constrain against and cannot express "…and this session is
 * yours". Without this hook, ANY authenticated user could POST a document
 * naming SOMEONE ELSE'S session id — and the ingest hook would then derive a
 * corpus from that row.
 *
 * Note what kind of hole that is: they could not READ it back
 * (`visibleToCaller` covers reads), so it was not disclosure. It was
 * INJECTION, which in a knowledgebase is worse — the victim's assistant answers
 * from a document the attacker chose and cites it as the victim's own source.
 *
 * ⚠ `update` is checked too. Re-pointing an existing document at another
 * session or another ecosistema is the same attack in two steps.
 *
 * ⚠ Writes with `overrideAccess: true` and no user — the seed, the ingest
 * hook's own status updates, the publish state machine — pass through
 * untouched. They are server-side by definition and have no session to
 * impersonate.
 */
export const bindDocumentToEcosystem: CollectionBeforeValidateHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const next = { ...(data ?? {}) } as Record<string, unknown>
  const user = req.user
  if (!user) return next

  const original = (originalDoc ?? {}) as Record<string, unknown>

  if (operation === 'create') {
    // ⚠ Always the caller. A client-supplied `uploadedBy` would let one person
    // file a draft as another — and drafts are private PER PERSON, so that is
    // both an impersonation and a way to plant a document in someone's private
    // corpus.
    next.uploadedBy = user.id
    // Everything starts private. Sharing is a deliberate, separate act.
    next.publicationStatus = 'draft'
  } else {
    // ⚠ Immutable after creation. Both are corpus-name inputs: letting either
    // change would leave the embedded copy in one corpus while the row claims
    // another, and the mismatch is invisible until search stops working.
    next.uploadedBy = original.uploadedBy
    // `publicationStatus` moves ONLY through `lib/publishDocument.ts`, which
    // writes with `overrideAccess: true` and therefore never reaches this
    // branch. A client PATCHing it directly would mark a document shared
    // without any of its content being in the shared corpus.
    //
    // 🔴 PIN IT TO THE STORED VALUE — DO NOT `delete` IT. Payload merges the
    // incoming body over the stored row BEFORE `beforeValidate` runs, so `data`
    // already carries the row's own `publicationStatus`. Deleting the key does
    // not "ignore the client's value", it removes the field from the document
    // being validated — and `publicationStatus` is `required: true`. The result
    // was that EVERY authenticated PATCH on a document, including a plain
    // rename, failed with `400 The following field is invalid: Publication
    // Status`. Found by `e2e/documents.e2e.ts`.
    //
    // ⚠ Same shape as `uploadedBy` above, and for the same reason: an immutable
    // field is held at its stored value, not erased. The `else` branch keeps a
    // client-supplied value from surviving in the (Payload-internal) case where
    // no original row was handed to the hook.
    if (typeof original.publicationStatus === 'string') {
      next.publicationStatus = original.publicationStatus
    } else {
      delete next.publicationStatus
    }
  }

  // On update Payload sends only what changed, so fall back to the stored row.
  const sessionId = resolveId(next.session ?? original.session)

  if (sessionId != null) {
    try {
      const { organizationId } = await assertSessionOwnedBy(req.payload, sessionId, user.id)
      next.session = sessionId
      // ⚠ The ecosistema is DERIVED, never accepted from the body. A
      // client-supplied `organization` would let a document be filed under a
      // tenant it does not belong to — and then published into that tenant's
      // shared corpus.
      if (organizationId != null) next.organization = organizationId
    } catch (err) {
      if (err instanceof SessionNotOwnedError) {
        throw new ValidationError({
          collection: 'documents',
          errors: [{ path: 'session', message: err.message }],
          req,
        })
      }
      throw err
    }
  } else if (operation === 'create') {
    // No session — an upload straight into the ecosistema, with no conversation
    // attached. Only unambiguous when the person belongs to exactly one.
    const organizationIds = await organizationIdsForUser(req.payload, user.id)
    if (organizationIds.length === 1) {
      next.organization = organizationIds[0]
    } else {
      throw new ValidationError({
        collection: 'documents',
        errors: [
          {
            path: 'organization',
            message:
              organizationIds.length === 0
                ? 'You do not belong to an ecosistema yet, so there is nowhere to put this document.'
                : 'You belong to several ecosistemas — attach this upload to a conversation so it is clear which one it is for.',
          },
        ],
        req,
      })
    }
  } else {
    // Update with no session on either side: keep the stored ecosistema, and
    // never let the body redefine it.
    next.organization = original.organization
  }

  // ⚠ LAST, because it needs the ecosistema this hook just derived. A permission
  // is held IN an organization, so the check is meaningless before we know which
  // one the row belongs to.
  await enforceVocesUploadRights({ next, original, operation, req })

  return next
}

/**
 * 🔴 WHO MAY FILE SOMEBODY ELSE'S WORDS.
 *
 * A `testimonio` — a Voz — is not the uploader's own material. It is a person's
 * testimony, collected offline by an Investigador and filed under the
 * Investigador's `uploadedBy`. Every one of them goes through the anonymisation
 * gate and lands in the ecosistema's shared corpus as an anonymous voice.
 *
 * That is a different act from uploading a PDF you own, so it needs its own
 * permission (`voces:upload`, held by Investigador and up) rather than riding on
 * `documents:write`. A participant who set `contentKind: 'testimonio'` in a
 * request body would otherwise be publishing an unattributable document into the
 * shared corpus of their ecosistema.
 *
 * ⚠ `contentKind` IS IMMUTABLE AFTER CREATION, and that is the other half of the
 * rule. Without it the check is a formality: create a `documento`, then PATCH it
 * to `testimonio` and the gate has already been skipped, because the gate runs
 * on the ingest that already happened. Worse, the ingested chunk would keep
 * saying `kind: 'documento'` while the row claimed otherwise — and the chunk is
 * the copy retrieval actually reads.
 *
 * ⚠ `conversacion` is NEVER accepted from a request body at all. Conversation
 * chunks are produced by `lib/conversationIngest.ts` from `messages` rows; a
 * `documents` row claiming to be one would be a hand-written chunk wearing the
 * "this came from a previous answer" label that citations trust.
 */
async function enforceVocesUploadRights(args: {
  next: Record<string, unknown>
  original: Record<string, unknown>
  operation: string
  req: Parameters<CollectionBeforeValidateHook>[0]['req']
}): Promise<void> {
  const { next, original, operation, req } = args
  const user = req.user
  if (!user) return

  const refuse = (message: string): never => {
    throw new ValidationError({
      collection: 'documents',
      errors: [{ path: 'contentKind', message }],
      req,
    })
  }

  if (operation !== 'create') {
    // Pinned to the stored value, not deleted — `contentKind` is `required`, and
    // deleting the key fails validation on every PATCH. Same shape and same
    // reason as `publicationStatus` above.
    if (isContentKind(original.contentKind)) {
      next.contentKind = original.contentKind
      return
    }
    /**
     * ⚠ NO STORED VALUE TO PIN TO. Payload merges the incoming body over the
     * stored row BEFORE `beforeValidate`, so on a real update `next` already
     * carries the row's own `contentKind` even when no `originalDoc` was handed
     * to the hook. Falling back to it keeps ordinary edits working.
     *
     * 🔴 WHAT IT MUST NOT DO IS FALL BACK TO `documento`. That was the previous
     * behaviour and it is fail-OPEN in the worst place in the design: a
     * testimony silently reclassified as an ungated document makes
     * `corpusTextFor` select `extractedText` instead of `redactedText`, and the
     * next publish promotes the unredacted original into the shared corpus.
     * With neither a stored value nor a usable merged one, we do not know what
     * this row is — and "we do not know" resolves to "not yet", like every other
     * uncertainty here.
     */
    if (isContentKind(next.contentKind)) return
    // Neither side holds a readable kind. Write NOTHING and let the column keep
    // whatever it has: this hook's job is to stop a client CHANGING the value,
    // not to invent one. `contentKind` is a NOT NULL enum, so the database is
    // the backstop, and the ingest and publish paths read the kind off the
    // stored row rather than from anything decided here.
    delete next.contentKind
    return
  }

  const declared = isContentKind(next.contentKind) ? next.contentKind : DEFAULT_CONTENT_KIND
  next.contentKind = declared

  if (declared === 'documento') return

  if (declared === 'conversacion') {
    refuse(
      'Las conversaciones entran al corpus solas, desde el chat. No se pueden subir como documento.',
    )
  }

  if (isPlatformAdminUser(user)) return

  const organizationId = relationId(next.organization)
  if (organizationId === null) {
    refuse('No se puede registrar una Voz sin saber a qué ecosistema pertenece.')
  }

  const allowed = await organizationIdsForUserWithPermission(
    req.payload,
    user.id,
    PERMISSIONS.vocesUpload,
  )
  if (!allowed.some((id) => String(id) === String(organizationId))) {
    refuse(
      'Solo una persona con el rol de Investigador puede registrar una Voz en este ecosistema.',
    )
  }
}

interface DocumentRow {
  id: number | string
  kind?: string | null
  /**
   * ⚠ NOT `kind`. `kind` is the FILE FORMAT (pdf/docx/audio/markdown);
   * `contentKind` is what the material IS (documento/testimonio/conversacion).
   * See `lib/contentKind.ts` — confusing the two is how a testimony gets
   * ingested without passing the anonymisation gate.
   */
  contentKind?: string | null
  /** The gate's output. The ONLY text a gated document is ever embedded from. */
  redactedText?: string | null
  anonymisationStatus?: string | null
  mode?: string | null
  name?: string | null
  session?: number | string | { id: number | string } | null
  organization?: number | string | { id: number | string } | null
  uploadedBy?: number | string | { id: number | string } | null
  publicationStatus?: string | null
  mediaFile?: number | string | { id: number | string } | null
  extractedText?: string | null
  ingestId?: string | null
  ingestStatus?: string | null
  ingestError?: string | null
  transcribeId?: string | null
  transcribeAttempt?: number | null
  audioMeta?: AudioMeta | null
}

/**
 * What we know about the recording behind an audio document.
 *
 * `durationSeconds` is populated at SUBMIT time (audio-service runs ffprobe
 * inline and returns it on the 202), not at completion — which is what lets the
 * UI say "esto tarda más o menos lo que dura la grabación" while the job is
 * still running instead of after it finishes. The rest arrives with
 * `transcribe.completed`.
 *
 * ⚠ `languageProbability` is the only visible signal of ASR confidence. The
 * product's mitigation for "a transcript can contain errors presented as fact"
 * is a label in the UI; this is the data behind it.
 */
export interface AudioMeta {
  durationSeconds?: number | null
  language?: string | null
  languageProbability?: number | null
  segmentCount?: number | null
  model?: string | null
  chunks?: number | null
}

/**
 * Postgres text-search config for new corpora — a `regconfig` name, not a
 * locale code. Overridable for a deployment in another language; the product
 * itself is Spanish end to end (UI, prompts, and `WHISPER_LANGUAGE=es`).
 */
const CORPUS_LANGUAGE = process.env.CORPUS_LANGUAGE?.trim() || 'spanish'

/** The kinds whose text arrives through the extract → ingest pipeline. */
const INGESTABLE_KINDS = new Set(['pdf', 'docx', 'audio'])

function resolveId(raw: unknown): string | number | null {
  if (typeof raw === 'string' || typeof raw === 'number') return raw
  if (raw && typeof raw === 'object' && 'id' in raw) {
    return resolveId((raw as { id: unknown }).id)
  }
  return null
}

/**
 * afterChange hook — runs after the row is committed. We re-fetch in
 * `extractAndIngest` to dodge any partial-doc snapshots Payload might pass
 * on `update` operations.
 */
const extractAndIngestHook: CollectionAfterChangeHook = async ({
  doc,
  req,
  operation,
}) => {
  // Re-entrancy guard: when we update the same row below (to persist
  // extractedText / ingestId), Payload re-fires the afterChange hook. Skip
  // if the recursive call set the flag.
  const ctx = req.context as { __skipDocsExtract?: boolean }
  if (ctx?.__skipDocsExtract) return doc

  const row = doc as DocumentRow
  if (operation !== 'create' && operation !== 'update') return doc
  if (!INGESTABLE_KINDS.has(String(row.kind))) return doc

  // Run async to avoid blocking the Payload response, AND defer one tick
  // so the create transaction is fully committed before we re-read the row
  // (Payload uses transactions internally for create/update; the row isn't
  // visible to a fresh `findByID` until commit).
  setImmediate(() => {
    void runExtractAndIngest(row).catch((err) => {
      console.error('[documents] background extract+ingest failed', row.id, err)
    })
  })

  return doc
}

/** A document row read at `depth: 1`, so `mediaFile` is the resolved row. */
type DocumentRowWithMedia = DocumentRow & {
  mediaFile?: {
    id: number | string
    filename?: string | null
    mimeType?: string | null
    filesize?: number | null
  } | null
}

/**
 * Retire a deleted document from its corpora.
 *
 * Runs AFTER the row is gone, so it can neither block nor undo the delete —
 * that is the point. It reports, and never throws: turning a successful delete
 * into an error the user cannot act on would be worse than the leak it is
 * trying to close, and the leak is already logged with the corpus and id so it
 * can be retried by hand.
 */
const retireDeletedDocumentHook: CollectionAfterDeleteHook = async ({ doc, req }) => {
  const row = doc as { id?: unknown; organization?: unknown; uploadedBy?: unknown }
  if (row?.id == null) return doc

  try {
    const { getAdminAIClient } = await import('@/lib/aiClient')
    const { retireDeletedDocument } = await import('@/lib/publishDocument')
    await retireDeletedDocument(
      { payload: req.payload, client: getAdminAIClient() as never },
      row as never,
    )
  } catch (err) {
    // Includes "the AI service is not configured at all", which is a normal
    // state for a local run with no admin key. Never fatal here.
    req.payload.logger.warn(
      { documentId: String(row.id), err: String(err) },
      '[delete] could not retire the deleted document; its chunks may stay retrievable.',
    )
  }
  return doc
}

async function runExtractAndIngest(row: DocumentRow): Promise<void> {
  const docId = resolveId(row.id)
  if (docId == null) return

  // Acquire a fresh Payload instance (no transaction context). The `req`
  // passed into afterChange carries the in-flight transaction; once the
  // setImmediate runs the original transaction has closed, so reads on
  // `req.payload` may 404. The top-level `getPayload({ config })` returns
  // the singleton on the no-tx connection.
  const { getPayload } = await import('payload')
  const configPromise = (await import('@payload-config')).default
  const payload = await getPayload({ config: configPromise })

  // Re-fetch with depth: 1 so `mediaFile` includes filename + mimeType.
  // Don't trust the partial `doc` passed to afterChange on `update` paths.
  //
  // 🔴 THIS RETRIES, AND THE RETRY IS THE WHOLE FIX. Read this before
  // "simplifying" it back to a single findByID.
  //
  // `afterChange` fires INSIDE Payload's create transaction. `setImmediate`
  // defers one tick, which is not remotely enough — the transaction commits
  // when the HTTP response completes, several ticks and one network round trip
  // later. So the first read routinely lands before the row is visible on the
  // no-transaction connection and `findByID` THROWS `Not Found` (it throws; it
  // does not return null, which is why the `if (!fresh)` guard below never
  // caught this).
  //
  // The symptom was total and silent: EVERY pdf/docx/audio upload logged
  // "background extract+ingest failed <id> Not Found" once and stopped there.
  // The row sat at `ingestStatus: 'pending'` forever, nothing was ever
  // enqueued, ai-service never saw a single job, and the UI showed "en cola"
  // with no error. Found by the first end-to-end run against the live stack;
  // no unit test could see it, because they all pass a row that already exists.
  //
  // Payload has no after-commit hook, so a bounded retry is the honest fix.
  // ~2.5s total is far longer than a commit needs and still fails loudly if the
  // row genuinely does not exist.
  const RETRY_DELAYS_MS = [25, 50, 100, 250, 500, 750, 800]
  let fresh: DocumentRowWithMedia | null = null

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      fresh = (await payload.findByID({
        collection: 'documents',
        id: docId as never,
        depth: 1,
        overrideAccess: true,
      })) as DocumentRowWithMedia
      if (fresh) break
    } catch (err) {
      const last = attempt === RETRY_DELAYS_MS.length
      if (last) {
        console.error(
          '[documents] doc',
          docId,
          `still not readable after ${RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)}ms —`,
          'giving up on extract+ingest',
          err,
        )
        return
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
    }
  }
  if (!fresh) return
  if (!INGESTABLE_KINDS.has(String(fresh.kind))) return

  /**
   * 🔴 A HELD ROW IS NOT RE-GATED BY AN ORDINARY SAVE.
   *
   * `afterChange` fires on every update, and the only other guard here is
   * `if (fresh.ingestId)` — which a held document never has, because it never
   * reached the enqueue. So RENAMING a held testimony used to re-run the whole
   * gate: two more model calls, billed, and — because the detector IS a model —
   * a chance of a DIFFERENT verdict. Rename it enough times and one of those
   * runs comes back `ready`. That is an "ingest anyway" button nobody meant to
   * build, and it made the header's promise ("re-running it will say no again")
   * a claim the code did not keep.
   *
   * ⚠ The way out is `POST /api/documents/:id/retry`, which clears
   * `anonymisationStatus` deliberately. One explicit path, not a side effect of
   * editing a field.
   */
  if (fresh.anonymisationStatus === 'held') {
    console.warn(
      '[documents] doc',
      docId,
      'is HELD by the anonymisation gate — skipping. Use POST /api/documents/:id/retry to re-run it.',
    )
    return
  }

  // ⚠ The corpus is keyed on (ecosistema, uploader), NOT on the session. A
  // document outlives the conversation it was uploaded into, and drafts are
  // private to their uploader rather than to a thread.
  const organizationId = resolveId(fresh.organization)
  const uploadedById = resolveId(fresh.uploadedBy)
  if (organizationId == null || uploadedById == null) {
    console.warn(
      '[documents] doc',
      docId,
      'has no organization/uploadedBy — cannot derive a corpus, skipping ingest',
    )
    return
  }

  // 1. Extract — skip if already cached on the row (idempotent re-saves).
  let extractedText = fresh.extractedText ?? ''
  if (!extractedText || !extractedText.trim()) {
    const mediaId = resolveId(fresh.mediaFile)
    if (mediaId == null) {
      console.warn('[documents] no mediaFile on', fresh.kind, 'doc', docId, '— cannot extract')
      return
    }

    // 🔴 THE AUDIO FORK, AND THE `return` IS THE POINT OF IT.
    //
    // There is no text yet and there will not be for minutes-to-hours, so
    // control must NOT reach `enqueueIngestForDoc` on this pass. It gets there
    // from the `transcribe.completed` callback, which calls the very same
    // function with the very same arguments. Falling through here would enqueue
    // an empty document: ai-service would happily embed nothing, the row would
    // go `ready`, and search would silently never find the recording.
    if (fresh.kind === 'audio') {
      await startTranscription({ payload, docId, fresh })
      return
    }

    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: { ingestStatus: 'extracting' },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })

    try {
      extractedText = await extractText(
        payload,
        mediaId,
        fresh.kind === 'docx' ? 'docx' : 'pdf',
      )
    } catch (err) {
      console.error('[documents] extraction failed for doc', docId, err)
      await payload.update({
        collection: 'documents',
        id: docId as never,
        data: {
          ingestStatus: 'failed',
          ingestError: `extraction_failed: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            500,
          ),
        },
        overrideAccess: true,
        context: { __skipDocsExtract: true },
      })
      return
    }

    if (!extractedText.trim()) {
      console.warn('[documents] extraction yielded empty text for doc', docId)
      await payload.update({
        collection: 'documents',
        id: docId as never,
        data: {
          ingestStatus: 'failed',
          ingestError: 'empty_extraction: the file produced no text',
        },
        overrideAccess: true,
        context: { __skipDocsExtract: true },
      })
      return
    }

    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: { extractedText },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
  }

  // 2. Enqueue ingest — skip if already enqueued (idempotent re-saves).
  if (fresh.ingestId) return

  await enqueueIngestForDoc({ payload, docId, organizationId, uploadedById, fresh, extractedText })
}

/**
 * The enqueue half of the pipeline, split out from `runExtractAndIngest` so it
 * can be exercised directly in tests without standing up Payload or the
 * `@payload-config` module graph. Same code that runs in production.
 */
export async function enqueueIngestForDoc(args: {
  payload: Pick<Awaited<ReturnType<typeof import('payload').getPayload>>, 'update'>
  docId: string | number
  /** Ecosistema the document belongs to. Half of the corpus name. */
  organizationId: string | number
  /** Who uploaded it. The other half — drafts are PRIVATE per person. */
  uploadedById: string | number
  fresh: Pick<DocumentRow, 'name' | 'kind' | 'contentKind'>
  extractedText: string
  /** Test seam for the anonymisation gate's model call. */
  detector?: import('@/lib/anonymise/types').PersonDetector
}): Promise<void> {
  const { payload, docId, organizationId, uploadedById, fresh, extractedText } = args
  const contentKind = contentKindOf(fresh)

  /**
   * 🔴 THE ANONYMISATION GATE, AT THE ONE POINT EVERY PATH CONVERGES ON.
   *
   * PDF/DOCX extraction, the audio transcript arriving on a webhook, and the
   * manual retry all reach ai-service through this function and no other. Put
   * the gate anywhere upstream and the audio path — the slow asynchronous one
   * nobody watches — is the one that would get missed.
   *
   * ⚠ A HOLD RETURNS. It does not throw, and it does not fall through to a
   * "degraded" ingest. There is no per-document delete at ai-service, so
   * ingesting a testimony whose scrub we are not sure about is close to
   * permanent. The row keeps its `extractedText` and its reason; nothing is
   * lost, it is simply not embedded.
   */
  const { anonymiseDocumentText } = await import('@/lib/anonymiseDocument')
  const gated = await anonymiseDocumentText({
    payload,
    docId,
    contentKind,
    text: extractedText,
    ...(args.detector ? { detector: args.detector } : {}),
    // ⚠ Empty on purpose for a testimony. The people a Voz names — the speaker,
    // their family, an official — are not users of this system, so no roster we
    // hold contains them. Testimony redaction rests on the content scrub.
    roster: [],
  })

  if (!gated.ok) {
    console.warn(
      `[documents] doc ${docId} HELD at the ${gated.stage} stage of the anonymisation gate — not ingested.`,
    )
    /**
     * 🔴 SAY SO ON `ingestStatus` TOO, OR THE USER WATCHES A SPINNER FOREVER.
     *
     * `anonymisationStatus: 'held'` is the truthful record and an operator can
     * see it — but the row was left at `extracting` (or `transcribing`), which
     * is a NON-TERMINAL state with nothing left to move it. That breaks this
     * file's own rule and looks, to the person who uploaded a testimony,
     * exactly like an upload that is still working.
     *
     * ⚠ `failed`, so `planIngestRetry` will accept it. A hold is not something
     * to retry blindly — re-running the gate on identical bytes costs two model
     * calls for the same answer — but the person may well fix the source and
     * ask again, and `POST /:id/retry` is the ONE explicit path for that.
     * `runExtractAndIngest` refuses to re-gate a held row on any other save.
     */
    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: {
        ingestStatus: 'failed',
        ingestError: `anonymisation_held: ${gated.stage}: ${gated.reason}`.slice(0, 500),
      },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
    return
  }

  const corpusText = gated.text

  // From the UI's POV, the wait between enqueue and the ai-service callback
  // *is* the embedding phase (ai-service workers chunk + embed + upsert).
  await payload.update({
    collection: 'documents',
    id: docId as never,
    // `ingestError: null` clears whatever a previous failed attempt left behind.
    // A retry that succeeded must not keep showing the reason it failed before.
    data: { ingestStatus: 'embedding', ingestError: null },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })

  // Lazy-import the client + helpers so we don't pull @edc/ai-client
  // into the payload-types-only `payload generate:types` build path.
  const { getAppAIClient } = await import('@/lib/aiClient')
  const { draftCorpus } = await import('@/lib/corpus')

  // ⚠ A NEW UPLOAD ALWAYS LANDS IN THE UPLOADER'S PRIVATE DRAFT CORPUS, never
  // in the ecosistema's shared one. That is the workflow: upload, try it in
  // chat, then publish deliberately. Ingesting straight into the shared corpus
  // would share every document the instant it finished uploading, which is the
  // opposite of what `publicationStatus: 'draft'` promises on the row.
  //
  // Both halves of the name come from the DATABASE ROW, which was itself
  // validated on write (`bindDocumentToEcosystem`). Nothing here is derived
  // from a request body.
  const corpus = draftCorpus(organizationId, uploadedById)

  let client
  try {
    client = getAppAIClient()
  } catch (err) {
    console.error('[documents] ai-client unavailable; ingest skipped for doc', docId, err)
    return
  }

  // Single seam shared with the boot check in `payload.config.ts`, so the
  // warning an operator sees at boot cannot drift from what actually happens
  // here. Returns null unless BOTH the secret and a well-formed absolute base
  // URL are set — a malformed base URL degrades to "no callback" rather than
  // 400-ing the ingest call itself (ai-service validates `callbackUrl` with
  // `z.string().url()`, and that 400 would take ingestion down entirely, not
  // just the callback).
  const { ingestCallbackUrl, missingCallbackConfig } = await import('@/lib/callbackConfig')
  const callbackUrl = ingestCallbackUrl() ?? undefined
  if (!callbackUrl) {
    console.warn(
      '[documents] ai-service callbacks not configured (' +
        missingCallbackConfig().join(', ') +
        `) — doc ${docId} is being enqueued WITHOUT a callbackUrl and will stay in ` +
        'ingestStatus="embedding" until an operator fixes the config and it is re-uploaded',
    )
  }

  try {
    const result = await client.ingest.enqueue({
      corpus,
      documents: [
        {
          id: String(docId),
          // 🔴 THE GATE'S OUTPUT, NEVER `extractedText`. For a `documento` they
          // are the same string; for a `testimonio` they are not, and sending
          // the wrong one embeds the unredacted original into a corpus that has
          // no per-document delete.
          text: corpusText,
          // ⚠ `titleFor`, not `fresh.name`. The top-level title is not echoed
          // back on retrieve, but it IS stored at ai-service — and for a
          // testimony the uploader's filename is exactly the identifier the
          // gate just spent two model calls removing from the body.
          title: titleFor(contentKind, fresh.name),
          /**
           * ⚠ BUILT BY `chunkMetadata`, NOT INLINE. It is the same builder the
           * publish move uses, which is what stops `kind` from being silently
           * dropped when a document is re-embedded into the shared corpus. See
           * `lib/contentKind.ts`.
           */
          metadata: chunkMetadata({
            docId: String(docId),
            organizationId,
            contentKind,
            format: fresh.kind,
            publication: 'draft',
            title: fresh.name,
          }),
        },
      ],
      /**
       * 🔴 THE LEXICAL LEG'S STEMMING, and it is only honoured when the corpus
       * is FIRST created.
       *
       * This is a Postgres text-search config name (`regconfig`), not an ISO
       * locale: `'spanish'`, not `'es'`. Without it the corpus is created as
       * `'simple'`, which does no stemming at all — so `acuerdo` does not match
       * `acuerdos`, and `firmamos` does not match `firmar`.
       *
       * ⚠ It costs more here than it would in an English product. This is a
       * Spanish-language repository, Spanish is heavily inflected, and half the
       * corpus is TRANSCRIBED SPEECH — where people conjugate freely and rarely
       * repeat a term in the exact form someone later searches for. Dense
       * retrieval papers over some of it; the hybrid mode's lexical half simply
       * misses.
       *
       * ⚠ APPLIED AT CREATION ONLY. A corpus that already exists keeps whatever
       * it was made with — setting this does not retro-fix one. Existing
       * corpora need `client.corpora.update`, or to be rebuilt.
       */
      language: CORPUS_LANGUAGE,
      ...(callbackUrl ? { callbackUrl } : {}),
    })
    // Don't overwrite ingestStatus here — we already set 'embedding' above,
    // and the ai-service callback will flip it to 'ready' / 'failed'.
    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: { ingestId: result.ingestId },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
    console.log(
      `[documents] enqueued ingest for doc ${docId} → ingestId=${result.ingestId} corpus=${corpus}`,
    )
  } catch (err) {
    console.error('[documents] ingest.enqueue failed for doc', docId, err)
    // Use the same no-transaction `payload` handle as every other write here.
    // This used to be `req.payload`, whose transaction has already committed by
    // the time this `setImmediate` body runs — so the one write that reports a
    // FAILURE was the one most likely to be silently dropped.
    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: {
        ingestStatus: 'failed',
        ingestError: `ingest_enqueue_failed: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          500,
        ),
      },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
  }
}

// ---------------------------------------------------------------------------
// Audio → transcript
// ---------------------------------------------------------------------------

/**
 * Hand one audio document to `services/audio-service` and record the job id.
 *
 * Split out and exported for the same reason as {@link enqueueIngestForDoc}: it
 * can then be exercised without booting Payload or the `@payload-config` module
 * graph, and the code under test is the code that runs.
 *
 * ⚠ THIS FUNCTION NEVER PRODUCES TEXT AND NEVER CALLS ai-service. It returns as
 * soon as audio-service has accepted the job (HTTP 202). Everything after that
 * arrives at `/api/ai-service/callback`.
 *
 * ⚠ NO RETRY LOOP HERE, deliberately. audio-service owns retries (its own
 * schedule, plus a reconciler that turns a killed job into a real
 * `transcribe.failed`). A retry from this side would pay for the same
 * CPU-hours twice. A human retry goes through `POST /api/documents/:id/retry`,
 * which bumps `transcribeAttempt` so the idempotency key changes.
 */
export async function startTranscription(args: {
  payload: Pick<
    Awaited<ReturnType<typeof import('payload').getPayload>>,
    'update' | 'findByID'
  >
  docId: string | number
  fresh: Pick<
    DocumentRow,
    'name' | 'kind' | 'mediaFile' | 'transcribeId' | 'transcribeAttempt' | 'organization' | 'uploadedBy'
  >
  /**
   * Test seam. Production reads Payload's local media directory as a
   * FILE-BACKED, LAZILY-READ blob — see {@link openMediaBlob}.
   */
  openMedia?: typeof openMediaBlob
}): Promise<void> {
  const { payload, docId, fresh } = args

  // The afterChange hook re-fires on every save, including the saves this
  // function makes. One job per document per attempt.
  if (fresh.transcribeId) return

  const fail = async (code: string, message: string): Promise<void> => {
    console.error('[documents] transcription not started for doc', docId, code, message)
    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: { ingestStatus: 'failed', ingestError: `${code}: ${message}`.slice(0, 500) },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
  }

  const mediaId = resolveId(fresh.mediaFile)
  if (mediaId == null) return void (await fail('no_media', 'this document has no audio file'))

  const { ingestCallbackUrl, missingCallbackConfig } = await import('@/lib/callbackConfig')
  const callbackUrl = ingestCallbackUrl()
  if (!callbackUrl) {
    // 🔴 FAIL, DO NOT DEGRADE — and this is the one place audio diverges from
    // the PDF path on purpose. A PDF with no callback still gets its text and
    // its chunks; only the final status flip is lost. For audio the callback IS
    // the delivery mechanism for the transcript, so without it the row would sit
    // in `transcribing` forever with nothing anywhere able to move it. A visible
    // failure the user can retry beats an honest-looking spinner that never ends.
    return void (await fail(
      'callbacks_not_configured',
      `transcription needs the callback round-trip (missing: ${missingCallbackConfig().join(', ')})`,
    ))
  }

  const { submitTranscription, TRANSCRIBE_LANGUAGE } = await import('@/lib/audioClient')

  let media: Awaited<ReturnType<typeof openMediaBlob>>
  try {
    media = await (args.openMedia ?? openMediaBlob)(payload, mediaId)
  } catch (err) {
    return void (await fail(
      'media_unreadable',
      err instanceof Error ? err.message : String(err),
    ))
  }

  // Visible BEFORE the network call, so a hanging audio-service still shows the
  // user something true rather than looking like nothing happened.
  await payload.update({
    collection: 'documents',
    id: docId as never,
    data: { ingestStatus: 'transcribing', ingestError: null },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })

  const attempt = Number(fresh.transcribeAttempt ?? 0) || 0
  const result = await submitTranscription({
    body: media.body,
    filename: media.filename,
    contentType: media.contentType,
    // The join key back to this row. The callback echoes it as `externalId`.
    externalId: String(docId),
    title: fresh.name ?? null,
    // ⚠ The attempt number is IN the key. audio-service dedupes on it within our
    // (org, project), which is what makes a double-fire of the hook free — but
    // it also means a retry reusing the key would silently re-adopt the failed
    // job instead of transcribing again.
    idempotencyKey: `doc-${docId}-a${attempt}`,
    callbackUrl,
    language: TRANSCRIBE_LANGUAGE,
    // ⚠ DECORATIVE — log correlation only. audio-service does not and must not
    // scope anything on these; see the header of `lib/audioClient.ts`.
    metadata: {
      docId: String(docId),
      organizationId: String(resolveId(fresh.organization) ?? ''),
      uploadedById: String(resolveId(fresh.uploadedBy) ?? ''),
      kind: 'audio',
    },
  })

  if (!result.ok) {
    return void (await fail(result.code, result.message))
  }

  await payload.update({
    collection: 'documents',
    id: docId as never,
    data: {
      transcribeId: result.transcribeId,
      transcribeAttempt: attempt,
      // Known already: audio-service runs ffprobe inline before it answers 202.
      // This is what lets the UI quote an honest wait instead of a spinner.
      audioMeta: { durationSeconds: result.durationSeconds },
    },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })
  console.log(
    `[documents] transcription started for doc ${docId} → transcribeId=${result.transcribeId}` +
      (result.deduplicated ? ' (idempotency hit — re-adopted the existing job)' : ''),
  )
}

/**
 * Open a media row's bytes as a Blob.
 *
 * ⚠ `fs.openAsBlob` rather than `fs.readFile`: it is FILE-BACKED and read
 * lazily as the request body streams, so a 200 MB recording never lands in the
 * Next process's heap whole. `readFile` on the same file is an OOM waiting for
 * a big enough upload.
 *
 * ⚠ `path.resolve(process.cwd(), 'media', …)` mirrors `extractText` exactly.
 * That hardcoded location is Payload's default `staticDir` and is an EXISTING
 * assumption, not one introduced here. It does mean the backend and
 * audio-service must not be assumed to share a filesystem: we read the bytes and
 * POST them.
 */
/**
 * Read a media row's bytes, from wherever that row's bytes actually live.
 *
 * 🔴 THE ONE PLACE THAT KNOWS WHERE UPLOADS ARE STORED. Both the text-extract
 * path and the audio-transcription path go through here, and they used to each
 * hardcode `path.resolve(process.cwd(), 'media', filename)` instead.
 *
 * That assumption silently stopped being true when uploads moved to
 * S3-compatible object storage: Payload no longer writes to `./media/`, so
 * every pdf/docx extraction failed with ENOENT and every audio upload failed
 * with "Unable to open file as blob". Neither had a test that could see it —
 * the unit tests inject their own reader, and nothing exercised a real upload
 * against a configured bucket until the first end-to-end run.
 *
 * ⚠ The S3 key is `${prefix}/${filename}`, NOT `filename`. The plugin writes
 * the per-document prefix (`eco_{orgId}/u_{uploaderId}`) onto the media row and
 * that is part of the key. Reading without it 404s on every object.
 *
 * Local disk remains supported and is still the no-config default, so a bare
 * `pnpm dev` with no S3 variables behaves exactly as before.
 */
async function loadMediaBytes(
  payload: Pick<Awaited<ReturnType<typeof import('payload').getPayload>>, 'findByID'>,
  mediaId: string | number,
): Promise<{ bytes: Buffer; filename: string; contentType: string | null }> {
  const media = (await payload.findByID({
    collection: 'media',
    id: mediaId as never,
    depth: 0,
    overrideAccess: true,
  })) as { filename?: string | null; mimeType?: string | null; prefix?: string | null } | null

  const filename = media?.filename
  if (!filename) throw new Error(`media ${mediaId} has no filename`)
  const contentType = media?.mimeType ?? null

  const { isStorageConfigured } = await import('@/lib/storage/client')
  if (isStorageConfigured()) {
    const { getObjectBytes } = await import('@/lib/storage/client')
    const prefix = (media?.prefix ?? '').replace(/^\/+|\/+$/g, '')
    const key = prefix ? `${prefix}/${filename}` : filename
    const { bytes } = await getObjectBytes(key)
    return { bytes, filename, contentType }
  }

  const path = await import('node:path')
  const fs = await import('node:fs/promises')
  const filePath = path.resolve(process.cwd(), 'media', filename)
  const bytes = await fs.readFile(filePath)
  return { bytes, filename, contentType }
}

async function openMediaBlob(
  payload: Pick<Awaited<ReturnType<typeof import('payload').getPayload>>, 'findByID'>,
  mediaId: string | number,
): Promise<{ body: Blob; filename: string; contentType: string | null }> {
  const { bytes, filename, contentType } = await loadMediaBytes(payload, mediaId)
  const body = new Blob([new Uint8Array(bytes)], {
    type: contentType ?? 'application/octet-stream',
  })
  return { body, filename, contentType }
}

async function extractText(
  payload: Awaited<ReturnType<typeof import('payload').getPayload>>,
  mediaId: string | number,
  kind: 'pdf' | 'docx',
): Promise<string> {
  // ⚠ Goes through `loadMediaBytes`, which knows whether this deployment keeps
  // uploads on local disk or in the bucket. This function used to resolve
  // `./media/<filename>` itself, which broke the moment object storage was
  // enabled — see the header on `loadMediaBytes`.
  const { bytes: buffer } = await loadMediaBytes(payload, mediaId)

  if (kind === 'pdf') {
    // Workaround for a known dev-only issue: `drizzle-kit` (transitive via
    // Payload's postgres adapter) defines `Array.prototype.random`, which
    // pdfjs's defensive `for...in` checks reject with "unexpected enumerable
    // property." We temporarily mark the property non-enumerable for the
    // duration of the extract, then restore it. No-op in production builds
    // where drizzle-kit isn't loaded into the runtime.
    const arrProto = Array.prototype as unknown as Record<string, unknown>
    const hadRandom = Object.prototype.hasOwnProperty.call(arrProto, 'random')
    let restore: (() => void) | null = null
    if (hadRandom) {
      const desc = Object.getOwnPropertyDescriptor(arrProto, 'random')
      if (desc?.enumerable) {
        Object.defineProperty(arrProto, 'random', { ...desc, enumerable: false })
        restore = () => Object.defineProperty(arrProto, 'random', desc)
      }
    }
    try {
      const { extractText: extractPdfText, getDocumentProxy } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(buffer))
      const { text } = await extractPdfText(pdf, { mergePages: true })
      return Array.isArray(text) ? text.join('\n\n') : text
    } finally {
      restore?.()
    }
  }
  // docx
  const mammoth = (await import('mammoth')).default ?? (await import('mammoth'))
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

export const Documents: CollectionConfig = {
  slug: 'documents',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'publicationStatus', 'organization', 'uploadedBy', 'ingestStatus'],
  },
  access: {
    read: visibleToCaller,
    update: uploaderOnly,
    delete: uploaderOnly,
    create: ({ req: { user } }) => Boolean(user),
  },
  fields: [
    {
      /**
       * ⚠ THE ECOSISTEMA. Half of every corpus name this document touches, and
       * the scope of who may see it once published.
       *
       * Always derived — from the session it was uploaded into, or from the
       * uploader's sole membership. NEVER accepted from a request body; see
       * `bindDocumentToEcosystem`.
       */
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: {
        readOnly: true,
        description: 'Derived on upload. The ecosistema this document belongs to.',
      },
    },
    {
      /**
       * ⚠ THE OTHER HALF OF THE DRAFT CORPUS NAME, and the whole of the draft
       * visibility rule. Drafts are private PER PERSON, not per ecosistema.
       */
      name: 'uploadedBy',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      index: true,
      admin: { readOnly: true, description: 'Taken from the session. Immutable.' },
    },
    {
      /**
       * ⚠ ONLY `published` IS SHARED. Everything else — `draft` and the two
       * in-flight states — is visible to `uploadedBy` alone.
       *
       * The in-flight states are not decoration. Publishing re-embeds the
       * document into a different corpus, which is slow and can fail, so a row
       * can legitimately sit in `publishing` for a while. Leaving it there with
       * `publicationError` populated is what makes a failure VISIBLE and
       * RETRYABLE instead of silently stuck. See `lib/publishDocument.ts`.
       *
       * ⚠ Moved ONLY by that state machine, which writes with
       * `overrideAccess: true`. A direct client PATCH is stripped in
       * `bindDocumentToEcosystem` — otherwise a document could be marked shared
       * without a single chunk of it being in the shared corpus.
       */
      name: 'publicationStatus',
      type: 'select',
      required: true,
      defaultValue: 'draft',
      index: true,
      // Derived from PUBLICATION_STATES so the column and the state machine
      // cannot fall out of step; the labels are the only hand-written part.
      options: PUBLICATION_STATES.map((value) => ({ value, label: PUBLICATION_LABELS[value] })),
      admin: { position: 'sidebar' },
    },
    {
      name: 'publicationError',
      type: 'textarea',
      admin: {
        readOnly: true,
        position: 'sidebar',
        description:
          'Why the last publish/unpublish did not finish. Populated with the status left at the in-flight value — that pair means "retryable", not "broken".',
      },
    },
    {
      /**
       * ⚠ SEPARATE FROM `ingestId`, deliberately. `ingestId` belongs to the
       * ORIGINAL draft ingest. If the publish re-ingest reused it, the draft's
       * own late `ingest.completed` callback would be read as "publish
       * confirmed" and would retire the draft copy before anything was actually
       * in the shared corpus.
       */
      name: 'publishIngestId',
      type: 'text',
      index: true,
      admin: { readOnly: true, description: 'ai-service ingestId of the in-flight publish move.' },
    },
    {
      /**
       * Where it was uploaded. OPTIONAL: a document belongs to the ecosistema
       * and to its uploader, not to a conversation, and it must outlive any
       * conversation it happened to be attached to.
       */
      name: 'session',
      type: 'relationship',
      relationTo: 'sessions',
      index: true,
      admin: { description: 'The conversation this was uploaded into, if any.' },
    },
    {
      name: 'kind',
      type: 'select',
      required: true,
      defaultValue: 'markdown',
      options: [
        { label: 'Markdown', value: 'markdown' },
        { label: 'PDF', value: 'pdf' },
        { label: 'DOCX', value: 'docx' },
        /**
         * ⚠ An audio document's TEXT is a machine transcription. It is a
         * first-class document — citable, publishable — and it can contain ASR
         * errors presented as fact. `kind` is what the UI keys the
         * "Transcripción automática" label off; do not let it be lost.
         */
        { label: 'Audio', value: 'audio' },
      ],
    },
    {
      /**
       * 🔴 WHAT THIS MATERIAL *IS* — as opposed to what file it arrived in.
       *
       *   documento    a source somebody uploaded under their own name
       *   testimonio   a Voz: someone's words, filed by an Investigador
       *   conversacion a chat turn ingested back into the corpus
       *
       * ⚠ NOT `kind`, WHICH IS THE FILE FORMAT. A `testimonio` is usually
       * `kind: 'audio'`; a `documento` is usually `kind: 'pdf'`. Reading one for
       * the other is how a testimony reaches a corpus unscrubbed.
       *
       * ⚠ IMMUTABLE, and gated on `voces:upload` at creation — see
       * `enforceVocesUploadRights`. It decides whether the anonymisation gate
       * runs, and the gate runs at ingest time, so a value that could change
       * afterwards would be a value that could be changed AFTER the gate was
       * skipped.
       *
       * 🔴 THERE IS NO SUBJECT FIELD NEXT TO THIS ONE, AND THAT IS DELIBERATE.
       * A testimony is anonymous, full stop. We do not store who it came from —
       * not a name, not a code, not a hidden column. The Investigador knows
       * offline; the system never does. A stored subject is a re-identification
       * map, which is the exact thing the anonymisation design refuses to keep,
       * just living in a column instead. There is no consent-level field either:
       * one rule means no default for a bulk upload to get wrong.
       */
      name: 'contentKind',
      type: 'select',
      required: true,
      defaultValue: DEFAULT_CONTENT_KIND,
      index: true,
      // Derived from CONTENT_KINDS so the column and the domain type cannot fall
      // out of step; the labels are the only hand-written part.
      options: CONTENT_KINDS.map((value) => ({ value, label: CONTENT_KIND_LABELS[value] })),
    },
    {
      /**
       * The gate's output, and the ONLY text a `testimonio` is ever embedded
       * from.
       *
       * ⚠ BESIDE the original, never over it. `extractedText` stays as the
       * record of what was actually said, access-controlled in Postgres and
       * never sent to any corpus. Overwriting it would destroy the only copy of
       * what the person gave.
       */
      name: 'redactedText',
      type: 'textarea',
      admin: {
        readOnly: true,
        description:
          'What the anonymisation gate produced. This — not `extractedText` — is what gets embedded for a testimonio or a conversacion.',
      },
    },
    {
      /**
       * 🔴 `held` IS NOT `failed`, AND THE DIFFERENCE IS THE POINT.
       *
       *   n/a      not gated: an ordinary `documento`
       *   pending  the gate is running
       *   held     🔴 THE GATE REFUSED. Not ingested, and there is no override.
       *   ready    cleared; `redactedText` is populated
       *
       * `failed` deliberately does not appear. A failure invites a retry button;
       * a hold means the gate looked at this and said no, and re-running it on
       * the same bytes will say no again. ai-service has no per-document delete,
       * so "ingest anyway" is not a state this product can offer.
       */
      name: 'anonymisationStatus',
      type: 'select',
      required: true,
      defaultValue: 'n/a',
      index: true,
      options: ANONYMISATION_STATES.map((value) => ({ value, label: ANONYMISATION_LABELS[value] })),
      admin: { position: 'sidebar' },
    },
    {
      name: 'anonymisationError',
      type: 'textarea',
      admin: {
        readOnly: true,
        description:
          'Which stage refused, and why. ⚠ Counts only — it never quotes the text that triggered the hold, because that would be a re-identification map.',
      },
    },
    {
      /**
       * 🔴 COUNTS AND RULE NAMES ONLY. Never a removed string, never a mapping
       * from `[Persona A]` back to anything. A report that carried the matches
       * would be the re-identification map this whole design refuses to keep,
       * filed under a friendlier name. Enforced in `lib/anonymise/gate.ts` and
       * asserted in its tests.
       */
      name: 'anonymisationReport',
      type: 'json',
      admin: {
        readOnly: true,
        description:
          'Per-stage counts of what the gate removed. Rule names and numbers — no removed text.',
      },
    },
    {
      name: 'mode',
      type: 'select',
      required: true,
      defaultValue: 'full-text',
      options: [
        { label: 'Full-text (inline as prompt context)', value: 'full-text' },
        { label: 'RAG retrieve', value: 'rag-retrieve' },
      ],
    },
    { name: 'name', type: 'text', required: true, defaultValue: 'Untitled document' },
    {
      name: 'bodyMarkdown',
      type: 'textarea',
      admin: {
        description: 'Markdown source. Used for kind=markdown.',
      },
    },
    {
      name: 'mediaFile',
      type: 'upload',
      relationTo: 'media',
      admin: {
        description:
          'Used for kind=pdf, docx or audio. For audio it is also the PROVENANCE: a member who distrusts a quoted line can play the source recording.',
      },
    },
    { name: 'isPinned', type: 'checkbox', defaultValue: true },
    {
      /**
       * 🔴 THE PIPELINE STATE MACHINE, AND IT MUST STAY HONEST.
       *
       *   n/a          markdown note — no pipeline at all
       *   pending      the row exists; nothing has happened yet
       *   extracting   PDF/DOCX only. Synchronous, seconds.
       *   transcribing AUDIO only. audio-service has the job. ⚠ ROUGHLY REAL
       *                TIME ON CPU: a one-hour recording is a one-hour wait.
       *   transcribed  the transcript is ON THE ROW but not embedded yet. A
       *                real, observable state: if the process dies between
       *                persisting the text and enqueuing the ingest, this is
       *                where the row stops, and it says exactly what is true.
       *   embedding    ai-service is chunking + embedding
       *   ready        retrievable and citable
       *   failed       terminal, with the reason in `ingestError`, and
       *                RETRYABLE via POST /api/documents/:id/retry
       *
       * ⚠ `extracting` is NOT reused for audio. It belongs to the synchronous
       * PDF/DOCX extractor, and borrowing it would tell an audio uploader their
       * one-hour job is a two-second one.
       *
       * ⚠ EVERY NON-TERMINAL STATE HAS SOMETHING THAT WILL MOVE IT. `embedding`
       * is moved by the ai-service callback; `transcribing` by audio-service,
       * including its reconciler, which turns a worker killed mid-job into a
       * real `transcribe.failed` rather than a row that waits forever.
       */
      name: 'ingestStatus',
      type: 'select',
      required: true,
      defaultValue: 'n/a',
      options: [
        { label: 'N/A (markdown)', value: 'n/a' },
        { label: 'Pending (queued)', value: 'pending' },
        { label: 'Extracting text', value: 'extracting' },
        { label: 'Transcribing (audio, ~real time)', value: 'transcribing' },
        { label: 'Transcribed (awaiting ingest)', value: 'transcribed' },
        { label: 'Embedding (awaiting ai-service)', value: 'embedding' },
        { label: 'Ready', value: 'ready' },
        { label: 'Failed', value: 'failed' },
      ],
    },
    {
      /**
       * Why the pipeline stopped, as `code: message`.
       *
       * ⚠ NOT decoration. A `failed` row with no reason is indistinguishable
       * from a bug, and the user cannot tell "wrong file" from "our service is
       * down" — the first they can fix, the second they should just retry. The
       * leading code is stable and is what the frontend maps to Spanish copy.
       */
      name: 'ingestError',
      type: 'textarea',
      admin: {
        readOnly: true,
        description: 'Why the last ingest/transcription attempt failed. `code: message`.',
      },
    },
    {
      name: 'ingestId',
      type: 'text',
      admin: {
        description: 'ai-service ingestId join-back key.',
      },
    },
    {
      /**
       * The audio-service job id — the other join-back key.
       *
       * ⚠ Also the guard against a STALE callback. A retry mints a new job, and
       * a late callback from the old one names the same `externalId`; the
       * receiver only accepts a callback whose `transcribeId` matches this
       * field. Without that check an abandoned attempt could overwrite a good
       * transcript minutes after the fact.
       */
      name: 'transcribeId',
      type: 'text',
      index: true,
      admin: { readOnly: true, description: 'audio-service transcribeId join-back key.' },
    },
    {
      /**
       * How many times transcription has been (re)started for this document.
       *
       * ⚠ It is IN the idempotency key we send audio-service. Retrying with the
       * same key returns the ORIGINAL job — which after a genuine failure means
       * the retry silently does nothing.
       */
      name: 'transcribeAttempt',
      type: 'number',
      defaultValue: 0,
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      /**
       * Duration, detected language and ASR confidence for an audio document.
       *
       * `durationSeconds` lands at SUBMIT time, so the UI can quote a realistic
       * wait while the job runs. The rest arrives with `transcribe.completed`.
       */
      name: 'audioMeta',
      type: 'json',
      admin: {
        readOnly: true,
        description: 'Recording metadata: duration, language, confidence, model, chunk count.',
      },
    },
    {
      name: 'extractedText',
      type: 'textarea',
      admin: {
        description:
          'The document text: extracted for pdf/docx, TRANSCRIBED for audio. Cached so retries do not redo the work — which for audio is CPU-hours, not milliseconds.',
      },
    },
  ],
  hooks: {
    beforeValidate: [bindDocumentToEcosystem],
    afterChange: [extractAndIngestHook],
    /**
     * ✅ CORPUS CLEANUP ON DELETE. Deleting a row used to leave its chunks
     * embedded and retrievable — the document vanished from the UI while the
     * ecosistema's assistant kept quoting it, citing something nobody could
     * open.
     *
     * ⚠ `@edc/ai-client` still has no per-document DELETE — only
     * `deleteCorpus(name)`, which would take the whole ecosistema's shared
     * corpus with it. So this RETIRES instead: it closes the chunk's validity
     * window, which removes it from every retrieve that passes `asOf`. See
     * `retireDeletedDocument` for why that distinction matters.
     *
     * ⚠ `afterDelete`, not `beforeDelete`, on purpose: a document that could
     * not be retired should still be deletable. The user asked for it gone, and
     * refusing because a downstream service is unreachable would leave them
     * stuck with a row they cannot remove. The failure is logged instead.
     */
    afterDelete: [retireDeletedDocumentHook],
  },
  endpoints: [publishEndpoint(), unpublishEndpoint(), retryIngestEndpoint()],
}

// ---------------------------------------------------------------------------
// POST /api/documents/:id/publish  and  /unpublish
// ---------------------------------------------------------------------------

/**
 * Sharing a draft with the ecosistema, and taking it back.
 *
 * ⚠ THESE ARE NOT PLAIN FIELD WRITES, which is why they are endpoints rather
 * than a PATCH on `publicationStatus`. Publishing RE-EMBEDS the document into a
 * different corpus (isolation is by corpus name — see `lib/corpus.ts`), so it
 * is slow, costs tokens and can fail halfway. A PATCH that flipped a column
 * would claim a document was shared while none of its content was in the shared
 * corpus, and search would simply never find it.
 *
 * `POST` returns as soon as the move is ENQUEUED, not when it is done. The row
 * sits in `publishing` until ai-service calls back; the client should poll
 * `publicationStatus` (and show `publicationError` when it is populated).
 */
function documentActionEndpoint(
  action: 'publish' | 'unpublish',
): Endpoint {
  return {
    path: `/:id/${action}`,
    method: 'post',
    handler: async (req) => {
      const json = (body: unknown, status: number): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      const fail = (status: number, message: string): Response =>
        json({ errors: [{ message }] }, status)

      const user = req.user
      if (!user) return fail(401, 'Authentication required.')

      const id = (req.routeParams as { id?: string } | undefined)?.id
      if (!id) return fail(400, 'Missing document id.')

      // ⚠ Read UNDER ACCESS CONTROL. `uploaderOnly` is what makes "you may only
      // publish your own document" true; using overrideAccess here would let
      // anyone publish anyone's draft into the shared corpus.
      const doc = (await req.payload
        .findByID({ collection: 'documents', id: id as never, depth: 0, overrideAccess: false, user, req })
        .catch(() => null)) as unknown as {
        id: number | string
        publicationStatus?: unknown
        uploadedBy?: unknown
      } | null

      if (!doc) return fail(404, 'No such document.')
      if (String(relationId(doc.uploadedBy) ?? '') !== String(user.id)) {
        return fail(403, 'Only the person who uploaded a document can publish it.')
      }

      const state = doc.publicationStatus
      if (action === 'publish' && state === 'published') {
        return json({ ok: true, publicationStatus: 'published', alreadyDone: true }, 200)
      }
      if (action === 'unpublish' && state === 'draft') {
        return json({ ok: true, publicationStatus: 'draft', alreadyDone: true }, 200)
      }

      // ⚠ THE ADMIN CLIENT, not the app one. Publishing does two things: an
      // ingest (any role) AND a `setDocumentValidity` call to retire the old
      // copy, which is an admin-role route. Using the app key would succeed at
      // the ingest and 403 on the retire — leaving the document in BOTH
      // corpora, published and still in drafts, with no error the user sees.
      const { getAdminAIClient } = await import('@/lib/aiClient')
      const { ingestCallbackUrl } = await import('@/lib/callbackConfig')

      let client
      try {
        client = getAdminAIClient()
      } catch {
        // ⚠ Refuse rather than flip the column. Marking a document published
        // when the re-embed could not even be attempted is exactly the lie this
        // endpoint exists to prevent.
        return fail(
          503,
          'The AI service is not configured (AI_SERVICE_ADMIN_API_KEY), so documents cannot be published.',
        )
      }

      const deps = {
        payload: req.payload,
        client: client as never,
        callbackUrl: ingestCallbackUrl() ?? undefined,
      }

      try {
        const result =
          action === 'publish'
            ? await beginPublish(doc as never, deps)
            : await unpublish(doc as never, deps)
        return json(
          {
            ok: true,
            publicationStatus: action === 'publish' ? 'publishing' : 'unpublishing',
            ingestId: result.ingestId,
            corpus: result.corpus,
          },
          202,
        )
      } catch (err) {
        if (err instanceof NotPublishableError) return fail(409, err.message)
        req.payload.logger.error({ err, docId: id, action }, `[documents] ${action} failed`)
        return fail(500, `Could not ${action} this document.`)
      }
    },
  }
}

/**
 * ⚠ FUNCTION DECLARATIONS, NOT `const` ARROWS. They are CALLED in the
 * `endpoints` array of the collection object above, which is evaluated at
 * module load. A `const` arrow is not hoisted, so that call would hit the
 * temporal dead zone and the whole config would throw at import — taking the
 * server down at boot, before any of this ever ran.
 */
// ---------------------------------------------------------------------------
// POST /api/documents/:id/retry — re-run a FAILED ingest
// ---------------------------------------------------------------------------

/** The narrow slice of a row {@link planIngestRetry} reasons about. */
export interface RetryableDocument {
  kind?: string | null
  ingestStatus?: string | null
  extractedText?: string | null
  transcribeAttempt?: number | null
  anonymisationStatus?: string | null
}

/**
 * 🔴 WHAT A RETRY ACTUALLY COSTS, decided as a pure function so it can be
 * tested and so the rule is written in one place.
 *
 * ⚠ THE EXPENSIVE MISTAKE THIS AVOIDS: blindly clearing `extractedText` on
 * every retry. If a transcript already exists and only the ai-service ingest
 * failed, clearing it would throw away a finished transcription and re-run the
 * recording through Whisper — CPU-hours, to redo work that succeeded. So:
 *
 *   · text already on the row → re-enqueue the INGEST only.
 *   · no text                → start over, and bump `transcribeAttempt` so the
 *                              idempotency key changes (an unchanged key makes
 *                              audio-service hand back the failed job and the
 *                              retry silently does nothing).
 *
 * Returns null when there is nothing to retry — a `ready` row, or a markdown
 * note that never had a pipeline.
 */
export function planIngestRetry(doc: RetryableDocument): Record<string, unknown> | null {
  if (!INGESTABLE_KINDS.has(String(doc.kind))) return null
  // Only a TERMINAL failure is retryable. Re-running a job that is still going
  // would double-transcribe and leave two callbacks racing for one row.
  if (doc.ingestStatus !== 'failed') return null

  /**
   * ⚠ CLEARS THE ANONYMISATION HOLD, and this is the ONLY place that does.
   *
   * `runExtractAndIngest` refuses to re-gate a `held` row, so without this a
   * retry would return 202 and then do nothing at all. Clearing it here is what
   * makes "I fixed the source, try again" a deliberate act with a single entry
   * point, instead of something a rename does by accident.
   *
   * ⚠ `redactedText` is NOT cleared. Either the gate held (so there is none) or
   * it is about to be overwritten by the next run.
   */
  const clearHold = { anonymisationStatus: 'n/a', anonymisationError: null }

  const hasText = typeof doc.extractedText === 'string' && doc.extractedText.trim().length > 0
  if (hasText) {
    return { ingestStatus: 'pending', ingestError: null, ingestId: null, ...clearHold }
  }
  return {
    ingestStatus: 'pending',
    ingestError: null,
    ingestId: null,
    transcribeId: null,
    transcribeAttempt: (Number(doc.transcribeAttempt ?? 0) || 0) + 1,
    ...clearHold,
  }
}

/**
 * Re-run the pipeline for a document whose ingest FAILED.
 *
 * ⚠ This is why `failed` is allowed to be a visible, terminal state instead of
 * a silent revert to `pending`. The row keeps its reason (`ingestError`), the
 * user sees it, and this endpoint is the way out. Nothing here retries by
 * itself: the cost of a wrong automatic retry on a three-hour recording is
 * three CPU-hours.
 *
 * The write is a plain `payload.update` with NO `__skipDocsExtract`, so the
 * ordinary `afterChange` hook picks it up — the retry path and the first-upload
 * path are the same code.
 */
function retryIngestEndpoint(): Endpoint {
  return {
    path: '/:id/retry',
    method: 'post',
    handler: async (req) => {
      const json = (body: unknown, status: number): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        })
      const fail = (status: number, message: string): Response =>
        json({ errors: [{ message }] }, status)

      const user = req.user
      if (!user) return fail(401, 'Authentication required.')

      const id = (req.routeParams as { id?: string } | undefined)?.id
      if (!id) return fail(400, 'Missing document id.')

      // ⚠ Read UNDER ACCESS CONTROL, like publish does. `visibleToCaller` 404s
      // a document the caller may not see, so this cannot be used to probe ids.
      const doc = (await req.payload
        .findByID({
          collection: 'documents',
          id: id as never,
          depth: 0,
          overrideAccess: false,
          user,
          req,
        })
        .catch(() => null)) as unknown as (RetryableDocument & { uploadedBy?: unknown }) | null

      if (!doc) return fail(404, 'No such document.')
      if (String(relationId(doc.uploadedBy) ?? '') !== String(user.id)) {
        return fail(403, 'Only the person who uploaded a document can retry it.')
      }

      const data = planIngestRetry(doc)
      if (!data) {
        return fail(409, 'This document has nothing to retry.')
      }

      await req.payload.update({
        collection: 'documents',
        id: id as never,
        data,
        overrideAccess: true,
      })

      return json({ ok: true, ingestStatus: 'pending' }, 202)
    },
  }
}

function publishEndpoint(): Endpoint {
  return documentActionEndpoint('publish')
}

function unpublishEndpoint(): Endpoint {
  return documentActionEndpoint('unpublish')
}
