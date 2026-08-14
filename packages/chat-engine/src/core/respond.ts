/**
 * `respond()` — the top-level engine orchestrator. Given a chat turn and a
 * `DomainAdapter`, it chains the whole context-aware-RAG pipeline:
 *
 *   condense (anaphora → standalone query)
 *     → scopeHierarchy (deterministic Tier-1 summary + retrieval corpora)
 *     → retrieve (corpora + per-thread corpus + ai-service `filter`)
 *     → resolveEntity for each @-mention ref (clean text)
 *     → buildChatTurn (USER-TURN INJECTION — the load-bearing invariant)
 *     → generate (sync) | streaming passthrough
 *     → provenance shaping
 *
 * EVERY context step is best-effort: a failing summary / retrieve / condense /
 * ref-resolve degrades to empty and NEVER breaks the turn (spec §5.8).
 *
 * Router-agnostic by design: any routing decision sits IN FRONT of the engine
 * and decides whether to call `respond()` at all. The engine never routes; it
 * just runs the RAG conversation. `prepareTurn()` is exported separately so a
 * caller (e.g. a streaming one) can assemble the turn without committing to a
 * generation transport.
 */

import type { AIClient, ChatHistoryRow, RetrievedChunk, Provenance, SyncChatMessage, SyncGenerationResult } from './types.js';
import type { ContextRef, ContextScope } from './types.js';
import type { DomainAdapter } from './adapter.js';
import type { EngineConfig } from './config.js';
import { condenseQuery } from './condense.js';
import { retrieveContext } from './retrieve.js';
import { buildChatTurn } from './turn.js';

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
}

export interface RespondResult extends PreparedTurn {
  /** The synchronous generation result. */
  generation: SyncGenerationResult;
}

/**
 * Resolve `@`-mention refs into one clean-text block. Best-effort per ref —
 * a failing/empty resolve is dropped, never thrown. Capped per the engine's
 * inline-ref budget at the adapter level (each `resolveEntity` self-caps).
 */
async function resolveInlineRefs(
  adapter: DomainAdapter,
  refs: ContextRef[] | undefined,
): Promise<string> {
  if (!refs || refs.length === 0) return '';
  const blocks: string[] = [];
  for (const ref of refs.slice(0, 8)) {
    try {
      const text = await adapter.resolveEntity(ref);
      if (text && text.trim()) blocks.push(text.trim());
    } catch {
      /* best-effort per ref */
    }
  }
  return blocks.join('\n\n');
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
  } catch {
    /* best-effort: degrade to tenant-/thread-only context */
  }

  // 3. Scoped retrieval (resolver corpora + per-thread corpus + filter).
  const matches = await retrieveContext({
    aiClient,
    orgId,
    fallbackScopeId: scopeId ?? orgId,
    corpora,
    threadId,
    query: retrievalQuery,
    ...(retrievalFilter ? { filter: retrievalFilter } : {}),
  });

  // 4. Resolve @-mention refs into clean text (best-effort).
  const inlineRefsText = await resolveInlineRefs(adapter, inlineRefs);

  // 5. Assemble the turn — ALL factual context in the USER turn (invariant).
  const { messages, provenance } = buildChatTurn({
    config,
    history,
    summaryText,
    retrievedMatches: matches,
    inlineRefsText,
    userMessage,
    teamInstructions,
    threadInstructions,
    ...(includePassageText !== undefined ? { includePassageText } : {}),
  });

  return { messages, provenance, matches, retrievalQuery, summaryText };
}

/**
 * Full synchronous turn: prepare context + generate. Returns the generation
 * result alongside the prepared-turn artefacts (provenance/matches) so the
 * caller can persist the assistant turn + render citations.
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
  return { ...prepared, generation };
}
