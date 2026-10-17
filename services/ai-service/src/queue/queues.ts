// Typed BullMQ queue + FlowProducer construction, with an in-memory mock set.
//
// One queue (`generation`); job `name` is formatted `generation:<org>:<unitType>`
// so the worker's BullMQ rate limiter can key off prefix for per-org fairness.
// `FlowProducer` carries `dependsOn` (see plan/m3-m4-decisions.md §3).
//
// The mock set (in-memory queue + flow producer, no Redis) is chosen by the
// CALLER via `createQueues({ mock: true })` — see `src/runtime.ts`, which
// defaults it off `config.NODE_ENV`. Nothing in this module reads the
// environment to decide.

import type { Redis } from 'ioredis';

import {
  Queue as BullQueue,
  FlowProducer,
  type FlowJob,
  type JobsOptions,
  type Queue,
} from 'bullmq';

import { env } from '../config/env.js';
import { bullmqStalledTotal } from '../metrics/registry.js';
import { QUEUE_NAMES } from './connection.js';
import type { GenerationJobData } from '../types/generation.js';

export const GENERATION_QUEUE_NAME = QUEUE_NAMES.generation;
export const INGEST_QUEUE_NAME = QUEUE_NAMES.ingest;

// ---------------------------------------------------------------------------
// Ingest queue payload — see decisions §14. One job per `IngestDocument`,
// shaped so the worker can chunk/embed/insert without re-reading the route's
// request. Kept opaque-text (`text`) per decisions §13.
// ---------------------------------------------------------------------------

export interface IngestJobData {
  ingestId: string;
  /**
   * The `ingest_jobs` row this delivery is allowed to claim. Written by
   * `IngestService.ingestBatch` before the job is added to the queue.
   *
   * OPTIONAL for forward-compatibility ONLY: jobs enqueued by a build older
   * than the `ingest_jobs` table are still sitting in Redis across a deploy and
   * carry no id. Those run UNCLAIMED — exactly the old behaviour, including the
   * old double-embed risk on a stall — rather than being dropped. Every job
   * this build enqueues has one.
   */
  jobId?: string;
  corpusId: string;
  org: string;
  project: string;
  /** Consumer-supplied dedupe key (decisions §15); null ⇒ always new doc. */
  externalId: string | null;
  text: string;
  title?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
  /**
   * Temporal validity of this document, ISO-8601. Half-open
   * `[validFrom, validTo)`; either side may be omitted for "unbounded". Copied
   * onto every chunk so `POST /v1/retrieve` with `asOf` can filter superseded
   * content inside the candidate set. Omitted on both sides ⇒ always valid,
   * which is the pre-existing behaviour for every document ingested so far.
   */
  validFrom?: string;
  validTo?: string;
  /**
   * Per-document ISO-style language code. Stored on the document row for a
   * future per-chunk stemming path. Does NOT drive the lexical regconfig — that
   * is the PER-CORPUS `text_search_config` (mapped from the corpus's language),
   * which IS live.
   */
  language?: string;
  /**
   * Chunking configuration resolved for THIS document at enqueue time
   * (document-level override, else the batch-level field). Carried on the job
   * rather than re-read from the corpus row because it is a per-request
   * decision: one corpus legitimately holds both documents with a numbered
   * structure and documents that are ordinary prose.
   *
   * Absent ⇒ the worker uses the corpus row's `chunk_strategy` /
   * `chunk_config`, which is the pre-existing behaviour.
   */
  chunkConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mock shapes
// ---------------------------------------------------------------------------

export interface MockJob<T> {
  id: string;
  name: string;
  data: T;
  opts?: JobsOptions;
}

export interface MockQueueAPI<T> {
  add(name: string, data: T, opts?: JobsOptions): Promise<MockJob<T>>;
  addBulk(jobs: { name: string; data: T; opts?: JobsOptions }[]): Promise<MockJob<T>[]>;
  remove(jobId: string): Promise<number>;
  getJob(jobId: string): Promise<MockJob<T> | null>;
  readonly __mockJobs: MockJob<T>[];
}

export interface MockJobNode {
  job: { id: string; name: string; data: unknown };
  children?: MockJobNode[];
}

export interface MockFlowProducer {
  add(flowJob: FlowJob): Promise<MockJobNode>;
  addBulk(flowJobs: FlowJob[]): Promise<MockJobNode[]>;
}

export type GenerationQueueLike =
  | Queue<GenerationJobData>
  | MockQueueAPI<GenerationJobData>;

export type IngestQueueLike =
  | Queue<IngestJobData>
  | MockQueueAPI<IngestJobData>;

// ---------------------------------------------------------------------------
// Queue construction — VALUES, not singletons (phase 2, row 8)
//
// 🔴 WHAT THIS REPLACED, AND WHY. This block used to hold three module-scope
// `let`s (`_queue`, `_flow`, `_ingestQueue`) behind `getGenerationQueue()` /
// `getIngestQueue()` / `getGenerationFlowProducer()`, plus a
// `_resetQueuesForTests()` that closed and nulled them. Any module that wanted
// a queue imported the getter, so the queue a call site used was decided by a
// module-scope variable that no signature mentioned, the choice of real-vs-mock
// was a hidden `process.env.NODE_ENV` read, and a test could only substitute
// one by mutating global state between cases.
//
// `createQueues()` returns all three as one value with an explicit `mock`
// switch. `src/runtime.ts` calls it exactly once per process (and once per test
// runtime), and everything downstream takes what it is given.
// ---------------------------------------------------------------------------

export interface Queues {
  generation: GenerationQueueLike;
  ingest: IngestQueueLike;
  flow: FlowProducer | MockFlowProducer;
  /** Close the real BullMQ objects. A no-op on the mock set. */
  close(): Promise<void>;
}

export interface CreateQueuesOptions {
  /**
   * The shared BullMQ connection. Required for real queues; ignored (and
   * normally `null`) when `mock` is true.
   */
  connection: Redis | null;
  /**
   * In-memory queues instead of BullMQ. True for the unit suite, which runs
   * with no Redis service container; the caller decides, so nothing in here
   * reads `NODE_ENV`.
   */
  mock: boolean;
}

function createMockQueue<T>(): MockQueueAPI<T> {
  const jobs: MockJob<T>[] = [];
  let counter = 0;
  return {
    async add(name, data, opts) {
      const job: MockJob<T> = {
        id: opts?.jobId ?? `mock-${++counter}`,
        name,
        data,
        opts,
      };
      jobs.push(job);
      return job;
    },
    async addBulk(items) {
      const out: MockJob<T>[] = [];
      for (const it of items) {
        const job: MockJob<T> = {
          id: it.opts?.jobId ?? `mock-${++counter}`,
          name: it.name,
          data: it.data,
          opts: it.opts,
        };
        jobs.push(job);
        out.push(job);
      }
      return out;
    },
    async remove(jobId) {
      const idx = jobs.findIndex((j) => j.id === jobId);
      if (idx === -1) return 0;
      jobs.splice(idx, 1);
      return 1;
    },
    async getJob(jobId) {
      return jobs.find((j) => j.id === jobId) ?? null;
    },
    get __mockJobs() {
      return jobs;
    },
  };
}

function createMockFlowProducer(queue: MockQueueAPI<GenerationJobData>): MockFlowProducer {
  let counter = 0;

  async function addNode(node: FlowJob): Promise<MockJobNode> {
    const children: MockJobNode[] = [];
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        children.push(await addNode(child as FlowJob));
      }
    }
    // Cast: FlowJob.data is `any` upstream; the orchestrator only ever passes
    // `GenerationJobData` through this mock.
    const data = (node.data ?? {}) as GenerationJobData;
    const added = await queue.add(node.name, data, {
      ...(node.opts as JobsOptions | undefined),
      jobId: (node.opts as JobsOptions | undefined)?.jobId ?? `mock-flow-${++counter}`,
    });
    return {
      job: { id: added.id, name: added.name, data: added.data },
      children: children.length > 0 ? children : undefined,
    };
  }

  return {
    async add(flowJob) {
      return addNode(flowJob);
    },
    async addBulk(flowJobs) {
      const out: MockJobNode[] = [];
      for (const fj of flowJobs) out.push(await addNode(fj));
      return out;
    },
  };
}

/**
 * Build the generation queue, the ingest queue and the generation flow
 * producer as one value. Called once per runtime — see `src/runtime.ts`.
 */
export function createQueues(opts: CreateQueuesOptions): Queues {
  if (opts.mock) {
    const generation = createMockQueue<GenerationJobData>();
    return {
      generation,
      ingest: createMockQueue<IngestJobData>(),
      flow: createMockFlowProducer(generation),
      close: async () => {},
    };
  }

  const connection = opts.connection;
  if (!connection) {
    throw new Error('createQueues: a Redis connection is required unless `mock` is set');
  }

  const generation = new BullQueue<GenerationJobData>(GENERATION_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600, count: 1000 },
    },
  });
  const ingest = new BullQueue<IngestJobData>(INGEST_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600, count: 1000 },
    },
  });
  const flow = new FlowProducer({ connection });

  return {
    generation,
    ingest,
    flow,
    close: async () => {
      await Promise.allSettled([generation.close(), ingest.close(), flow.close()]);
    },
  };
}

/**
 * Per-org rate-limited job name. The worker's BullMQ limiter keys off this
 * prefix to fan out throughput across orgs without one-queue-per-org.
 */
export function generationJobName(org: string, unitType?: string): string {
  return `generation:${org}:${unitType ?? 'untyped'}`;
}

/** Stable string-hash → [1, 10] bucket for cross-org priority interleaving. */
export function orgPriorityBucket(org: string): number {
  let h = 0;
  for (let i = 0; i < org.length; i++) {
    h = (h * 31 + org.charCodeAt(i)) | 0;
  }
  return (Math.abs(h) % 10) + 1;
}

/** Test-only: read the in-memory job buffer. Throws on a real BullMQ queue. */
export function __getMockJobs(
  queue: GenerationQueueLike,
): MockJob<GenerationJobData>[] {
  if (!('__mockJobs' in queue)) {
    throw new Error('__getMockJobs called on a non-mock queue');
  }
  return queue.__mockJobs;
}

/** Test-only: read the ingest mock-queue job buffer. */
export function __getMockIngestJobs(
  queue: IngestQueueLike,
): MockJob<IngestJobData>[] {
  if (!('__mockJobs' in queue)) {
    throw new Error('__getMockIngestJobs called on a non-mock queue');
  }
  return queue.__mockJobs;
}

// ---------------------------------------------------------------------------
// Shared worker runtime (lock / stall) — seams row C6, "one job harness"
// ---------------------------------------------------------------------------
//
// 🔴 WHY THIS EXISTS. Both in-process workers used to pass only
// `connection` + `concurrency` (+ a limiter), which left BullMQ's DEFAULTS in
// force: `lockDuration: 30000`, `stalledInterval: 30000`, `maxStalledCount: 1`.
// A generation job routinely runs LONGER than 30 s — `LLM_REQUEST_TIMEOUT_MS`
// alone defaults to 120 s and a unit can make two router calls (initial pass
// plus the validator retry). BullMQ renews the lock on a timer, so a healthy
// worker survives; a worker whose event loop stalls (GC pause, a blocking
// sync call, a SIGSTOP'd container, a paused VM) does not. When the renewal
// misses, the stalled checker hands the SAME job to a SECOND worker.
//
// MEASURED on this tree against real Postgres + Redis: with W1 SIGSTOPped
// mid-job, W2 re-ran the job — `attempts` went to 2, TWO trace rows were
// written, the LLM was called twice, the budget was charged twice, and W1's
// late write landed on top of W2's, leaving a COMPLETED job's row reading
// `status = 'cancelled'`. BullMQ's own "Missing lock for job … moveToFinished"
// error arrives only AFTER those DB writes, so it cannot prevent any of it.
//
// The lock window is therefore sized off the LLM timeout rather than left at
// BullMQ's 30 s default. It is a TOLERANCE, not a deadline: a job that runs
// longer is fine as long as the process keeps renewing.
//
// `WORKER_LOCK_DURATION_MS` (src/config/env.ts) overrides the whole derivation
// when a deployment's real job duration is not a function of the LLM timeout;
// unset, the multiplier + floor below decide it. Tests override the whole block
// through `startGenerationWorker({ runtime })`.

/** Lock window = this many × max(`LLM_REQUEST_TIMEOUT_MS`,
 *  `LLM_ASYNC_REQUEST_TIMEOUT_MS`). Two full LLM timeouts
 *  covers the worst in-band case (initial call + one validator retry). */
export const WORKER_LOCK_TIMEOUT_MULTIPLIER = 2;

/** Floor for the lock window, for deployments that set a tiny LLM timeout. */
export const WORKER_LOCK_DURATION_FLOOR_MS = 60_000;

/** How often each worker scans for stalled jobs. Left at BullMQ's default —
 *  the defect was the lock WINDOW, not the scan cadence. */
export const WORKER_STALLED_INTERVAL_MS = 30_000;

/** How many times one job may be recovered from `stalled` before BullMQ fails
 *  it outright. Kept at 1: with the terminal-status guard in the generation
 *  worker a re-delivery is a no-op, so more retries buy nothing. */
export const WORKER_MAX_STALLED_COUNT = 1;

export interface WorkerRuntimeOptions {
  lockDuration: number;
  stalledInterval: number;
  maxStalledCount: number;
}

/**
 * The lock/stall options every in-process worker should be constructed with.
 * Pure — reads `env` only, opens no connection (CI runs the unit suite with no
 * Redis; nothing in this module may dial at import).
 */
export function workerRuntimeOptions(
  overrides: Partial<WorkerRuntimeOptions> = {},
): WorkerRuntimeOptions {
  // The LONGER of the two provider deadlines: the async worker runs under
  // `LLM_ASYNC_REQUEST_TIMEOUT_MS`, and a unit that outlives its lock is the
  // stalled double-run described above.
  const llmDeadline = Math.max(env.LLM_REQUEST_TIMEOUT_MS, env.LLM_ASYNC_REQUEST_TIMEOUT_MS);
  const derived = llmDeadline * WORKER_LOCK_TIMEOUT_MULTIPLIER;
  // The env var wins outright — floor included. An operator who sets it has a
  // measured job duration; re-imposing the 60 s floor on top would silently
  // ignore a deliberately smaller value (which is what the stall repro needs
  // when it drives a real worker through the env rather than the seam).
  const lockDuration =
    env.WORKER_LOCK_DURATION_MS ?? Math.max(derived, WORKER_LOCK_DURATION_FLOOR_MS);
  return {
    lockDuration,
    stalledInterval: WORKER_STALLED_INTERVAL_MS,
    maxStalledCount: WORKER_MAX_STALLED_COUNT,
    ...overrides,
  };
}

/**
 * Minimal structural view of a BullMQ `Worker` for lifecycle logging. Declared
 * structurally so one helper can take `Worker<GenerationJobData>` and
 * `Worker<IngestJobData>` without an `any`.
 */
export interface WorkerLifecycleEvents {
  on(event: 'stalled', listener: (jobId: string, prev: string) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/**
 * Log the two events that were previously silent. A stalled job is the exact
 * signal that a worker stopped renewing its lock — either it is wedged, or it
 * is gone — so it is the first line in the log that names a lost worker.
 */
export function attachWorkerLifecycleLogging(
  worker: WorkerLifecycleEvents,
  label: string,
): void {
  worker.on('stalled', (jobId, prev) => {
    // The log line below is for a human already reading logs; this counter is
    // what an alert can watch. See `src/metrics/registry.ts`.
    bullmqStalledTotal.inc({ queue: label });
    console.warn(
      `${label}: job ${jobId} STALLED (was '${prev}') — its lock expired and it ` +
        'is being re-delivered. The re-delivery will NOT re-run it: the claim ' +
        'guard refuses a row that is not queued, and a row whose owner is ' +
        "presumed dead is failed as 'worker_lost' instead.",
    );
  });
  worker.on('error', (err) => {
    console.error(`${label}: worker error: ${err.message}`);
  });
}
