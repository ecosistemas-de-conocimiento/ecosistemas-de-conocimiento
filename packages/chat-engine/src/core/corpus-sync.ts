/**
 * Generic entity-corpus sync scaffolding: stable-id replace, metadata tagging,
 * batched ingest, and an event-driven fire-and-forget path split from an
 * offline backfill.
 *
 * The engine owns the MECHANISM (build docs → ingest, swallow failures, never
 * block the write path); the product owns the CONTENT — it supplies an
 * `EntitySource` that turns an entity ref into ingest docs. This is the seam
 * the advanced-RAG ingest path builds on; keep it minimal.
 */

import type { AIClient, ContextRef } from './types.js';

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
 * Sync ONE entity into its corpus/corpora. Best-effort: a failed/slow ai-service
 * must never propagate to the caller's write path — callers fire-and-forget.
 * Returns the number of docs ingested (0 on any miss).
 */
export async function syncEntity(
  aiClient: AIClient,
  source: EntitySource,
  ref: ContextRef,
): Promise<{ synced: number }> {
  let synced = 0;
  const batches = await source.docsForEntity(ref).catch(() => [] as CorpusBatch[]);
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
    } catch {
      /* best-effort: a down ingest path must not break the write */
    }
  }
  return { synced };
}

/**
 * Backfill an entire scope — re-sync every entity (batched per entity). Meant
 * for an offline/boot job, NOT the write path; runs sequentially to stay gentle
 * on ai-service.
 */
export async function backfillScope(
  aiClient: AIClient,
  source: EntitySource,
  scopeId: string,
): Promise<{ entities: number; docs: number }> {
  const refs = await source.entitiesInScope(scopeId).catch(() => [] as ContextRef[]);
  let docs = 0;
  for (const ref of refs) {
    const res = await syncEntity(aiClient, source, ref);
    docs += res.synced;
  }
  return { entities: refs.length, docs };
}
