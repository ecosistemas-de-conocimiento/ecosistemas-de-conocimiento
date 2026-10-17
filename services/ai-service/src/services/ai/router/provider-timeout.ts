// `ProviderTimeout` — the provider was cut off by OUR deadline.
//
// Decision (Rodrigo, option A of
// `plan/tecnología/prod-readiness/ai-reality-audit.md` §3 item 5):
// when `LLM_REQUEST_TIMEOUT_MS` (the router's wall-clock deadline) or
// `LLM_STREAM_STALL_TIMEOUT_MS` (the streaming adapter's inactivity backstop)
// cuts a generation, the call FAILS: 504 on the JSON transports, a terminal
// `error` frame mid-stream, a failed job on the async path. The org is not
// charged; the router refunds every hold and writes a $0 `aborted` trace marked
// `truncated: true`, `reason: 'provider_timeout'`.
//
// Before this class the 504 body was a hand-rolled literal in
// `routes/generate.ts`, and only for a timeout in the FIRST pass. A deadline
// that fired in a refine or extra-sample pass was swallowed as "best effort",
// and the primary draft went out as a 200 and was billed (measured:
// req-1gk, 120038 ms, $0.0009979).
//
// Wire shape is ADDITIVE over the old literal `{ error, message }`: `code`,
// `truncated` and `reason` are new fields, so a consumer on any client that
// switched on `error === 'ProviderTimeout'` keeps matching.
//
// ⚠ Not a shutdown and not a client disconnect. Those still surface as
// `OpenRouterAbortError` and still bill the partial — see `router.ts`.

import { AiServiceError } from '../../../errors/base.js';

export const PROVIDER_TIMEOUT_REASON = 'provider_timeout' as const;

export class ProviderTimeout extends AiServiceError {
  readonly code = 'ERR_PROVIDER_TIMEOUT';
  readonly status = 504;
  /** Fastify's default error handler reads THIS one. */
  readonly statusCode = 504;
  /** A slow provider day is worth one more try; the call was not billed. */
  override readonly retryable = true;
  /** The deadline fires after the SSE reply is hijacked. */
  override readonly midStream = true;
  readonly truncated = true as const;
  readonly reason = PROVIDER_TIMEOUT_REASON;
  /** The router trace id, so a consumer can quote it in a support ticket. */
  readonly traceId: string | undefined;

  constructor(opts: { traceId?: string; cause?: unknown } = {}) {
    super('The upstream LLM provider exceeded the request timeout.');
    this.name = 'ProviderTimeout';
    this.traceId = opts.traceId;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }

  protected override bodyFields() {
    return {
      code: this.code,
      truncated: this.truncated,
      reason: this.reason,
      ...(this.traceId ? { traceId: this.traceId } : {}),
    };
  }

  /** Frame field names predate the taxonomy: frame `errorCode` ≡ body `code`. */
  override streamFields() {
    return {
      errorCode: this.code,
      truncated: this.truncated,
      reason: this.reason,
      ...(this.traceId ? { traceId: this.traceId } : {}),
    };
  }
}

/**
 * Did this failure come from one of OUR timeouts?
 *
 * Two sources:
 *   - the router's wall-clock deadline — `deadlineCause === 'timeout'`;
 *   - the adapter's stall backstop, which aborts an INTERNAL controller, so the
 *     router's own signal never fires. Its reason is a `TimeoutError`
 *     DOMException, which `fetch` rejects with and the adapter keeps as `cause`.
 * A shutdown aborts with a string reason and a disconnect with an `AbortError`,
 * so neither matches.
 */
export function isProviderTimeout(err: unknown, deadlineCause: string): boolean {
  if (deadlineCause === 'timeout') return true;
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    if (cur.name === 'TimeoutError') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
