// Coalescing batcher for BULK ingests: debounce + batch, the standard shape.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// A consumer that syncs every edited row as its own `POST /v1/ingest` turns one
// user action into hundreds of calls. The gate (`./ingest-gate.ts`) bounds the
// RATE of those calls correctly, but it cannot make them fewer, so the queue
// behind them grows to minutes. One bulk operation
// made 71 and 100 single-document calls (measured with local Postgres,
// AI stubbed -> a lower bound; a live model writes more rows), i.e. minutes of
// queue at 40/min. With this batcher the same operations made 3 calls each. This batcher collapses those into
// `ceil(distinct docs / maxBatch)` calls.
//
// ── WHAT IT DOES ────────────────────────────────────────────────────────────
//   * Groups documents by their batch-level request (corpus + every other
//     request field: `callbackUrl`, `embeddingModel`, `language`, …) — a batch
//     can only carry ONE of each.
//   * Coalesces by document `id` inside a group: last write wins, so a row
//     edited five times in a second is embedded (and paid for) once.
//   * Flushes a group after `quietMs` without a new write, after `maxWaitMs`
//     since its first pending write (so a steady trickle cannot postpone it
//     forever), or at once when it reaches `maxBatch` documents.
//   * Sends through `IngestAPI.enqueue` on the `bulk` lane, so every flush is
//     admitted by the same process-wide gate and respects its interactive
//     reserve and 429 cooldown.
//   * One batch in flight per group at a time. A document re-written while its
//     previous version is in flight is sent in the NEXT batch, never raced.
//
// ── 🔴 PREREQUISITE: THE CONSUMER'S CALLBACK JOIN MUST BE PER-DOCUMENT ──────
// ai-service answers ONE `ingestId` per call. Its per-document callbacks carry
// `docId` (the document's `id`), but a consumer that joins callbacks on
// `(ingestId, corpus)` alone, or binds one row's id into `callbackUrl`, strands
// every other document of a batch at `indexing`. See the note at the top of
// `./ingest-gate.ts`. That is why this is an OPT-IN class and not something
// `IngestAPI` does implicitly, and why `add` refuses a document with no `id`.
//
// ── NO SILENT DROPS ─────────────────────────────────────────────────────────
// Every document handed to `add` ends in exactly one of: `onBatch` (landed,
// with its `ingestId`), `onError` (did not land, named), or a synchronous
// throw from `add` itself (buffer full, closed, no id). Nothing is discarded
// quietly, including on shutdown — call `close()` from your shutdown hook.

import type { IngestAPI } from './ingest.js';
import { MAX_DOCS_PER_INGEST_REQUEST } from './ingest-gate.js';
import type { IngestDocument, IngestRequest, IngestResult } from './types.js';

/** A request minus its documents: everything that must be equal to share a batch. */
export type IngestBatchRequest = Omit<IngestRequest, 'documents'>;

/** A batch that did not land. `documents` is every document in it. */
export interface IngestBatchFailure {
  request: IngestBatchRequest;
  documents: IngestDocument[];
  error: unknown;
  /**
   * Present when the batch DID land and it was `onBatch` that threw. The
   * documents are being indexed under this id; only the consumer's own
   * bookkeeping failed.
   */
  result?: IngestResult;
}

export interface IngestBatcherOptions {
  /** Where flushed batches go — normally `client.ingest`. Always sent as `bulk`. */
  ingest: Pick<IngestAPI, 'enqueue'>;
  /**
   * REQUIRED. Receives every batch that did not land. There is no default,
   * because a default that logs and moves on is a silent drop with extra steps.
   * Must not throw; anything it throws is swallowed.
   */
  onError: (failure: IngestBatchFailure) => void;
  /**
   * Called once per landed batch — record `result.ingestId` against each
   * document id here if your callback bookkeeping needs it.
   */
  onBatch?: (result: IngestResult, documents: IngestDocument[], request: IngestBatchRequest) => void;
  /** Flush a group this long after its last write. Default 2 000 ms. */
  quietMs?: number;
  /** Flush a group this long after its first pending write, however busy. Default 10 000 ms. */
  maxWaitMs?: number;
  /** Documents per call. Default and ceiling: `MAX_DOCS_PER_INGEST_REQUEST` (100). */
  maxBatch?: number;
  /**
   * Bound on documents held, pending AND in flight, across all groups.
   * `add` throws `IngestBatcherFullError` beyond it. Default 10 000.
   */
  maxBuffered?: number;
}

/** Thrown by `add` when the buffer is at `maxBuffered`. Nothing was queued. */
export class IngestBatcherFullError extends Error {
  readonly corpus: string;
  readonly documentId: string;
  readonly maxBuffered: number;
  constructor(corpus: string, documentId: string, maxBuffered: number) {
    super(
      `ingest batcher is full (${maxBuffered} documents pending or in flight); ` +
        `document "${documentId}" for corpus "${corpus}" was NOT queued.`,
    );
    this.name = 'IngestBatcherFullError';
    this.corpus = corpus;
    this.documentId = documentId;
    this.maxBuffered = maxBuffered;
  }
}

interface Group {
  request: IngestBatchRequest;
  pending: Map<string, IngestDocument>;
  quietTimer: ReturnType<typeof setTimeout> | null;
  maxWaitTimer: ReturnType<typeof setTimeout> | null;
  /** Tail of this group's send chain — one batch in flight per group. */
  chain: Promise<void>;
}

export class IngestBatcher {
  private readonly opts: Required<Omit<IngestBatcherOptions, 'onBatch'>> &
    Pick<IngestBatcherOptions, 'onBatch'>;
  private readonly groups = new Map<string, Group>();
  private pendingCount = 0;
  private inFlightCount = 0;
  private closed = false;

  constructor(opts: IngestBatcherOptions) {
    this.opts = {
      quietMs: 2_000,
      maxWaitMs: 10_000,
      maxBuffered: 10_000,
      ...opts,
      maxBatch: Math.max(1, Math.min(opts.maxBatch ?? MAX_DOCS_PER_INGEST_REQUEST, MAX_DOCS_PER_INGEST_REQUEST)),
    };
  }

  /**
   * Queue one document. Returns at once; the outcome arrives via `onBatch` or
   * `onError`. Throws — having queued nothing — when the document has no `id`,
   * the batcher is closed, or the buffer is full.
   */
  add(request: IngestBatchRequest, document: IngestDocument): void {
    if (this.closed) throw new Error('IngestBatcher is closed; document was NOT queued.');
    if (!document.id) {
      throw new TypeError(
        `IngestBatcher needs a document id to coalesce and to join callbacks (corpus "${request.corpus}").`,
      );
    }
    const key = groupKey(request);
    let group = this.groups.get(key);
    const replacing = group?.pending.has(document.id) ?? false;
    if (!replacing && this.pendingCount + this.inFlightCount >= this.opts.maxBuffered) {
      throw new IngestBatcherFullError(request.corpus, document.id, this.opts.maxBuffered);
    }
    if (!group) {
      group = { request, pending: new Map(), quietTimer: null, maxWaitTimer: null, chain: Promise.resolve() };
      this.groups.set(key, group);
    }
    // Delete first so a re-write moves to the END: batch order follows last write.
    group.pending.delete(document.id);
    group.pending.set(document.id, document);
    if (!replacing) this.pendingCount += 1;

    if (group.pending.size >= this.opts.maxBatch) {
      this.flushGroup(key, group);
      return;
    }
    // Not `unref()`ed, same reasoning as the gate's wake timer: an armed timer
    // means real pending work, and a CLI that exits over it loses documents.
    if (group.quietTimer) clearTimeout(group.quietTimer);
    const g = group;
    group.quietTimer = setTimeout(() => this.flushGroup(key, g), this.opts.quietMs);
    group.maxWaitTimer ??= setTimeout(() => this.flushGroup(key, g), this.opts.maxWaitMs);
  }

  /** Send everything pending now and resolve once every batch has settled. */
  async flush(): Promise<void> {
    for (const [key, group] of this.groups) this.flushGroup(key, group);
    await Promise.all([...this.groups.values()].map((g) => g.chain));
  }

  /** Refuse further `add`s, then `flush()`. Call it from your shutdown hook. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  /** Documents waiting for a flush, and documents in a batch being sent. */
  stats(): { pending: number; inFlight: number } {
    return { pending: this.pendingCount, inFlight: this.inFlightCount };
  }

  private flushGroup(key: string, group: Group): void {
    if (group.quietTimer) clearTimeout(group.quietTimer);
    if (group.maxWaitTimer) clearTimeout(group.maxWaitTimer);
    group.quietTimer = null;
    group.maxWaitTimer = null;
    if (group.pending.size === 0) return;

    const documents = [...group.pending.values()];
    group.pending = new Map();
    this.pendingCount -= documents.length;
    this.inFlightCount += documents.length;
    group.chain = group.chain.then(() => this.send(group.request, documents));
    // A drained group with nothing in flight is forgotten, so a long-lived
    // process does not accumulate one entry per corpus it ever touched.
    const chain = group.chain;
    void chain.then(() => {
      if (group.chain === chain && group.pending.size === 0 && this.groups.get(key) === group) {
        this.groups.delete(key);
      }
    });
  }

  private async send(request: IngestBatchRequest, documents: IngestDocument[]): Promise<void> {
    let result: IngestResult;
    try {
      result = await this.opts.ingest.enqueue({ ...request, documents }, { lane: 'bulk' });
    } catch (error) {
      this.inFlightCount -= documents.length;
      this.report({ request, documents, error });
      return;
    }
    this.inFlightCount -= documents.length;
    try {
      this.opts.onBatch?.(result, documents, request);
    } catch (error) {
      this.report({ request, documents, error, result });
    }
  }

  private report(failure: IngestBatchFailure): void {
    try {
      this.opts.onError(failure);
    } catch {
      // The consumer's failure handler is the last line; nothing sits below it.
    }
  }
}

/** Stable key over every batch-level field, independent of property order. */
function groupKey(request: IngestBatchRequest): string {
  return stableStringify(request);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}
