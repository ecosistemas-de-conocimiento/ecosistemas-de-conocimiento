/**
 * Cross-encoder reranking on chat turns: the retrieval policy EDC hands to
 * `@edc/chat-engine`. Pure (no `$env`), so the eval harness in `apps/backend`
 * imports this module, not a copy.
 *
 * ── WHAT IT TURNS ON ─────────────────────────────────────────────────────────
 *
 * ai-service's `/v1/retrieve` accepts `rerank: true`: it retrieves a pool of
 * `min(topK × 4, 50)` candidates, has the cross-encoder (dev: DeepInfra
 * Qwen3-Reranker-0.6B) re-score them against the query, and returns the top
 * `topK`. The returned `score` is then the cross-encoder value, `rerankScore`
 * carries it too, and `denseScore` keeps the cosine — which is why
 * `makeEngineAIClient` forwards all three: the engine's relevance helpers read
 * `denseScore`, never a cross-encoder `score`, as a similarity.
 *
 * ── WHERE THE RERANK HAPPENS, AND HOW MANY TIMES ─────────────────────────────
 *
 * chat-engine 0.6 can rerank ONCE after cross-corpus fusion only through a
 * `hybrid` policy plus `AIClient.retrieveMulti` (`/v1/retrieve/multi`). EDC
 * cannot use that path: the draft leg is post-filtered to this conversation's
 * documents and every retrieve must carry `asOf`, and neither fits one multi
 * call (see `aiClient.ts`). ai-service has no stand-alone rerank endpoint
 * either. So the rerank runs server-side ONCE PER CORPUS per turn:
 *
 *   · the published corpus  — pool 20 (topK 5 × 4)
 *   · the draft corpus      — pool 50 (the draft over-fetch of 20, × 4, capped)
 *
 * The two calls run in parallel. Query expansion (`./expand`) reranks only the
 * ORIGINAL query's search; its three variant searches go out without `rerank`,
 * so expansion does not multiply the rerank calls by four. The GraphRAG
 * widened retrieve (`$lib/server/graph`) builds its own request and is never
 * reranked — its query is a bag of graph terms, not a question.
 *
 * ── FAILURE ──────────────────────────────────────────────────────────────────
 *
 * ai-service's rerank rung is fail-safe on its own: a timeout
 * (`RERANK_TIMEOUT_MS`, 5 s by default) or a reranker error returns the fused
 * order. An HTTP error on a rerank request is retried once WITHOUT `rerank`
 * (`retrieveScoped` in `aiClient.ts`), so a misconfigured reranker costs one
 * round trip, never the corpus and never the turn.
 *
 * ⚠ ai-service advertises NO rerank capability in `GET /v1/capabilities`
 * (its `src/capabilities.ts` lists `retrievalLegs`, not a rerank name), so
 * there is nothing to gate on at boot. Whether rerank really ran is read off
 * each response: `legs` includes `rerank`, and chunks carry `rerankScore`.
 */

import {
  DEFAULT_MERGED_CAP,
  DEFAULT_PER_CORPUS_TOPK,
  type RetrievalPolicy,
} from '@edc/chat-engine/core';

/** `CHAT_RERANK` env value → on/off. Default ON; off on off/0/false/no. */
export function parseRerankFlag(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/**
 * The policy for a chat turn. `undefined` when rerank is off: the engine then
 * takes its pre-0.6.0 path, byte for byte — no policy fields on the wire.
 *
 * `dense` with the engine's own defaults (topK 5 per corpus, cap 8), so the
 * only thing the policy changes is `rerank: true` on each corpus retrieve.
 */
export function chatRetrievalPolicy(rerank: boolean): RetrievalPolicy | undefined {
  if (!rerank) return undefined;
  return {
    mode: 'dense',
    perCorpusTopK: DEFAULT_PER_CORPUS_TOPK,
    limit: DEFAULT_MERGED_CAP,
    rerank: true,
  };
}
