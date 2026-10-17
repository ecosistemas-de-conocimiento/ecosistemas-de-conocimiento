/**
 * WIRING EXTRACTION INTO INGEST, WITHOUT EVER BLOCKING IT.
 * `plan/adr-corpus-graph.md` §5.1.
 *
 * ⚠ THERE IS NO JOB QUEUE IN `apps/backend`. Ingest is `setImmediate` plus a
 * retry ladder (`collections/Documents.ts:333-337`), and adding BullMQ to a Next
 * process to serve hundreds of documents would be new infrastructure for a load
 * that does not need it. Extraction copies that pattern rather than inventing a
 * second one.
 *
 * ⚠ THE HONEST COST: a backend restart mid-extraction LOSES THE RUN. Nothing
 * here solves that. Three things mitigate it, and all three exist:
 * `graphStatus` makes a lost run visible instead of silent,
 * `POST /api/documents/:id/graph-retry` re-runs one document, and
 * `lib/graph/backfill.ts` re-runs everything stale.
 *
 * 🔴 THIS MUST NEVER BLOCK OR FAIL THE WRITE PATH. {@link scheduleGraphExtraction}
 * returns synchronously after arming a `setImmediate`; every error inside the
 * deferred run is caught and recorded on the row. A graph that cannot be built
 * is a missing feature; an upload that fails because of it is a broken product.
 */

import { mustPassAnonymisationGate } from '@/lib/anonymiseDocument'

import { extractGraph, type GraphGenerateClient } from './extract'
import { GRAPH_PROMPT_VERSION } from './prompt'
import type { GraphStatus } from './types'
import { writeGraphForDocument, type GraphWriterPayload } from './writer'

/** The Payload surface a run needs. Structural, so tests need no real instance. */
export type GraphSchedulerPayload = GraphWriterPayload & {
  update(args: Record<string, unknown>): Promise<unknown>
}

export interface RunGraphExtractionArgs {
  payload: GraphSchedulerPayload
  docId: string | number
  organizationId: string | number
  /** 🔴 Read from `documents.contentKind`. The person rule keys off it. */
  contentKind: string | null | undefined
  text: string
  title?: string | null
  /** Test seam. Production resolves `getAppAIClient()`. */
  client?: GraphGenerateClient
}

/**
 * Minimum text worth an inference call.
 *
 * ⚠ Below this a document is `skipped`, not `failed`: there is nothing wrong
 * with it, there is just nothing to extract. Spending a `deep`-tier call on two
 * lines of text buys noise.
 */
const MIN_TEXT_CHARS = 200

/**
 * Drop everything this document contributed to the graph.
 *
 * 🔴 Tenancy named explicitly, as in every other graph query.
 *
 * Exported for the backfill, which clears a gated document it refuses to graph.
 */
export async function clearGraphRows(
  payload: GraphSchedulerPayload,
  docId: string | number,
  organizationId: string | number,
): Promise<void> {
  const where = {
    and: [{ organization: { equals: organizationId } }, { document: { equals: docId } }],
  }
  await payload.delete({ collection: 'graphMentions', where, overrideAccess: true })
  await payload.delete({ collection: 'graphRelations', where, overrideAccess: true })
}

async function setGraphStatus(
  payload: GraphSchedulerPayload,
  docId: string | number,
  data: Record<string, unknown>,
): Promise<void> {
  await payload.update({
    collection: 'documents',
    id: docId,
    data,
    overrideAccess: true,
    // The ingest hook must not re-fire on a graph status write. Same guard the
    // ingest pipeline uses for its own status updates.
    context: { __skipDocsExtract: true },
  })
}

/**
 * Extract and store one document's graph, start to finish.
 *
 * Awaits everything, so it can be tested directly and called from the backfill.
 * The fire-and-forget wrapper is {@link scheduleGraphExtraction}.
 *
 * Never throws: every outcome ends as a `graphStatus` value with a reason. The
 * caller has nowhere useful to put an exception — it is running detached from
 * the request that caused it.
 */
export async function runGraphExtraction(args: RunGraphExtractionArgs): Promise<GraphStatus> {
  const { payload, docId, organizationId, contentKind } = args
  const text = typeof args.text === 'string' ? args.text : ''

  if (text.trim().length < MIN_TEXT_CHARS) {
    // ⚠ CLEAR WHAT A PREVIOUS RUN LEFT BEHIND. A document can lose its text —
    // a retry that cleared `extractedText`, a re-upload of a shorter file — and
    // returning early without deleting would leave the OLD version's entities
    // and snippets attached to a document that no longer says any of it.
    await clearGraphRows(payload, docId, organizationId).catch((err) => {
      console.warn('[graph] could not clear rows for skipped doc', docId, err)
    })
    await setGraphStatus(payload, docId, {
      graphStatus: 'skipped',
      graphError: null,
      graphPromptVersion: GRAPH_PROMPT_VERSION,
      graphExtractedAt: new Date().toISOString(),
    }).catch(() => undefined)
    return 'skipped'
  }

  let client = args.client
  if (!client) {
    try {
      // ⚠ NOT `getAppAIClient()` DIRECTLY, and `lib/graph/client.ts` explains
      // why with the measurement: a `deep` extraction window took 120 s, and the
      // shared client's timeout is 30 s. It wraps the same factory, so a
      // misconfigured deployment still fails with the same message.
      const { getGraphAIClient } = await import('./client')
      client = await getGraphAIClient()
    } catch (err) {
      // A deployment with no `AI_SERVICE_API_KEY` is a normal state for a local
      // run. `failed` rather than `skipped` on purpose: an operator can fix it
      // and the backfill will then pick the row up.
      await recordFailure(args, 'ai_client_unavailable', err)
      return 'failed'
    }
  }

  try {
    await setGraphStatus(payload, docId, { graphStatus: 'extracting', graphError: null })
  } catch {
    // A status write that fails is not a reason to skip the work.
  }

  try {
    const extraction = await extractGraph({
      docId,
      contentKind,
      text,
      title: args.title ?? null,
      client,
    })

    await writeGraphForDocument({
      payload,
      docId,
      organizationId,
      contentKind,
      extraction,
    })

    // ⚠ `.catch`, NOT inside the outer try. The rows are already written and
    // committed at this point. A database blip on the STATUS write would
    // otherwise land in `recordFailure`, mark a perfectly good extraction
    // `failed`, and make the backfill pay for it all over again. A row stuck at
    // `extracting` with correct data is the cheaper wrong answer, and the
    // backfill still finds it because `graphPromptVersion` never got stamped.
    await setGraphStatus(payload, docId, {
      graphStatus: 'ready',
      graphError: null,
      graphPromptVersion: extraction.promptVersion,
      graphExtractedAt: new Date().toISOString(),
    }).catch((err) => {
      console.error('[graph] rows written for doc', docId, 'but the status write failed', err)
    })

    console.log(
      `[graph] doc ${docId} → ${extraction.entities.length} entidades, ` +
        `${extraction.relations.length} relaciones, ${extraction.windows} ventanas` +
        (extraction.windowsFailed ? ` (${extraction.windowsFailed} fallidas)` : '') +
        (extraction.truncated ? ' [TRUNCADO]' : ''),
    )
    return 'ready'
  } catch (err) {
    await recordFailure(args, 'graph_extract_failed', err)
    return 'failed'
  }
}

/**
 * Mark a run `failed`.
 *
 * 🔴 A GATED DOCUMENT LOSES ITS PREVIOUS ROWS ON FAILURE. A `documento` keeps
 * them. Why the asymmetry:
 *
 * Nothing on a mention row says which text it came from. Before the backfill
 * read `corpusTextFor`, it extracted testimonios from the RAW transcript, so a
 * gated document's old rows may hold the names and places the gate removes.
 * Keeping them after a failed re-extraction would let them go live the moment
 * the testimonio is published. Deleting is the only rule that is safe without
 * knowing the rows' history; the cost is a testimonio with an empty graph until
 * the next successful run, which the backfill retries anyway (`failed`).
 *
 * A `documento`'s raw text IS its corpus text, so its old rows are merely stale,
 * not leaked; keeping them is the better answer there.
 *
 * ⚠ `mustPassAnonymisationGate` reads the RAW kind, so an unknown kind is gated.
 */
async function recordFailure(
  args: Pick<RunGraphExtractionArgs, 'payload' | 'docId' | 'organizationId' | 'contentKind'>,
  code: string,
  err: unknown,
): Promise<void> {
  const { payload, docId, organizationId, contentKind } = args
  if (mustPassAnonymisationGate(contentKind)) {
    await clearGraphRows(payload, docId, organizationId).catch((clearErr) => {
      console.error('[graph] could not clear rows for failed gated doc', docId, clearErr)
    })
  }
  const message = err instanceof Error ? err.message : String(err)
  console.error('[graph] extraction failed for doc', docId, code, message)
  await setGraphStatus(payload, docId, {
    graphStatus: 'failed',
    // Same `code: message` shape as `ingestError`, so the frontend maps the
    // leading code to Spanish copy the same way.
    graphError: `${code}: ${message}`.slice(0, 500),
    graphPromptVersion: GRAPH_PROMPT_VERSION,
  }).catch((updateErr) => {
    console.error('[graph] could not record the failure on doc', docId, updateErr)
  })
}

// ---------------------------------------------------------------------------
// Fire-and-forget, with a brake
// ---------------------------------------------------------------------------

/**
 * 🔴 HOW MANY EXTRACTIONS MAY RUN AT ONCE IN THIS PROCESS.
 *
 * ⚠ THE INGEST PATTERN THIS COPIES IS NOT ACTUALLY THE SAME SHAPE.
 * `enqueueIngestForDoc` fires ONE http call and returns in milliseconds, so an
 * unbounded `setImmediate` per document is harmless there. An extraction run
 * holds up to `GRAPH_EXTRACT_MAX_WINDOWS` (8) SEQUENTIAL `deep`-tier calls —
 * minutes — and then a Postgres transaction for its writes.
 *
 * Uploading twenty files at once would therefore arm twenty concurrent runs,
 * twenty pending transactions against a small pg pool, and twenty simultaneous
 * `deep` requests at ai-service. The failure is ugly and misattributed:
 * documents fail with a pool timeout that has nothing to do with them.
 *
 * Two at a time keeps a bulk upload progressing without either pressure. The
 * queue is per-process and in memory — a restart drops it, which is the same
 * durability the whole path has (§5.1) and is why the backfill exists.
 */
const graphConcurrency = (): number => {
  const raw = process.env.GRAPH_EXTRACT_MAX_CONCURRENCY
  const n = raw == null || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2
}

let running = 0
const queue: RunGraphExtractionArgs[] = []

function pump(): void {
  while (running < graphConcurrency() && queue.length > 0) {
    const next = queue.shift()
    if (!next) break
    running++
    void runGraphExtraction(next)
      .catch((err) => {
        // `runGraphExtraction` already swallows everything it can name. Anything
        // arriving here is a bug in the recording path itself.
        console.error('[graph] background extraction crashed for doc', next.docId, err)
      })
      .finally(() => {
        running--
        // ⚠ Defer, so a long synchronous chain of completions cannot starve the
        // event loop and so `running` is settled before the next check.
        setImmediate(pump)
      })
  }
}

/** Test seam — drains the queue between cases. */
export function __resetGraphQueueForTests(): void {
  queue.length = 0
  running = 0
}

/** How many runs are queued or in flight. Exposed for tests and diagnostics. */
export function graphQueueDepth(): { running: number; queued: number } {
  return { running, queued: queue.length }
}

/**
 * 🔴 THE FIRE-AND-FORGET ENTRY POINT. Returns immediately; the caller's write
 * path is never delayed and never fails because of the graph.
 *
 * Called at the same two points `enqueueIngestForDoc` is:
 *   · `collections/Documents.ts` — the pdf/docx path, after the ingest enqueue.
 *   · `app/api/ai-service/callback/route.ts` — the audio path, after the
 *     transcript has become `extractedText`.
 *
 * ⚠ `setImmediate`, NOT a bare promise, for the same reason the ingest hook uses
 * one: the create transaction has not committed when an `afterChange` hook runs,
 * and the deferred body re-reads through a no-transaction handle.
 */
export function scheduleGraphExtraction(args: RunGraphExtractionArgs): void {
  queue.push(args)
  setImmediate(pump)
}
