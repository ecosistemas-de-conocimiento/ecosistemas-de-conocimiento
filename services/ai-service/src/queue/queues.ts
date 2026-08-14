// Typed BullMQ queue + FlowProducer accessors with a test-mode mock fallback.
//
// One queue (`generation`); job `name` is formatted `generation:<org>:<unitType>`
// so the worker's BullMQ rate limiter can key off prefix for per-org fairness.
// `FlowProducer` carries `dependsOn` (see plan/m3-m4-decisions.md §3).
//
// Test mode (`NODE_ENV === 'test'`) returns an in-memory mock for both the
// queue and the flow producer so unit tests run without Redis.

import {
  Queue as BullQueue,
  FlowProducer,
  type FlowJob,
  type JobsOptions,
  type Queue,
} from 'bullmq';

import { QUEUE_NAMES, redisConnection } from './connection.js';
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
// Singletons
// ---------------------------------------------------------------------------

let _queue: GenerationQueueLike | null = null;
let _flow: FlowProducer | MockFlowProducer | null = null;
let _ingestQueue: IngestQueueLike | null = null;

function isTestMode(): boolean {
  return process.env.NODE_ENV === 'test';
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

export function getGenerationQueue(): GenerationQueueLike {
  if (_queue) return _queue;
  if (isTestMode()) {
    _queue = createMockQueue<GenerationJobData>();
    return _queue;
  }
  _queue = new BullQueue<GenerationJobData>(GENERATION_QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600, count: 1000 },
    },
  });
  return _queue;
}

/**
 * Ingest queue accessor. Same singleton pattern as `getGenerationQueue`. The
 * mock variant lets unit tests inspect what the ingest service enqueued
 * without spinning Redis.
 */
export function getIngestQueue(): IngestQueueLike {
  if (_ingestQueue) return _ingestQueue;
  if (isTestMode()) {
    _ingestQueue = createMockQueue<IngestJobData>();
    return _ingestQueue;
  }
  _ingestQueue = new BullQueue<IngestJobData>(INGEST_QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600, count: 1000 },
    },
  });
  return _ingestQueue;
}

export function getGenerationFlowProducer(): FlowProducer | MockFlowProducer {
  if (_flow) return _flow;
  if (isTestMode()) {
    const q = getGenerationQueue();
    if (!('__mockJobs' in q)) {
      throw new Error('Expected mock queue in test mode');
    }
    _flow = createMockFlowProducer(q);
    return _flow;
  }
  _flow = new FlowProducer({ connection: redisConnection });
  return _flow;
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

/** Test helper — drop the singletons and clear the mock job buffer. */
export async function _resetQueuesForTests(): Promise<void> {
  if (_queue && !('__mockJobs' in _queue)) {
    await (_queue as Queue<GenerationJobData>).close().catch(() => {});
  }
  if (_flow && _flow instanceof FlowProducer) {
    await _flow.close().catch(() => {});
  }
  if (_ingestQueue && !('__mockJobs' in _ingestQueue)) {
    await (_ingestQueue as Queue<IngestJobData>).close().catch(() => {});
  }
  _queue = null;
  _flow = null;
  _ingestQueue = null;
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
