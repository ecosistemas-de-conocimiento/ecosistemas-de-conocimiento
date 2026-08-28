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

import { isRateLimited, withRateLimitRetry, type RetryOptions } from './aiRetry'
import { corpusTextFor } from './anonymiseDocument'
import { chunkMetadata, contentKindOf, titleFor } from './contentKind'
import { draftCorpus, publishedCorpus } from './corpus'

/**
 * The publication states a document can be in.
 *
 * ⚠ ONLY `published` IS SHARED. Everything else — including the two in-flight
 * states — is visible to the uploader alone. That is what makes a crash safe:
 * a document stuck mid-transition is never accidentally exposed, it is only
 * temporarily not-yet-shared.
 */
/**
 * Postgres text-search config for a corpus created by the publish move — a
 * `regconfig` name, not a locale code.
 *
 * 🔴 PUBLISHING IS USUALLY WHAT CREATES THE SHARED CORPUS. A draft lives in
 * `eco-{org}-draft-{user}`; the first publish in an ecosistema is typically the
 * first thing ever written to `eco-{org}`. So omitting this here is what would
 * leave the SHARED corpus — the one every colleague searches — with no
 * stemming, even though every draft corpus had it.
 *
 * Kept in step with the same constant in `collections/Documents.ts`, and read
 * from the same env var so a deployment cannot set one and not the other.
 */
const CORPUS_LANGUAGE = process.env.CORPUS_LANGUAGE?.trim() || 'spanish'

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
  /** The FILE FORMAT — pdf/docx/audio/markdown. Not what the material is. */
  kind?: string | null
  /** What the material IS. See `lib/contentKind.ts`. */
  contentKind?: string | null
  extractedText?: string | null
  /** The anonymisation gate's output. What a gated document is embedded from. */
  redactedText?: string | null
  /**
   * 🔴 REQUIRED FOR GATED CONTENT. `corpusTextFor` refuses anything that is not
   * `ready` or `approved`, because a non-empty `redactedText` alone is not proof
   * the row cleared the gate — it can be left over from an earlier run that did.
   */
  anonymisationStatus?: string | null
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
      /** Postgres `regconfig` for a corpus created by THIS call. See CORPUS_LANGUAGE. */
      language?: string
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
 * 🔴 "IT WAS NEVER THERE" IS SUCCESS, NOT FAILURE.
 *
 * ai-service answers a `setDocumentValidity` for a corpus it does not have with
 * `404 CORPUS_NOT_FOUND`, and for a document that corpus does not hold with
 * `404 DOCUMENT_NOT_FOUND`. Both mean the same thing to a retirement: that
 * document is not retrievable from that corpus. Which is the property the caller
 * asked for.
 *
 * ⚠ THIS IS NOT DEFENSIVE PADDING — IT CLOSES A REPRODUCIBLE DEAD END. A corpus
 * only exists at ai-service once something has been ingested into it, and only
 * `INGESTABLE_KINDS` (pdf, docx, audio) are ever ingested. So a `kind:
 * 'markdown'` note — the DEFAULT kind — has no draft corpus at all. Publishing
 * one used to: enqueue into the shared corpus (fine), then throw on the retire,
 * leaving the row at `publishing` with `ai-service request failed (status 404)`
 * FOREVER. The document was in the ecosistema's shared corpus while the row
 * claimed it was not published — retrievable by every colleague's chat, invisible
 * in every colleague's document list, and impossible for the uploader to finish
 * or undo. Found by `e2e/publish.e2e.ts`.
 *
 * ⚠ THE RESIDUAL RISK, STATED SO IT IS NOT DISCOVERED LATER: if the corpus NAME
 * were ever computed wrongly, this would swallow the 404 and report a retirement
 * that never happened, leaving the document live under its real name. That is
 * why it warns rather than passing silently, and why every name still comes from
 * `lib/corpus.ts` alone. A wrong name is a code bug, not a runtime state — and
 * the behaviour it replaces (a permanently stuck publish) was not safer, only
 * louder in the wrong place.
 */
function isAlreadyAbsent(err: unknown): boolean {
  // Duck-typed on `status` rather than `instanceof NotFoundError`, so this file
  // keeps depending on the structural `CorpusMover` above and stays testable
  // with a plain fake client.
  return Boolean(err) && typeof err === 'object' && (err as { status?: unknown }).status === 404
}

/**
 * Retire a document from a corpus: close its validity window at `now`.
 *
 * ⚠ NOT A DELETE. The chunks stay in the corpus and stay embedded; they simply
 * fall outside the window a retrieval with `asOf` will consider. Two
 * consequences worth stating: storage is not reclaimed, and a retrieval that
 * forgets `asOf` still sees the document. See the file header.
 *
 * ⚠ IDEMPOTENT. See {@link isAlreadyAbsent}: a 404 is treated as "already not
 * retrievable there", which is also what makes a re-run of either transition
 * safe after a partial failure.
 *
 * ⚠ EXPORTED, and not only for documents. `collections/Sessions.ts` retires the
 * chat turns of a deleted conversation with it (external id `msg-<id>`, see
 * `lib/conversationIngest.ts`). It is the ONLY retirement primitive in the
 * repo, deliberately: the 404 rule above is subtle enough that a second
 * implementation would get it wrong. Note that it THROWS on any non-404 — the
 * never-throws policy belongs to `retireDeletedDocument`, its caller, not here.
 */
export async function retireFrom(
  client: CorpusMover,
  corpus: string,
  documentId: number | string,
  now: Date,
  log?: RetireLogger,
): Promise<void> {
  try {
    await client.admin.setDocumentValidity(corpus, String(documentId), {
      validTo: now.toISOString(),
    })
  } catch (err) {
    if (!isAlreadyAbsent(err)) throw err
    log?.warn(
      { corpus, documentId: String(documentId) },
      '[publish] nothing to retire — ai-service has no such corpus or document. ' +
        'Treated as already retired. Verify the corpus name if this is unexpected.',
    )
  }
}

/** Just the one method of Payload's logger this file uses. */
export interface RetireLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

function loggerOf(deps: RowDeps): RetireLogger | undefined {
  const candidate = (deps.payload as unknown as { logger?: unknown }).logger
  if (candidate && typeof (candidate as RetireLogger).warn === 'function') {
    return candidate as RetireLogger
  }
  return undefined
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
  /**
   * Overrides for the rate-limit backoff around the enqueue. Production leaves
   * this unset and takes the env-configured defaults; tests inject `sleep` and
   * `random` so the suite does not actually wait two minutes. See `aiRetry.ts`.
   */
  retry?: RetryOptions
}

// ---------------------------------------------------------------------------
// 🔴 THE ENQUEUE IS RATE-LIMITED, AND A REFUSAL MUST NOT BE INVISIBLE
// ---------------------------------------------------------------------------

/**
 * 🔴 The message a user sees when ai-service refused because we were going too
 * fast. Spanish, because it lands in `publicationError` and the UI renders it
 * verbatim.
 *
 * ⚠ IT SAYS "NOTHING WAS SENT", and that is a factual claim we can make only
 * because a 429 is refused BEFORE the handler runs. It matters: the user's next
 * question is "did half of it go through?", and for this one failure the answer
 * is a clean no. Retrying is safe.
 */
export function rateLimitedError(action: 'publish' | 'unpublish'): string {
  const what =
    action === 'publish'
      ? 'publicar este documento'
      : 'quitar este documento de la biblioteca compartida'
  return (
    'El servicio de IA está saturado y rechazó la solicitud (límite de peticiones por minuto). ' +
    `No se envió nada, así que puedes volver a intentar ${what} en unos minutos.`
  )
}

/**
 * Anything else the move threw. Spanish frame, original detail kept for support.
 *
 * ⚠ Deliberately vague about WHICH call failed ("devolvió un error", not
 * "rechazó el envío"): both the ingest and the retire land here, and naming the
 * wrong one in a message a user reads back to support is worse than naming
 * neither. The detail in parentheses is the real diagnosis.
 */
export function transitionFailedError(action: 'publish' | 'unpublish', detail: string): string {
  const what =
    action === 'publish'
      ? 'publicar este documento'
      : 'quitar este documento de la biblioteca compartida'
  return `No se pudo ${what}: el servicio de IA devolvió un error (${detail}).`
}

/**
 * 🔴 THE FIX FOR THE 99 INVISIBLE ROWS.
 *
 * `beginPublish` sets `publicationStatus: 'publishing'` and THEN enqueues. When
 * the enqueue threw, the row was already in the in-flight state and nobody wrote
 * anything down: 99 documents sat at `publishing` with no `publicationError` and
 * no `publishIngestId`, which reads to a user as "still working" forever and
 * gives an operator nothing to act on.
 *
 * ⚠ CALL THIS FROM EVERY STEP THAT RUNS AFTER THE STATUS WRITE. The rule this
 * enforces is "once the row says in-flight, no path out of this function may be
 * silent" — which covers the ingest in both directions AND the retire in
 * `unpublish`, not just the one call the incident happened to expose.
 *
 * ⚠ EVERY failure is stamped, not just the rate limit. A 500, a DNS failure or
 * a dropped socket produce the exact same invisible row, and "the state says
 * what happened" is not a property that should hold for one error class only.
 *
 * ⚠ THE STATUS IS LEFT ALONE. `publishing` + a populated `publicationError` is
 * this file's existing vocabulary for "this tried and did not make it" (see
 * {@link failPublish}). Rolling back to `draft` would claim the document was
 * never touched.
 *
 * ⚠ NEVER MASKS THE ORIGINAL ERROR. If the row write itself fails there is
 * nothing useful left to do, and replacing the real cause with a Payload write
 * error would lose the only diagnosis anyone has.
 */
async function recordTransitionFailure(
  doc: PublishableDocument,
  deps: TransitionDeps,
  err: unknown,
  action: 'publish' | 'unpublish',
): Promise<void> {
  // ⚠ Building the message is INSIDE the try. It is cheap but not free of
  // failure modes — `isRateLimited` does an `instanceof` against a class from
  // another package — and this function's whole job is to be the path that does
  // not itself throw.
  try {
    const reason = isRateLimited(err)
      ? rateLimitedError(action)
      : transitionFailedError(action, err instanceof Error ? err.message : String(err))
    await failPublish(doc, deps, reason)
  } catch (writeErr) {
    loggerOf(deps)?.warn(
      { documentId: String(doc.id), action, err: String(writeErr) },
      '[publish] could not record the transition failure on the row — it stays in an in-flight ' +
        'state with no visible error. The publish janitor is the remaining safety net.',
    )
  }
}

/**
 * 🔴 THE INGEST WAS ACCEPTED AND WE COULD NOT WRITE DOWN ITS ID.
 *
 * The narrowest hole of the three, and the one with the most misleading failure
 * mode if it is left alone. `beginPublish`/`unpublish` store `publishIngestId`
 * in a SEPARATE write after the enqueue returns. If that write throws:
 *
 *   · the ingest IS running at ai-service, and
 *   · `app/api/ai-service/callback/route.ts` matches the completion on
 *     `doc.publishIngestId === envelope.ingestId`, so the callback can never
 *     match this row. It is stuck permanently, not merely until the callback.
 *
 * ⚠ AND THE JANITOR WOULD LIE ABOUT IT. `publishJanitor.stalledPublishReason`
 * splits on whether `publishIngestId` is set, so an empty one reads as "never
 * reached ai-service, nothing was sent, retry freely" — which is exactly
 * backwards here, and invites the duplicate publish the janitor exists to
 * prevent. So this stamps the TRUE story itself, before the janitor can guess
 * the wrong one.
 *
 * ⚠ IT DOES NOT RETHROW. The publish genuinely started; reporting a hard
 * failure to the caller would be as wrong as saying nothing. The row now
 * carries the ingest id in its message, which is what support needs to
 * reconcile it by hand.
 */
async function recordLostIngestId(
  doc: PublishableDocument,
  deps: TransitionDeps,
  ingestId: string,
  action: 'publish' | 'unpublish',
  cause: unknown,
): Promise<void> {
  loggerOf(deps)?.warn(
    { documentId: String(doc.id), action, ingestId, err: String(cause) },
    '[publish] the ingest was accepted but its id could not be stored — the completion ' +
      'callback will not match this row and it must be reconciled by hand.',
  )
  try {
    await failPublish(doc, deps, lostIngestIdError(action, ingestId))
  } catch {
    // Nothing left to try. The janitor will at least make the row visible, even
    // if its guess about what happened is the pessimistic one.
  }
}

/** ⚠ Must NOT say "nothing was sent" — something was. See {@link recordLostIngestId}. */
export function lostIngestIdError(action: 'publish' | 'unpublish', ingestId: string): string {
  const what = action === 'publish' ? 'publicar' : 'quitar de la biblioteca compartida'
  return (
    `Se envió la solicitud de ${what} al servicio de IA (referencia ${ingestId}), pero no se ` +
    'pudo guardar esa referencia, así que no podremos confirmar automáticamente cuándo termine. ' +
    'Pide ayuda al equipo en lugar de volver a intentarlo, para no duplicar el envío.'
  )
}

/**
 * The enqueue, with the server's own backoff applied.
 *
 * ⚠ RETRY IS SAFE HERE FOR ONE SPECIFIC REASON: a 429 is refused by the rate
 * limiter before ai-service's handler runs, so no ingest was created and a
 * re-send cannot duplicate one. `isRateLimited` is deliberately narrow for
 * exactly that reason — see `aiRetry.ts`.
 */
async function enqueueWithBackoff(
  deps: TransitionDeps,
  doc: PublishableDocument,
  action: 'publish' | 'unpublish',
  req: Parameters<CorpusMover['ingest']['enqueue']>[0],
): Promise<{ ingestId: string }> {
  return withRateLimitRetry(() => deps.client.ingest.enqueue(req), {
    label: `${action} document ${doc.id}`,
    ...(loggerOf(deps) ? { log: loggerOf(deps)! } : {}),
    ...(deps.retry ?? {}),
  })
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
  /**
   * 🔴 THE GATE'S OUTPUT FOR A TESTIMONY, THE ORIGINAL FOR A DOCUMENT — and it
   * is `corpusTextFor` that knows which. Reading `extractedText` here directly
   * is the bug this call exists to prevent: publishing is what puts a document
   * in front of the WHOLE ecosistema, so it is the worst possible moment to
   * promote the unredacted original.
   *
   * ⚠ A gated row with no `redactedText` is REFUSED, not silently published
   * from the original. That covers the real case: the draft ingest was HELD, so
   * there is nothing cleared to share, and the publish must say so.
   *
   * ⚠ The gate is NOT re-run here. Two more model calls on text that has already
   * been decided, with the chance of a different answer, is worse than either
   * answer.
   */
  const selected = corpusTextFor(doc)
  if (!selected.ok) {
    throw new NotPublishableError(
      selected.reason === 'no extracted text'
        ? 'This document has no extracted text yet, so it cannot be published. Wait for ingestion to finish, or re-upload it.'
        : `This document cannot be published: ${selected.reason}.`,
    )
  }
  const text = selected.text

  const corpus = publishedCorpus(organizationId)

  await deps.payload.update({
    collection: 'documents',
    id: doc.id as never,
    data: { publicationStatus: 'publishing', publicationError: null },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })

  // 🔴 Backed off and, on final give-up, WRITTEN DOWN. Before this, a refused
  // enqueue threw straight past every caller and left the row at `publishing`
  // with nothing on it. See `recordTransitionFailure`.
  let result: { ingestId: string }
  try {
    result = await enqueueWithBackoff(deps, doc, 'publish', {
      corpus,
      documents: [
        {
          id: String(doc.id),
          text,
          // ⚠ Neutral for gated content — see `titleFor`. A testimony's filename
          // is free text and never went through the gate.
          title: titleFor(contentKindOf(doc), doc.name),
          /**
           * 🔴 THE SAME BUILDER THE DRAFT INGEST USES, AND THAT IS THE WHOLE
           * POINT. Publishing RE-EMBEDS the document into a different corpus, so
           * it rebuilds the chunk metadata from scratch. Assembled inline, this
           * object silently loses `contentKind` at exactly the moment the material
           * becomes visible to the entire ecosistema — and then a citation can no
           * longer say "this is a testimony" or "this came from a previous
           * answer". See `lib/contentKind.ts`.
           */
          metadata: chunkMetadata({
            docId: String(doc.id),
            organizationId,
            contentKind: contentKindOf(doc),
            format: doc.kind,
            publication: 'published',
            title: doc.name,
          }),
        },
      ],
      language: CORPUS_LANGUAGE,
      ...(deps.callbackUrl ? { callbackUrl: deps.callbackUrl } : {}),
    })
  } catch (err) {
    await recordTransitionFailure(doc, deps, err, 'publish')
    throw err
  }

  try {
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
  } catch (err) {
    // ⚠ Does not rethrow — the publish really did start. See the helper.
    await recordLostIngestId(doc, deps, result.ingestId, 'publish', err)
  }

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

  await retireFrom(deps.client, draftCorpus(organizationId, userId), doc.id, now, loggerOf(deps))

  await deps.payload.update({
    collection: 'documents',
    id: doc.id as never,
    data: { publicationStatus: 'published', publicationError: null, publishIngestId: null },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })
}

/**
 * 🔴 THE MESSAGE FOR A FAILURE THAT ARRIVED WITH NO WORDS IN IT, and it exists
 * to close a hole rather than to be read often.
 *
 * `failPublish` is called with whatever the caller had: at
 * `app/api/ai-service/callback/route.ts` that is `envelope.error` straight off
 * the wire on an `ingest.failed`, and elsewhere an `err.message`. Both can be
 * the empty string — a `new Error()` has one, and nothing validates that
 * ai-service put words in its error field.
 *
 * ⚠ AN EMPTY STRING HERE IS THE WORST OF BOTH WORLDS, which is not obvious. The
 * UI shows the error only when it is populated, so `''` is invisible to the
 * user. And `publishJanitor.ts` cannot rescue the row either: its `where`
 * carries `publicationError: { exists: false }`, which Payload compiles to
 * `IS NULL` alone, so a row holding `''` is never even returned by the sweep
 * that exists to make exactly this state visible. The row keeps
 * `publicationStatus: 'publishing'` forever with nobody able to tell.
 *
 * ⚠ THE GUARD BELONGS HERE, NOT IN THE SWEEP'S `where`. This is the only place
 * that writes the field, so one clause here fixes every caller; widening the
 * janitor's query to `or: [exists: false, equals: '']` would fix the symptom in
 * one of the two places it shows and leave the bad value in the database.
 *
 * Spanish, because it lands in `publicationError` and the UI renders it verbatim.
 */
export const UNEXPLAINED_PUBLISH_FAILURE =
  'El servicio de IA reportó un error sin detalle. Vuelve a intentarlo; si vuelve a pasar, ' +
  'avisa a quien administra la instalación.'

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
    data: { publicationError: (reason.trim() || UNEXPLAINED_PUBLISH_FAILURE).slice(0, 500) },
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
  // Same rule as `beginPublish`: the gate's output for gated content, the
  // original for a plain document. Un-publishing is still a full re-embed.
  const selected = corpusTextFor(doc)
  if (!selected.ok) {
    throw new NotPublishableError(
      'This document has no text that may be embedded, so it cannot be moved back to drafts.',
    )
  }
  const text = selected.text
  const now = (deps.now ?? (() => new Date()))()

  await deps.payload.update({
    collection: 'documents',
    id: doc.id as never,
    data: { publicationStatus: 'unpublishing', publicationError: null },
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  })

  // 🔴 Sharing stops HERE, before anything slow happens.
  //
  // ⚠ A 404 is tolerated (see `isAlreadyAbsent`) and it is SAFE in this
  // direction too: "the shared corpus does not hold this document" is exactly
  // the guarantee unpublishing has to make. Failing instead would strand a
  // document the user has already asked to stop sharing.
  //
  // ⚠ THE RETIRE IS RECORDED TOO, and it is the SECOND invisible-row hole in
  // this file. The row is already at `unpublishing` by the time we get here, so
  // a throw from this call left exactly the shape the publish path was fixed
  // for: an in-flight status, no error, nothing to retry from — and in this
  // direction it also means the document is still SHARED while the row claims
  // it is being withdrawn. `setDocumentValidity` is an admin route, so a
  // mis-scoped key makes this a 403 on every attempt, not a rare accident.
  try {
    await retireFrom(deps.client, publishedCorpus(organizationId), doc.id, now, loggerOf(deps))
  } catch (err) {
    await recordTransitionFailure(doc, deps, err, 'unpublish')
    throw err
  }

  const corpus = draftCorpus(organizationId, userId)
  // ⚠ SAME BACKOFF, AND IT MATTERS MORE IN THIS DIRECTION. By the time we get
  // here the shared copy is ALREADY retired, so a refused enqueue leaves a
  // document that is no longer shared and not yet back in drafts. Silently, that
  // is a document its own uploader can no longer find. The stamped error is what
  // makes it a state someone can retry out of.
  let result: { ingestId: string }
  try {
    result = await enqueueWithBackoff(deps, doc, 'unpublish', {
      corpus,
      documents: [
        {
          id: String(doc.id),
          text,
          // ⚠ Neutral for gated content — see `titleFor`. A testimony's filename
          // is free text and never went through the gate.
          title: titleFor(contentKindOf(doc), doc.name),
          // Same shared builder as every other ingest — see `beginPublish`.
          metadata: chunkMetadata({
            docId: String(doc.id),
            organizationId,
            contentKind: contentKindOf(doc),
            format: doc.kind,
            publication: 'draft',
            title: doc.name,
          }),
        },
      ],
      language: CORPUS_LANGUAGE,
      ...(deps.callbackUrl ? { callbackUrl: deps.callbackUrl } : {}),
    })
  } catch (err) {
    await recordTransitionFailure(doc, deps, err, 'unpublish')
    throw err
  }

  try {
    await deps.payload.update({
      collection: 'documents',
      id: doc.id as never,
      data: { publishIngestId: result.ingestId },
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
  } catch (err) {
    // ⚠ Same hole, same handling. See `recordLostIngestId`.
    await recordLostIngestId(doc, deps, result.ingestId, 'unpublish', err)
  }

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

/**
 * Retire a document from BOTH of its possible corpora, because it is being
 * deleted.
 *
 * 🔴 THIS CLOSES A REAL LEAK. Deleting a `documents` row used to remove it from
 * the UI and leave its chunks embedded and retrievable. For a PUBLISHED
 * document that is the bad one: the row is gone, the uploader believes it is
 * gone, and the ecosistema's assistant keeps quoting it — with a citation that
 * now points at nothing.
 *
 * ⚠ RETIRES FROM BOTH, deliberately, and does not consult
 * `publicationStatus`. A row can be deleted mid-transition (`publishing` /
 * `unpublishing`), when copies legitimately exist in both places at once, and a
 * crash between the two publish steps can leave one behind in either. Guessing
 * from the stored state is exactly how you leave the copy that mattered. A
 * corpus that has no such document answers 404 and `retireFrom` already treats
 * that as "already not retrievable there" — so retiring twice is cheap and
 * always safe, while retiring once is a bet.
 *
 * ⚠ RETIREMENT IS NOT DELETION. ai-service has no per-document delete; this
 * closes the chunk's validity window (`validTo: now`), which removes it from
 * results ONLY for retrieves that pass `asOf`. Every caller in this repo does —
 * `retrievalOptionsFor()` is the single place that says so and
 * `GET /api/sessions/:id/corpora` hands it to the client rather than
 * documenting it — but a future caller that forgets would see deleted documents
 * come back. That is the weakest link in this design and it is worth knowing.
 *
 * Never throws. The row is already gone by the time this runs, so there is
 * nothing to roll back and failing loudly would only turn a successful delete
 * into an error the user cannot act on. It logs instead, and the document stays
 * retrievable until someone retries — which is why the log line names the
 * corpus and the id.
 */
export async function retireDeletedDocument(
  deps: TransitionDeps,
  doc: PublishableDocument,
  now: Date = new Date(),
): Promise<void> {
  const organizationId = plainId(doc.organization)
  const uploadedById = plainId(doc.uploadedBy)
  const log = loggerOf(deps)

  if (organizationId == null) {
    log?.warn(
      { documentId: String(doc.id) },
      '[delete] document had no ecosistema — cannot name a corpus, so its chunks (if any) stay retrievable.',
    )
    return
  }

  const corpora = [publishedCorpus(organizationId)]
  if (uploadedById != null) corpora.push(draftCorpus(organizationId, uploadedById))

  for (const corpus of corpora) {
    try {
      await retireFrom(deps.client, corpus, doc.id, now, log)
    } catch (err) {
      // Keep going: the OTHER corpus is the one that might still be serving
      // this document to colleagues, and one unreachable corpus must not stop
      // us reaching it.
      log?.warn(
        { corpus, documentId: String(doc.id), err: String(err) },
        '[delete] could not retire a deleted document — its chunks remain retrievable in this corpus.',
      )
    }
  }
}
