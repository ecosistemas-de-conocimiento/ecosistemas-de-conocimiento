/**
 * The Domain Adapter — the ONLY per-product seam in the engine. The consumer
 * implements it against its own data layer (Payload collections, an API,
 * whatever); the engine stays domain-blind. In this repo `apps/web`
 * implements it in `src/lib/server/engine/adapter.ts`.
 */

import type {
  ContextRef,
  ContextScope,
  ContextSearchResult,
  ResolvedCorpus,
} from './types.js';

/** What `scopeHierarchy` returns: the Tier-1 summary + the retrieval corpora. */
export interface ResolvedScope {
  /** Always-on (Tier-1) ambient summary text for the user-turn context. */
  summaryText: string;
  /** Retrieval corpus set the engine fans out over (per-thread corpus added by engine). */
  corpora: ResolvedCorpus[];
}

export interface DomainAdapter {
  /**
   * Typeahead / picker search for `@`-mentions and the scope header. `kind`
   * narrows to one type when given; `scope` bounds the search (e.g. to a space).
   */
  searchEntities(
    kind: string | undefined,
    query: string,
    scope: ContextScope,
  ): Promise<ContextSearchResult[]>;

  /**
   * Resolve a single ref into clean injectable prompt text (story narrative,
   * document body, chat digest…). Best-effort — return '' on miss.
   */
  resolveEntity(ref: ContextRef): Promise<string>;

  /**
   * Resolve a thread's scope into BOTH halves of per-turn context: the Tier-1
   * `summaryText` and the retrieval `corpora`. Best-effort — degrade to an
   * empty summary / tenant corpus.
   */
  scopeHierarchy(scope: ContextScope): Promise<ResolvedScope>;

  /**
   * Re-sync one entity's content into its corpus (stable-id replace). Used by
   * the runtime event subscriber. Fire-and-forget at the call site.
   */
  syncEntity(ref: ContextRef): Promise<void>;

  /**
   * Backfill an entire scope's entities into corpora (batched). Used by an
   * offline/boot job, NOT the write path.
   */
  backfill(scope: ContextScope): Promise<void>;

  /**
   * Standalone summary for a scope (when a caller just wants the ambient text
   * without the corpora). May reuse `scopeHierarchy().summaryText`.
   */
  summary(scope: ContextScope): Promise<string>;
}
