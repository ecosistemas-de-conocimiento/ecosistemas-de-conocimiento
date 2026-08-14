/**
 * Adapt chat's BFF `AIServiceClient` (the `unit`-shaped wire client) to the
 * `@edc/chat-engine` `AIClient` seam (`generateSync({messages})` +
 * `retrieve({corpus, query, topK, filter})`).
 *
 * Two impedance mismatches handled here:
 *
 *  1. **generate shape.** The engine hands us a full `messages[]` (system +
 *     history + the user-turn-injected message); ai-service takes a real
 *     `systemPrompt` plus ONE rendered user message. `buildChatUnitRequest`
 *     (`./wire.ts`) owns that partition — see its header for what moves where
 *     and why. It used to be a system-role FOLD (everything flattened into the
 *     user message with literal `system:` markers); that is gone.
 *
 *  2. **retrieve shape + filter.** chat's `RetrieveResponse` is `{chunks}`
 *     with `{chunkId, documentId, ordinal, text, score, metadata}`; the engine
 *     wants `{matches}` with `{documentId, chunkId, score, text, metadata}`.
 *     We map it. The engine's `filter` is forwarded to ai-service `/v1/retrieve`
 *     as an extra field even though `@edc/ai-client@0.2.0` (and chat's
 *     local schema) don't type it — a sibling client already does this; the
 *     ai-service `filter` shipped in `d312d10`. chat's local zod schema is
 *     `.strict()`, so we bypass it for the filtered path (raw fetch) and fall
 *     back to the typed client when no filter is present.
 */

import type {
  AIClient as EngineAIClient,
  RetrieveRequest as EngineRetrieveRequest,
  RetrieveResult as EngineRetrieveResult,
  SyncGenerationRequest as EngineSyncGenerationRequest,
  SyncGenerationResult as EngineSyncGenerationResult,
  IngestRequest as EngineIngestRequest,
  IngestResult as EngineIngestResult,
} from '@edc/chat-engine/core';
import type { AIServiceClient } from '$lib/server/aiService';
import { buildChatUnitRequest } from './wire';
import { useRegistryPrompt } from './promptSource';
import { buildRetrieveBody } from '$lib/server/retrieval';
import { env } from '$env/dynamic/private';

/** Map the engine's effort tier to ai-service's `effortLevel`. */
function effortLevel(effort: string | undefined): string | undefined {
  // chat's ai-service registry accepts these; pass through unchanged. Unknown
  // values are dropped so a future tier can't break the call.
  if (effort && ['quick', 'standard', 'deep', 'maximum'].includes(effort)) return effort;
  return undefined;
}

interface RawRetrieveChunk {
  chunkId: string;
  documentId: string;
  ordinal?: number;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * Build an engine `AIClient` over chat's BFF client + a session-scope tag.
 * `signal` (optional) propagates the request's AbortSignal to the generate
 * call so a user "Stop" cancels the upstream.
 */
export function makeEngineAIClient(
  chatClient: AIServiceClient,
  opts: { sessionId: string; signal?: AbortSignal; asOf?: string | null } = { sessionId: '' },
): EngineAIClient {
  return {
    async generateSync(req: EngineSyncGenerationRequest): Promise<EngineSyncGenerationResult> {
      // `generateSync` itself asserts `systemPromptApplied === true` whenever
      // the built request carried a `systemPrompt`, so a dropped or unsupported
      // system prompt throws here rather than silently degrading the answer.
      const result = await chatClient.generateSync(
        buildChatUnitRequest({
          messages: req.messages,
          unitKey: opts.sessionId || req.scopeId || req.surface,
          // Off unless PROMPT_SOURCE=registry, so this is today's
          // behaviour until an operator flips it — see `./promptSource`.
          useRegistryPrompt: useRegistryPrompt(),
          ...(effortLevel(req.effort) ? { effortLevel: effortLevel(req.effort)! } : {}),
          ...(req.modelOverride ? { modelOverride: req.modelOverride } : {}),
        }),
        opts.signal ? { signal: opts.signal } : {},
      );
      // ⚠ `warnings` (e.g. BUDGET_SOFT_CAP) is carried as an EXTRA field the
      // engine cannot type: `SyncGenerationResult` in
      // `@edc/chat-engine/core` has no `warnings` key, and that package
      // is published and shared — we must not edit it here. The engine's
      // `respond()` returns the generation object by reference
      // (`return { ...prepared, generation }`), so an extra field rides through
      // untouched and the BFF reads it back off the result. If chat-engine ever
      // starts re-shaping the generation, this field dies silently — the fix
      // then is to add `warnings` to `SyncGenerationResult` in the prototypes.
      const passthrough: EngineSyncGenerationResult & { warnings?: unknown } = {
        text: result.text,
        parsed: result.parsed,
        modelUsed: result.modelUsed ?? 'unknown',
        provider: result.provider ?? 'unknown',
        costUsd: result.costUsd ?? 0,
        traceId: result.traceId ?? '',
      };
      if (result.warnings?.length) passthrough.warnings = result.warnings;
      return passthrough;
    },

    async retrieve(req: EngineRetrieveRequest): Promise<EngineRetrieveResult> {
      // 🔴 ALL retrieval goes through the raw path now, filtered or not, so
      // that every call carries `asOf`. The typed client's zod schema is
      // `.strict()` and would reject the extra field — and a retrieve without
      // `asOf` still returns the chunks of UNPUBLISHED documents, because
      // unpublishing only end-dates them. See `$lib/server/retrieval`.
      const chunks = await retrieveScoped(req, opts.asOf);
      return {
        matches: chunks.map((c) => ({
          documentId: c.documentId,
          chunkId: c.chunkId,
          score: c.score,
          text: c.text,
          ...(c.metadata ? { metadata: c.metadata } : {}),
        })),
      };
    },

    // apps/web does not ingest from the BFF (the backend's Documents hook owns
    // ingest). The engine's corpus-sync path is unused on this surface; provide
    // a no-op so the seam is satisfied.
    async ingest(_req: EngineIngestRequest): Promise<EngineIngestResult> {
      return { ingested: 0, documentIds: [] };
    },
  };
}

/**
 * Retrieve one corpus, always scoped to `asOf`.
 *
 * Raw fetch rather than the typed client: the local zod schema is `.strict()`
 * and types neither `filter` nor `asOf`.
 *
 * 🔴 FAILS CLOSED. `buildRetrieveBody` returns null when there is no `asOf`,
 * and we then return no chunks instead of retrieving unscoped. That is
 * deliberate: an unscoped retrieve silently includes the chunks of unpublished
 * documents, so "answer with less context" is the correct degradation and
 * "answer with leaked context" is not. Failure is otherwise swallowed by the
 * engine's per-corpus try/catch, so an empty result just drops this corpus.
 */
async function retrieveScoped(
  req: EngineRetrieveRequest,
  asOf: string | null | undefined,
): Promise<RawRetrieveChunk[]> {
  const baseUrl = env.AI_SERVICE_URL?.replace(/\/+$/, '');
  const apiKey = env.AI_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) return [];

  const body = buildRetrieveBody({
    corpus: req.corpus,
    query: req.query,
    topK: req.topK,
    filter: req.filter,
    asOf,
  });
  if (!body) {
    console.error(
      `[retrieve] refusing to retrieve corpus "${req.corpus}" without an asOf ` +
        '— unpublished documents would be included. Check GET /api/sessions/:id/corpora.',
    );
    return [];
  }

  const post = (payload: Record<string, unknown>) =>
    fetch(`${baseUrl}/v1/retrieve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

  let res = await post(body);
  if (!res.ok) {
    // An ai-service that rejects the extra `filter` field: retry without it so
    // scoped retrieval degrades to unfiltered rather than empty.
    // ⚠ `asOf` is NOT dropped on the retry — that would reintroduce the leak.
    // If the 400 was caused by `asOf` itself, we take the empty result.
    if (res.status === 400 && body.filter !== undefined) {
      const { filter: _dropped, ...withoutFilter } = body;
      res = await post(withoutFilter);
    }
    if (!res.ok) return [];
  }
  const parsed = (await res.json().catch(() => ({}))) as { chunks?: RawRetrieveChunk[] };
  return parsed.chunks ?? [];
}
