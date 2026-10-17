/**
 * Empty-generation predicates. ADDITIVE (0.6.0). Pure.
 *
 * ai-service can answer 200 with `text: ''`. That never throws, so a caller's
 * error path never sees it, and a blank bubble ships. These two predicates are
 * the shared rule.
 *
 * Chat itself does NOT retry (decision D3): it fails fast on an empty answer.
 * `shouldRetryEmpty` exists for a product that retries once.
 */

/** No visible text: missing, empty, or whitespace only. */
export function isEmptyGeneration(text: string | null | undefined): boolean {
  return !text || !text.trim();
}

/**
 * Whether ONE retry of an empty generation can help. `false` for `'length'`:
 * the output cap was spent before any visible text (a reasoning model burning
 * it on hidden reasoning), which is deterministic — a retry doubles the wait
 * to reach the same empty string. Any other reason, or none (a cache hit or an
 * older ai-service), is treated as transient: `true`.
 */
export function shouldRetryEmpty(finishReason: string | null | undefined): boolean {
  return finishReason !== 'length';
}
