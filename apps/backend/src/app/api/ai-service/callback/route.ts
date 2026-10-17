/**
 * POST /api/ai-service/callback — receiver for ai-service webhook callbacks,
 * AND for `services/audio-service`'s transcription callbacks.
 *
 * ⚠ ONE ROUTE, ONE VERIFIER, ONE SECRET — and that is deliberate on BOTH sides.
 * audio-service signs with `X-AIService-*` and the identical HMAC scheme
 * (`services/audio-service/app/callbacks.py` says so in its header) precisely so
 * this file grows `event` branches rather than a second verifier that would have
 * to be kept in sync. Nothing in the verification code below changes for audio.
 * `X-Callback-Source: audio-service` rides along for anyone who wants to branch
 * on the emitter; we do not need to.
 *
 * Order (matters for security and latency):
 *   1. `await req.text()` — read the RAW body BEFORE any parse. Next.js's
 *      request body parser is one-shot and any JSON round-trip loses the
 *      byte-fidelity HMAC verification needs.
 *   2. Verify HMAC + replay window (`lib/hmac.ts`) against the raw bytes.
 *   3. INSERT-on-conflict into `aiServiceCallbacks`; if the row already
 *      existed (unique violation), return 200 immediately — ai-service is
 *      retrying an event we've already processed.
 *   4. JSON.parse the body (now safe), dispatch the side-effect (Documents
 *      row update). Return 200.
 *
 * Return-code mapping (from the contract):
 *   - 200 — happy path, also retries on already-deduped events.
 *   - 400 — body unparseable as JSON (signature already verified, so the
 *           emit side is at fault). ai-service treats 4xx-not-401 as a
 *           permanent rejection and doesn't retry.
 *   - 401 — HMAC mismatch / stale timestamp / no secret configured.
 *           ai-service stops retrying THIS callback (auth misconfig);
 *           operator alert + manual rotation + replay.
 *   - 500 — internal failures: the dedupe insert blows up, OR the handler
 *           throws. Triggers the sender's retry schedule.
 *
 * 🔴 A HANDLER THAT THROWS DELETES ITS DEDUPE ROW AND ANSWERS 500. It used to
 * log and answer 200 with the dedupe row in place, so the sender stopped
 * retrying and any retry would have been deduped away: the event was lost.
 *
 * ⚠ THE HANDLERS ARE SHORT ON PURPOSE. audio-service gives up on a callback
 * after 20 s (`services/audio-service/app/config.py`). `transcribe.completed`
 * used to run the anonymisation gate (two model calls) and the ingest enqueue
 * inside this request; now it only persists the transcript and writes
 * `transcribed`, and `lib/ingestRecovery.ts` runs the gate and the enqueue.
 *
 * Dispatch model: we run the Documents update INLINE before responding.
 * A <200ms turnaround via `queueMicrotask` was tried and abandoned: on
 * Next 15 + Payload v3, detaching from the request task makes Next reap the
 * async context and silently drop the scheduled work. The actual find + update is well under 200ms in practice.
 */

import { NextResponse } from 'next/server'
import { getPayload } from 'payload'
import configPromise from '@payload-config'

import {
  CALLBACK_SIGNATURE_HEADER,
  CALLBACK_TIMESTAMP_HEADER,
  verifyCallbackSignature,
} from '@/lib/hmac'
import { messageIdFromExternalId } from '@/lib/conversationIngest'
import { relationId } from '@/lib/permissions'

/**
 * Envelope shape — narrow mirror of `callback-contract.md`. Only the fields
 * we actually read are typed; everything else passes through.
 */
type CallbackEnvelope =
  | {
      event: 'ingest.completed'
      ingestId: string
      docId: string
      corpus?: string
      embeddings?: { chunkCount?: number; model?: string; dimensions?: number }
      costUsd?: number
      durationMs?: number
    }
  | {
      event: 'ingest.failed'
      ingestId: string
      docId: string
      corpus?: string
      error?: { code?: string; message?: string }
    }
  | {
      event: 'ingest.progress'
      ingestId: string
      corpus?: string
      totalDocs?: number
      completedDocs?: number
      failedDocs?: number
    }
  // Generate events are forward-compat: accept-and-dedupe but no dispatch
  // until chat starts using `generate.enqueue` (today it uses sync only).
  | { event: 'unit.completed' | 'unit.failed'; requestId: string; unitKey: string }
  | {
      event: 'request.completed' | 'request.failed' | 'request.cancelled'
      requestId: string
    }
  // ── audio-service (services/audio-service/app/callbacks.py) ───────────────
  | {
      event: 'transcribe.completed'
      transcribeId: string
      /** The `documents` row id we sent as `externalId`. The whole join. */
      externalId?: string | null
      title?: string | null
      audio?: {
        durationSeconds?: number
        chunks?: number
        filename?: string
        contentType?: string
        bytes?: number
      }
      transcript?: {
        /**
         * ⚠ `null` when `truncated` is true — over
         * `CALLBACK_MAX_TRANSCRIPT_CHARS` (200k) audio-service omits the text
         * rather than POSTing megabytes through a proxy that may cap it. Fetch
         * it with `GET /v1/transcribe/:id` in that case.
         */
        text?: string | null
        truncated?: boolean
        characters?: number
        language?: string
        languageProbability?: number
        segmentCount?: number
        durationSeconds?: number
      }
      model?: { name?: string }
      durationMs?: number
      metadata?: Record<string, unknown> | null
    }
  | {
      event: 'transcribe.failed'
      transcribeId: string
      externalId?: string | null
      error?: { code?: string; message?: string }
      attempts?: number
    }
  | {
      event: 'transcribe.progress'
      transcribeId: string
      externalId?: string | null
      chunksDone?: number
      chunksTotal?: number
    }

interface NaturalKey {
  correlationKey: string
  eventKey: string
}

function naturalKeyFor(envelope: CallbackEnvelope): NaturalKey | null {
  switch (envelope.event) {
    case 'ingest.completed':
    case 'ingest.failed':
      return { correlationKey: envelope.ingestId, eventKey: envelope.docId }
    case 'ingest.progress':
      return { correlationKey: envelope.ingestId, eventKey: '' }
    case 'unit.completed':
    case 'unit.failed':
      return { correlationKey: envelope.requestId, eventKey: envelope.unitKey }
    case 'request.completed':
    case 'request.failed':
    case 'request.cancelled':
      return { correlationKey: envelope.requestId, eventKey: '' }
    case 'transcribe.completed':
    case 'transcribe.failed':
      // Same shape as the ingest pair: the job id plus the consumer id.
      return { correlationKey: envelope.transcribeId, eventKey: envelope.externalId ?? '' }
    case 'transcribe.progress':
      // ⚠ NOT `''`. Progress fires repeatedly for one job, and an empty
      // eventKey would collide with the terminal event's key — the first
      // progress callback would dedupe the completion away. A constant is
      // enough because progress is a no-op: deduping several of them is fine,
      // deduping the completion is data loss.
      return { correlationKey: envelope.transcribeId, eventKey: 'progress' }
    default:
      return null
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  // 1. Raw body first — anything that parses must read the bytes once.
  let rawBody: string
  try {
    rawBody = await req.text()
  } catch (err) {
    console.warn('[callback] failed to read raw body', err)
    return NextResponse.json(
      { error: 'bad_request', reason: 'unreadable_body' },
      { status: 400 },
    )
  }

  // 2. HMAC verify against the bytes-as-received.
  const verify = verifyCallbackSignature({
    rawBody,
    timestamp: req.headers.get(CALLBACK_TIMESTAMP_HEADER),
    signature: req.headers.get(CALLBACK_SIGNATURE_HEADER),
    secret: process.env.CALLBACK_SECRET,
  })
  if (!verify.ok) {
    // Don't leak which check failed — same 401 for every reason.
    console.warn('[callback] signature verify failed:', verify.reason)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // 3. Parse JSON now that we trust the body.
  let envelope: CallbackEnvelope
  try {
    envelope = JSON.parse(rawBody) as CallbackEnvelope
  } catch (err) {
    console.warn('[callback] signed body is not valid JSON', err)
    return NextResponse.json(
      { error: 'bad_request', reason: 'invalid_json' },
      { status: 400 },
    )
  }
  if (!envelope?.event || typeof envelope.event !== 'string') {
    return NextResponse.json(
      { error: 'bad_request', reason: 'missing_event' },
      { status: 400 },
    )
  }

  const key = naturalKeyFor(envelope)
  if (!key) {
    // 200 — accept-and-discard so ai-service doesn't dead-letter perfectly
    // valid events that this build doesn't yet know about.
    console.warn('[callback] unknown event type; ignoring:', envelope.event)
    return NextResponse.json({ ok: true, deduped: false, dispatched: false })
  }

  // 4. Idempotency dedupe — INSERT-ON-CONFLICT-DO-NOTHING. If create
  //    succeeds, this is a fresh event; if a unique-violation is raised,
  //    we've already processed it.
  const payload = await getPayload({ config: configPromise })
  let alreadyProcessed = false
  let dedupeRowId: number | string | null = null
  try {
    const dedupeRow = await payload.create({
      collection: 'aiServiceCallbacks',
      data: {
        correlationKey: key.correlationKey,
        eventKey: key.eventKey,
        event: envelope.event,
        receivedAt: new Date().toISOString(),
        rawBody: rawBody.length > 100_000 ? rawBody.slice(0, 100_000) : rawBody,
      },
      overrideAccess: true,
    })
    dedupeRowId = (dedupeRow as { id?: number | string } | null)?.id ?? null
  } catch (err) {
    // Distinguish "already-processed" (unique violation) from a real DB
    // error. Payload wraps PG's `23505` in a 400 ValidationError; the raw
    // drizzle error may also escape with code 23505 or a constraint name.
    const code = (err as { code?: string })?.code
    const status = (err as { status?: number })?.status
    const msg = err instanceof Error ? err.message : String(err)
    const data = (err as { data?: { errors?: Array<{ message?: string }> } })?.data
    const payloadValidationUnique =
      status === 400 &&
      (data?.errors ?? []).some((e) => /must be unique/i.test(e?.message ?? ''))
    const isUnique =
      code === '23505' ||
      msg.includes('duplicate key value') ||
      msg.includes('ai_service_callbacks_natural_key_unq') ||
      payloadValidationUnique
    if (!isUnique) {
      console.error('[callback] dedupe insert failed', err)
      return NextResponse.json(
        { error: 'internal_error', message: 'dedupe_failed' },
        { status: 500 },
      )
    }
    alreadyProcessed = true
  }

  if (alreadyProcessed) {
    return NextResponse.json({ ok: true, deduped: true, dispatched: false })
  }

  // 5. Dispatch — update the documents row by ingestId + docId.
  try {
    await dispatchCallback(payload, envelope)
  } catch (err) {
    console.error('[callback] dispatch failed; asking the sender to retry:', envelope.event, err)
    // 🔴 Forget the event, or the retry this 500 asks for is deduped away.
    if (dedupeRowId != null) {
      try {
        await payload.delete({
          collection: 'aiServiceCallbacks',
          id: dedupeRowId as never,
          overrideAccess: true,
        })
      } catch (delErr) {
        console.error(
          '[callback] could not delete the dedupe row after a failed dispatch — a retry of',
          envelope.event,
          'will be deduped and LOST',
          delErr,
        )
      }
    }
    return NextResponse.json(
      { error: 'internal_error', message: 'dispatch_failed' },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, deduped: false, dispatched: true })
}

async function dispatchCallback(
  payload: Awaited<ReturnType<typeof getPayload>>,
  envelope: CallbackEnvelope,
): Promise<void> {
  switch (envelope.event) {
    case 'ingest.completed':
    case 'ingest.failed': {
      // `docId` is the consumer-supplied id from the original ingest request —
      // we set it to the Documents row id, so the join is direct.
      const docIdRaw = envelope.docId

      /**
       * 🔴 …EXCEPT FOR A CHAT TURN, WHICH IS NOT A `documents` ROW AT ALL.
       *
       * Conversation ingest sends one document per turn under the id
       * `msg-{messageId}` (see `lib/conversationIngest.ts`). Without this branch
       * every one of those callbacks would look up a `documents` row that does
       * not exist, log "no documents row for msg-41", and leave the turn stuck
       * in `embedding` forever with nothing able to move it.
       */
      const messageId = messageIdFromExternalId(docIdRaw)
      if (messageId !== null) {
        await dispatchConversationTurn(payload, messageId, envelope)
        return
      }


      const docId = /^\d+$/.test(docIdRaw) ? Number(docIdRaw) : docIdRaw

      // Read the row FIRST: whether this callback is the original draft ingest
      // or the second half of a publish depends on which ingestId it carries,
      // and those two mean completely different things.
      const doc = await readDocument(payload, docId)
      if (!doc) return

      // 🔴 IS THIS THE PUBLISH MOVE COMPLETING? `publishIngestId` is a separate
      // column from `ingestId` precisely so these cannot be confused. If they
      // shared one, the ORIGINAL draft ingest's late `ingest.completed` would be
      // read as "the shared-corpus copy is ready" and would retire the draft
      // copy before anything was actually published.
      const isPublishMove =
        typeof doc?.publishIngestId === 'string' &&
        doc.publishIngestId.length > 0 &&
        doc.publishIngestId === envelope.ingestId

      if (isPublishMove) {
        await dispatchPublishMove(payload, doc, envelope)
        return
      }

      if (!ingestCallbackMatches(doc, envelope.ingestId)) {
        console.warn(
          '[callback] ignoring',
          envelope.event,
          'from a superseded ingest for doc',
          docIdRaw,
          envelope.ingestId,
        )
        return
      }

      /**
       * 🔴 THE INGEST COLUMNS ONLY, as one narrow `UPDATE`. A whole-row
       * `payload.update` writes every other column back as it read them, so a
       * corpus-graph status write in the same milliseconds was erased — and the
       * mirror-image race is what stranded uploads at `embedding`.
       * `lib/documentColumns.ts`.
       *
       * It also never fires `afterChange`. The whole-row write needed
       * `__skipDocsExtract` for that: without it the save re-ran
       * `runExtractAndIngest`, whose only "already enqueued" guard is
       * `ingestId`. ai-service can call back BEFORE the enqueue's own response
       * lands (measured: ~1 ms early, 3 of 4 uploads on the fake provider), so
       * the pipeline re-ran, wrote `embedding` over this `ready` and enqueued
       * the document a second time. `Documents.callbackRace.test.ts`.
       */
      const { updateDocumentColumns } = await import('@/lib/documentColumns')
      await updateDocumentColumns(payload as never, {
        id: docId,
        data:
          envelope.event === 'ingest.completed'
            ? // Clear the reason a PREVIOUS attempt failed: a retry that
              // succeeded must not keep showing the old error next to "Listo".
              { ingestStatus: 'ready', ingestError: null }
            : {
                ingestStatus: 'failed',
                ingestError: `${envelope.error?.code ?? 'ingest_failed'}: ${
                  envelope.error?.message ?? 'ai-service reported a failure'
                }`.slice(0, 500),
              },
      })
      if (envelope.event === 'ingest.failed') {
        console.warn(
          '[callback] ingest.failed for doc',
          docIdRaw,
          envelope.error ?? '<no error payload>',
        )
      }
      // A failed write throws to `POST`, which answers 500 so the sender retries.
      return
    }
    case 'ingest.progress':
      // No-op — we don't track per-doc batch progress in the UI yet.
      return
    case 'transcribe.completed':
      await dispatchTranscribeCompleted(payload, envelope)
      return
    case 'transcribe.failed': {
      const docId = documentIdFrom(envelope.externalId)
      if (docId === null) {
        console.warn('[callback] transcribe.failed with no usable externalId', envelope.transcribeId)
        return
      }
      const doc = await readDocument(payload, docId)
      if (!doc) return
      // Same stale-attempt guard as the completed path. A `failed` from an
      // abandoned earlier attempt must not knock over a retry that is running.
      if (!transcribeIdMatches(doc, envelope.transcribeId)) {
        console.warn(
          '[callback] ignoring transcribe.failed from a superseded job for doc',
          docId,
          envelope.transcribeId,
        )
        return
      }
      const code = envelope.error?.code ?? 'transcription_failed'
      const message = envelope.error?.message ?? 'audio-service reported a failure'
      console.warn('[callback] transcription failed for doc', docId, code, message)
      await payload.update({
        collection: 'documents',
        id: docId as never,
        // ⚠ `failed` + a REASON, never a silent revert to `pending`. The user is
        // shown the reason and offered POST /api/documents/:id/retry; a row that
        // quietly went back to "queued" would look like it was still working.
        data: { ingestStatus: 'failed', ingestError: `${code}: ${message}`.slice(0, 500) },
        overrideAccess: true,
        context: { __skipDocsExtract: true },
      })
      return
    }
    case 'transcribe.progress':
      // No-op, exactly like `ingest.progress`.
      //
      // ⚠ Deliberate: a progress BAR that advances once every ten minutes is
      // worse than an honest indeterminate state plus a realistic ETA, and the
      // ETA we already have — `audioMeta.durationSeconds`, recorded at submit
      // time — is the better number to show. Revisit only if the UI grows a
      // genuine per-chunk display.
      return
    default:
      // Generate events arrive accepted-and-deduped; no chat-side write path
      // exists yet (chat uses generate.sync, not generate.enqueue).
      return
  }
}


/**
 * A chat turn's ingest finished (or did not). Move the `messages` row.
 *
 * ⚠ `__skipConversationIngest` on the write, or this status update re-fires the
 * afterChange hook that starts a whole ingest run — and each run can cost model
 * calls for the anonymisation gate.
 *
 * A `failed` turn goes back into the runnable set, so the next message in that
 * conversation retries it. Nothing polls; the retry rides along with normal use,
 * which is the right cadence for something nobody is waiting on.
 */
async function dispatchConversationTurn(
  payload: Awaited<ReturnType<typeof getPayload>>,
  messageId: number | string,
  envelope: Extract<CallbackEnvelope, { event: 'ingest.completed' | 'ingest.failed' }>,
): Promise<void> {
  /**
   * 🔴 IS THIS CALLBACK ABOUT THE RUN THE ROW IS ACTUALLY WAITING FOR?
   *
   * The same guard the audio path has (`transcribeIdMatches`), for the same
   * reason. A turn can be enqueued more than once — a `failed` turn goes back
   * into the runnable set and the next message in the thread retries it — and
   * both runs' callbacks carry the same `msg-{id}`. Without this check a late
   * callback from the SUPERSEDED run can mark a turn `failed` while the retry
   * is succeeding, or claim `ingested` for a run that never landed.
   *
   * ⚠ A row with no `corpusIngestId` accepts nothing: it has not enqueued
   * anything, so no callback can be about it.
   */
  const row = (await payload
    .findByID({ collection: 'messages', id: messageId as never, depth: 0, overrideAccess: true })
    .catch(rethrowUnlessNotFound)) as { corpusIngestId?: unknown } | null

  if (!row || typeof row.corpusIngestId !== 'string' || row.corpusIngestId !== envelope.ingestId) {
    console.warn(
      '[callback] ignoring an ingest callback from a superseded run for message',
      messageId,
      envelope.ingestId,
    )
    return
  }

  const data =
    envelope.event === 'ingest.completed'
      ? ({ corpusStatus: 'ingested', corpusError: null } as const)
      : ({
          corpusStatus: 'failed',
          // Cleared so the next run's guard cannot be satisfied by a stale id.
          corpusIngestId: null,
          corpusError: `${envelope.error?.code ?? 'ingest_failed'}: ${
            envelope.error?.message ?? 'ai-service reported a failure'
          }`.slice(0, 500),
        } as const)
  // A failed write throws to `POST`, which answers 500 so the sender retries.
  await payload.update({
    collection: 'messages',
    id: messageId as never,
    data,
    overrideAccess: true,
    context: { __skipConversationIngest: true },
  })
}

/** The slice of a documents row the callback dispatcher reasons about. */
interface DocumentSnapshot {
  id: number | string
  organization?: unknown
  uploadedBy?: unknown
  publicationStatus?: unknown
  publishIngestId?: unknown
  kind?: unknown
  /**
   * What the material IS, as opposed to the file format. `lib/contentKind.ts`.
   * ⚠ Also the corpus graph's person rule keys off it — see `lib/graph/`.
   */
  contentKind?: unknown
  /** `documents.lengua`, for the retrieval filter. Null on anything but a documento. */
  lengua?: unknown
  name?: unknown
  extractedText?: unknown
  redactedText?: unknown
  /**
   * 🔴 Read so the ingest can honour a `held` / `rejected` / `approved` row —
   * see `enqueueIngestForDoc`. Without it a replayed callback re-gated a
   * rejected testimony.
   */
  anonymisationStatus?: unknown
  ingestStatus?: unknown
  ingestId?: unknown
  transcribeId?: unknown
}

/**
 * 🔴 IS THIS `ingest.completed` / `ingest.failed` ABOUT THE INGEST THE ROW IS
 * WAITING FOR? The document twin of `transcribeIdMatches`.
 *
 * A retry clears `ingestId` and enqueues again; the old run's callback carries
 * the same `docId`. Without this check a late `failed` from the superseded run
 * fails a row whose retry is succeeding, and a late `completed` marks `ready` a
 * row whose current ingest has not landed.
 *
 * Accepted when the ids match, OR when the row has no `ingestId` yet and is
 * `embedding`. The second case is the callback-before-ingestId race (commit
 * 7bf0622, `Documents.callbackRace.test.ts`): ai-service can call back before
 * the enqueue's response lets us store the id.
 *
 * ⚠ The second case cannot tell the current run from a superseded one inside
 * that window. It is milliseconds wide, and closing it needs an id minted
 * before the enqueue, which ai-service does not take.
 */
function ingestCallbackMatches(doc: DocumentSnapshot, ingestId: string): boolean {
  if (typeof doc.ingestId === 'string' && doc.ingestId.length > 0) return doc.ingestId === ingestId
  return doc.ingestStatus === 'embedding'
}

/**
 * A "no such row" is permanent: answer 200 and drop the event. Anything else
 * (the database is down) is transient and must reach `POST` as a 500.
 */
function rethrowUnlessNotFound(err: unknown): null {
  const status = (err as { status?: number })?.status
  if (status === 404 || (err as { name?: string })?.name === 'NotFound') return null
  throw err
}

// ---------------------------------------------------------------------------
// audio-service → documents
// ---------------------------------------------------------------------------

/**
 * The `documents` row id an audio callback names.
 *
 * ⚠ `externalId` is ECHOED BACK BY audio-service, which means it is data we
 * sent, round-tripped through another service. It names a row; it proves
 * nothing about ownership. Everything about who owns the document — the
 * ecosistema, the uploader, and therefore the corpus — is read from the ROW,
 * never from the envelope. audio-service's echo of `metadata.organizationId` is
 * for log correlation and is deliberately not consulted anywhere below.
 */
function documentIdFrom(externalId: string | null | undefined): string | number | null {
  const raw = typeof externalId === 'string' ? externalId.trim() : ''
  if (!raw) return null
  return /^\d+$/.test(raw) ? Number(raw) : raw
}

async function readDocument(
  payload: Awaited<ReturnType<typeof getPayload>>,
  docId: string | number,
): Promise<DocumentSnapshot | null> {
  try {
    return (await payload.findByID({
      collection: 'documents',
      id: docId as never,
      depth: 0,
      overrideAccess: true,
    })) as unknown as DocumentSnapshot
  } catch (err) {
    rethrowUnlessNotFound(err)
    console.error('[callback] no documents row for', docId, err)
    return null
  }
}

/**
 * 🔴 IS THIS CALLBACK ABOUT THE JOB THE ROW IS ACTUALLY WAITING FOR?
 *
 * A retry mints a NEW audio-service job while the old one may still be alive
 * (audio-service's retry schedule runs out past ten minutes, and its reconciler
 * emits a terminal event for jobs nobody is watching). Both callbacks carry the
 * same `externalId`. Without this check a late event from the superseded
 * attempt could overwrite a good transcript, or fail a row that is succeeding.
 *
 * A row with no `transcribeId` at all accepts nothing: it never started a job,
 * so any callback claiming to be its is not.
 */
function transcribeIdMatches(doc: DocumentSnapshot, transcribeId: string): boolean {
  return typeof doc.transcribeId === 'string' && doc.transcribeId === transcribeId
}

/**
 * 🔴 PERSIST THE TRANSCRIPT, WRITE `transcribed`, AND STOP.
 *
 * The transcript becomes `extractedText`. The anonymisation gate (two model
 * calls) and the ingest enqueue used to run here, inside a webhook request
 * audio-service abandons after 20 s. They now run in
 * `lib/ingestRecovery.ts:driveTranscribedDocuments`, which calls the SAME
 * `enqueueIngestForDoc` an uploaded PDF goes through — so the transcript still
 * lands in the uploader's PRIVATE draft corpus, resolved from the row.
 */
async function dispatchTranscribeCompleted(
  payload: Awaited<ReturnType<typeof getPayload>>,
  envelope: Extract<CallbackEnvelope, { event: 'transcribe.completed' }>,
): Promise<void> {
  const docId = documentIdFrom(envelope.externalId)
  if (docId === null) {
    console.warn('[callback] transcribe.completed with no usable externalId', envelope.transcribeId)
    return
  }

  const doc = await readDocument(payload, docId)
  if (!doc) return
  if (!transcribeIdMatches(doc, envelope.transcribeId)) {
    console.warn(
      '[callback] ignoring transcribe.completed from a superseded job for doc',
      docId,
      envelope.transcribeId,
    )
    return
  }

  // ⚠ Idempotency guard, because the `aiServiceCallbacks` composite UNIQUE index
  // DOES NOT EXIST yet (no migration baseline), so the dedupe insert upstream is
  // currently inert. Text on the row plus an ingestId means this already ran;
  // running it again would enqueue a second ingest for the same document.
  //
  // ⚠ And a row that has left `transcribing` with its text on it: the
  // transcript is already persisted, and `transcribed` is now a resting state
  // the sweep picks up, so an ingestId alone no longer marks "done".
  const hasText = typeof doc.extractedText === 'string' && doc.extractedText.trim().length > 0
  const alreadyDone =
    hasText &&
    ((typeof doc.ingestId === 'string' && doc.ingestId.length > 0) ||
      (typeof doc.ingestStatus === 'string' && doc.ingestStatus !== 'transcribing'))
  if (alreadyDone) {
    console.warn('[callback] transcribe.completed already applied to doc', docId, '— ignoring')
    return
  }

  let text = typeof envelope.transcript?.text === 'string' ? envelope.transcript.text : ''
  if (!text.trim()) {
    // Either the transcript was truncated out of the webhook body (over
    // CALLBACK_MAX_TRANSCRIPT_CHARS) or nothing was said. Ask before deciding.
    const { fetchTranscriptText } = await import('@/lib/audioClient')
    text = (await fetchTranscriptText(envelope.transcribeId)) ?? ''
  }

  const audioMeta = {
    durationSeconds:
      envelope.audio?.durationSeconds ?? envelope.transcript?.durationSeconds ?? null,
    language: envelope.transcript?.language ?? null,
    languageProbability: envelope.transcript?.languageProbability ?? null,
    segmentCount: envelope.transcript?.segmentCount ?? null,
    model: envelope.model?.name ?? null,
    chunks: envelope.audio?.chunks ?? null,
  }

  if (!text.trim()) {
    // A recording with no speech in it, or a transcript that expired from
    // audio-service's Redis before we could fetch it. Either way there is
    // nothing to embed, and an empty ingest would produce a `ready` document
    // that matches nothing — a silent, permanent "why does search never find
    // it". Fail it visibly instead.
    console.warn('[callback] empty transcript for doc', docId, envelope.transcribeId)
    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: {
        ingestStatus: 'failed',
        ingestError: 'empty_transcript: no speech was detected in the recording',
        audioMeta,
      },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
    return
  }

  // The resting state `lib/ingestRecovery.ts` drives from: the text exists and
  // nothing has been embedded. A write that throws reaches `POST` as a 500.
  await payload.update({
    collection: 'documents',
    id: docId as never,
    data: {
      extractedText: text,
      audioMeta,
      ingestStatus: 'transcribed',
      ingestError: null,
    },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })
}

/**
 * 🔴 THE SECOND HALF OF A PUBLISH (or an unpublish), driven by ai-service
 * confirming that the re-embed finished.
 *
 * ⚠ THE ORDERING RULE LIVES IN `lib/publishDocument.ts` AND MUST NOT BE
 * SHORT-CIRCUITED HERE. On a successful PUBLISH, the draft copy is retired only
 * now — after the shared-corpus ingest is confirmed — and the row flips to
 * `published` only after that retire succeeds. A crash anywhere in between
 * leaves the document in `publishing`: still in the draft corpus, still visible
 * to its uploader, still retryable. The failure mode is a duplicate, never a
 * disappearance.
 *
 * On FAILURE the status deliberately stays at the in-flight value with
 * `publicationError` populated. Rolling back to `draft` would hide the problem —
 * the row would look untouched while a half-finished copy sat in the shared
 * corpus.
 */
async function dispatchPublishMove(
  payload: Awaited<ReturnType<typeof getPayload>>,
  doc: DocumentSnapshot,
  envelope: Extract<CallbackEnvelope, { event: 'ingest.completed' | 'ingest.failed' }>,
): Promise<void> {
  const { confirmPublish, confirmUnpublish, failPublish } = await import('@/lib/publishDocument')
  const wasPublishing = doc.publicationStatus === 'publishing'

  if (envelope.event === 'ingest.failed') {
    const reason =
      typeof envelope.error === 'string' ? envelope.error : JSON.stringify(envelope.error ?? {})
    console.error(
      '[callback] the re-embed for doc',
      doc.id,
      'failed; leaving it in',
      String(doc.publicationStatus),
      'so it stays visible and retryable:',
      reason,
    )
    await failPublish(doc as never, { payload }, reason)
    return
  }

  try {
    if (wasPublishing) {
      // ⚠ ADMIN client: retiring a copy is `setDocumentValidity`, an admin-role
      // route. If we cannot get one, the document stays `publishing` — present
      // in BOTH corpora, which is duplicated content rather than lost content,
      // and is retryable.
      const { getAdminAIClient } = await import('@/lib/aiClient')
      // The draft copy lives in the document's ecosistema org. A row with no
      // ecosistema throws here and stays `publishing` — retryable, never lost.
      const organizationId = relationId(doc.organization)
      if (organizationId == null) throw new Error('document has no ecosistema')
      await confirmPublish(doc as never, {
        payload,
        client: getAdminAIClient(organizationId) as never,
      })

      /**
       * 🔴 THE RELEASE, AND THIS IS THE ONLY PLACE IT CAN CORRECTLY HAPPEN.
       *
       * The owner's rule: a conversation citing unpublished drafts is held, and
       * when the LAST of those drafts is published the whole conversation goes
       * in one run. "Published" means the shared-corpus copy is CONFIRMED —
       * which is here, not at the `POST /publish` that merely enqueued it.
       * Releasing at the endpoint would put chat turns in the ecosistema's
       * corpus citing a document whose re-embed had not landed and might fail.
       *
       * ⚠ AFTER `confirmPublish`, never before: `releaseConversationsWaitingOn`
       * re-reads `publicationStatus` to decide, and the flip to `published`
       * happens inside that call.
       *
       * Never throws — a conversation that could not be embedded must not turn a
       * successful publish into an error the user cannot act on.
       */
      const { releaseConversationsWaitingOn } = await import('@/lib/conversationIngest')
      const { getAppAIClient } = await import('@/lib/aiClient')
      const { ingestCallbackUrl } = await import('@/lib/callbackConfig')
      try {
        await releaseConversationsWaitingOn({
          payload,
          documentId: doc.id,
          // 🔴 A resolver, not one client: the held conversations this walks
          // belong to every ecosistema, each to its own ai-service org.
          client: ((organizationId: number | string) => getAppAIClient(organizationId)) as never,
          ...(ingestCallbackUrl() ? { callbackUrl: ingestCallbackUrl() as string } : {}),
        })
      } catch (err) {
        console.warn('[callback] conversation release failed for doc', doc.id, err)
      }
    } else {
      // Unpublish already retired the shared copy before this re-ingest was
      // enqueued, so there is nothing left to retire — just record the state.
      await confirmUnpublish(doc as never, { payload })
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error('[callback] could not finish the publish move for doc', doc.id, err)
    await failPublish(doc as never, { payload }, reason)
  }
}

// Avoid Next.js trying to cache or static-render this route.
export const dynamic = 'force-dynamic'
