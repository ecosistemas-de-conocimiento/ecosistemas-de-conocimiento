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

import { anonymiseRequested, corpusTextFor, mustPassAnonymisationGate } from '@/lib/anonymiseDocument'
import { updateDocumentColumns, type DocumentColumnsPayload } from '@/lib/documentColumns'
import { errSummary, safeErrMessage } from '@/lib/errorSummary'

import { isConsentHeldNow } from '@/lib/consentHold'

import { extractGraph, type GraphGenerateClient } from './extract'
import { GRAPH_PROMPT_VERSION } from './prompt'
import type { GraphStatus } from './types'
import { blockedAuthorNames, dropKeptAuthors, keptLogNames, mergeWikiSeeds, wikiSeedsForRow, type WikiSeeds } from './wikilinks'
import { findSeedEntities, pruneDeadSeeds, writeGraphForDocument, type GraphWriterPayload } from './writer'

/**
 * 🔴 THE ECOSISTEMAS WHOSE NOTES SEED THE GRAPH FROM `[[wikilinks]]` (owner
 * ruling Q7, 2026-10-28: Semiosis, org 8). An allowlist, not a feature flag:
 * the seeds are graph rows built from author markup, so each ecosistema is a
 * deliberate decision. There is no model-less backfill: old notes get their
 * seeds from a model re-extraction of each note. ⚠ The ordinary backfill does
 * NOT pick them up (their `graphPromptVersion` is current, and it must not be
 * bumped — owner ruling); `scripts/reextract-wikilink-notes.ts` queues them by
 * id, then `lib/graph/backfill.cli.ts` runs them.
 * See `lib/graph/wikilinks.ts` for what a link must survive.
 */
export const WIKILINK_SEED_ORGS: ReadonlySet<string> = new Set(['8'])

export function wikiLinkSeedingEnabled(organizationId: string | number): boolean {
  return WIKILINK_SEED_ORGS.has(String(organizationId))
}

/**
 * `{ wikiLinks: value }` for an allowlisted ecosistema, `{}` otherwise.
 * ⚠ Other ecosistemas' status writes never name the column, so a graph run
 * elsewhere cannot fail on it (a database without the migration, a test on the
 * baseline schema).
 */
function wikiLinksColumn(organizationId: string | number, value: unknown): Record<string, unknown> {
  return wikiLinkSeedingEnabled(organizationId) ? { wikiLinks: value } : {}
}

/** The Payload surface a run needs. Structural, so tests need no real instance. */
export type GraphSchedulerPayload = GraphWriterPayload & DocumentColumnsPayload

export interface RunGraphExtractionArgs {
  payload: GraphSchedulerPayload
  docId: string | number
  organizationId: string | number
  /** 🔴 Read from `documents.contentKind`. The person rule keys off it. */
  contentKind: string | null | undefined
  /** `documents.anonymise` when the job was queued. A change aborts the run. */
  anonymise?: unknown
  /**
   * `documents.publicationStatus` when the job was queued. A row that was
   * `published` then and is not now was withdrawn: the run aborts.
   */
  publicationStatus?: unknown
  /**
   * 🔴 THE CORPUS TEXT WHEN THE JOB WAS QUEUED — A FINGERPRINT, NOT THE INPUT.
   * The run re-derives its text from the row (`corpusTextFor`) and aborts if it
   * no longer equals this. See {@link abortIfStale}.
   */
  text: string
  title?: string | null
  /** Test seam. Production resolves `getGraphAIClient(organizationId)`. */
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
  // 🔴 This document's model mentions may have been the last ones keeping
  // another note's seeds alive.
  await pruneSeedsIfEnabled(payload, organizationId)
}

/**
 * {@link pruneDeadSeeds} for a seeding ecosistema. Never throws: the graph
 * write already landed, and the read path's `seedGuard.ts` hides what a failed
 * prune leaves.
 */
export async function pruneSeedsIfEnabled(
  payload: Pick<GraphSchedulerPayload, 'db'>,
  organizationId: string | number,
): Promise<void> {
  if (!wikiLinkSeedingEnabled(organizationId)) return
  await pruneDeadSeeds(payload.db.drizzle, organizationId).catch((err) => {
    console.error('[graph] could not prune dead wikilink seeds in org', organizationId, err instanceof Error ? err.name : typeof err)
  })
}

/**
 * 🔴 A DOCUMENT THAT MAY NOT BE GRAPHED KEEPS NO GRAPH ROWS.
 *
 * Every path that marks a row `skipped` because it is not graphable (rejected,
 * held, gate not cleared) goes through here, so the status and the rows can
 * never disagree. Rows an earlier run built may carry the very text the row was
 * refused for.
 *
 * Never throws: callers run after their own write has landed. A failed delete
 * marks the row `failed` (`graph_clear_failed`), which the backfill selects and
 * clears again (`backfill.ts`, the `corpusTextFor` refusal branch).
 */
export async function markNotGraphable(
  payload: GraphSchedulerPayload,
  docId: string | number,
  organizationId: string | number,
  reason: string,
): Promise<'skipped' | 'failed'> {
  try {
    await clearGraphRows(payload, docId, organizationId)
  } catch (err) {
    console.error('[graph] could not clear rows for non-graphable doc', docId, err instanceof Error ? err.name : typeof err)
    await setGraphStatus(payload, docId, {
      graphStatus: 'failed',
      graphError: `graph_clear_failed: ${reason}`.slice(0, 500),
    }).catch(() => undefined)
    return 'failed'
  }
  await setGraphStatus(payload, docId, {
    graphStatus: 'skipped',
    graphError: `not_graphable: ${reason}`.slice(0, 500),
    ...wikiLinksColumn(organizationId, null),
  }).catch(() => undefined)
  return 'skipped'
}

async function setGraphStatus(
  payload: GraphSchedulerPayload,
  docId: string | number,
  data: Record<string, unknown>,
): Promise<void> {
  // 🔴 ONLY THE GRAPH COLUMNS. A `payload.update` here rewrote the whole row
  // with the `ingestStatus` it had just read, and the ingest callback's `ready`
  // landing in between was erased — the upload stuck at `embedding` forever.
  // `lib/documentColumns.ts` has the measurement.
  await updateDocumentColumns(payload, { id: docId, data })
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
  const { payload, docId, organizationId } = args

  // 🔴 RE-READ AT JOB START. The queue may have held this job for minutes.
  let start: GraphableRow
  try {
    start = await readGraphableRow(payload, docId, organizationId)
  } catch (err) {
    await recordFailure(args, 'graph_reread_failed', err)
    return 'failed'
  }
  const queued: GraphableRow = {
    ok: true,
    text: typeof args.text === 'string' ? args.text.trim() : '',
    contentKind: typeof args.contentKind === 'string' ? args.contentKind : null,
    anonymise: anonymiseRequested(args.anonymise),
    publicationStatus: args.publicationStatus,
  }
  // 🔴 RETENIDO POR CONSENTIMIENTO (audit, ola 11 A2): a job queued before the
  // hold sends nothing to the model and writes nothing (`lib/consentHold.ts`).
  if (isHeldRead(start)) return 'skipped'
  const startAbort = await abortIfStale(payload, docId, organizationId, queued, start)
  if (startAbort || !start.ok) return startAbort ?? 'skipped'
  // From here on, the ROW's values, never the queued ones.
  const { text, contentKind } = start
  const ctx = { payload, docId, organizationId, contentKind, anonymise: start.anonymise }

  if (text.trim().length < MIN_TEXT_CHARS) {
    // ⚠ CLEAR WHAT A PREVIOUS RUN LEFT BEHIND. A document can lose its text —
    // a retry that cleared `extractedText`, a re-upload of a shorter file — and
    // returning early without deleting would leave the OLD version's entities
    // and snippets attached to a document that no longer says any of it.
    await clearGraphRows(payload, docId, organizationId).catch((err) => {
      console.warn('[graph] could not clear rows for skipped doc', docId, errSummary(err))
    })
    await setGraphStatus(payload, docId, {
      graphStatus: 'skipped',
      graphError: null,
      ...wikiLinksColumn(organizationId, null),
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
      client = await getGraphAIClient(organizationId)
    } catch (err) {
      // A deployment with no `AI_SERVICE_API_KEY` is a normal state for a local
      // run. `failed` rather than `skipped` on purpose: an operator can fix it
      // and the backfill will then pick the row up.
      await recordFailure(ctx, 'ai_client_unavailable', err)
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

    // 🔴 RE-READ RIGHT BEFORE WRITING. The deep calls above take minutes; a
    // reviewer can hold, reject, withdraw or re-gate the row in that window.
    const beforeWrite = await readGraphableRow(payload, docId, organizationId)
    // 🔴 Held while the model ran: its output is dropped, no graph row is
    // written, and the status leaves `extracting` for `skipped` (the status
    // column only, no reason text). Without this the row stayed `extracting`.
    if (isHeldRead(beforeWrite)) {
      await setGraphStatus(payload, docId, { graphStatus: 'skipped' }).catch((err) => {
        console.error('[graph] could not mark held doc skipped', docId, errSummary(err))
      })
      return 'skipped'
    }
    const writeAbort = await abortIfStale(payload, docId, organizationId, start, beforeWrite)
    if (writeAbort) return writeAbort
    // 🔴 THE SEEDS COME FROM THE ROW AS RE-READ HERE, merged by `canonicalKey`
    // BEFORE the writer's replace-all, so a re-run never duplicates them.
    // 🔴 Attach-only, and never a persona: the ecosistema's stored nodes for
    // the seed keys say which keys exist and which are people (`writer.ts`
    // `findSeedEntities`, live = a model-written mention in another note).
    const seeds = beforeWrite.ok ? beforeWrite.seeds : null
    const stored = await findSeedEntities(payload.db.drizzle, organizationId, docId, seeds)
    const authorNames = beforeWrite.ok ? (beforeWrite.authorNames ?? []) : []
    const merged = mergeWikiSeeds(dropKeptAuthors(extraction, authorNames), seeds, {
      personaLabels: [...(beforeWrite.ok ? (beforeWrite.personaLabels ?? []) : []), ...stored.personaKeys],
      authorNames,
      known: stored.known,
    })
    const seeded = merged.extraction

    await writeGraphForDocument({
      payload,
      docId,
      organizationId,
      contentKind,
      extraction: seeded,
    })
    await pruneSeedsIfEnabled(payload, organizationId)

    // ⚠ `.catch`, NOT inside the outer try. The rows are already written and
    // committed at this point. A database blip on the STATUS write would
    // otherwise land in `recordFailure`, mark a perfectly good extraction
    // `failed`, and make the backfill pay for it all over again. A row stuck at
    // `extracting` with correct data is the cheaper wrong answer, and the
    // backfill still finds it because `graphPromptVersion` never got stamped.
    await setGraphStatus(payload, docId, {
      graphStatus: 'ready',
      graphError: null,
      // FILTERED links only (`safeWikiLinks`); null when this row has none.
      // `[]` (not null) when the run judged links and none attached.
      ...wikiLinksColumn(organizationId, seeds ? (merged.links ?? []) : null),
      graphPromptVersion: extraction.promptVersion,
      graphExtractedAt: new Date().toISOString(),
    }).catch((err) => {
      console.error('[graph] rows written for doc', docId, 'but the status write failed', errSummary(err))
    })

    console.log(
      `[graph] doc ${docId} → ${extraction.entities.length} entidades, ` +
        `${extraction.relations.length} relaciones, ${extraction.windows} ventanas` +
        (extraction.windowsFailed ? ` (${extraction.windowsFailed} fallidas)` : '') +
        (extraction.truncated ? ' [TRUNCADO]' : ''),
    )
    return 'ready'
  } catch (err) {
    await recordFailure(ctx, 'graph_extract_failed', err)
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
  args: Pick<RunGraphExtractionArgs, 'payload' | 'docId' | 'organizationId' | 'contentKind' | 'anonymise'>,
  code: string,
  err: unknown,
): Promise<void> {
  const { payload, docId, organizationId, contentKind } = args
  // 🔴 `anonymise` TOO: a documento filed for anonymisation is gated content.
  const gated = mustPassAnonymisationGate(contentKind, args.anonymise)
  if (gated) {
    await clearGraphRows(payload, docId, organizationId).catch((clearErr) => {
      console.error('[graph] could not clear rows for failed gated doc', docId, errSummary(clearErr))
    })
  }
  // 🔴 A DATABASE error's message is the failed query with its params (P-07):
  // a mention's label or snippet. Its summary goes to the log AND to
  // `graphError`, which the frontend shows.
  const message = safeErrMessage(err, 500)
  // 🔴 PRIVACY. A gated kind logs safe metadata only: a downstream error (a
  // Postgres unique violation, a client error) can quote a label or the reply.
  if (gated) {
    console.error('[graph] extraction failed for doc', docId, String(contentKind), code,
      err instanceof Error ? err.name : typeof err, `message length ${message.length}`)
  } else {
    console.error('[graph] extraction failed for doc', docId, code, message.slice(0, 500))
  }
  await setGraphStatus(payload, docId, {
    graphStatus: 'failed',
    // Same `code: message` shape as `ingestError`, so the frontend maps the
    // leading code to Spanish copy the same way.
    graphError: `${code}: ${message}`.slice(0, 500),
    ...(gated ? wikiLinksColumn(args.organizationId, null) : {}),
    graphPromptVersion: GRAPH_PROMPT_VERSION,
  }).catch((updateErr) => {
    console.error('[graph] could not record the failure on doc', docId, errSummary(updateErr))
  })
}

// ---------------------------------------------------------------------------
// 🔴 The re-read: a queued job never trusts the text it was queued with
// ---------------------------------------------------------------------------

/**
 * What a run may graph, read from the row NOW.
 *
 * `ok: false` means there is nothing graphable: the row is gone, or
 * `corpusTextFor` refuses it (held, rejected, gated and not yet cleared, no
 * text). Same helper, same fail-closed rule as publish and the backfill.
 */
type GraphableRow =
  | {
      ok: true
      text: string
      contentKind: string | null
      anonymise: boolean
      publicationStatus: unknown
      /** Wikilink seeds, filtered against `text`; null when none or not enabled. */
      seeds?: WikiSeeds | null
      /** Kept public figures on the row: never a seed `tema`. */
      personaLabels?: string[]
      /** The document author and cited authors left visible on the row: never a node (`dropKeptAuthors`). */
      authorNames?: string[]
    }
  | { ok: false; reason: string; consentHeld?: true }

const isHeldRead = (r: GraphableRow): boolean => !r.ok && r.consentHeld === true

async function readGraphableRow(
  payload: GraphSchedulerPayload,
  docId: string | number,
  organizationId: string | number,
): Promise<GraphableRow> {
  // 🔴 Tenancy named explicitly, as in every other graph query.
  const found = await payload.find({
    collection: 'documents',
    where: { and: [{ id: { equals: docId } }, { organization: { equals: organizationId } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const row = found?.docs?.[0] as Record<string, unknown> | undefined
  if (!row) return { ok: false, reason: 'document not found' }
  // ⚠ `find` with no `select`: the row carries `consentHeld` (pinned on a real
  // Postgres, `schedule.consentHeld.pg.test.ts`).
  // A revision answers for its note too: read now, as the note may have been
  // held while the revision was in flight (`isConsentHeldNow`, ola 11).
  // ⚠ No `req`: only the detached queue (`setImmediate`) and the backfill call this, never inside a write.
  if (await isConsentHeldNow(payload, row)) return { ok: false, reason: 'consent held', consentHeld: true }
  const corpus = corpusTextFor(row)
  if (!corpus.ok) return corpus
  return {
    ok: true,
    text: corpus.text,
    contentKind: typeof row.contentKind === 'string' ? row.contentKind : null,
    anonymise: anonymiseRequested(row.anonymise),
    publicationStatus: row.publicationStatus,
    seeds: wikiLinkSeedingEnabled(organizationId) ? wikiSeedsForRow(row, corpus.text) : null,
    personaLabels: keptLogNames(row.publicFiguresKept),
    authorNames: blockedAuthorNames(row),
  }
}

type Graphable = Extract<GraphableRow, { ok: true }>

/** Why `now` no longer matches `then`, or null when the run may go on. */
function staleReason(then: Graphable, now: Graphable): string | null {
  if (now.text !== then.text) return 'the corpus text changed'
  if (now.contentKind !== then.contentKind) return 'the content kind changed'
  if (now.anonymise !== then.anonymise) return 'the anonymise flag changed'
  // ⚠ ONLY published → not published. A draft published while queued is the
  // normal auto-publish path (`lib/autoPublish.ts`) and must not abort.
  if (then.publicationStatus === 'published' && now.publicationStatus !== 'published') {
    return 'the document was unpublished'
  }
  return null
}

/**
 * Abort the run when the row is no longer graphable or changed under it.
 * Returns the final status, or null to go on.
 *
 * 🔴 BOTH ABORTS CLEAR THE DOCUMENT'S ROWS. Rows an earlier run built may carry
 * the very text the row was withdrawn for.
 *
 *   · not graphable → `skipped`, the same terminal value
 *     `scheduleGraphExtractionForDoc` writes for a row it refuses.
 *   · changed       → `failed` with `graph_stale_job`, so the backfill rebuilds
 *     it from the current text. ⚠ If a newer job for the same row already wrote,
 *     this clears its rows too; the `failed` stamp is what gets them rebuilt.
 */
async function abortIfStale(
  payload: GraphSchedulerPayload,
  docId: string | number,
  organizationId: string | number,
  then: GraphableRow,
  now: GraphableRow,
): Promise<GraphStatus | null> {
  if (now.ok) {
    const reason = then.ok ? staleReason(then, now) : 'the row was not graphable when queued'
    if (reason == null) return null
    await clearGraphRows(payload, docId, organizationId).catch((err) => {
      console.error('[graph] could not clear rows for aborted doc', docId, errSummary(err))
    })
    // Safe metadata only: the reasons are fixed strings, never row text.
    // eslint-disable-next-line edc/no-raw-error-log -- `reason` is a staleness reason, not an error
    console.warn('[graph] doc', docId, 'changed since its job was queued — run aborted:', reason)
    await setGraphStatus(payload, docId, {
      graphStatus: 'failed',
      graphError: `graph_stale_job: ${reason}`.slice(0, 500),
      ...wikiLinksColumn(organizationId, null),
      graphPromptVersion: GRAPH_PROMPT_VERSION,
    }).catch(() => undefined)
    return 'failed'
  }

  await clearGraphRows(payload, docId, organizationId).catch((err) => {
    console.error('[graph] could not clear rows for aborted doc', docId, errSummary(err))
  })
  console.warn('[graph] doc', docId, 'no longer graphable — run aborted')
  await setGraphStatus(payload, docId, {
    graphStatus: 'skipped',
    graphError: `not_graphable: ${now.reason}`.slice(0, 500),
    ...wikiLinksColumn(organizationId, null),
  }).catch(() => undefined)
  return 'skipped'
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
        console.error('[graph] background extraction crashed for doc', next.docId, errSummary(err))
      })
      .then(() => {
        // A "Publicar cambios" revision waits for its graph (`lib/studentNotes.ts`).
        void import('@/lib/studentNotes').then((m) => m.onGraphSettled(next.docId)).catch(() => {})
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
 *   · `lib/ingestRecovery.ts:driveTranscribedDocuments` — the audio path, after
 *     the sweep has run the gate and the enqueue on a `transcribed` row.
 *
 * ⚠ `setImmediate`, NOT a bare promise, for the same reason the ingest hook uses
 * one: the create transaction has not committed when an `afterChange` hook runs,
 * and the deferred body re-reads through a no-transaction handle.
 */
export function scheduleGraphExtraction(args: RunGraphExtractionArgs): void {
  queue.push(args)
  setImmediate(pump)
}
