/**
 * HMAC-SHA256 verify helper — ai-service → consumer webhook callback contract.
 *
 * Verifies the signature ai-service puts on every webhook callback. Keep the
 * public surface (`verifyCallbackSignature`) stable — the receiver route is its
 * only caller and the tests pin the reason codes.
 *
 * Two operational pitfalls this helper is designed around:
 *
 * 1. **Sign the raw bytes, not re-serialized JSON.** Callers MUST pass the
 *    exact request body as received (via `await req.text()`), BEFORE any
 *    JSON.parse / JSON.stringify round-trip — those lose byte-fidelity (key
 *    order, whitespace, number formatting) and break HMAC verification.
 *
 * 2. **Constant-time compare.** `expected === got` on hex strings leaks the
 *    secret one character at a time via timing. This helper uses
 *    `crypto.timingSafeEqual` on equal-length byte buffers; a length
 *    mismatch short-circuits before the comparison (still constant-time
 *    for the equal-length case).
 *
 * Replay window: see {@link CALLBACK_SKEW_WINDOW_SECONDS} — it is 900s, NOT the
 * 300s the contract document claims, and the reason is written out there.
 * Either way both sides need decent clock sync; any host running NTP is fine.
 */

import crypto from 'node:crypto'

/** Header names — lower-case, as Node's IncomingMessage normalizes them. */
export const CALLBACK_TIMESTAMP_HEADER = 'x-aiservice-timestamp' as const
export const CALLBACK_SIGNATURE_HEADER = 'x-aiservice-signature' as const
export const CALLBACK_EVENT_HEADER = 'x-aiservice-event' as const

/**
 * ±15-minute replay window.
 *
 * 🔴 DO NOT "FIX" THIS BACK TO 300. The callback contract document says ±300s,
 * and the contract document is WRONG about our ai-service.
 *
 * Measured in `services/ai-service/src/services/callbacks/emit.ts`: the
 * timestamp is stamped ONCE when the callback is enqueued and REUSED for every
 * retry, and the retry schedule runs out to roughly **t+10 minutes**. With a
 * 300s window, every retry after the ~5-minute mark is rejected as a replay —
 * so a callback that failed once because this backend was mid-deploy can never
 * succeed, and the document it was about stays in `ingestStatus: "embedding"`
 * forever with a 401 in the logs that reads like an attack.
 *
 * 900s covers the whole retry schedule with margin. It costs a wider replay
 * window on a signature an attacker would have to have captured anyway; that
 * trade is worth not silently losing the tail of every retry schedule.
 *
 * ⚠ If ai-service ever starts re-signing with a FRESH timestamp per attempt,
 * this can go back to 300 — but change it in the same commit as that, not
 * before, and not because a doc says so.
 */
export const CALLBACK_SKEW_WINDOW_SECONDS = 900

export type VerifyOutcome =
  | { ok: true }
  | {
      ok: false
      /**
       * Stable reason code for logging / metric labelling. Do NOT leak the
       * details to the client — the receiver should reply 401 with no body
       * (or a generic "signature mismatch") regardless of reason.
       */
      reason:
        | 'missing_signature'
        | 'missing_timestamp'
        | 'bad_timestamp'
        | 'stale_timestamp'
        | 'signature_mismatch'
        | 'no_secret_configured'
    }

export interface VerifyCallbackOptions {
  /** Raw request body, exact bytes as received (NOT re-stringified JSON). */
  rawBody: string
  /**
   * Header value of `X-AIService-Timestamp` (unix seconds, string).
   *
   * ⚠ This is the ENQUEUE time, not the send time — ai-service reuses it across
   * the whole retry schedule. That is why the window is 900s.
   */
  timestamp: string | null | undefined
  /** Header value of `X-AIService-Signature` (hex sha256). */
  signature: string | null | undefined
  /** Shared HMAC secret. Caller's job to ensure it's loaded from env. */
  secret: string | null | undefined
  /**
   * Defaults to `Math.floor(Date.now() / 1000)`. Injectable for tests so
   * we can fabricate stale / future timestamps deterministically.
   */
  now?: () => number
  /**
   * Defaults to {@link CALLBACK_SKEW_WINDOW_SECONDS}. Don't override at
   * call-sites; exposed only for the test that exercises stale-rejection.
   */
  skewWindowSeconds?: number
}

/**
 * Sign a payload — used by tests (and by SDKs / replay tooling). The
 * production emit side lives in ai-service and re-implements this; keeping
 * a copy here means tests don't depend on the emit-side package shape.
 */
export function signCallback(opts: {
  timestamp: number | string
  body: string
  secret: string
}): string {
  const message = `${opts.timestamp}.${opts.body}`
  return crypto.createHmac('sha256', opts.secret).update(message).digest('hex')
}

/**
 * Verify the HMAC + replay-window of an incoming ai-service callback POST.
 *
 * @returns `{ ok: true }` on success, or `{ ok: false, reason }` describing
 *          which check failed. Always reply 401 to the client on `ok: false`
 *          regardless of the reason — don't leak which step failed.
 */
export function verifyCallbackSignature(
  opts: VerifyCallbackOptions,
): VerifyOutcome {
  const { rawBody, timestamp, signature, secret } = opts

  if (!secret) {
    return { ok: false, reason: 'no_secret_configured' }
  }
  if (!signature) {
    return { ok: false, reason: 'missing_signature' }
  }
  if (!timestamp) {
    return { ok: false, reason: 'missing_timestamp' }
  }

  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || ts <= 0) {
    return { ok: false, reason: 'bad_timestamp' }
  }

  const now = (opts.now ?? defaultNow)()
  const skewWindow = opts.skewWindowSeconds ?? CALLBACK_SKEW_WINDOW_SECONDS
  if (Math.abs(now - ts) > skewWindow) {
    return { ok: false, reason: 'stale_timestamp' }
  }

  const expected = signCallback({ timestamp: ts, body: rawBody, secret })

  // Length mismatch ⇒ definitely not a match. Skip timingSafeEqual which
  // throws on uneven-length buffers; we'd be done anyway.
  if (expected.length !== signature.length) {
    return { ok: false, reason: 'signature_mismatch' }
  }

  let equal = false
  try {
    equal = crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex'),
    )
  } catch {
    // Malformed hex in either side (odd length, non-hex chars). Treat as
    // mismatch; never bubble the parse error to the client.
    return { ok: false, reason: 'signature_mismatch' }
  }

  return equal ? { ok: true } : { ok: false, reason: 'signature_mismatch' }
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000)
}
