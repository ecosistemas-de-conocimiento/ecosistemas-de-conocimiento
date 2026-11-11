// In-process BullMQ worker for the `ingest` queue.
//
// One job = one IngestDocument. Steps (plan/m3-m4-decisions.md §11/§13–§15):
//   1. Load the corpus row to pick up the current chunk + embedding settings.
//   2. Chunk the doc text via `chunkForCorpus(...)` — request-supplied
//      `chunkConfig` first, else the corpus row's strategy.
//   3. Embed all chunk texts in one batch call to OpenRouter.
//   4. Dedupe: if `externalId` is non-null, look up the existing document and
//      delete its prior chunks, then UPDATE the doc row's text/title/metadata.
//      Otherwise INSERT a new document row.
//   5. INSERT one chunk row per chunk (with ordinal + embedding).
//   6. Append a `usage_logs` row tagged `/v1/ingest` so spend rolls up cleanly.
//
// Budget (audit 2026-10-17, AIS-7): step 3 is bracketed by the same
// reserve → adjust / refund cycle `/v1/embed` uses. See `chargeIngestEmbed`.
//
// `processIngestJob` is exported so unit tests can drive it without Redis. It
// CLAIMS the job's `ingest_jobs` row before step 1 and settles it after step 7
// — see the block comment at `claimIngestJob` for why a redelivered job that
// re-ran these steps embedded and inserted the document twice.
// Errors are re-thrown to BullMQ (so its retry/backoff kicks in) — unlike the
// generation worker which swallows internally because validator retry is
// already in-band. The ONE exception is a cooperative-shutdown abort, which is
// not a failed attempt and gets no retry: see `settleShutdownAbortedIngestJob`
// and `startIngestWorker`'s `stop()`.

import { randomUUID } from 'node:crypto';

import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { and, eq, notInArray, sql } from 'drizzle-orm';

import { env } from '../config/env.js';
import { db as defaultDb, type Db } from '../db/client.js';
import {
  chunks,
  corpora,
  documents,
  ingestJobs,
  ingestRequests,
  usageLogs,
} from '../db/schema/index.js';
import {
  INGEST_QUEUE_NAME,
  attachWorkerLifecycleLogging,
  workerRuntimeOptions,
  type IngestJobData,
  type WorkerRuntimeOptions,
} from '../queue/queues.js';
import {
  callOpenRouterEmbedding,
  embeddingProviderLabel,
} from '../services/ai/embeddings/openrouter.js';
import {
  callSparseEmbed,
  toSparsevecLiteral,
  type SparseEmbedder,
} from '../services/ai/embeddings/sparse-embed.js';
import { priceForEmbedding } from '../services/ai/router/task-profiles.js';
import { BudgetEnforcer } from '../services/budget/enforcer.js';
import {
  BudgetExceeded,
  BudgetMisconfigured,
  BudgetNotConfigured,
} from '../services/budget/errors.js';
import {
  insertCallbackDelivery,
  kickDelivery,
  maybeMarkProgress,
  type BaseEnvelope,
  type DbOrTx,
  type EnqueueOptions,
  type InsertedDelivery,
} from '../services/callbacks/emit.js';
import { rootLogger } from '../logger.js';
import { recordCallbackEmitSkipped } from '../metrics/callbacks.js';
import { chunkForCorpus, parseStructuralConfig, STRUCTURAL } from '../services/rag/chunk-strategy.js';
import {
  WORKER_LOST_CODE,
  WORKER_LOST_ERROR,
  lostWindowMs,
} from '../services/jobs/lost.js';
import {
  SHUTDOWN_ABORT_REASON,
  SHUTDOWN_CODE,
  SHUTDOWN_ERROR,
  SHUTDOWN_SETTLE_MS,
  awaitBounded,
  shutdownGraceMs,
  waitForDrain,
} from '../services/jobs/shutdown.js';
import type { InFlightMap } from './generation.worker.js';

export interface IngestWorkerDeps {
  db?: Db;
  /**
   * The BullMQ Redis connection. Required by `startIngestWorker`; comes from
   * `Runtime.redis` (`src/runtime.ts`). Named `connection`, NOT `runtime` —
   * `runtime` is already taken here by the lock/stall overrides below.
   */
  connection?: Redis;
  embedder?: typeof callOpenRouterEmbedding;
  /**
   * The budget the dense embed is charged against. Defaults to a
   * `BudgetEnforcer` on `db`. Injectable so the stub-DB unit suite can observe
   * the reserve / adjust / refund calls without a real `budget_state` row.
   */
  budget?: IngestBudget;
  /**
   * Injectable learned-sparse (bge-m3) embedder. Defaults to the real
   * `callSparseEmbed` client. Passing a stub FORCES the sparse path on
   * (bypassing the `SPARSE_ENABLED` + `SPARSE_EMBED_URL` gate) so tests can drive
   * sparse ingest with zero network. When active, each chunk's
   * `sparse_embedding` is populated alongside its dense `embedding`.
   */
  sparseEmbedder?: SparseEmbedder;
  /**
   * BullMQ lock/stall overrides for `startIngestWorker`. Production leaves this
   * undefined and gets `workerRuntimeOptions()`. The stalled-redelivery
   * integration test patches `lockDuration` / `stalledInterval` down to
   * milliseconds so a stall is reproducible inside a test timeout.
   */
  runtime?: Partial<WorkerRuntimeOptions>;
  /** Worker concurrency override. Test seam only. */
  concurrency?: number;
  /**
   * How old a `running` row must be before a redelivery presumes its owner
   * died. Production leaves this undefined and gets `lostWindowMs()`; the
   * SIGKILL repro shrinks it so a lost job fits inside a test timeout.
   */
  lostWindowMs?: number;
  /**
   * The cooperative-shutdown drain map: one `AbortController` per job that is
   * INSIDE the handler right now, keyed by its `ingest_jobs` row id. Shared
   * with `stop()` below, which is the only thing that aborts through it.
   * Defaults to a map owned by `startIngestWorker`; injectable so a test can
   * observe it.
   */
  inFlight?: InFlightMap;
  /**
   * Override for `SHUTDOWN_GRACE_MS`. Production leaves it undefined and gets
   * `shutdownGraceMs()`; the SIGTERM integration test shrinks it to 2 s so the
   * grace demonstrably EXPIRES inside a test timeout.
   */
  shutdownGraceMs?: number;
}

/** The slice of `BudgetEnforcer` the ingest path uses. */
export type IngestBudget = Pick<BudgetEnforcer, 'reserve' | 'adjust' | 'refund' | 'heldReserveUsd'>;

/** Structured logger for this worker; `component` makes it filterable. */
const ingestLog = rootLogger.child({ component: 'ingest-worker' });

function usdString(v: number): string {
  return v.toFixed(6);
}

/**
 * Combine the consumer's document-level metadata with whatever the chunker
 * derived for this specific chunk. Consumer keys win. Returns null (not `{}`)
 * when there is nothing on either side, preserving the exact column value
 * every pre-existing row has.
 */
function mergeChunkMetadata(
  docMeta: Record<string, unknown> | undefined,
  chunkMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!docMeta && !chunkMeta) return null;
  return { ...(chunkMeta ?? {}), ...(docMeta ?? {}) };
}

// ---------------------------------------------------------------------------
// 🔴 EXACTLY-ONCE-ISH INGEST JOB LIFECYCLE
// ---------------------------------------------------------------------------
// The generation worker fixed this shape first (`claimJob` /
// `writeTerminalStatus` in generation.worker.ts); ingest had the same defect
// and no row to hang the guard on, so `ingest_jobs` (drizzle/0002_ingest_jobs)
// was added for it.
//
// WHAT WENT WRONG WITHOUT IT. BullMQ hands a job to a second worker when the
// first one's lock expires. Both then ran this whole body: the document was
// chunked twice, EMBEDDED twice (a second, real charge on the org's budget and
// a second `usage_logs` row), and — on the `externalId === null` path, which
// has no dedupe key at all — a SECOND `documents` row was inserted with a
// second complete set of chunks. The corpus then answered a retrieve with the
// same passage twice. Nothing downstream could tell the copies apart.
//
// THE THREE WRITES:
//   · `claimIngestJob` — one conditional UPDATE, 'queued' → 'running'. Exactly
//     one of N concurrent deliveries wins. Runs BEFORE the corpus load, so the
//     loser spends nothing: no chunking, no embed call, no charge.
//   · `releaseIngestJob` — a caught error puts the row back to 'queued' so
//     BullMQ's own retry (`attempts: 3` on the ingest queue) still works. Safe
//     because the failed attempt has FINISHED; a release can never overlap a
//     live run.
//   · `writeIngestJobTerminal` — guarded `WHERE status NOT IN
//     ('completed','failed')` so a late writer cannot re-open a settled row.
//
// ⚠ A worker that DIES mid-run — SIGKILL, OOM, a pulled container — leaves the
// row at 'running', and it is deliberately NEVER re-run: a silent second embed
// charges the org and poisons the corpus with a duplicate document. It is not
// left stuck either. `reapLostIngestJob` fails a row that outlived the lock
// window with `error = 'worker_lost'` and pushes it through the SAME
// `onIngestDocFailed` bookkeeping as any other failed doc, so the batch
// counters move, the batch goes terminal and the `ingest.failed` callback
// fires. Never re-run, always reported — see `src/services/jobs/lost.ts`.
// The lost job's live budget hold (taken before its embed, keyed by the
// `ingest_jobs` row id) is refunded by the reaper from the ledger, exactly as
// `reapLostGenerationJob` does — see `reapLostIngestJob`.

/** The statuses an `ingest_jobs` row never leaves. */
export const TERMINAL_INGEST_JOB_STATUSES = ['completed', 'failed'] as const;

type IngestJobOutcome =
  | { status: 'completed' }
  | { status: 'failed'; error: string };

/**
 * Claim the row for THIS delivery. Returns false when someone else already has
 * it (or already finished it), which is the signal to do nothing at all.
 * `attempts` increments in SQL so two racing claimants cannot both write 1.
 *
 * 🔴 POSTGRES' clock, not node's — the same rule, for the same reason, as
 * `claimJob` in `generation.worker.ts`. `reapLostIngestJob` below asks
 * `started_at < now() - make_interval(...)`, and `now()` is the SERVER's. This
 * claim used to stamp `started_at` from a `new Date()` built in the worker, so
 * the two ends of that comparison read two different clocks: a worker running
 * ahead makes a live job look older than the lock window and gets it reaped as
 * `worker_lost` while it is still embedding, and a worker running behind hides
 * a genuinely lost row for the size of the skew. One clock, both ends.
 */
async function claimIngestJob(db: Db, jobRowId: string): Promise<boolean> {
  const claimed = await db
    .update(ingestJobs)
    .set({
      status: 'running',
      startedAt: sql`now()`,
      attempts: sql`${ingestJobs.attempts} + 1`,
    })
    .where(and(eq(ingestJobs.id, jobRowId), eq(ingestJobs.status, 'queued')))
    .returning({ id: ingestJobs.id });
  return claimed.length > 0;
}

/**
 * Hand the row back so BullMQ's retry can re-claim it. Conditional on
 * 'running': a row someone else has already settled must stay settled.
 */
async function releaseIngestJob(db: Db, jobRowId: string): Promise<void> {
  await db
    .update(ingestJobs)
    .set({ status: 'queued', startedAt: null })
    .where(and(eq(ingestJobs.id, jobRowId), eq(ingestJobs.status, 'running')));
}

/**
 * Conditional terminal write. True when THIS call settled the row, false when
 * it was already terminal — in which case the caller has lost a race and must
 * skip anything that is not idempotent.
 */
async function writeIngestJobTerminal(
  db: DbOrTx,
  jobRowId: string,
  values: { status: 'completed' | 'failed'; finishedAt: Date; error?: string | null },
): Promise<boolean> {
  const written = await db
    .update(ingestJobs)
    .set(values)
    .where(
      and(
        eq(ingestJobs.id, jobRowId),
        notInArray(ingestJobs.status, [...TERMINAL_INGEST_JOB_STATUSES]),
      ),
    )
    .returning({ id: ingestJobs.id });
  return written.length > 0;
}

/**
 * Process one ingest job: claim the row, run the body, settle the row.
 * Exported for direct unit-test invocation.
 *
 * A job whose payload carries no `jobId` (queued by a build older than the
 * `ingest_jobs` table and still in Redis across a deploy) runs UNCLAIMED —
 * byte-identical to the previous behaviour rather than dropped.
 */
export async function processIngestJob(
  bullJob: { id: string; data: IngestJobData },
  deps: IngestWorkerDeps = {},
): Promise<void> {
  const jobRowId = bullJob.data.jobId;

  // ── Cooperative-shutdown registration ────────────────────────────────────
  // 🔴 AT HANDLER ENTRY, BEFORE THE FIRST DB READ, AND REMOVED IN THE OUTERMOST
  // `finally` — after the terminal write, the batch rollup and the callback
  // insert, not merely around the embed. A drain map that covered only the
  // embed would report the job as drained while its settle path was still
  // running, and `stop()` would close the worker and let the process exit
  // through the middle of that write — reproducing the 'running' row the whole
  // seam exists to prevent. The window it must cover is the window in which a
  // SIGKILL would hurt, which is the WHOLE handler.
  //
  // Keyed by the `ingest_jobs` row id: that is the row `stop()`'s abort has to
  // settle, and it is unique per delivery. A payload from a build older than
  // `ingest_jobs` carries no `jobId`; it still gets a controller (so its embed
  // is interruptible) under a BullMQ-id key that collides with nothing.
  const ctrl = new AbortController();
  const inFlight = deps.inFlight;
  const inFlightKey = jobRowId ?? `bull:${bullJob.id}`;
  inFlight?.set(inFlightKey, ctrl);
  try {
    await runClaimedIngestJob(bullJob, deps, ctrl);
  } finally {
    inFlight?.delete(inFlightKey);
  }
}

/**
 * Everything `processIngestJob` does once it is registered in the drain map:
 * claim, run, settle. Split out ONLY so the map registration above can wrap it
 * in a single `finally` that is unambiguously outside every write.
 */
async function runClaimedIngestJob(
  bullJob: { id: string; data: IngestJobData },
  deps: IngestWorkerDeps,
  ctrl: AbortController,
): Promise<void> {
  const db = deps.db ?? defaultDb;
  const jobRowId = bullJob.data.jobId;

  if (jobRowId && !(await claimIngestJob(db, jobRowId))) {
    // Either a live worker still owns the row, or its owner died and the row
    // has outlived the lock window — in which case it is FAILED here instead
    // of left running forever. Never re-run either way: this branch returns
    // before any chunking or embedding.
    const reaped = await reapLostIngestJob(jobRowId, {
      db,
      ...(deps.lostWindowMs !== undefined ? { windowMs: deps.lostWindowMs } : {}),
      ...(deps.budget ? { budget: deps.budget } : {}),
    }).catch((err) => {
      ingestLog.warn({ jobRowId, err }, 'ingest worker: reaping job row failed');
      return false;
    });
    if (!reaped) {
      ingestLog.warn(
        `ingest worker: job row ${jobRowId} is not claimable (already running or ` +
          `settled) — this is a stalled re-delivery of BullMQ job ${bullJob.id}. ` +
          'Doing nothing: re-running it would embed and insert the document twice.',
      );
    }
    return;
  }

  let outcome: IngestJobOutcome;
  try {
    outcome = await runIngestJob(bullJob, deps, ctrl.signal);
  } catch (err) {
    // A SHUTDOWN abort is not a failed attempt — it is this process ending on
    // purpose, and there will be no retry because there will be no process.
    // Releasing the row to 'queued' and re-throwing (the branch below) would
    // therefore leave it 'queued' with nobody to claim it and the batch never
    // terminal; doing nothing would leave it 'running' until the reaper found
    // it minutes later and reported the redeploy as `worker_lost`. So it
    // settles HERE, terminally, through the same guarded write and the same
    // `onIngestDocFailed` bookkeeping every other failed doc uses.
    //
    // `signal.reason` is what tells a shutdown abort from any other abort —
    // the thrown `AbortError` is identical either way. Same test, same reason,
    // as `settleAbortedJob` in `generation.worker.ts`.
    if (ctrl.signal.aborted && ctrl.signal.reason === SHUTDOWN_ABORT_REASON) {
      await settleShutdownAbortedIngestJob(db, bullJob.data, jobRowId);
      return;
    }
    // Put the row back so BullMQ's retry can re-claim it. The attempt is over,
    // so nothing is running concurrently with this release. Re-throw either
    // way — swallowing here would turn a failed ingest into a silent success.
    if (jobRowId) {
      await releaseIngestJob(db, jobRowId).catch((e) => {
        ingestLog.warn({ jobRowId, err: e }, 'ingest worker: releasing job row failed');
      });
    }
    throw err;
  }

  if (jobRowId) {
    await writeIngestJobTerminal(db, jobRowId, {
      status: outcome.status,
      finishedAt: new Date(),
      error: outcome.status === 'failed' ? outcome.error : null,
    });
  }
}

/**
 * Settle a job whose embed was aborted by the cooperative shutdown.
 *
 * The guarded terminal write is what decides who runs the bookkeeping: if it
 * returns false somebody else already settled this row (a reaper, a racing
 * delivery), and bumping the batch counters a second time would push
 * `completed + failed` past `total_docs` and mis-report the batch.
 *
 * No `jobId` means a pre-`ingest_jobs` payload with no row to settle — the
 * per-doc bookkeeping still fires, so the batch counters and the
 * `ingest.failed` callback are not lost.
 */
async function settleShutdownAbortedIngestJob(
  db: Db,
  data: IngestJobData,
  jobRowId: string | undefined,
): Promise<void> {
  if (jobRowId) {
    const written = await writeIngestJobTerminal(db, jobRowId, {
      status: 'failed',
      finishedAt: new Date(),
      error: SHUTDOWN_ERROR,
    });
    if (!written) return;
  }
  await onIngestDocFailed(db, data, {
    code: SHUTDOWN_CODE,
    message: SHUTDOWN_ERROR,
  }).catch((e) => {
    ingestLog.error(
      { jobRowId, ingestId: data.ingestId, err: e },
      'ingest worker: shutdown bookkeeping failed — batch counters and ingest.failed callback NOT written',
    );
  });
}

/**
 * The body of one ingest job — everything after the claim. Returns the outcome
 * the caller settles the `ingest_jobs` row with; throws on unrecoverable errors
 * so BullMQ retries (the caller releases the claim first). Empty input is a
 * soft failure: it logs, fires the per-doc `ingest.failed` bookkeeping, and
 * returns rather than throwing.
 *
 * Callback contract (per `plan/m3-webhook-signing-followup.md`):
 *   - On success → emit `ingest.completed` for this doc.
 *   - On failure → emit `ingest.failed` for this doc, and RE-THROW so BullMQ
 *     retries. Throwing AFTER counters bump is intentional: we only want to
 *     count the doc as failed once the retries are exhausted, but BullMQ
 *     handles that bookkeeping; we count optimistically and the consumer
 *     should treat `ingest.failed` as terminal-for-this-doc (the contract
 *     spec says "ai-service has already exhausted retries"). To match the
 *     contract, we only fire `ingest.failed` from the BullMQ `on('failed')`
 *     handler, which fires after retries exhaust — see `startIngestWorker`.
 *   - When `completed + failed >= total`, emit `ingest.completed` /
 *     `ingest.failed` at the batch level too (one envelope: progress-style
 *     summary with batch counts).
 */
async function runIngestJob(
  bullJob: { id: string; data: IngestJobData },
  deps: IngestWorkerDeps = {},
  /**
   * The shutdown/abort signal from `processIngestJob`'s controller, passed to
   * both embed calls. They are the only steps here that can outlive a grace
   * window: chunking is CPU-bound and finishes in milliseconds, and the
   * document/chunk write is one local transaction. Without the signal on them
   * a SIGTERM mid-embed had nothing to interrupt and the row stayed 'running'.
   */
  signal?: AbortSignal,
): Promise<IngestJobOutcome> {
  const db = deps.db ?? defaultDb;
  const embedder = deps.embedder ?? callOpenRouterEmbedding;
  const sparseEmbedder = deps.sparseEmbedder ?? callSparseEmbed;
  // Sparse (bge-m3 learned-lexical) leg is OFF unless a stub is injected (tests)
  // or the production gate is set. Byte-identical dense/tsvector ingest when off.
  const sparseActive =
    deps.sparseEmbedder !== undefined || (env.SPARSE_ENABLED && Boolean(env.SPARSE_EMBED_URL));
  const data = bullJob.data;
  const startedAt = Date.now();

  // ── 1. Load corpus ────────────────────────────────────────────────────
  const corpusRows = await db
    .select()
    .from(corpora)
    .where(eq(corpora.id, data.corpusId))
    .limit(1);
  const corpus = corpusRows[0];
  if (!corpus) {
    // Plan finding A3: this used to return WITHOUT the failure bookkeeping, so
    // no `ingest.failed` callback fired and the batch counters never reached
    // terminal — a poller and a callback consumer both waited forever.
    ingestLog.warn(
      { corpusId: data.corpusId, ingestId: data.ingestId, bullJobId: bullJob.id },
      'ingest worker: corpus missing; failing the document',
    );
    await onIngestDocFailed(db, data, {
      code: 'corpus-missing',
      message: `corpus ${data.corpusId} no longer exists`,
    });
    return { status: 'failed', error: 'corpus-missing' };
  }

  // ── 2. Chunk ──────────────────────────────────────────────────────────
  const text = data.text;
  if (!text || text.length === 0) {
    ingestLog.warn(`ingest worker: empty text for ingestId=${data.ingestId} externalId=${data.externalId ?? '<none>'}; skipping`);
    // Treat as failure for callback purposes.
    await onIngestDocFailed(db, data, {
      code: 'empty-text',
      message: 'document text is empty',
    });
    return { status: 'failed', error: 'empty-text' };
  }
  // Request-level chunk config beats the corpus row.
  //
  // The corpus row is the wrong granularity on its own: a single corpus
  // routinely holds documents whose addressable unit is a numbered section
  // ALONGSIDE documents that are ordinary prose, and a per-corpus setting
  // forces one splitter on both. So a config supplied with the ingest request
  // (per batch, or per document) selects the structural splitter for exactly
  // the documents it came with, and leaves everything else alone.
  //
  // "Supplied AND usable" is the condition — `parseStructuralConfig` returning
  // null means the consumer sent something the splitter cannot run, and the
  // right answer then is the corpus's configured behaviour, not a failed
  // ingest. Every degradation below is warn-and-continue for that reason.
  const requestConfig = data.chunkConfig;
  const requestConfigUsable =
    requestConfig !== undefined &&
    parseStructuralConfig(requestConfig, (m) =>
      ingestLog.warn(`ingest worker: request chunkConfig rejected — ${m}`),
    ) !== null;
  const docChunks = chunkForCorpus(text, {
    chunkStrategy: requestConfigUsable ? STRUCTURAL : corpus.chunkStrategy,
    chunkSize: corpus.chunkSize,
    chunkOverlap: corpus.chunkOverlap,
    chunkConfig: requestConfigUsable ? requestConfig : corpus.chunkConfig,
  });
  // Temporal validity — parsed once and applied identically to the document
  // row and every chunk it produces. Denormalising onto chunks is deliberate:
  // the retrieval filter runs inside a hot vector/GIN scan and must not need a
  // join back to `documents` to decide whether a candidate is eligible.
  const validFrom = data.validFrom ? new Date(data.validFrom) : null;
  const validTo = data.validTo ? new Date(data.validTo) : null;

  if (docChunks.length === 0) {
    ingestLog.warn(`ingest worker: 0 chunks for ingestId=${data.ingestId}; skipping`);
    await onIngestDocFailed(db, data, {
      code: 'zero-chunks',
      message: 'document produced no chunks',
    });
    return { status: 'failed', error: 'zero-chunks' };
  }

  // ── 3. Budget hold + embed (batch) ────────────────────────────────────
  // Reserve BEFORE the paid call, so an org over its cap spends nothing.
  // Estimated from the chunker's token counts; the true-up below corrects it.
  const budget = deps.budget ?? new BudgetEnforcer(db);
  const estimateUsd = priceForEmbedding(
    corpus.embeddingModel,
    docChunks.reduce((n, c) => n + c.tokens, 0),
  );
  // One trace per ATTEMPT: a BullMQ retry takes a fresh hold, and the
  // true-up must settle only its own.
  const traceId = `ingest:${data.jobId ?? `bull:${bullJob.id}`}:${randomUUID()}`;
  try {
    await budget.reserve({
      org: data.org,
      amountUsd: estimateUsd,
      traceId,
      project: data.project,
      jobId: data.jobId,
    });
  } catch (err) {
    // Fail the DOCUMENT, not the attempt: a retry seconds later meets the
    // same cap, so BullMQ's backoff would only delay the `ingest.failed`.
    if (
      err instanceof BudgetExceeded ||
      err instanceof BudgetNotConfigured ||
      err instanceof BudgetMisconfigured
    ) {
      ingestLog.warn(
        { org: data.org, ingestId: data.ingestId, estimateUsd, code: err.code },
        'ingest worker: budget refused the embed; failing the document',
      );
      await onIngestDocFailed(db, data, { code: err.code, message: err.message });
      return { status: 'failed', error: err.code };
    }
    throw err;
  }

  let embedResult: Awaited<ReturnType<typeof embedder>>;
  try {
    embedResult = await embedder({
      model: corpus.embeddingModel,
      input: docChunks.map((c) => c.text),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    // No embedding came back, so nothing is owed: return the whole hold.
    // Covers a shutdown abort too — that path re-enters via this throw.
    await budget
      .refund({ org: data.org, amountUsd: estimateUsd, traceId })
      .catch((e: unknown) => {
        ingestLog.error(
          { org: data.org, ingestId: data.ingestId, traceId, err: e },
          'ingest worker: refunding the embed hold failed',
        );
      });
    throw err;
  }
  // The provider has charged from here on, whatever happens below (a count or
  // dimension mismatch, a failed insert): true up to the ACTUAL cost now.
  const cost =
    embedResult.usage.estimatedCostUsd > 0
      ? embedResult.usage.estimatedCostUsd
      : priceForEmbedding(corpus.embeddingModel, embedResult.usage.inputTokens);
  // ⚠ Logged, not thrown: throwing would release the job to a BullMQ retry
  // that embeds — and pays for — the same document again.
  await budget
    .adjust({ org: data.org, deltaUsd: estimateUsd - cost, traceId })
    .catch((e: unknown) => {
      ingestLog.error(
        { org: data.org, ingestId: data.ingestId, traceId, estimateUsd, cost, err: e },
        'ingest worker: budget true-up failed; the hold stays at the estimate',
      );
    });
  if (embedResult.embeddings.length !== docChunks.length) {
    throw new Error(
      `ingest worker: embedding count mismatch (got ${embedResult.embeddings.length}, expected ${docChunks.length})`,
    );
  }
  // Dimension guard (Fable review MUST-FIX 1 / #6). The `chunks.embedding`
  // column is a fixed-width `vector(corpus.embeddingDim)`; a vector of any
  // other length fails the pgvector insert. We check BEFORE writing the
  // document row so a dimension mismatch (a known-model mismatch is already
  // refused at corpus creation, but an UNKNOWN model or a drifted
  // `EMBEDDING_DIM` knob can still produce one) throws here — NOT after a
  // partial write. Throwing before the insert is what stops BullMQ retries
  // from accumulating duplicate document rows on the null-externalId path.
  const expectedDim = corpus.embeddingDim;
  const badIdx = embedResult.embeddings.findIndex(
    (v) => (Array.isArray(v) ? v.length : -1) !== expectedDim,
  );
  if (badIdx !== -1) {
    const gotLen = Array.isArray(embedResult.embeddings[badIdx])
      ? embedResult.embeddings[badIdx]!.length
      : 'non-array';
    throw new Error(
      `ingest worker: embedding dimension mismatch for corpus ${data.corpusId} ` +
        `(model ${corpus.embeddingModel}): vector ${badIdx} is ${gotLen}-dim but the corpus ` +
        `expects ${expectedDim} (chunks.embedding is fixed-width). Refusing to insert ` +
        `to avoid a poison-pill retry loop and duplicate document rows.`,
    );
  }

  // ── 3b. Learned-sparse (bge-m3) embed — OPT-IN, computed BEFORE any insert ──
  // When the sparse leg is active (an injected embedder for tests/eval, or the
  // `SPARSE_ENABLED` + `SPARSE_EMBED_URL` production gate), embed the same chunk
  // texts with the bge-m3 sparse sibling and build the sparsevec literals HERE —
  // BEFORE the document/chunk insert below, exactly mirroring the dense
  // dimension guard above.
  //
  // WHY BEFORE THE INSERT (HIGH #1): the sibling is a network call and can throw
  // (down service, timeout, count mismatch). This embed + the sparse UPDATE used
  // to run AFTER the doc/chunk insert (old §5b). On a throw there, processIngestJob
  // throws → BullMQ retries (attempts:3) → and the null-`externalId` path has NO
  // dedupe, so every retry inserted a fresh, fully-retrievable duplicate doc+chunk
  // set (missing only sparse). Computing the sparse vectors before the insert means
  // a sibling failure throws with NOTHING written — no duplicate rows accumulate on
  // retry, the same guarantee the dense dimension guard already provides.
  //
  // FAIL-LOUD is DELIBERATE, not fail-safe: the seam's own design notes (the
  // `callSparseEmbed` docstring and §5b) require a broken sibling to SURFACE
  // rather than silently produce a half-indexed corpus. Throwing before the
  // insert reconciles fail-loud with the no-duplicate invariant. The actual
  // sparse WRITE still runs in §5b — it needs the inserted `documentId` — but the
  // failure-prone step (the sibling call) is now pre-insert.
  let sparseLiterals: string[] | null = null;
  if (sparseActive) {
    const sparseResult = await sparseEmbedder({
      model: env.SPARSE_EMBED_MODEL,
      input: docChunks.map((c) => c.text),
      ...(signal ? { signal } : {}),
    });
    if (sparseResult.sparse.length !== docChunks.length) {
      throw new Error(
        `ingest worker: sparse embedding count mismatch (got ${sparseResult.sparse.length}, ` +
          `expected ${docChunks.length}) for corpus ${data.corpusId}`,
      );
    }
    sparseLiterals = sparseResult.sparse.map((v) => toSparsevecLiteral(v, env.SPARSE_DIM));
  }

  // ── 4–5b. Atomic write: document + chunks + tsvector + sparse ─────────
  // Everything that WRITES this document runs inside ONE transaction, so ANY
  // failure — a chunk insert, the tsvector build, or the sparse UPDATE — rolls
  // the WHOLE document back. Before this, the dense chunk INSERT COMMITTED before
  // the sparse write ran (old §5b lived after the insert with no surrounding
  // tx), so a sparse-write failure left a half-indexed dense-only document. The
  // transaction makes it clean all-or-nothing.
  //
  // Read-only / network steps stay OUTSIDE the tx on purpose: the corpus load
  // (§1) and the dense + sparse EMBED (§3/§3b) already ran, and the sparse
  // vectors are computed PRE-insert (§3b) so a sibling failure writes nothing —
  // we never hold a transaction open across a network call.
  //
  // 🔴 TRANSACTIONAL OUTBOX (plan PLAN-live-ingest §2.2, findings
  // A6/A7). Usage tracking (§6), the batch counters, the `callback_deliveries`
  // row(s) and the `ingest_jobs` terminal write (§7) commit in the SAME
  // transaction as the document. Before, they ran after commit, and the
  // delivery insert was fire-and-forget: a failed insert left an indexed
  // document whose consumer was never told, with one `console.warn` as the
  // only trace. Now the document exists if and only if its callback row does.
  // A failure anywhere rolls everything back and BullMQ retries a job that
  // wrote nothing — so the retry cannot duplicate the document either. The
  // POST itself starts only after commit (`kickOutbox`); a crash in between
  // leaves a `pending` row the sweeper delivers.
  const { outbox } = await db.transaction(async (tx) => {
    // ── 4. Dedupe / upsert the document row ───────────────────────────────
    let docId: string;
    if (data.externalId !== null) {
      const existing = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.corpusId, data.corpusId),
            eq(documents.externalId, data.externalId),
          ),
        )
        .limit(1);
      if (existing[0]) {
        docId = existing[0].id;
        // Drop prior chunks (cascade-on-delete only triggers when the parent
        // doc is deleted; we want to KEEP the doc row and just refresh its
        // body, so wipe the chunks manually). Now inside the tx: the delete +
        // re-insert of a re-ingested doc's chunks is itself atomic.
        await tx.delete(chunks).where(eq(chunks.documentId, docId));
        await tx
          .update(documents)
          .set({
            text,
            title: data.title ?? null,
            sourceUrl: data.sourceUrl ?? null,
            metadata: data.metadata ?? null,
            language: data.language ?? null,
            validFrom,
            validTo,
            ingestId: data.ingestId,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, docId));
      } else {
        const inserted = await tx
          .insert(documents)
          .values({
            corpusId: data.corpusId,
            org: data.org,
            project: data.project,
            externalId: data.externalId,
            text,
            title: data.title ?? null,
            sourceUrl: data.sourceUrl ?? null,
            metadata: data.metadata ?? null,
            language: data.language ?? null,
            validFrom,
            validTo,
            ingestId: data.ingestId,
          })
          .returning({ id: documents.id });
        const row = inserted[0];
        if (!row) throw new Error('ingest worker: document insert returned no row');
        docId = row.id;
      }
    } else {
      const inserted = await tx
        .insert(documents)
        .values({
          corpusId: data.corpusId,
          org: data.org,
          project: data.project,
          externalId: null,
          text,
          title: data.title ?? null,
          sourceUrl: data.sourceUrl ?? null,
          metadata: data.metadata ?? null,
          language: data.language ?? null,
          validFrom,
          validTo,
          ingestId: data.ingestId,
        })
        .returning({ id: documents.id });
      const row = inserted[0];
      if (!row) throw new Error('ingest worker: document insert returned no row');
      docId = row.id;
    }

    // ── 5. Insert chunk rows ──────────────────────────────────────────────
    const chunkValues = docChunks.map((c, i) => ({
      documentId: docId,
      corpusId: data.corpusId,
      org: data.org,
      project: data.project,
      ordinal: c.ordinal,
      text: c.text,
      tokens: c.tokens,
      embedding: embedResult.embeddings[i] as number[],
      // Round-trip the consumer's opaque doc-level metadata onto each chunk so
      // /v1/retrieve (which SELECTs chunks.metadata) returns it. Without this,
      // chunk.metadata is always null and consumers cannot
      // map a retrieved chunk back to their source row.
      //
      // Chunker-derived metadata (structural section ids, under whatever `key`
      // the consumer's own `chunk_config` named) is merged UNDERNEATH the
      // consumer's, so a consumer key always wins a collision. The consumer
      // owns its namespace; we are only
      // adding what it could not have known — which chunk of the document this
      // is, structurally.
      metadata: mergeChunkMetadata(data.metadata, c.metadata),
      validFrom,
      validTo,
    }));
    if (chunkValues.length > 0) {
      await tx.insert(chunks).values(chunkValues);
      // Build the lexical index for the chunks we just wrote. A separate
      // statement rather than part of the INSERT because the text search
      // configuration is per-corpus and has to be bound as a parameter; and a
      // separate statement rather than a GENERATED column for the same reason.
      // Scoped to this document so a re-ingest of one doc never rewrites the
      // whole corpus. `::regconfig` on a bound param — the config name is never
      // interpolated into SQL text.
      await tx.execute(sql`
        UPDATE "chunks"
           SET "text_search" = to_tsvector(${corpus.textSearchConfig}::regconfig, "text")
         WHERE "document_id" = ${docId}::uuid
      `);

      // ── 5b. Learned-sparse (bge-m3) index — OPT-IN, gated ────────────────────
      // Write the sparse vectors embedded in §3b (computed BEFORE this insert, so a
      // sibling failure can never leave a duplicate doc on retry — see §3b). The
      // dense path above is untouched (still OpenRouter, cost tracked as before);
      // sparse is purely additive, so a gate-off ingest is byte-identical
      // (`sparseLiterals` stays null and this block is skipped). Matched back to the
      // just-inserted rows by (document_id, ordinal) — ordinal is unique within a
      // document. Runs inside the SAME transaction as the insert above, so a
      // sparse-write failure rolls the whole document back — no dense-only
      // half-index.
      if (sparseLiterals) {
        // Ship the (ordinal, sparsevec-literal) pairs as ONE json param and
        // unnest them server-side. A raw JS array interpolated into drizzle's
        // `sql` template is NOT a single array bind: drizzle expands it into a
        // parenthesised param LIST — `unnest(($1,$2,…)::int[])` — and pushes each
        // element as its own scalar param, so the first ordinal (a raw number)
        // reaches postgres.js's Bind step as a non-string and throws
        // (`"string" argument … Received type number (0)`). A single json string
        // is one clean bind, and it needs no manual PG-array escaping of the
        // sparsevec literals (which themselves contain commas and braces).
        // `jsonb_array_elements` yields one `[ordinal, literal]` row per chunk;
        // the casts pull each field back out.
        const pairs = JSON.stringify(
          docChunks.map((c, i) => [c.ordinal, sparseLiterals![i]]),
        );
        await tx.execute(sql`
          UPDATE "chunks" AS c
             SET "sparse_embedding" = (d.pair->>1)::sparsevec
            FROM (
              SELECT jsonb_array_elements(${pairs}::jsonb) AS pair
            ) AS d
           WHERE c."document_id" = ${docId}::uuid
             AND c."ordinal" = (d.pair->>0)::int
        `);
      }
    }

    // ── 6. Usage tracking ─────────────────────────────────────────────────
    await tx.insert(usageLogs).values({
      org: data.org,
      project: data.project,
      provider: embeddingProviderLabel(embedResult),
      model: corpus.embeddingModel,
      endpoint: '/v1/ingest',
      inputTokens: embedResult.usage.inputTokens,
      outputTokens: 0,
      estimatedCostUsd: usdString(cost),
      actualCostUsd: usdString(cost),
      status: 'completed',
      metadata: { ingestId: data.ingestId, documentId: docId, chunkCount: docChunks.length },
    });

    // ── 7. Callback contract: per-doc completion + batch terminal ─────────
    const outbox = await recordIngestDocCompleted(tx, data, {
      docId: data.externalId ?? docId,
      chunkCount: docChunks.length,
      model: corpus.embeddingModel,
      dimensions: corpus.embeddingDim,
      costUsd: cost,
      durationMs: Date.now() - startedAt,
    });

    // Settle the job row in the same commit. A post-commit settle that failed
    // used to leave the row 'running' over a committed document, which the
    // reaper later reported as `worker_lost` — an `ingest.failed` for a
    // document that was indexed.
    if (data.jobId) {
      await writeIngestJobTerminal(tx, data.jobId, {
        status: 'completed',
        finishedAt: new Date(),
        error: null,
      });
    }

    return { outbox };
  });

  kickOutbox(db, outbox);
  return { status: 'completed' };
}

// ---------------------------------------------------------------------------
// Callback contract: terminal-state helpers
// ---------------------------------------------------------------------------

/**
 * One delivery row written inside a transaction, waiting for that transaction
 * to commit before its first POST. See `insertCallbackDelivery`.
 */
interface OutboxEntry {
  inserted: InsertedDelivery;
  envelope: BaseEnvelope;
  opts: EnqueueOptions;
}

/** Start every committed outbox entry. Never throws (see `kickDelivery`). */
function kickOutbox(db: Db, outbox: readonly OutboxEntry[]): void {
  for (const e of outbox) kickDelivery(e.inserted, e.envelope, e.opts, { db });
}

/** Insert one delivery row in `tx` and queue it for the post-commit kick. */
async function stageCallback(
  tx: DbOrTx,
  outbox: OutboxEntry[],
  envelope: BaseEnvelope,
  opts: EnqueueOptions,
): Promise<void> {
  const inserted = await insertCallbackDelivery(envelope, opts, { db: tx });
  outbox.push({ inserted, envelope, opts });
}

/**
 * Plan finding A6. A doc whose `ingest_requests` row is gone cannot be
 * reported to anyone: there is no callbackUrl and no counter. That used to be
 * a silent `return`. It stays non-fatal (the document itself is fine), but it
 * is an ERROR and a counted event now.
 */
function reportMissingRequestRow(data: IngestDocCoords, outcome: 'completed' | 'failed'): void {
  recordCallbackEmitSkipped('ingest_request_missing');
  ingestLog.error(
    { ingestId: data.ingestId, org: data.org, project: data.project, externalId: data.externalId, outcome },
    'ingest worker: ingest_requests row missing — no counters moved and no callback emitted for this document',
  );
}

/**
 * Inside the document transaction: increment `completed_docs`, stage the
 * per-doc `ingest.completed` delivery (plus `ingest.progress` per the contract
 * throttle — every 10 docs or 30s on batches > 5) and flip the batch terminal
 * when this was the last doc. Returns the staged deliveries for the caller to
 * kick AFTER commit.
 */
async function recordIngestDocCompleted(
  tx: DbOrTx,
  data: IngestJobData,
  result: {
    docId: string;
    chunkCount: number;
    model: string;
    dimensions: number;
    costUsd: number;
    durationMs: number;
  },
): Promise<OutboxEntry[]> {
  const outbox: OutboxEntry[] = [];
  const requestRow = await bumpIngestCounters(tx, data.ingestId, 'completed');
  if (!requestRow) {
    reportMissingRequestRow(data, 'completed');
    return outbox;
  }

  const now = new Date();
  if (requestRow.callbackUrl) {
    await stageCallback(
      tx,
      outbox,
      {
        event: 'ingest.completed',
        emittedAt: now.toISOString(),
        ingestId: data.ingestId,
        corpus: requestRow.corpus,
        docId: result.docId,
        embeddings: {
          chunkCount: result.chunkCount,
          model: result.model,
          dimensions: result.dimensions,
        },
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      },
      {
        url: requestRow.callbackUrl,
        apiKeyId: requestRow.apiKeyId,
        source: 'ingest',
        sourceId: data.ingestId,
        itemKey: result.docId,
        org: data.org,
        project: data.project,
      },
    );

    // Progress event throttle (only for batches > 5 docs, every 10 or 30s).
    if (
      await maybeMarkProgress(
        tx,
        data.ingestId,
        requestRow.totalDocs,
        requestRow.completedDocs,
        now,
      )
    ) {
      await stageCallback(
        tx,
        outbox,
        {
          event: 'ingest.progress',
          emittedAt: now.toISOString(),
          ingestId: data.ingestId,
          corpus: requestRow.corpus,
          totalDocs: requestRow.totalDocs,
          completedDocs: requestRow.completedDocs,
          failedDocs: requestRow.failedDocs,
        },
        {
          url: requestRow.callbackUrl,
          apiKeyId: requestRow.apiKeyId,
          source: 'ingest',
          sourceId: data.ingestId,
          itemKey: null,
          org: data.org,
          project: data.project,
        },
      );
    }
  }
  await maybeMarkBatchTerminal(tx, data, requestRow);
  return outbox;
}

/**
 * The tenant + batch coordinates the failure bookkeeping needs. Narrower than
 * `IngestJobData` (which is structurally assignable to it) so the reaper can
 * call it from an `ingest_jobs` ROW, with no BullMQ payload in hand.
 */
interface IngestDocCoords {
  ingestId: string;
  org: string;
  /** Nullable on the `ingest_jobs` row; `IngestJobData` always carries one. */
  project: string | null;
  externalId: string | null;
}

/**
 * Count a failed doc, stage its `ingest.failed` delivery and flip the batch
 * terminal — in ONE transaction, then kick the delivery after commit.
 *
 * Throws when the write fails, so no caller can lose the failure silently:
 * inside a job the throw becomes a BullMQ retry (nothing was written, so a
 * retry is safe); the reaper and the `failed` listener log it at ERROR.
 */
async function onIngestDocFailed(
  db: Db,
  data: IngestDocCoords,
  error: { code: string; message: string },
): Promise<void> {
  const outbox = await db.transaction(async (tx) => {
    const staged: OutboxEntry[] = [];
    const requestRow = await bumpIngestCounters(tx, data.ingestId, 'failed');
    if (!requestRow) {
      reportMissingRequestRow(data, 'failed');
      return staged;
    }
    const now = new Date();
    const docId = data.externalId ?? data.ingestId; // fallback: caller didn't supply an id
    if (requestRow.callbackUrl) {
      await stageCallback(
        tx,
        staged,
        {
          event: 'ingest.failed',
          emittedAt: now.toISOString(),
          ingestId: data.ingestId,
          corpus: requestRow.corpus,
          docId,
          error,
        },
        {
          url: requestRow.callbackUrl,
          apiKeyId: requestRow.apiKeyId,
          source: 'ingest',
          sourceId: data.ingestId,
          itemKey: docId,
          org: data.org,
          project: data.project,
        },
      );
    }
    await maybeMarkBatchTerminal(tx, data, requestRow);
    return staged;
  });
  kickOutbox(db, outbox);
}

interface IngestRequestSnapshot {
  callbackUrl: string | null;
  apiKeyId: string | null;
  corpus: string;
  totalDocs: number;
  completedDocs: number;
  failedDocs: number;
  status: 'queued' | 'running' | 'partial' | 'completed' | 'failed';
}

/**
 * Atomic `UPDATE … RETURNING` to bump completed/failed counters and read the
 * post-update snapshot back. Returns null if no `ingest_requests` row exists
 * for the id (legacy / orphan).
 */
async function bumpIngestCounters(
  db: DbOrTx,
  ingestRequestId: string,
  kind: 'completed' | 'failed',
): Promise<IngestRequestSnapshot | null> {
  const column = kind === 'completed' ? ingestRequests.completedDocs : ingestRequests.failedDocs;
  const rows = await db
    .update(ingestRequests)
    .set(
      kind === 'completed'
        ? { completedDocs: sql`${column} + 1`, status: sql`CASE WHEN ${ingestRequests.status} = 'queued' THEN 'running'::ingest_request_status ELSE ${ingestRequests.status} END` }
        : { failedDocs: sql`${column} + 1`, status: sql`CASE WHEN ${ingestRequests.status} = 'queued' THEN 'running'::ingest_request_status ELSE ${ingestRequests.status} END` },
    )
    .where(eq(ingestRequests.id, ingestRequestId))
    .returning({
      callbackUrl: ingestRequests.callbackUrl,
      apiKeyId: ingestRequests.apiKeyId,
      corpus: ingestRequests.corpus,
      totalDocs: ingestRequests.totalDocs,
      completedDocs: ingestRequests.completedDocs,
      failedDocs: ingestRequests.failedDocs,
      status: ingestRequests.status,
    });
  return rows[0] ?? null;
}

/**
 * When `completed + failed >= total`, flip status to its terminal value
 * (`completed` / `partial` / `failed`) and emit no additional callback —
 * per the contract spec the per-doc events ARE the terminal signal; we do
 * NOT fire a duplicate batch-level `ingest.completed`. The contract says
 * "plus a final ingest.completed envelope for the batch IF any docs
 * succeeded" — we keep that as a future enhancement.
 */
async function maybeMarkBatchTerminal(
  db: DbOrTx,
  data: Pick<IngestDocCoords, 'ingestId'>,
  snapshot: IngestRequestSnapshot,
): Promise<void> {
  const { totalDocs, completedDocs, failedDocs } = snapshot;
  if (completedDocs + failedDocs < totalDocs) return;
  const nextStatus: 'completed' | 'partial' | 'failed' =
    failedDocs === 0 ? 'completed' : completedDocs === 0 ? 'failed' : 'partial';
  await db
    .update(ingestRequests)
    .set({ status: nextStatus, finishedAt: new Date() })
    .where(eq(ingestRequests.id, data.ingestId));
}

// ---------------------------------------------------------------------------
// Worker lost — a claimed ingest row whose worker died
// ---------------------------------------------------------------------------

/**
 * Guarded transition, same shape and same reasoning as
 * `settleLostGenerationJob`: ONE statement whose rowcount decides who runs the
 * non-idempotent bookkeeping. Postgres evaluates `now()`, so replicas with
 * drifting clocks still agree on "past the window".
 */
export async function settleLostIngestJob(
  db: Db,
  jobRowId: string,
  opts: { windowMs: number },
): Promise<typeof ingestJobs.$inferSelect | null> {
  const seconds = opts.windowMs / 1000;
  const rows = await db
    .update(ingestJobs)
    .set({ status: 'failed', error: WORKER_LOST_ERROR, finishedAt: new Date() })
    .where(
      and(
        eq(ingestJobs.id, jobRowId),
        eq(ingestJobs.status, 'running'),
        sql`${ingestJobs.startedAt} IS NOT NULL`,
        sql`${ingestJobs.startedAt} < now() - make_interval(secs => ${seconds})`,
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export interface IngestReapDeps {
  db?: Db;
  windowMs?: number;
  /** Defaults to a `BudgetEnforcer` on `db`. */
  budget?: IngestBudget;
}

/**
 * Reap ONE ingest job if it is lost. True when this call settled it.
 *
 * `ingest_jobs` carries the tenant coordinates and the batch id, so the
 * bookkeeping call needs nothing from the BullMQ payload — which is the point:
 * the periodic reaper has no payload to read.
 */
export async function reapLostIngestJob(
  jobRowId: string,
  deps: IngestReapDeps = {},
): Promise<boolean> {
  const db = deps.db ?? defaultDb;
  const windowMs = deps.windowMs ?? lostWindowMs();
  const settled = await settleLostIngestJob(db, jobRowId, { windowMs });
  if (!settled) return false;

  // Refund AFTER the guarded transition won, so two sweeps cannot both refund.
  // The ledger is the source: only a hold still `reserved` (the worker died
  // between reserve and true-up) is returned, and `jobId` closes it out.
  const budget = deps.budget ?? new BudgetEnforcer(db);
  try {
    const held = await budget.heldReserveUsd(jobRowId);
    if (held !== null && held > 0) {
      await budget.refund({ org: settled.org, amountUsd: held, jobId: jobRowId });
    }
  } catch (e) {
    ingestLog.error(
      { jobRowId, org: settled.org, err: e },
      'ingest worker: refunding the lost job\'s budget hold failed',
    );
  }

  await onIngestDocFailed(
    db,
    {
      ingestId: settled.ingestId,
      org: settled.org,
      project: settled.project,
      externalId: settled.externalId,
    },
    { code: WORKER_LOST_CODE, message: WORKER_LOST_ERROR },
  ).catch((e) => {
    ingestLog.error(
      { jobRowId, ingestId: settled.ingestId, err: e },
      'ingest worker: lost-job bookkeeping failed — batch counters and ingest.failed callback NOT written',
    );
  });
  ingestLog.warn(
    `ingest worker: job row ${jobRowId} presumed LOST (running for longer than ` +
      `${windowMs} ms) — failed as '${WORKER_LOST_ERROR}'. It is NOT re-run.`,
  );
  return true;
}

/** Sweep every lost ingest job. One guarded UPDATE per row; see above. */
export async function reapLostIngestJobs(
  deps: IngestReapDeps & { batchSize?: number } = {},
): Promise<string[]> {
  const db = deps.db ?? defaultDb;
  const windowMs = deps.windowMs ?? lostWindowMs();
  const seconds = windowMs / 1000;
  const candidates = await db
    .select({ id: ingestJobs.id })
    .from(ingestJobs)
    .where(
      and(
        eq(ingestJobs.status, 'running'),
        sql`${ingestJobs.startedAt} IS NOT NULL`,
        sql`${ingestJobs.startedAt} < now() - make_interval(secs => ${seconds})`,
      ),
    )
    .limit(deps.batchSize ?? 100);
  const reaped: string[] = [];
  for (const c of candidates) {
    if (
      await reapLostIngestJob(c.id, {
        db,
        windowMs,
        ...(deps.budget ? { budget: deps.budget } : {}),
      })
    ) {
      reaped.push(c.id);
    }
  }
  return reaped;
}

export async function startIngestWorker(
  deps: IngestWorkerDeps = {},
): Promise<{ worker: Worker<IngestJobData>; stop: () => Promise<void> }> {
  const connection = deps.connection;
  if (!connection) {
    throw new Error('startIngestWorker: deps.connection (Runtime.redis) is required');
  }
  const db = deps.db ?? defaultDb;
  const inFlight: InFlightMap = deps.inFlight ?? new Map();
  const worker = new Worker<IngestJobData>(
    INGEST_QUEUE_NAME,
    async (job) => {
      await processIngestJob({ id: String(job.id ?? ''), data: job.data }, {
        ...deps,
        inFlight,
      });
    },
    {
      connection,
      concurrency: deps.concurrency ?? 3,
      // Same lock/stall window as the generation worker — one shared helper so
      // the two can't drift. An ingest job embeds a whole document in one
      // batch call, which regularly outruns BullMQ's 30 s default lock.
      ...workerRuntimeOptions(deps.runtime),
    },
  );

  attachWorkerLifecycleLogging(worker, 'ingest worker');

  // BullMQ fires `failed` on each attempt; only emit `ingest.failed` once
  // retries are exhausted (`job.attemptsMade >= job.opts.attempts`). The
  // counter bump + callback contract emit happens then.
  worker.on('failed', (job, err) => {
    ingestLog.error({ bullJobId: job?.id, err }, 'ingest worker: BullMQ-level failure');
    if (!job) return;
    const attempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade >= attempts) {
      // Retries exhausted: settle the job row. Each failed attempt RELEASED it
      // back to 'queued', which is what let those retries re-claim; nothing
      // else will now, so 'failed' is the row's final word.
      if (job.data.jobId) {
        void writeIngestJobTerminal(db, job.data.jobId, {
          status: 'failed',
          finishedAt: new Date(),
          error: err.message,
        }).catch(() => undefined);
      }
      void onIngestDocFailed(db, job.data, {
        code: 'job-failed',
        message: err.message,
      }).catch((e) => {
        ingestLog.error(
          {
            bullJobId: job.id,
            ingestId: job.data.ingestId,
            err: e,
          },
          'ingest worker: failure bookkeeping failed — batch counters and ingest.failed callback NOT written',
        );
      });
    }
  });

  return {
    worker,
    /**
     * COOPERATIVE SHUTDOWN. The same four steps, in the same order, as
     * `startGenerationWorker.stop()` — see `services/jobs/shutdown.ts` for the
     * reasoning behind each:
     *
     *   1. stop taking NEW jobs, without waiting for the active ones
     *   2. let the active ones finish, for up to `SHUTDOWN_GRACE_MS`
     *   3. abort whatever is left, so it settles as a NAMED terminal job
     *   4. close the worker
     *
     * 🔴 STEP 1 STARTS `close()` WITHOUT AWAITING IT, and it is NOT `pause()`.
     * This worker used to call `worker.pause(true)` and claim that stopped new
     * fetches. It does not. MEASURED against a real Redis on the generation
     * queue: `pause()` only flags the fetch LOOP, so a fetch already blocked
     * inside Redis still returns its job and the worker runs it — a job
     * enqueued after SIGTERM was claimed and processed anyway. `close()`
     * disconnects the blocking connection, which cancels that outstanding
     * fetch; it is the only one of the two that actually stops taking work.
     *
     * ⚠ …and it is NOT awaited here, because awaiting it is the original bug:
     * `close()` then waits on the active jobs with NO BOUND. An ingest job is
     * one batch embed of a whole document, which routinely outruns the
     * platform's 10 s stop timeout — so the SIGKILL landed mid-embed and left
     * the `ingest_jobs` row at 'running' until the reaper called it
     * `worker_lost` minutes later. Starting the close now and awaiting it LAST
     * gives both halves: the fetch stops at once, the drain is bounded by us.
     *
     * The other half of the old comment was wrong too: ingest DOES have an
     * abort seam now — `processIngestJob` passes its controller's signal into
     * the dense and sparse embed calls, which is the one step long enough to
     * be worth interrupting.
     */
    stop: async () => {
      // 1. No new work. From here the only jobs that exist are the ones
      //    already inside the handler, i.e. the ones in `inFlight`. Nothing
      //    between here and step 4 may await `closing`, or the grace window
      //    collapses back into the old unbounded wait.
      const closing = worker.close().catch(() => undefined);

      // 2. Grace. The common case drains here and nothing below runs.
      const graceMs = deps.shutdownGraceMs ?? shutdownGraceMs();
      if (inFlight.size > 0) {
        ingestLog.info(
          `ingest worker: draining ${inFlight.size} in-flight job(s), ` +
            `grace ${graceMs}ms`,
        );
      }
      await waitForDrain(inFlight, graceMs);

      // 3. Past the window: abort the embed through each job's own controller,
      //    stamped with the shutdown reason so `processIngestJob` settles the
      //    row as 'failed'/`shutdown` and runs the batch bookkeeping, rather
      //    than releasing it for a retry that will never come. Then give each
      //    job a bounded moment to finish that settle path.
      if (inFlight.size > 0) {
        ingestLog.warn(
          `ingest worker: shutdown grace of ${graceMs}ms expired with ` +
            `${inFlight.size} job(s) still running; aborting them as ` +
            `'${SHUTDOWN_ERROR}'`,
        );
        for (const ctrl of inFlight.values()) ctrl.abort(SHUTDOWN_ABORT_REASON);
        const drained = await waitForDrain(inFlight, SHUTDOWN_SETTLE_MS);
        if (!drained) {
          ingestLog.error(
            `ingest worker: ${inFlight.size} job(s) did not settle within ` +
              `${SHUTDOWN_SETTLE_MS}ms of being aborted; the reaper will ` +
              `recover them as '${WORKER_LOST_ERROR}'`,
          );
        }
      }

      // 4. Await the close started at step 1 — never `close(true)`. By now
      //    there is nothing active for it to wait on, so it returns promptly;
      //    forcing it would drop the job lock without settling the row, which
      //    is the exact state this sequence exists to avoid.
      //
      //    🔴 BOUNDED, for the same reason as the generation worker's step 4 —
      //    and MEASURED here, not assumed. With a bare `await closing` an
      //    IDLE ingest worker (nothing in flight, nothing to abort) still held
      //    the shutdown for ~5 s: BullMQ's blocking fetch has its own timeout,
      //    and `close()` does not return until it lapses. On the HTTP-only
      //    shutdown path that pushed process exit from ~2.4 s to 7.03 s
      //    against a promised `grace + 5 s` = 7 s — a bound the service missed
      //    by 31 ms while doing nothing at all.
      if (!(await awaitBounded(closing, graceMs))) {
        ingestLog.error(
          `ingest worker: worker.close() did not return within ${graceMs}ms of the ` +
            `shutdown grace; leaving it and exiting.`,
        );
      }
    },
  };
}
