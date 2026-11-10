/**
 * `respond()` — the top-level engine orchestrator. Given a chat turn and a
 * `DomainAdapter`, it chains the whole context-aware-RAG pipeline:
 *
 *   condense (anaphora → standalone query)
 *     → scopeHierarchy (deterministic Tier-1 summary + retrieval corpora)
 *     → retrieve (corpora + per-thread corpus + ai-service `filter`)
 *       ‖ optional graphProvider (same condensed query, run CONCURRENTLY)
 *       → fuseMatches (RRF; a no-op merge when the graph path is absent)
 *     → resolveEntity for each @-mention ref (clean text)
 *     → buildChatTurn (USER-TURN INJECTION — the load-bearing invariant)
 *     → generate (sync) | streaming passthrough
 *     → provenance shaping
 *
 * EVERY context step is best-effort: a failing summary / retrieve / condense /
 * ref-resolve degrades to empty and NEVER breaks the turn (spec §5.8). Each
 * degrade is VISIBLE: it emits one structured warning (see warn.ts).
 *
 * Router-agnostic by design: any routing decision sits IN FRONT of the engine
 * and decides whether to call `respond()` at all. The engine never routes; it
 * just runs the RAG conversation. `prepareTurn()` is exported separately so a
 * caller (e.g. a streaming one) can assemble the turn without committing to a
 * generation transport.
 */

import type { AIClient, ChatHistoryRow, RetrievalPolicy, RetrievedChunk, Provenance, SyncChatMessage, SyncGenerationResult } from './types.js';
import type { ContextRef, ContextScope } from './types.js';
import type { DomainAdapter } from './adapter.js';
import type { EngineConfig } from './config.js';
import { condenseQuery } from './condense.js';
import { DEFAULT_MERGED_CAP, fuseMatches, retrieveWithPolicy } from './retrieve.js';
import { buildChatTurn } from './turn.js';
import { maxDenseScore } from './relevance.js';
import { warnEngine, warnEngineCapped } from './warn.js';
import { assertAnswer } from './generation.js';

/**
 * What an optional second retrieval path contributes to a turn. Both fields
 * are optional: a provider may contribute chunks, a prose block, both, or
 * (returning `null`) nothing at all.
 */
export interface GraphProviderResult {
  /** A second RANKED list of chunks, fused with the vector list via `fuseMatches`. */
  chunks?: RetrievedChunk[];
  /**
   * A pre-rendered context block. OPAQUE to the engine — it is injected into
   * the user turn verbatim under its own header and never inspected.
   */
  context?: string;
}

/**
 * The optional graph-retrieval hook. Called with the CONDENSED query (so it
 * benefits from step 1's anaphora rewrite), concurrently with the vector
 * retrieve.
 *
 * The engine knows nothing about what is on the other side of this callback —
 * no entities, no domain vocabulary, no transport. It is best-effort like
 * every other context step: rejecting, hanging past the consumer's own timeout
 * or matching nothing all produce a normal answer with no message to the user.
 * Enforcing a timeout is the provider's job, not the engine's.
 */
export type GraphProvider = (
  condensedQuery: string,
) => Promise<GraphProviderResult | null>;

export interface RespondArgs {
  config: EngineConfig;
  aiClient: AIClient;
  adapter: DomainAdapter;

  /** ai-service attribution + RLS keys. */
  orgId: string;
  userId: string;
  /** Attribution scope tag for generate/condense (NOT used for retrieval). */
  scopeId?: string;

  /** Stable per-thread/session id; the engine always adds its per-thread corpus. */
  threadId: number | string;

  /** The thread's resolved scope (Org/Team/Project/Member refs). */
  scope: ContextScope;

  /** Persisted history (oldest → newest), excluding the new user turn. */
  history: ChatHistoryRow[];
  /** The user's new message (raw text). */
  userMessage: string;

  /** Per-message `@`-mention refs to resolve into the user turn. */
  inlineRefs?: ContextRef[];

  /** Optional behavioral steering (system message only). */
  teamInstructions?: string;
  threadInstructions?: string;

  /**
   * Optional extra metadata filter forwarded to ai-service `/v1/retrieve`
   * (merged with the engine's own `{ scope }`-style filter if any). The
   * adapter/caller decides the keys (e.g. `{ sessionId }`).
   */
  retrievalFilter?: Record<string, string | number | boolean>;

  /**
   * How to retrieve (mode, depth, cap, rerank). ADDITIVE (0.6.0). Absent =
   * the pre-0.6.0 retrieval exactly. See `RetrievalPolicy`.
   */
  retrievalPolicy?: RetrievalPolicy;

  /**
   * OPTIONAL second retrieval path (ADDITIVE; omit it and nothing changes).
   * Runs CONCURRENTLY with the vector/hybrid retrieve — the latency of the extra call
   * is the cost being managed, so it must not be serialised behind the vector
   * retrieve — and is called with the condensed query. Its chunks are fused
   * with the vector matches by `fuseMatches` (RRF); its `context` string rides
   * into the user turn as its own labelled block.
   *
   * Fully opaque to the engine, and fully best-effort.
   */
  graphProvider?: GraphProvider;

  /**
   * Persist the grounding passage of each retrieved chunk into the provenance
   * (drives the citation card's quoted `<blockquote>`). ADDITIVE (≥0.3.0);
   * forwarded verbatim to `buildChatTurn`. `true` (default) stores full text,
   * `false` keeps the legacy lean shape, a number truncates to N chars.
   */
  includePassageText?: boolean | number;
}

/** Everything the engine assembled for a turn, transport-agnostic. */
export interface PreparedTurn {
  /** The full `messages[]` to send to ai-service (system + history + user). */
  messages: SyncChatMessage[];
  /** Provenance to persist on the assistant turn (null when nothing cited). */
  provenance: Provenance | null;
  /** The retrieved chunks (for citation rendering / debugging). */
  matches: RetrievedChunk[];
  /** The standalone query condense produced (for tracing). */
  retrievalQuery: string;
  /** The deterministic Tier-1 summary that rode in the user turn. */
  summaryText: string;
  /**
   * The optional graph block that rode in the user turn (for tracing). `''`
   * when no `graphProvider` was supplied, or it contributed no block.
   */
  graphContext: string;
  /**
   * `maxDenseScore` over the VECTOR/HYBRID matches: the best cosine, for a no-information gate.
   * ADDITIVE (0.6.0). `0` when nothing was retrieved. A chunk the dense leg
   * missed (it has a lexical or rerank score but no `denseScore`) counts as 0,
   * never its RRF or rerank score. A pure dense chunk (only `score`) counts
   * its `score`, which is the cosine there. Graph-provider chunks are left
   * out on purpose: their `score` is on the provider's own scale, and a chunk
   * carrying only `score` would otherwise be read as a cosine.
   */
  maxDenseScore: number;
  /**
   * Corpora whose retrieve failed this turn. ADDITIVE (0.6.0). The turn still
   * runs (best-effort); a product may surface partial grounding from this.
   */
  failedCorpora: string[];
  /**
   * `inlineRefs` past {@link MAX_INLINE_REFS} that were NOT resolved into the
   * turn. ADDITIVE (0.8.0). `0` when none. Each turn with drops also warns
   * `ref.capped`. A product may tell the reader some mentions were left out.
   */
  droppedRefs: number;
}

export interface RespondResult extends PreparedTurn {
  /** The synchronous generation result. */
  generation: SyncGenerationResult;
}

/**
 * The most `@`-mention refs one turn resolves. Refs past it are dropped, warned
 * `ref.capped` with the count, and reported as `PreparedTurn.droppedRefs`.
 */
export const MAX_INLINE_REFS = 8;

/**
 * Resolve `@`-mention refs into one clean-text block. Best-effort per ref —
 * a failing/empty resolve is dropped, never thrown. At most
 * {@link MAX_INLINE_REFS} refs are resolved; the rest are counted in
 * `droppedRefs`, never silently (each `resolveEntity` also self-caps its text).
 */
async function resolveInlineRefs(
  adapter: DomainAdapter,
  refs: ContextRef[] | undefined,
): Promise<{ text: string; droppedRefs: number }> {
  if (!refs || refs.length === 0) return { text: '', droppedRefs: 0 };
  const droppedRefs = Math.max(0, refs.length - MAX_INLINE_REFS);
  if (droppedRefs > 0) warnEngineCapped('ref.capped', droppedRefs);
  const blocks: string[] = [];
  for (const ref of refs.slice(0, MAX_INLINE_REFS)) {
    try {
      const text = await adapter.resolveEntity(ref);
      if (text && text.trim()) blocks.push(text.trim());
    } catch (err) {
      warnEngine('ref.failed', err); // best-effort per ref, never silent
    }
  }
  return { text: blocks.join('\n\n'), droppedRefs };
}

/**
 * Run the full context pipeline WITHOUT generating. The generation transport
 * (sync vs stream) is the caller's choice — `respond()` uses sync; a streaming
 * caller passes `prepareTurn()`'s `messages` to its own SSE open.
 */
export async function prepareTurn(args: RespondArgs): Promise<PreparedTurn> {
  const {
    config,
    aiClient,
    adapter,
    orgId,
    userId,
    scopeId,
    threadId,
    scope,
    history,
    userMessage,
    inlineRefs,
    teamInstructions,
    threadInstructions,
    retrievalFilter,
    retrievalPolicy,
    graphProvider,
    includePassageText,
  } = args;

  // 1. Condense the follow-up into a standalone retrieval query (fail-safe).
  const retrievalQuery = await condenseQuery(aiClient, {
    condenseSystemPrompt: config.condenseSystemPrompt,
    surface: config.surface,
    orgId,
    scopeId,
    userId,
    history,
    question: userMessage,
  });

  // 2. Resolve the scope into the deterministic Tier-1 summary + corpora
  //    (best-effort — a throwing/empty resolver degrades to no summary, no
  //    extra corpora; the per-thread corpus is still always retrieved).
  let summaryText = '';
  let corpora: Awaited<ReturnType<DomainAdapter['scopeHierarchy']>>['corpora'] = [];
  try {
    const resolved = await adapter.scopeHierarchy(scope);
    summaryText = resolved.summaryText ?? '';
    corpora = resolved.corpora ?? [];
  } catch (err) {
    // best-effort: degrade to tenant-/thread-only context, never silently
    warnEngine('scope.failed', err);
  }

  // 3. Scoped retrieval (resolver corpora + per-thread corpus + filter), and —
  //    when the consumer injected one — the optional graph path, CONCURRENTLY.
  //    No policy → the exact pre-0.6.0 call; failures are then only warned.
  //    Not sequentially: the graph path's extra round trip is the cost being
  //    managed, and running it alongside hides most of that latency.
  //    Best-effort like every other step: an erroring, timing-out or
  //    empty-handed provider degrades to the plain retrieved turn, with no
  //    message to the user (a failure still warns `graph.failed`).
  const retrieveArgs = {
    aiClient,
    orgId,
    fallbackScopeId: scopeId ?? orgId,
    corpora,
    threadId,
    query: retrievalQuery,
    ...(retrievalFilter ? { filter: retrievalFilter } : {}),
  };
  const [retrieved, graph] = await Promise.all([
    retrieveWithPolicy(retrieveArgs, retrievalPolicy),
    graphProvider
      ? Promise.resolve()
          .then(() => graphProvider(retrievalQuery))
          .catch((err: unknown) => {
            warnEngine('graph.failed', err);
            return null;
          })
      : Promise.resolve(null),
  ]);
  const { matches: vectorMatches, failedCorpora } = retrieved;

  // Fuse the two ranked lists. With no graph chunks the retrieved list is used
  // as-is. A hybrid list is
  // fused by its server ORDER (`vectorRanked`), never re-sorted by its
  // rank-based scores; the cap follows the policy's `limit`.
  const graphChunks = graph?.chunks ?? [];
  const matches =
    graphChunks.length > 0
      ? fuseMatches(vectorMatches, graphChunks, {
          mergedCap: retrievalPolicy?.limit ?? DEFAULT_MERGED_CAP,
          vectorRanked: retrievalPolicy?.mode === 'hybrid',
        })
      : vectorMatches;
  const graphContext = graph?.context?.trim() ? graph.context : '';

  // 4. Resolve @-mention refs into clean text (best-effort).
  const { text: inlineRefsText, droppedRefs } = await resolveInlineRefs(adapter, inlineRefs);

  // 5. Assemble the turn — ALL factual context in the USER turn (invariant).
  const { messages, provenance } = buildChatTurn({
    config,
    history,
    summaryText,
    retrievedMatches: matches,
    // Absent → `buildChatTurn` renders exactly what it rendered before the
    // graph path existed.
    ...(graphContext ? { graphContext } : {}),
    inlineRefsText,
    userMessage,
    teamInstructions,
    threadInstructions,
    ...(includePassageText !== undefined ? { includePassageText } : {}),
  });

  return {
    messages,
    provenance,
    matches,
    retrievalQuery,
    summaryText,
    graphContext,
    maxDenseScore: maxDenseScore(vectorMatches),
    failedCorpora,
    droppedRefs,
  };
}

/**
 * Full synchronous turn: prepare context + generate. Returns the generation
 * result alongside the prepared-turn artefacts (provenance/matches) so the
 * caller can persist the assistant turn + render citations.
 *
 * An answer with no visible text throws `EmptyAnswerError` (0.9.0): it is a
 * failed turn, never a successful empty message to persist.
 */
export async function respond(args: RespondArgs): Promise<RespondResult> {
  const prepared = await prepareTurn(args);
  const generation = await args.aiClient.generateSync({
    surface: args.config.surface,
    orgId: args.orgId,
    scopeId: args.scopeId,
    userId: args.userId,
    messages: prepared.messages,
    effort: args.config.chatEffort,
    maxTokens: args.config.chatMaxTokens,
  });
  return { ...prepared, generation: assertAnswer(generation) };
}
