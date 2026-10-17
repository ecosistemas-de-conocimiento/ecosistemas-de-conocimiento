/**
 * Generic entity-corpus sync scaffolding: stable-id replace, metadata tagging,
 * batched ingest, and an event-driven fire-and-forget path split from an
 * offline backfill.
 *
 * The engine owns the MECHANISM (build docs → ingest); the product owns the
 * CONTENT — it supplies an `EntitySource` that turns an entity ref into ingest
 * docs. This is the seam the advanced-RAG ingest path builds on; keep it minimal.
 *
 * 🔴 FAILURES REACH THE CALLER (0.5.0). Up to 0.4.x every error
 * was caught in here, so a consumer's `.catch` could never fire and a dead
 * ingest path looked exactly like "nothing to sync". Now:
 *   - every batch / entity is still ATTEMPTED (one failure does not stop the
 *     rest — a partial sync is better than none),
 *   - each failure warns once (warn.ts: name + status, never content),
 *   - and the promise then REJECTS with a `CorpusSyncError` carrying the
 *     totals and the per-failure name/status.
 * Keeping the write path safe is now the CALLER's choice: fire-and-forget
 * callers must attach their own `.catch`, or Node reports an unhandled
 * rejection.
 */

import type { AIClient, ContextRef } from './types.js';
import { describeError, warnEngine, type EngineWarning } from './warn.js';

/**
 * A sync or backfill that did not fully succeed. `synced` is what DID go in;
 * `failures` is one name/status entry per failed step (never content).
 *
 * 🔴 `cause` is SANITIZED: it is `failures[0]` (`{event, errorName, status}`),
 * NEVER the upstream error object. A consumer's `console.error(err)` prints
 * the cause chain, and an upstream message can carry a response body or a
 * bearer token. Log `err.failures` and `err.synced`.
 */
export class CorpusSyncError extends Error {
  override readonly name = 'CorpusSyncError';
  constructor(
    readonly synced: number,
    readonly failures: EngineWarning[],
  ) {
    super(
      `corpus sync failed: ${failures.length} step(s) failed, ${synced} doc(s) synced`,
      { cause: failures[0] },
    );
  }
}

function recordFailure(
  failures: EngineWarning[],
  event: EngineWarning['event'],
  err: unknown,
): void {
  warnEngine(event, err);
  failures.push({ event, ...describeError(err) });
}

/** One ai-service ingest document. The `id` is the stable dedupe/replace key. */
export interface CorpusDoc {
  /** Stable id — re-syncing the same id REPLACES rather than duplicates. */
  id: string;
  title: string;
  text: string;
  metadata: Record<string, unknown>;
}

/** A batch of docs targeting one corpus within one scope. */
export interface CorpusBatch {
  orgId: string;
  scopeId: string;
  corpus: string;
  documents: CorpusDoc[];
}

/**
 * The product-supplied content seam. Given an entity ref (or a whole scope for
 * backfill), produce the ingest batches. Returning `[]` is a valid no-op.
 */
export interface EntitySource {
  /** Build the ingest batches for a single entity (stable ids inside). */
  docsForEntity(ref: ContextRef): Promise<CorpusBatch[]>;
  /** Enumerate every entity ref in a scope, for backfill. */
  entitiesInScope(scopeId: string): Promise<ContextRef[]>;
}

/**
 * Sync ONE entity into its corpus/corpora. Attempts every batch, then rejects
 * with `CorpusSyncError` if any step failed; resolves with the docs ingested
 * otherwise. A write-path caller that must not block attaches its own `.catch`.
 */
export async function syncEntity(
  aiClient: AIClient,
  source: EntitySource,
  ref: ContextRef,
): Promise<{ synced: number }> {
  let synced = 0;
  const failures: EngineWarning[] = [];
  let batches: CorpusBatch[] = [];
  try {
    batches = await source.docsForEntity(ref);
  } catch (err) {
    recordFailure(failures, 'sync.docs.failed', err);
  }
  for (const batch of batches) {
    if (batch.documents.length === 0) continue;
    try {
      await aiClient.ingest({
        orgId: batch.orgId,
        scopeId: batch.scopeId,
        corpus: batch.corpus,
        documents: batch.documents,
      });
      synced += batch.documents.length;
    } catch (err) {
      recordFailure(failures, 'sync.ingest.failed', err);
    }
  }
  if (failures.length) throw new CorpusSyncError(synced, failures);
  return { synced };
}

/**
 * Backfill an entire scope — re-sync every entity (batched per entity). Meant
 * for an offline/boot job, NOT the write path; runs sequentially to stay gentle
 * on ai-service. Keeps going past a failing entity, then rejects with one
 * `CorpusSyncError` holding the totals and every failure.
 */
export async function backfillScope(
  aiClient: AIClient,
  source: EntitySource,
  scopeId: string,
): Promise<{ entities: number; docs: number }> {
  const failures: EngineWarning[] = [];
  let refs: ContextRef[];
  try {
    refs = await source.entitiesInScope(scopeId);
  } catch (err) {
    recordFailure(failures, 'backfill.entities.failed', err);
    throw new CorpusSyncError(0, failures);
  }
  let docs = 0;
  for (const ref of refs) {
    try {
      docs += (await syncEntity(aiClient, source, ref)).synced;
    } catch (err) {
      // syncEntity already warned per step; collect, do not warn twice.
      if (!(err instanceof CorpusSyncError)) throw err;
      docs += err.synced;
      failures.push(...err.failures);
    }
  }
  if (failures.length) throw new CorpusSyncError(docs, failures);
  return { entities: refs.length, docs };
}
