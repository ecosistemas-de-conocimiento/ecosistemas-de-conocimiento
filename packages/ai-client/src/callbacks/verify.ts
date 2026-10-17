/**
 * THE callback HMAC verifier — ai-service → consumer webhook contract.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS THE ONLY COPY. There used to be three.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Hand-copied verifiers drift: on missing-secret status, malformed-timestamp
 * status, header trimming, integer-vs-fractional timestamps, and on one security
 * constant (the replay window). Nothing detects it, and a written "keep these in
 * sync" contract does not hold.
 *
 * The fix is not a better comment. It is this file, plus
 * {@link CALLBACK_VERIFIER_CONFORMANCE_CASES} in `./conformance`, which every
 * receiver runs against the verifier it actually imports. Hand-rolling a
 * verifier again turns those tests red.
 *
 * WHY IT LIVES IN `@edc/ai-client` rather than a generic utility
 * package: this is the RECEIVING HALF of ai-service's own wire contract. Its
 * correctness is coupled to the emitter's behaviour (see the 🔴 note on
 * {@link CALLBACK_SKEW_WINDOW_SECONDS}), so it must version with the emitter.
 * ai-client is built from the same repo as the emitter, has zero runtime
 * dependencies, and is already an exact-pinned dependency of every consumer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Two pitfalls this helper is designed around
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. **Sign the raw bytes, never re-serialized JSON.** Callers MUST pass the
 *    exact body as received (`await req.text()`) BEFORE any JSON.parse /
 *    JSON.stringify round-trip — that loses byte-fidelity (key order,
 *    whitespace, number formatting) and the HMAC drifts. This helper takes an
 *    ALREADY-SERIALISED STRING and never parses anything. Body handling stays
 *    in the receiver, because Payload's `req` has no reliable `.text()` and
 *    each stack reads bytes differently.
 *
 * 2. **Constant-time compare.** `expected === got` on hex strings leaks the
 *    secret one character at a time via timing. This uses
 *    `crypto.timingSafeEqual` on equal-length buffers, with a length check and
 *    a hex-shape check first (both leak only the digest length, a fixed
 *    constant of SHA-256, and never a secret byte).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header names per the contract — lower-case, as Node normalizes them. */
export const CALLBACK_TIMESTAMP_HEADER = 'x-aiservice-timestamp' as const;
export const CALLBACK_SIGNATURE_HEADER = 'x-aiservice-signature' as const;
export const CALLBACK_EVENT_HEADER = 'x-aiservice-event' as const;

/**
 * ±5-minute replay window. THE contracted value
 * (`plan/tecnología/ai-infra/callback-contract.md`).
 *
 * ⚠ DO NOT WIDEN THIS TO 900. The argument has been made twice, it is written
 * down in at least two stale places, and it is dead. It is argued out of
 * existence here, at the constant, so the third person does not rediscover it.
 *
 * THE ARGUMENT. ai-service's retry schedule is `[0, 5s, 30s, 2m, 10m]`, each
 * delay measured from the previous attempt, so the fifth and final attempt
 * lands ~t+12m35s after enqueue. The emitter USED TO mint the timestamp once,
 * at enqueue, and resend it verbatim. Under a 300 s window the last two
 * attempts were therefore rejected as `stale_timestamp` → 401, and ai-service
 * maps 401 to a PERMANENT `auth_failed` and stops retrying. So the recovery
 * attempt that only happens BECAUSE the earlier ones failed could never
 * succeed. Widening every receiver to 900 s was the proposed workaround.
 *
 * WHY IT NO LONGER APPLIES. ai-service moved the stamping into
 * `attemptDelivery()`: every attempt re-signs `row.body` VERBATIM with the
 * current clock and persists the fresh `signedAtUnix` / `signature`. The body
 * bytes stay byte-identical; only the two header values change. A t+10min retry
 * therefore arrives stamped t+10min — seconds old, not ten minutes old.
 *
 * 🔴 THE COUPLING, STATED AT THE FAILURE SITE. 300 is correct ONLY WHILE
 * ai-service re-stamps per delivery attempt. If ai-service is rolled back past
 * `6ca6886`, or anyone hoists the stamping back to enqueue time, late retries
 * arrive bearing a 600-second-old timestamp and EVERY receiver in the fleet
 * silently refuses them as stale replays — leaving work stuck mid-ingest with
 * NOTHING IN ANY LOG NAMING THE CAUSE. The failure is invisible by
 * construction: a correct receiver rejecting a correctly-signed-but-stale
 * request looks exactly like an attack being repelled.
 *
 * The fix in that case is to RESTORE THE EMITTER, not to widen this. Widening
 * here hides an emitter regression behind a permanently weaker window — 3× the
 * contracted replay exposure, bought for nothing.
 *
 * This coupling is pinned by a test, not just by this comment:
 * `verify.test.ts` → "the +10m retry verifies BECAUSE the emitter re-stamps"
 * and its companion "…and would FAIL if stamping moved back to enqueue time".
 * That pair is the guard worth having: it catches the real regression instead
 * of encoding the workaround.
 *
 * Replay safety does not rest on this clock window alone. Each receiver's
 * dedupe table claims every accepted envelope exactly once on its natural key,
 * so a captured request replayed inside the window is recognised and discarded
 * without re-running a side effect. The window is the outer bound; the dedupe
 * is the guarantee.
 */
export const CALLBACK_SKEW_WINDOW_SECONDS = 300;

/**
 * Stable reason codes for logging and metric labelling.
 *
 * ⚠ NEVER put the reason in the HTTP response body. See {@link CallbackVerifyFailure.status}.
 */
export type CallbackVerifyReason =
  | 'no_secret_configured'
  | 'missing_signature'
  | 'missing_timestamp'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'signature_mismatch';

export interface CallbackVerifyFailure {
  ok: false;
  /** For logs and metrics ONLY. Do not send it to the client. */
  reason: CallbackVerifyReason;
  /**
   * The status the receiver MUST return. Only two values exist, and the
   * difference between them is load-bearing on the EMIT side:
   *
   * - **503 — "I am misconfigured, retry me."** Only `no_secret_configured`.
   *   ai-service treats 5xx as transient and keeps retrying on its backoff
   *   schedule, so the completion survives an unset environment variable long
   *   enough for an operator to set it. Answering 401 here
   *   makes ai-service mark the delivery `auth_failed` PERMANENTLY with no
   *   further retries, losing real completions to a missing env var.
   *
   * - **401 — "your signature is wrong, do not retry."** Every other reason.
   *   ai-service stops retrying this specific callback and alerts; an operator
   *   rotates the secret and replays. Retrying a bad signature would just burn
   *   the schedule.
   *
   * 🔴 The reason code is deliberately NOT reflected in the status beyond this
   * split. `bad_timestamp` returns 401, not 400, even though the timestamp is
   * arguably a malformed-request problem. At the point this check runs the
   * caller is UNAUTHENTICATED — nothing has been verified yet — so any status
   * that varies with which check failed is a free oracle: an attacker probes
   * "is the secret even configured", "did my timestamp shape pass", and narrows
   * the search without ever holding a valid signature. One receiver used to
   * return 400 here. Every non-secret failure now looks identical from outside.
   */
  status: 401 | 503;
}

export type CallbackVerifyOutcome = { ok: true } | CallbackVerifyFailure;

export interface VerifyCallbackOptions {
  /**
   * Raw request body, exact bytes as received, ALREADY SERIALISED.
   * NOT re-stringified JSON. This helper never parses it.
   */
  rawBody: string;
  /** Value of `X-AIService-Timestamp` (unix SECONDS, as a string). */
  timestamp: string | null | undefined;
  /** Value of `X-AIService-Signature` (lowercase hex sha256). */
  signature: string | null | undefined;
  /** The shared HMAC secret. Caller loads it from env; may be unset. */
  secret: string | null | undefined;
  /**
   * Defaults to `Math.floor(Date.now() / 1000)`. Injectable so tests can
   * fabricate stale / future timestamps deterministically.
   */
  now?: () => number;
  /**
   * Defaults to {@link CALLBACK_SKEW_WINDOW_SECONDS}. Do NOT override at a
   * call-site — exposed only for the tests that exercise stale rejection.
   */
  skewWindowSeconds?: number;
}

/**
 * Compute the signature for a body/timestamp pair.
 *
 * ⚠ `timestamp` is interpolated verbatim. The emitter builds
 * `` `${signedAtUnix}.${body}` `` and sends `String(signedAtUnix)`, so the
 * signed string and the header string are always the identical characters.
 * The verifier below therefore signs over the header string AS RECEIVED rather
 * than over a re-formatted parsed number — re-formatting is a canonicalisation
 * bug waiting to happen (`"01750000000"` and `"1750000000"` parse to the same
 * number but are different signed messages).
 */
export function signCallback(opts: {
  timestamp: number | string;
  body: string;
  secret: string;
}): string {
  return createHmac('sha256', opts.secret)
    .update(`${opts.timestamp}.${opts.body}`)
    .digest('hex');
}

/**
 * Constant-time hex digest comparison.
 *
 * `timingSafeEqual` THROWS on unequal-length buffers, so the length check comes
 * first. A non-hex character makes `Buffer.from(x, 'hex')` SILENTLY TRUNCATE,
 * which would let a short garbage signature compare equal to a truncated
 * expected value — hence the explicit hex-shape check on the untrusted side.
 */
function hexEqual(expected: string, got: string): boolean {
  if (expected.length !== got.length) return false;
  if (!/^[0-9a-fA-F]+$/.test(got)) return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(got, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

const defaultNow = (): number => Math.floor(Date.now() / 1000);

/**
 * Verify the HMAC + replay window of an incoming ai-service callback POST.
 *
 * The receiver's whole job on failure is:
 * `return respond(outcome.status, { error: '...' })` — log `outcome.reason`,
 * never send it.
 */
export function verifyCallbackSignature(
  opts: VerifyCallbackOptions,
): CallbackVerifyOutcome {
  const { rawBody, secret } = opts;

  // Fail CLOSED, but fail RETRYABLY. An unconfigured receiver must never accept
  // an unsigned write, and must never let ai-service give up on the delivery.
  if (!secret) {
    return { ok: false, reason: 'no_secret_configured', status: 503 };
  }

  // RFC 7230: leading/trailing optional whitespace is NOT part of a header
  // field value, and some proxies preserve it. Trim, or the same request
  // verifies on a trimming receiver and 401s on a non-trimming one — which is
  // exactly the divergence this file exists to end. The BODY is never trimmed.
  const got = String(opts.signature ?? '').trim();
  if (!got) return { ok: false, reason: 'missing_signature', status: 401 };

  const rawTs = String(opts.timestamp ?? '').trim();
  if (!rawTs) return { ok: false, reason: 'missing_timestamp', status: 401 };

  const ts = Number(rawTs);
  // Unix SECONDS, integer. A conforming emitter sends Math.floor(...), so a
  // fractional value is never legitimate — and it could not verify anyway,
  // since the signed message is built from these exact characters.
  if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts <= 0) {
    return { ok: false, reason: 'bad_timestamp', status: 401 };
  }

  const now = (opts.now ?? defaultNow)();
  const skewWindow = opts.skewWindowSeconds ?? CALLBACK_SKEW_WINDOW_SECONDS;
  if (Math.abs(now - ts) > skewWindow) {
    return { ok: false, reason: 'stale_timestamp', status: 401 };
  }

  // Sign over the header string as received (see signCallback's note).
  const expected = signCallback({ timestamp: rawTs, body: rawBody, secret });
  if (!hexEqual(expected, got)) {
    return { ok: false, reason: 'signature_mismatch', status: 401 };
  }

  return { ok: true };
}
