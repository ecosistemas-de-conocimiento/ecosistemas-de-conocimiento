/**
 * POST /api/ai-service/callback — receiver for ai-service webhook callbacks.
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
          data: { ingestStatus: envelope.event === 'ingest.completed' ? 'ready' : 'failed' },
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
    default:
      // Generate events arrive accepted-and-deduped; no chat-side write path
      // exists yet (chat uses generate.sync, not generate.enqueue).
      return
  }
}


/** The slice of a documents row the callback dispatcher reasons about. */
interface DocumentSnapshot {
  id: number | string
  organization?: unknown
  uploadedBy?: unknown
  publicationStatus?: unknown
  publishIngestId?: unknown
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
