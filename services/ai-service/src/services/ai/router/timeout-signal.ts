// Combined abort signal: client-disconnect OR wall-clock timeout.
//
// The route layer builds an AbortController and aborts it on `req.raw 'close'`
// (client disconnect). That is the ONLY thing that bounded a provider call
// before this module: if OpenRouter held the socket open without honouring TCP
// close, or stalled mid-stream, nothing capped it. `withRequestTimeout` adds an
// independent wall-clock backstop that COMBINES with the disconnect signal —
// whichever fires first aborts the upstream fetch. What happens next depends
// on `cause()`: a disconnect takes the `OpenRouterAbortError` partial-billing
// path in `router.ts`; a TIMEOUT ends the call as an unbilled
// `ProviderTimeout` (504) — decision, see `provider-timeout.ts`.
//
// Node target is >=22 (engines) and we run on Node 24; both `AbortSignal.any`
// (Node 20.3+) and `AbortSignal.timeout` are available, so no setTimeout
// fallback is needed. We still build the controller ourselves rather than
// `AbortSignal.timeout` alone because we need:
//   - to combine with the optional inbound request signal, and
//   - a `finally`-safe `dispose()` that clears the timer so it never leaks when
//     the call finishes before the deadline.

/** The cause a combined signal aborted for, derived from `signal.reason`. */
export type AbortCause = 'timeout' | 'disconnect' | 'unknown';

export interface TimeoutSignal {
  /** Pass this into the adapter / fetch. */
  readonly signal: AbortSignal;
  /** Clear the wall-clock timer. MUST be called in a `finally`. Idempotent. */
  dispose(): void;
  /**
   * Why did the combined signal abort? Distinguishes a wall-clock timeout from
   * a client disconnect for accounting/observability. Returns `'unknown'` when
   * not aborted or the cause can't be determined.
   */
  cause(): AbortCause;
}

/**
 * Build a combined signal that aborts when EITHER `inbound` (client disconnect)
 * fires OR `timeoutMs` elapses. The inbound signal is optional (the async
 * worker path has no socket). When `timeoutMs <= 0` the wall-clock backstop is
 * disabled and the inbound signal (if any) is passed through unchanged.
 */
export function withRequestTimeout(
  inbound: AbortSignal | undefined,
  timeoutMs: number,
): TimeoutSignal {
  // Timeout disabled — degrade to the inbound signal (or a never-aborting one).
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    const signal = inbound ?? new AbortController().signal;
    return {
      signal,
      dispose() {
        /* no timer */
      },
      cause() {
        return inbound?.aborted ? 'disconnect' : 'unknown';
      },
    };
  }

  // Dedicated controller for the wall-clock deadline so we can clear the timer
  // explicitly (AbortSignal.timeout gives no handle to cancel its internal
  // timer, which would otherwise keep the event loop ref'd until it fires).
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => {
    timeoutCtrl.abort(
      new DOMException(`LLM request exceeded ${timeoutMs}ms wall-clock timeout`, 'TimeoutError'),
    );
  }, timeoutMs);
  // Don't let the backstop timer keep the process alive on its own.
  (timer as { unref?: () => void }).unref?.();

  const signal = inbound
    ? AbortSignal.any([inbound, timeoutCtrl.signal])
    : timeoutCtrl.signal;

  let disposed = false;
  return {
    signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
    },
    cause() {
      if (!signal.aborted) return 'unknown';
      // The combined signal's `reason` is whichever source aborted first. Our
      // wall-clock controller aborts with a `TimeoutError` DOMException; the
      // route's disconnect controller aborts with the default `AbortError`.
      const reason = (signal as AbortSignal & { reason?: unknown }).reason;
      const name = reason instanceof Error ? reason.name : undefined;
      if (name === 'TimeoutError') return 'timeout';
      if (timeoutCtrl.signal.aborted && !inbound?.aborted) return 'timeout';
      if (inbound?.aborted) return 'disconnect';
      return 'unknown';
    },
  };
}
