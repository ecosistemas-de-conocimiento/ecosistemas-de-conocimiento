/**
 * PUBLISHING — moving a document between the uploader's private draft corpus
 * and the ecosistema's shared one.
 *
 * ── WHY THIS IS AN ASYNCHRONOUS STATE MACHINE AND NOT A BUTTON HANDLER ───────
 *
 * Isolation is by CORPUS NAME (see `lib/corpus.ts`), so a document cannot be
 * "moved" — it has to be RE-EMBEDDED into the other corpus. That is slow, costs
 * tokens, and can fail. Worse, ai-service embeds asynchronously and reports
 * completion through a webhook, so the operation genuinely spans two requests.
 * Anything modelled as a synchronous handler would either block for minutes or
 * lie about having finished.
 *
 * ── 🔴 THE ORDERING RULE, AND WHY THE TWO DIRECTIONS DIFFER ──────────────────
 *
 * PUBLISH:   ingest into the shared corpus, WAIT for confirmation, THEN retire
 *            from the draft corpus.
 * UNPUBLISH: retire from the shared corpus FIRST, then ingest into the draft.
 *
 * They are deliberately not mirror images, because they are protecting
 * different things:
 *
 *   · Publishing risks LOSING the document from retrieval. A crash between the
 *     two steps must leave it still readable as a draft, never vanished. So the
 *     draft copy is the last thing to go.
 *   · Unpublishing risks LEAKING it. "Stop sharing this" that leaves the
 *     document retrievable by the whole ecosistema for another minute while we
 *     re-embed is exactly the wrong failure. So the shared copy is the first
 *     thing to go.
 *
 * Neither direction can lose the document itself: `documents.extractedText`
 * lives in Postgres, so any re-ingest is replayable from local data. What is at
 * stake is which corpus can find it, and for how long.
 *
 * ── 🔴 THE PRIMITIVE WE DO NOT HAVE ──────────────────────────────────────────
 *
 * `@edc/ai-client` has NO per-document corpus delete. It offers
 * `admin.deleteCorpus(name)` — the whole corpus, far too blunt — and
 * `admin.setDocumentValidity(corpus, externalId, { validTo })`, which retires a
 * document by closing its validity window.
 *
 * So "delete it from the draft corpus" is implemented as "stamp `validTo` =
 * now". That is the intended primitive, and it has a CONSUMER-SIDE CONDITION:
 *
 *   ⚠ RETRIEVAL MUST PASS `asOf`. A retrieve that omits it may not apply the
 *   validity window at all, and a retired document would keep coming back.
 *   `retrievalOptionsFor()` below is the single place that says so; anything
 *   that calls `retrieveMulti` must spread it.
 *
 * This is the weakest link in the design and it is worth knowing about rather
 * than discovering. If ai-service ever grows a real per-document delete, this
 * file is the only place that changes.
 */

import type { Payload } from 'payload'

import { draftCorpus, publishedCorpus } from './corpus'

/**
 * The publication states a document can be in.
 *
 * ⚠ ONLY `published` IS SHARED. Everything else — including the two in-flight
 * states — is visible to the uploader alone. That is what makes a crash safe:
 * a document stuck mid-transition is never accidentally exposed, it is only
 * temporarily not-yet-shared.
 */
export const PUBLICATION_STATES = ['draft', 'publishing', 'published', 'unpublishing'] as const

export type PublicationState = (typeof PUBLICATION_STATES)[number]

/** ⚠ The one predicate that decides "can anyone else in the ecosistema see this?" */
export function isSharedWithEcosystem(state: unknown): boolean {
  return state === 'published'
}

/**
 * ⚠ SPREAD THIS INTO EVERY `retrieve` / `retrieveMulti` CALL.
 *
 * Retirement is implemented as a closed validity window (see the header), so a
 * retrieve that does not pin a point in time may ignore it and keep returning
 * documents that were unpublished or already promoted out of drafts.
 *
 * `asOf` is "now" rather than a stored timestamp on purpose: the question a
 * chat turn asks is "what is in this corpus right now", and any fixed value
 * would eventually drift into showing retired content again.
 */
export function retrievalOptionsFor(now: Date = new Date()): { asOf: string } {
  return { asOf: now.toISOString() }
}

/** Just enough of a document row to move it between corpora. */
export interface PublishableDocument {
  id: number | string
  name?: string | null
  kind?: string | null
  extractedText?: string | null
  organization?: unknown
  uploadedBy?: unknown
  publicationStatus?: unknown
}

export class NotPublishableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotPublishableError'
  }
}

type Ids = { organizationId: number | string; userId: number | string }

function idsOf(doc: PublishableDocument): Ids {
  const organizationId = plainId(doc.organization)
  const userId = plainId(doc.uploadedBy)
  if (organizationId === null) {
    throw new NotPublishableError('This document is not attached to an ecosistema.')
  }
  if (userId === null) {
    throw new NotPublishableError('This document has no uploader, so it has no draft corpus.')
  }
  return { organizationId, userId }
}

function plainId(value: unknown): number | string | null {
  if (typeof value === 'number' || (typeof value === 'string' && value !== '')) return value
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'number' || typeof id === 'string') return id
  }
  return null
}

/** Minimal slice of the ai-service client these transitions use. */
export interface CorpusMover {
  ingest: {
    enqueue(req: {
      corpus: string
      documents: Array<{ id: string; text: string; title: string; metadata?: Record<string, unknown> }>
      callbackUrl?: string
    }): Promise<{ ingestId: string }>
  }
  admin: {
    setDocumentValidity(
      corpus: string,
      externalId: string,
      bounds: { validFrom?: string | null; validTo?: string | null },
    ): Promise<unknown>
  }
}

/**
 * Retire a document from a corpus: close its validity window at `now`.
 *
 * ⚠ NOT A DELETE. The chunks stay in the corpus and stay embedded; they simply
 * fall outside the window a retrieval with `asOf` will consider. Two
 * consequences worth stating: storage is not reclaimed, and a retrieval that
 * forgets `asOf` still sees the document. See the file header.
 */
async function retireFrom(
  client: CorpusMover,
  corpus: string,
  documentId: number | string,
  now: Date,
): Promise<void> {
  await client.admin.setDocumentValidity(corpus, String(documentId), {
    validTo: now.toISOString(),
  })
}

/** What a transition that only writes the row needs. */
export interface RowDeps {
  payload: Payload
}

/** What a transition that also moves chunks needs. */
export interface TransitionDeps extends RowDeps {
  client: CorpusMover
  /** Absolute callback URL, or undefined when callbacks are not configured. */
  callbackUrl?: string
  now?: () => Date
}

/**
 * STEP 1 OF PUBLISHING. Enqueue the document into the ecosistema's shared
 * corpus and mark it `publishing`.
 *
 * ⚠ IT DOES NOT TOUCH THE DRAFT CORPUS. That happens in
 * {@link confirmPublish}, driven by the ai-service callback, and only once the
 * shared-corpus ingest is confirmed complete. A crash anywhere in between
 * leaves the document in `publishing` — still in the draft corpus, still
 * readable by its uploader, and still retryable by calling this again.
 *
 * ⚠ Requires `extractedText`. A document whose extraction never finished cannot
 * be re-embedded, and enqueueing an empty body would publish a document that
 * matches nothing — a silent, permanent "why does search never find it".
 */
export async function beginPublish(
  doc: PublishableDocument,
  deps: TransitionDeps,
): Promise<{ ingestId: string; corpus: string }> {
  const { organizationId } = idsOf(doc)
  const text = typeof doc.extractedText === 'string' ? doc.extractedText.trim() : ''
  if (!text) {
    throw new NotPublishableError(
      'This document has no extracted text yet, so it cannot be published. Wait for ingestion to finish, or re-upload it.',
    )
  }

  const corpus = publishedCorpus(organizationId)

  await deps.payload.update({
    collection: 'documents',
    id: doc.id as never,
    data: { publicationStatus: 'publishing', publicationError: null },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })

  const result = await deps.client.ingest.enqueue({
    corpus,
    documents: [
      {
        id: String(doc.id),
        text,
        title: doc.name ?? 'Untitled document',
        metadata: {
          docId: String(doc.id),
          organizationId: String(organizationId),
          kind: doc.kind ?? 'unknown',
          publication: 'published',
        },
      },
    ],
    ...(deps.callbackUrl ? { callbackUrl: deps.callbackUrl } : {}),
  })

  await deps.payload.update({
    collection: 'documents',
    id: doc.id as never,
    // ⚠ Stored on its OWN field, not on `ingestId`. `ingestId` belongs to the
    // original draft ingest, and overwriting it would make the two callbacks
    // indistinguishable — the draft's late `ingest.completed` would be read as
    // "publish confirmed" and retire the draft copy early.
    data: { publishIngestId: result.ingestId },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })

  return { ingestId: result.ingestId, corpus }
}

/**
 * STEP 2 OF PUBLISHING, driven by the `ingest.completed` callback.
 *
 * 🔴 THE ORDER HERE IS THE WHOLE SAFETY PROPERTY. The draft copy is retired
 * only after the shared-corpus ingest has been confirmed, and the row is
 * flipped to `published` only after that. If the retire call throws, the
 * document stays `publishing`: readable by its uploader, present in both
 * corpora, and retryable. The failure is duplicated content, never lost
 * content.
 */
export async function confirmPublish(
  doc: PublishableDocument,
  deps: Omit<TransitionDeps, 'callbackUrl'>,
): Promise<void> {
  const { organizationId, userId } = idsOf(doc)
  const now = (deps.now ?? (() => new Date()))()

  await retireFrom(deps.client, draftCorpus(organizationId, userId), doc.id, now)

  await deps.payload.update({
    collection: 'documents',
    id: doc.id as never,
    data: { publicationStatus: 'published', publicationError: null, publishIngestId: null },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })
}

/**
 * The publish failed at ai-service. Record it on the row so it is VISIBLE and
 * retryable rather than silently stuck.
 *
 * ⚠ Status stays `publishing`, not `draft`. Rolling back to `draft` would hide
 * the failure — the document would look untouched while a half-finished copy
 * sat in the shared corpus. `publishing` + a populated `publicationError` reads
 * as "this tried and did not make it", which is the truth and is what a retry
 * button should key off.
 */
export async function failPublish(
  doc: PublishableDocument,
  deps: RowDeps,
  reason: string,
): Promise<void> {
  await deps.payload.update({
    collection: 'documents',
    id: doc.id as never,
    data: { publicationError: reason.slice(0, 500) },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })
}

/**
 * UNPUBLISHING — the mirror, with the opposite ordering. See the header.
 *
 * Retire from the shared corpus FIRST so "stop sharing this" takes effect
 * immediately, then re-embed into the uploader's drafts. If the second half
 * fails the document is `unpublishing` with an error recorded: no longer shared
 * (which is what was asked for), not yet back in drafts, and retryable.
 *
 * ⚠ This is cheap to offer only because it reuses the publish machinery. It is
 * still a full re-embed and costs the same tokens as publishing did.
 */
export async function unpublish(
  doc: PublishableDocument,
  deps: TransitionDeps,
): Promise<{ ingestId: string; corpus: string }> {
  const { organizationId, userId } = idsOf(doc)
  const text = typeof doc.extractedText === 'string' ? doc.extractedText.trim() : ''
  if (!text) {
    throw new NotPublishableError(
      'This document has no extracted text, so it cannot be moved back to drafts.',
    )
  }
  const now = (deps.now ?? (() => new Date()))()

  await deps.payload.update({
    collection: 'documents',
    id: doc.id as never,
    data: { publicationStatus: 'unpublishing', publicationError: null },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })

  // 🔴 Sharing stops HERE, before anything slow happens.
  await retireFrom(deps.client, publishedCorpus(organizationId), doc.id, now)

  const corpus = draftCorpus(organizationId, userId)
  const result = await deps.client.ingest.enqueue({
    corpus,
    documents: [
      {
        id: String(doc.id),
        text,
        title: doc.name ?? 'Untitled document',
        metadata: {
          docId: String(doc.id),
          organizationId: String(organizationId),
          kind: doc.kind ?? 'unknown',
          publication: 'draft',
        },
      },
    ],
    ...(deps.callbackUrl ? { callbackUrl: deps.callbackUrl } : {}),
  })

  await deps.payload.update({
    collection: 'documents',
    id: doc.id as never,
    data: { publishIngestId: result.ingestId },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })

  return { ingestId: result.ingestId, corpus }
}

/** Completion of the unpublish re-ingest: the document is a draft again. */
export async function confirmUnpublish(
  doc: PublishableDocument,
  deps: RowDeps,
): Promise<void> {
  await deps.payload.update({
    collection: 'documents',
    id: doc.id as never,
    data: { publicationStatus: 'draft', publicationError: null, publishIngestId: null },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })
}
