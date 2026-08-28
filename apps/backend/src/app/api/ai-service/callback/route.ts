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
 *   - 500 — only on truly internal failures (dedupe insert blows up).
 *           Triggers ai-service's exponential-backoff retry schedule.
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
  try {
    await payload.create({
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
    console.error('[callback] dispatch failed (no consumer-side retry):', envelope.event, err)
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
      let doc: DocumentSnapshot | null = null
      try {
        doc = (await payload.findByID({
          collection: 'documents',
          id: docId as never,
          depth: 0,
          overrideAccess: true,
        })) as unknown as DocumentSnapshot
      } catch (err) {
        console.error('[callback] no documents row for', docIdRaw, err)
        return
      }

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

      try {
        await payload.update({
          collection: 'documents',
          id: docId as never,
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
          overrideAccess: true,
        })
        if (envelope.event === 'ingest.failed') {
          console.warn(
            '[callback] ingest.failed for doc',
            docIdRaw,
            envelope.error ?? '<no error payload>',
          )
        }
      } catch (err) {
        console.error(
          '[callback] failed to update documents row',
          docIdRaw,
          'for',
          envelope.event,
          err,
        )
      }
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
    .catch(() => null)) as { corpusIngestId?: unknown } | null

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
  try {
    await payload.update({
      collection: 'messages',
      id: messageId as never,
      data,
      overrideAccess: true,
      context: { __skipConversationIngest: true },
    })
  } catch (err) {
    console.error('[callback] could not update messages row', messageId, err)
  }
}

/** The slice of a documents row the callback dispatcher reasons about. */
interface DocumentSnapshot {
  id: number | string
  organization?: unknown
  uploadedBy?: unknown
  publicationStatus?: unknown
  publishIngestId?: unknown
  kind?: unknown
  /** What the material IS, as opposed to the file format. `lib/contentKind.ts`. */
  contentKind?: unknown
  name?: unknown
  extractedText?: unknown
  redactedText?: unknown
  /**
   * 🔴 Read so the ingest can honour a `held` / `rejected` / `approved` row —
   * see `enqueueIngestForDoc`. Without it a replayed callback re-gated a
   * rejected testimony.
   */
  anonymisationStatus?: unknown
  ingestId?: unknown
  transcribeId?: unknown
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
 * 🔴 THE JOIN BACK INTO THE EXISTING PIPELINE. This is the whole point of the
 * audio work: the transcript becomes `extractedText`, and then the SAME
 * `enqueueIngestForDoc` that an uploaded PDF goes through is called, unchanged.
 *
 * It resolves `draftCorpus(organizationId, uploadedById)` itself from the row —
 * so the transcript lands in the uploader's PRIVATE draft corpus and becomes
 * shared only if the document is deliberately published. We pass no corpus name
 * of our own; `lib/corpus.ts` is the only place one is derived, and it says so.
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
  const alreadyDone =
    typeof doc.extractedText === 'string' &&
    doc.extractedText.trim().length > 0 &&
    typeof doc.ingestId === 'string' &&
    doc.ingestId.length > 0
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

  // `transcribed` before `embedding`: if the process dies between these two
  // writes the row stops in a state that is TRUE — the text exists, nothing has
  // been embedded — and `POST /api/documents/:id/retry` picks it up from there
  // without re-transcribing.
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

  const organizationId = relationId(doc.organization)
  const uploadedById = relationId(doc.uploadedBy)
  if (organizationId == null || uploadedById == null) {
    // No ecosistema or no uploader means no corpus name can be derived. Refuse
    // rather than guess: a guessed corpus is a cross-tenant write.
    console.error(
      '[callback] doc',
      docId,
      'has no organization/uploadedBy — cannot derive a corpus for the transcript',
    )
    await payload.update({
      collection: 'documents',
      id: docId as never,
      data: {
        ingestStatus: 'failed',
        ingestError: 'no_tenant: the document has no ecosistema or uploader, so it has no corpus',
      },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
    return
  }

  const { enqueueIngestForDoc } = await import('@/collections/Documents')
  await enqueueIngestForDoc({
    payload,
    docId,
    organizationId,
    uploadedById,
    fresh: {
      name: typeof doc.name === 'string' ? doc.name : null,
      kind: typeof doc.kind === 'string' ? doc.kind : 'audio',
      /**
       * 🔴 CARRIED, NOT DEFAULTED. A Voz is normally a recording, so the audio
       * path is the one a `testimonio` actually takes. Dropping `contentKind`
       * here would let every testimony skip the anonymisation gate — the gate
       * runs inside `enqueueIngestForDoc` and decides on this field — while the
       * PDF path stayed correct and nothing looked wrong.
       */
      contentKind: typeof doc.contentKind === 'string' ? doc.contentKind : null,
      /**
       * 🔴 CARRIED FOR THE SAME REASON AS `contentKind`, AND IT USED TO BE
       * MISSING.
       *
       * `enqueueIngestForDoc` refuses a `held` or `rejected` row and honours an
       * `approved` one. Omitting these two fields made every one of those
       * decisions invisible on the audio path — so a replayed
       * `transcribe.completed` re-gated a rejected testimony and threw away an
       * approved reviewer's text. The keys are required by the type now, so this
       * cannot silently regress again.
       */
      anonymisationStatus: typeof doc.anonymisationStatus === 'string' ? doc.anonymisationStatus : null,
      redactedText: typeof doc.redactedText === 'string' ? doc.redactedText : null,
    },
    extractedText: text,
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
      await confirmPublish(doc as never, { payload, client: getAdminAIClient() as never })

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
          client: getAppAIClient() as never,
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
