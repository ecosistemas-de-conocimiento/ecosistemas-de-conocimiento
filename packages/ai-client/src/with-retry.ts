// `withRetry` — an OPT-IN, call-level retry wrapper for ai-service calls.
//
// A bulk seed can hit ai-service's `/v1` limiter and leave rows stuck. Every
// consumer hits the same limiter, so the helper lives here.
//
// ── How it differs from the transport retry in `http.ts` ────────────────────
//
// `HttpClient` already retries transient failures of IDEMPOTENT requests, on a
// short ladder (3 attempts, 30 s budget). It deliberately HANDS BACK what that
// ladder cannot honestly wait out:
//   · a 429 whose `Retry-After` exceeds `maxDelayMs` (20 s). ai-service's
//     window is 1 minute (`src/server-limits.ts` V1_RATE_LIMIT_WINDOW), so a
//     burst routinely gets a wait of tens of seconds;
//   · its own `timeoutMs` expiry (`RequestAbortedError` reason `timeout`);
//   · anything on a non-idempotent call.
// This wrapper is the outer layer for exactly those cases. It never changes
// the client's default behaviour: nothing calls it unless you do.
//
// 🔴 429 ONLY BY DEFAULT. A 429 is refused before the handler runs, so a
// resend is free. A 503, a dropped connection or a timeout can mean the server
// DID the work and the answer was lost. `/v1/generate/sync` has no dedupe: a
// resend is a second generation and a second budget debit. So those are
// retried only on `retryTransient: true`, which a caller passes when it knows
// its call is safe to repeat.
//
// 🔴 LADDERS MULTIPLY. Wrapping a GET keeps the transport's 3 attempts INSIDE
// each of these, so the worst case is attempts × 3 requests. Pass
// `retry: { attempts: 1 }` on the wrapped call to let this layer own the policy.
//
// ⚠ DUCK-TYPED ON PURPOSE. A process can load two copies of this package (a
// direct dependency and a transitive one). Their error classes are distinct, so
// `instanceof RateLimitError` fails across copies. Every check here reads the
// shape instead: `status`, `name`, `retryable`, `retryAfterMs`, `reason`.
//
// ⚠ BUT NOT ANY 429. A bare `status: 429` also matches a fetch `Response`, a
// plain object, or another SDK's quota refusal (OpenAI's `insufficient_quota`),
// and each of those would hold the caller a full 61 s window for nothing. The
// rate-limit match needs this package's own pair, `name` `RateLimitError` AND
// `status` 429; the error-parity map gives ai-service's limiter no `ERR_` code
// (`RateLimitExceeded: { code: null }` in `errors.ts`), so the name is the
// stable field. A quota code anywhere on the error vetoes every retry: a quota
// does not refill in a minute.

export interface WithRetryOptions {
  /** TOTAL tries, including the first. An integer ≥ 1; `1` disables retry. Default 4. */
  attempts?: number;
  /**
   * Wall-clock budget in ms, measured from the first attempt. A finite number
   * ≥ 0. No sleep starts that would END past it. Default 120 000.
   *
   * ⚠ WALL CLOCK, NOT SUMMED SLEEP. The budget exists to bound how long a
   * caller is held, and a caller does not care whether the time went on
   * sleeping or on slow calls. It matches `RetryPolicy.maxElapsedMs` in this
   * package. It does not cut an attempt short; pass a `signal`/`timeoutMs` to
   * the wrapped call for that.
   */
  maxElapsedMs?: number;
  /**
   * Ceiling on a single wait, `Retry-After` included. Also the wait for a 429
   * that gave no hint at all. Default 61 000: one ai-service rate-limit window
   * (1 minute) plus 1 s of slack.
   */
  maxRetryAfterMs?: number;
  /** First step of the doubling ladder for an unhinted transient failure. Default 1 000. */
  baseDelayMs?: number;
  /**
   * Also retry TRANSIENT failures, not just a 429. Default `false`.
   *
   * Transient means: an error whose typed `retryable` flag is `true` (a
   * breaker-open 503, a provider-timeout 504), our own timeout
   * (`RequestAbortedError` reason `timeout`), or a network fault. The flag,
   * not the status, decides: ai-service marks a "database unavailable" 503
   * NOT retryable, and it is not retried.
   *
   * 🔴 Set it only when a repeat is harmless. Each of these can mean the work
   * happened and the answer was lost. `/v1/generate/sync` has no dedupe, so a
   * resend there is a second generation and a second debit.
   */
  retryTransient?: boolean;
  /**
   * Cancels the wait between attempts. On abort, `withRetry` stops at once and
   * rethrows `signal.reason`. An already-aborted signal means `fn` is never
   * called. It does not cancel an attempt in flight: pass the same signal to
   * the wrapped call for that.
   */
  signal?: AbortSignal;
  /** Called before each wait. Use it to log; it must not throw. */
  onRetry?: (info: RetryInfo) => void;
  /** Injectable for tests. Default: a `setTimeout` promise. `signal` cancels it either way. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. Default: `Date.now`. */
  now?: () => number;
  /** Injectable for tests (jitter). Default: `Math.random`. */
  random?: () => number;
}

export interface RetryInfo {
  /** The attempt that just failed, 1-based. */
  attempt: number;
  /** How long this wait will be, jitter included. */
  waitMs: number;
  error: unknown;
}

/**
 * The field `withRetry` adds to the ORIGINAL error when it gives up on a
 * retryable failure: how many attempts it made, the first included.
 * Non-enumerable, so logs and `JSON.stringify` are unchanged. Read it as
 * `(err as WithRetryAttempts).retryAttempts`.
 */
export interface WithRetryAttempts {
  readonly retryAttempts?: number;
}

/**
 * Defaults, and why each is what it is. The four values are quoted from a
 * consumer's production retry helper, where they were tuned against
 * ai-service's own limiter.
 *
 * - `attempts: 4` and `maxElapsedMs: 120_000`: 120 s fits one full rate-limit
 *   window plus its jitter (61 s + 5 s) with room for the calls themselves,
 *   while staying short enough for a request a person is waiting on. Two
 *   unhinted 429s (61 s each) overrun it, so that case stops at two attempts:
 *   when the server will not say how long, a visible failure beats minutes of
 *   blind waiting.
 * - `maxRetryAfterMs: 61_000`: ai-service's own window (1 minute) plus 1 s. A
 *   server asking for longer is fronted by something else; obeying it blindly
 *   can spend the whole budget on one sleep.
 * - `baseDelayMs: 1_000`: 1 s, 2 s, 4 s across 4 attempts is 7 s, enough for a
 *   restarting pod or a breaker half-open probe.
 */
export const DEFAULT_WITH_RETRY_OPTIONS = {
  attempts: 4,
  maxElapsedMs: 120_000,
  maxRetryAfterMs: 61_000,
  baseDelayMs: 1_000,
} as const;

/**
 * ⚠ JITTER IS NOT COSMETIC. N callers refused in the same second were all told
 * the same wait; firing exactly on it re-stampedes the window that just opened.
 * Each waiter adds up to 25% of its wait, capped at 5 s, always LATE, never
 * early.
 */
const JITTER_FRACTION = 0.25;
const MAX_JITTER_MS = 5_000;

/** Socket-level codes meaning "the connection broke", not "the server said no". */
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

type Shape = {
  status?: unknown;
  name?: unknown;
  code?: unknown;
  retryable?: unknown;
  retryAfterMs?: unknown;
  reason?: unknown;
  type?: unknown;
  body?: unknown;
  error?: unknown;
  message?: unknown;
  cause?: unknown;
};

function shape(err: unknown): Shape | undefined {
  return err !== null && typeof err === 'object' ? (err as Shape) : undefined;
}

/**
 * Is `err` worth repeating unchanged?
 *
 * Always: a rate limit from any copy of this package (`name` `RateLimitError`
 * and `status` 429). A bare `{ status: 429 }` is not enough. With `retryTransient`, also: a typed `retryable: true`, our
 * own timeout (`RequestAbortedError` reason `timeout`), and a network fault
 * (undici's `TypeError: fetch failed`, or a socket code on the error or its
 * `cause`; the transport rethrows these raw).
 *
 * Never: a quota refusal (a `code` or `type` containing `quota`, on the error,
 * its `body` or its `body.error`), a caller cancel, and any error not marked
 * retryable — a 4xx is a decision, and a 500 may mean the work half-happened.
 */
export function isRetryableError(err: unknown, opts: { retryTransient?: boolean } = {}): boolean {
  if (isQuota(err)) return false;
  if (isRateLimit(err)) return true;
  if (!opts.retryTransient) return false;
  const e = shape(err);
  if (!e) return false;
  if (e.name === 'RequestAbortedError') return e.reason === 'timeout';
  if (e.retryable === true) return true;
  return isNetworkError(err);
}

function isRateLimit(err: unknown): boolean {
  const e = shape(err);
  return e !== undefined && e.name === 'RateLimitError' && e.status === 429;
}

/** A quota code or type on the error, its `body`, or `body.error` (OpenAI's nesting). */
function isQuota(err: unknown): boolean {
  const e = shape(err);
  const body = shape(e?.body);
  const nested = shape(body?.error);
  return [e, body, nested].some(
    (s) => s !== undefined && [s.code, s.type].some((v) => typeof v === 'string' && /quota/i.test(v)),
  );
}

function isNetworkError(err: unknown): boolean {
  const e = shape(err);
  if (!e) return false;
  const code = e.code ?? shape(e.cause)?.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  return err instanceof TypeError && e.message === 'fetch failed';
}

/** The server's stated wait, when it gave a usable one. */
function hintMs(err: unknown): number | undefined {
  const ms = shape(err)?.retryAfterMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function check(name: string, value: number, ok: boolean, rule: string): number {
  if (!ok) throw new RangeError(`withRetry: \`${name}\` must be ${rule}; got ${String(value)}`);
  return value;
}

/**
 * Mark the original error with the attempt count, without changing its class
 * or its JSON. When the mark cannot be made (a frozen or sealed error, or a
 * locked `retryAttempts` already on it) the error is rethrown unmarked: a
 * `TypeError` from `defineProperty` would replace the error the caller needs.
 */
function giveUp(err: unknown, attempts: number): never {
  if (err !== null && typeof err === 'object') {
    try {
      Object.defineProperty(err, 'retryAttempts', {
        value: attempts,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
      // Unmarkable: throw the original as it is.
    }
  }
  throw err;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Sleep `ms`, or reject with `signal.reason` the moment it aborts. Without an
 * injected `sleep` the timer itself is cleared, so an abort leaves nothing
 * pending.
 */
function cancellableSleep(
  ms: number,
  sleep: ((ms: number) => Promise<void>) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return (sleep ?? defaultSleep)(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(signal.reason);
    };
    const done = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (sleep)
      sleep(ms).then(done, (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
    else timer = setTimeout(done, ms);
  });
}

/**
 * Run `fn`; on a retryable failure wait and run it again.
 *
 * Wait before retry `n`: the server's `retryAfterMs` when it sent one, capped
 * at `maxRetryAfterMs`. Otherwise a 429 waits the full `maxRetryAfterMs` (a
 * 1 s retry only spends an attempt on a bucket the server just said is full),
 * and a transient failure waits `baseDelayMs × 2^(n-1)`, same cap. Then jitter.
 *
 * Gives up LOUDLY, and always with the ORIGINAL error, so `instanceof
 * RateLimitError` keeps matching. A non-retryable error is rethrown untouched.
 * A retryable one that outlasts `attempts` or `maxElapsedMs` is rethrown with
 * a non-enumerable `retryAttempts` (see {@link WithRetryAttempts}). An abort
 * rethrows `signal.reason`. Nothing is ever swallowed: only the caller knows
 * where to record the failure.
 *
 * Rejects with a `RangeError` before calling `fn` when `attempts` is not an
 * integer ≥ 1, or a delay option is not a finite number ≥ 0.
 *
 * `fn` receives the 1-based attempt number.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<T> {
  const d = DEFAULT_WITH_RETRY_OPTIONS;
  const attempts = opts.attempts ?? d.attempts;
  check('attempts', attempts, Number.isInteger(attempts) && attempts >= 1, 'an integer ≥ 1');
  const finite = (name: string, v: number) =>
    check(name, v, Number.isFinite(v) && v >= 0, 'a finite number ≥ 0');
  const budget = finite('maxElapsedMs', opts.maxElapsedMs ?? d.maxElapsedMs);
  const cap = finite('maxRetryAfterMs', opts.maxRetryAfterMs ?? d.maxRetryAfterMs);
  const base = finite('baseDelayMs', opts.baseDelayMs ?? d.baseDelayMs);
  const { signal } = opts;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const startedAt = now();

  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (err) {
      if (!isRetryableError(err, opts)) throw err;
      const elapsed = now() - startedAt;
      if (attempt >= attempts) giveUp(err, attempt);

      const hinted = hintMs(err);
      const unhinted = isRateLimit(err) ? cap : base * 2 ** (attempt - 1);
      const wait = Math.min(cap, hinted ?? unhinted);
      const waitMs = Math.round(wait + Math.min(MAX_JITTER_MS, wait * JITTER_FRACTION) * random());

      // Stop BEFORE the sleep: sleeping past the budget only to give up after
      // holds the caller for the very time the budget exists to bound.
      if (elapsed + waitMs > budget) giveUp(err, attempt);

      opts.onRetry?.({ attempt, waitMs, error: err });
      await cancellableSleep(waitMs, opts.sleep, signal);
    }
  }
}
