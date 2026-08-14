// Router-internal pricing fallback. The effort-profile defaults live in
// `src/services/registry/resolve.ts` as `EFFORT_PROFILES` (single source of
// truth in ai-service); `TASK_PROFILES` is re-exported as an alias for back-
// compat with prototype-shaped imports. This file owns only the per-model price
// table used when OpenRouter doesn't return a `cost` field on usage.

import type { EffortLevel, EffortProfile } from '../../../types/generation.js';
import { EFFORT_PROFILES } from '../../registry/resolve.js';

export { EFFORT_PROFILES as TASK_PROFILES } from '../../registry/resolve.js';

/**
 * Per-million-token pricing in USD. Cross-checked against OpenRouter
 * via `scripts/refresh-model-pricing.ts`. Legacy entries kept
 * for cost-fallback on traces that reference older model strings.
 *
 * `embeddingPerMillion` is the per-1M-input-token price for embedding models
 * (input only; embeddings don't have an "output" token count). Completion
 * rows leave it `undefined`; embedding rows leave `inputPerMillion` /
 * `outputPerMillion` at 0 since they are never charged the completion way.
 */
export const MODEL_PRICING: Record<
  string,
  { inputPerMillion: number; outputPerMillion: number; embeddingPerMillion?: number }
> = {
  // Active defaults (open-weight, OpenRouter-routed):
  // DeepSeek shipped a chat-v3.1 cache-aware
  // price cut, and R1 settled at $0.70/$2.50 after its open-source push.
  'deepseek/deepseek-chat-v3.1': { inputPerMillion: 0.21, outputPerMillion: 0.79 },
  'moonshotai/kimi-k2-0905': { inputPerMillion: 0.6, outputPerMillion: 2.5 },
  'deepseek/deepseek-r1': { inputPerMillion: 0.7, outputPerMillion: 2.5 },
  // Legacy entries (kept for old trace cost-fallback):
  'openai/gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'openai/gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'anthropic/claude-3.5-sonnet': { inputPerMillion: 3, outputPerMillion: 15 },
  'anthropic/claude-3.5-haiku': { inputPerMillion: 0.8, outputPerMillion: 4 },
  'anthropic/claude-3.7-sonnet': { inputPerMillion: 3, outputPerMillion: 15 },
  'anthropic/claude-sonnet-4.5': { inputPerMillion: 3, outputPerMillion: 15 },
  // Embedding models — see plan/m3-m4-decisions.md §10 (1536-dim, the default
  // for RAG) / §9 (OpenRouter passthrough). Completion fields are 0 so a
  // mis-routed call (chat-style usage on an embedding model) costs nothing
  // rather than silently borrowing the wrong rate.
  //
  // `baai/bge-m3` is the ACTIVE default embedder (env.EMBEDDING_MODEL) — an
  // explicit entry so its cost is a decision, not a silent $0 lookup-miss
  // (Fable review #3). Rate is OpenRouter's listed $0.01 / 1M input tokens
  // (verified via openrouter.ai/baai/bge-m3); refresh via
  // `scripts/refresh-model-pricing.ts` if it moves. When self-hosted in prod
  // (env.EMBEDDINGS_URL points at our own box) the marginal token cost is ~0,
  // but keeping the managed-endpoint rate here keeps the ledger conservative.
  'baai/bge-m3': {
    inputPerMillion: 0,
    outputPerMillion: 0,
    embeddingPerMillion: 0.01,
  },
  'openai/text-embedding-3-small': {
    inputPerMillion: 0,
    outputPerMillion: 0,
    embeddingPerMillion: 0.02,
  },
  'openai/text-embedding-3-large': {
    inputPerMillion: 0,
    outputPerMillion: 0,
    embeddingPerMillion: 0.13,
  },
  // Deterministic e2e mock — small but non-zero prices so abort tests can
  // assert `actualCostUsd > 0`. Never reaches a real provider.
  'mock/model': { inputPerMillion: 1, outputPerMillion: 4 },
};

/** Compute USD cost for an embedding call. Mirrors `priceForUsage` but for the
 *  one-token-count (input only) shape embedding endpoints emit. Returns 0 for
 *  unknown models — embedded usage tracking should still record the row. */
export function priceForEmbedding(model: string, inputTokens: number): number {
  const row = MODEL_PRICING[model];
  if (!row || typeof row.embeddingPerMillion !== 'number') return 0;
  return (inputTokens / 1_000_000) * row.embeddingPerMillion;
}

/** Compute USD cost from a model name + token counts. */
export function priceForUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const row = MODEL_PRICING[model];
  if (!row) return 0;
  return (
    (inputTokens / 1_000_000) * row.inputPerMillion +
    (outputTokens / 1_000_000) * row.outputPerMillion
  );
}

/** Thin convenience wrapper over the registry's built-in defaults. */
export function getTaskProfile(effort: EffortLevel): EffortProfile {
  return { ...EFFORT_PROFILES[effort] };
}
