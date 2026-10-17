// Ingest sub-API — async POST + status GET.
//
// `enqueue` returns immediately with an `ingestId`; consumers poll `status`
// or subscribe via SSE (not yet wired on the ingest path — generation only).
//
// 🔴 EVERY `POST /v1/ingest` FROM THIS PACKAGE GOES THROUGH THE PROCESS-WIDE
// GATE. The gate lives BELOW this class so no call site can bypass it, and it
// counts HTTP REQUESTS rather than documents so a caller cannot defeat it by
// handing over one document at a time. See `./ingest-gate.ts` for the limits
// it respects and the reasoning behind every number.
//
// `status` is deliberately NOT gated — see the same file.

import type { HttpClient } from './http.js';
import {
  DEFAULT_INGEST_GATE_SCOPE,
  IngestBatchTooLargeError,
  IngestRateLimitExhaustedError,
  MAX_DOCS_PER_INGEST_REQUEST,
  chunkDocuments,
  getIngestGate,
  type IngestLane,
} from './ingest-gate.js';
import type { IngestDocument, IngestRequest, IngestResult, IngestStatus } from './types.js';

export interface IngestCallOptions {
  /**
   * `interactive` (default) is a person holding an HTTP connection — admitted
   * first, short budgets. `bulk` is a seed, backfill or background hook nobody
   * is watching — waits its turn for as long as it takes.
   *
   * 🔴 Pass `'bulk'` from seeds and hooks. A seed left on the default lane
   * jumps ahead of real users AND fails after 15 s of queueing instead of
   * waiting, which is the silent partial-seed failure the gate exists to stop.
   */
  lane?: IngestLane;
  /** Cancel while queued or between retries; frees the slot for someone else. */
  signal?: AbortSignal;
}

export interface EnqueueAllOptions extends IngestCallOptions {
  /**
   * Called after each batch lands, before the next is sent.
   *
   * `enqueueAll` is SEQUENTIAL, so a failure part-way through means earlier
   * batches DID land and carry live `ingestId`s the caller still has to join
   * callbacks against. This hook hands each one over as it happens, so nothing
   * is lost even when the sequence throws.
   */
  onBatch?: (result: IngestResult, documents: IngestDocument[]) => void;
}

export class IngestAPI {
  constructor(
    private readonly http: HttpClient,
    /** Which process-wide gate this client's ingests are admitted by. */
    private readonly gateScope: string = DEFAULT_INGEST_GATE_SCOPE,
  ) {}

  /**
   * Enqueue ONE batch of at most `MAX_DOCS_PER_INGEST_REQUEST` documents.
   *
   * Throws `IngestBatchTooLargeError` — before the network call, so it costs no
   * rate slot — when handed more; use `enqueueAll`, which chunks.
   * Throws `IngestRateLimitExhaustedError`, naming the corpus and every
   * document id, when the gate runs out of attempts or wall clock.
   */
  async enqueue(req: IngestRequest, opts: IngestCallOptions = {}): Promise<IngestResult> {
    const documents = req.documents ?? [];
    if (documents.length > MAX_DOCS_PER_INGEST_REQUEST) {
      throw new IngestBatchTooLargeError(req.corpus, documents.length);
    }
    return this.send(req, opts);
  }

  /**
   * Enqueue any number of documents, chunked to ai-service's schema cap and
   * admitted one batch at a time by the gate. Returns one `IngestResult` per
   * batch, in order.
   *
   * 🔴 One `IngestResult` PER BATCH, never merged. ai-service returns one
   * `ingestId` per call, and consumer callbacks are joined on `(ingestId,
   * corpus)` — so a caller must keep the per-batch mapping to know which
   * documents a callback refers to. See `./ingest-gate.ts` on why this package
   * chunks but never coalesces.
   */
  async enqueueAll(req: IngestRequest, opts: EnqueueAllOptions = {}): Promise<IngestResult[]> {
    const batches = chunkDocuments(req.documents ?? []);
    const results: IngestResult[] = [];
    for (let i = 0; i < batches.length; i += 1) {
      const documents = batches[i]!;
      try {
        const result = await this.send({ ...req, documents }, opts);
        results.push(result);
        opts.onBatch?.(result, documents);
      } catch (err) {
        // Name EVERYTHING that did not land — this batch and every batch after
        // it — not just the one that happened to fail. A caller that only
        // learns about batch 3 of 7 re-drives the wrong rows.
        if (err instanceof IngestRateLimitExhaustedError) {
          const offset = i * MAX_DOCS_PER_INGEST_REQUEST;
          const unsent = batches.slice(i).flat();
          throw new IngestRateLimitExhaustedError({
            corpus: req.corpus,
            documentIds: documentLabels(unsent, offset),
            attempts: err.attempts,
            waitedMs: err.waitedMs,
            reason: err.reason,
            lane: err.lane,
            busyMessage: err.message,
            lastError: err.lastError,
            partialResults: results,
          });
        }
        throw err;
      }
    }
    return results;
  }

  /**
   * Snapshot of one ingest batch. Once terminal it carries `chunkCount` and
   * per-document `documents[].chunkCount` (servers from 0.24.0's release on).
   *
   * Throws `IngestNotFoundError` (a `NotFoundError`, status 404) when the id
   * does not exist in this key's org/project. Older servers answered 200
   * `status: 'processing'` instead, so a reconciler must also bound how long
   * it waits on `processing`.
   */
  async status(ingestId: string): Promise<IngestStatus> {
    return this.http.json<IngestStatus>({
      method: 'GET',
      path: `/v1/ingest/${encodeURIComponent(ingestId)}`,
    });
  }

  private send(req: IngestRequest, opts: IngestCallOptions): Promise<IngestResult> {
    const documents = req.documents ?? [];
    return getIngestGate(this.gateScope).run(
      () =>
        this.http.json<IngestResult>({
          method: 'POST',
          path: '/v1/ingest',
          body: req,
          signal: opts.signal,
        }),
      {
        corpus: req.corpus,
        documentIds: documentLabels(documents),
        lane: opts.lane,
        signal: opts.signal,
      },
    );
  }
}

/**
 * Human-usable identifiers for a failure report.
 *
 * `IngestDocument.id` is OPTIONAL in ai-service's schema (the service generates
 * one when it is absent), so a failure report cannot simply map `d.id` — half
 * the array would read `undefined` and nothing could be re-driven from it. Fall
 * back to the title, then to a labelled ordinal. `offset` keeps ordinals
 * meaningful across a chunked `enqueueAll`.
 */
function documentLabels(documents: readonly IngestDocument[], offset = 0): string[] {
  return documents.map((d, i) => {
    if (d.id) return d.id;
    if (d.title) return `(no id, title="${d.title.slice(0, 80)}")`;
    return `(no id, document #${offset + i})`;
  });
}
