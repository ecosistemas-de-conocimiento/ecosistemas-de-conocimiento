// Project router-internal token accounting onto the public wire shape.
//
// Why this is a module and not two inline object literals
// -------------------------------------------------------
// `/v1/generate/sync` and the `done` frame of `/v1/generate/stream` are
// documented as carrying the SAME payload (see the frame contract comment in
// `src/routes/generate.ts`). They are built by two separate object literals
// several hundred lines apart, which is exactly how they drifted before: the
// token counts were computed, persisted to `traces` + `usage`, and then
// silently dropped by BOTH literals because each only forwarded
// `usage.estimatedCostUsd`. One shared projection means a future field can
// only be added in one place, and both routes get it.
//
// This layer PROJECTS, it never recomputes. The numbers already came back from
// the provider, were used for cost and written to the ledger; re-deriving them
// here (chars/4, say) would put a second, disagreeing set of numbers on the
// wire — which is the estimate consumers are trying to stop using.

import type { TokenUsage } from '../ai/router/types.js';

/**
 * Token counts as they appear on the HTTP response.
 *
 * Deliberately NOT `TokenUsage`: cost stays on the existing top-level
 * `costUsd` field (unchanged, so existing consumers are untouched), and this
 * object is only about tokens. `outputTokens` is the field a per-user credits
 * meter bills on, so it is the one required member.
 */
export interface WireUsage {
  outputTokens: number;
  inputTokens?: number;
  totalTokens?: number;
}

/**
 * Build the optional `usage` object for a generation response.
 *
 * Returns `undefined` when the provider genuinely reported no token counts, so
 * the caller omits the field. That matters: the adapter defaults absent
 * `prompt_tokens`/`completion_tokens` to `0`, so "provider said nothing" and
 * "provider said zero" arrive here indistinguishable as zeros. Sending
 * `{ outputTokens: 0 }` would look like an authoritative measurement of an
 * empty response, and a consumer metering credits would bill nothing while
 * believing it had a real number. An absent field makes them fall back to
 * their own estimate, which is the honest outcome.
 *
 * `inputTokens` and `totalTokens` are included only when positive — same
 * reasoning, one field at a time.
 */
export function projectWireUsage(usage: TokenUsage): WireUsage | undefined {
  const outputTokens = positiveOrZero(usage.outputTokens);
  const inputTokens = positiveOrZero(usage.inputTokens);

  // Nothing real to report ⇒ omit the whole object rather than send zeros.
  if (outputTokens === 0 && inputTokens === 0) return undefined;

  const totalTokens = positiveOrZero(usage.totalTokens);

  return {
    outputTokens,
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(totalTokens > 0 ? { totalTokens } : {}),
  };
}

/**
 * Coerce a count to a non-negative integer. Guards against a provider (or a
 * stubbed adapter) handing back `NaN`, `Infinity`, a negative, or a float —
 * none of which should ever reach a billing consumer as-is.
 */
function positiveOrZero(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}
