// Minimal fetch wrapper for @edc/ai-client.
//
// Responsibilities:
//   - inject `Authorization: Bearer <apiKey>` on every call
//   - apply a request timeout (AbortController) when `timeoutMs` is set
//   - retry TRANSIENT failures of IDEMPOTENT requests (see `RetryPolicy`)
//   - parse JSON responses; non-2xx → throw a typed AIServiceError
//   - return the raw `Response` on streaming endpoints (SSE) so callers can
//     consume the body themselves
//
// Zero runtime deps. Uses the platform `fetch` (Node 18+ / browsers); a
// custom fetch can be injected via `AIClientOptions.fetch` for tests.

import { AIServiceError, RequestAbortedError, errorFromResponse } from './errors.js';

export interface HttpDeps {
  baseUrl: string;
  apiKey: string;
  /** Delegated org suffix, sent as `X-AI-Org` on every call. See `AIClientOptions.org`. */
  org?: string;
  fetchImpl: typeof fetch;
  /**
   * Per-attempt deadline in ms. Omit for {@link DEFAULT_TIMEOUT_MS}, which —
   * unlike an explicit value — is cut to the retry budget remaining, so a
   * caller that sets nothing keeps the 30 s wall over the whole call.
   */
  timeoutMs?: number;
  /** Transient-failure retry. Omit for `DEFAULT_RETRY_POLICY`. */
  retry?: Partial<RetryPolicy>;
}

/**
 * Retry policy for TRANSIENT failures of IDEMPOTENT requests.
 *
 * 🔴 IDEMPOTENT ONLY, and that is not a nicety. A retried non-idempotent POST
 * is a DOUBLE SPEND: `/v1/generate` debits the org budget, so a request that
 * succeeded server-side but whose response was lost in transit gets charged
 * twice if we resend it blind. So the default retries GET (safe by HTTP
 * semantics) and nothing else; a POST opts in per call with
 * `idempotent: true`, which is honest only when the call carries a
 * `clientRequestId` the server dedupes on, or has no side effect at all.
 *
 * 🔴 `idempotent: true` IS NOT A BLANKET LICENCE FOR POST. It is honest for
 * `POST /v1/generate`, which dedupes on `clientRequestId` and answers 409
 * `IdempotencyConflictError` — but ONLY when the caller actually sends one.
 * It is FALSE for `POST /v1/generate/sync`, which has no dedupe at all
 * (ai-service `routes/generate.ts:88` reads no `clientRequestId`): a resend
 * there is a second generation and a second budget debit. Do not set it.
 *
 * ⚠ SSE (`events.ts`) opens its stream with a GET, so it is retried by
 * default. That is intended for a connection that never established, but a
 * consumer reconnecting in its own loop is now stacking two ladders. So is any
 * caller hosted by a queue that already retries the job — BullMQ workers above
 * all: `attempts` here MULTIPLIES with the queue's, it does not replace them.
 * A retry added below an existing ladder compounds with it. When a caller
 * already owns a retry, pass `retry: { attempts: 1 }` and let the outer one
 * own the policy. (`CapabilitiesAPI.probe` does exactly this.)
 *
 * What counts as transient: a network/DNS/socket error, 408, 425, 429, and
 * 5xx. NOT 4xx otherwise — a 400/401/403/404 is a decision, and re-asking gets
 * the same answer more slowly. NOT an abort, ever: a caller cancel or a
 * `timeoutMs` expiry must stay one observable failure, or `timeoutMs` silently
 * becomes `attempts × timeoutMs` and a user-cancelled request keeps spending.
 * Both surface as {@link RequestAbortedError}, whose `cause` says which.
 */
export interface RetryPolicy {
  /** TOTAL attempts, not extra ones. `1` disables retry. */
  attempts: number;
  /** First backoff step in ms; doubles per attempt before jitter. */
  baseDelayMs: number;
  /**
   * Ceiling for a single exponential wait.
   *
   * ⚠ NOT a clamp on `Retry-After`. A server asking for longer than this is
   * not asking us to come back sooner — see `raw()`, which gives up instead.
   */
  maxDelayMs: number;
  /**
   * RETRY BUDGET, in wall-clock ms since the call began.
   *
   * Once it is spent, no FURTHER attempt starts (nor a backoff wait that would
   * end past it).
   *
   * 🔴 It never shortens an attempt whose `timeoutMs` was set EXPLICITLY — on
   * the client or on the call. Such an attempt runs for its full `timeoutMs`.
   * Until 0.26.0 every attempt was clamped to the budget remaining, so with
   * the 30 s default an explicit `timeoutMs: 120_000` became 30 s on EVERY
   * call, retried or not (measured: a `/v1/generate/sync`
   * aborted at 29 979 ms, billed for a partial generation). With an explicit
   * `timeoutMs`, a retried call can take up to about
   * `maxElapsedMs + timeoutMs`; pass `signal: AbortSignal.timeout(ms)` for a
   * hard ceiling over the whole ladder.
   *
   * With NO explicit `timeoutMs`, the default 30 s attempt IS still clamped to
   * the budget remaining, so a caller that sets nothing still waits at most
   * `maxElapsedMs` (30 s) in total, however many attempts it makes. Consumers
   * size boot deadlines on that. `Infinity`
   * lifts the budget.
   */
  maxElapsedMs: number;
}

/** Per-attempt deadline when neither the client nor the call sets `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 20_000,
  maxElapsedMs: 30_000,
};

export interface JsonRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** Extra headers (Authorization is set automatically). */
  headers?: Record<string, string>;
  /** Caller-supplied abort signal — composed with the timeout. */
  signal?: AbortSignal;
  /**
   * Declare THIS call safe to resend. GET is treated as idempotent without
   * asking; everything else needs an explicit `true`. Pass it only
   * when a duplicate delivery is harmless or deduped server-side (a
   * `clientRequestId`), because the retry can and will resend.
   */
  idempotent?: boolean;
  /** Per-call override of the client's retry policy. `{ attempts: 1 }` opts out. */
  retry?: Partial<RetryPolicy>;
  /**
   * Per-call override of the client's `timeoutMs`: the deadline for EACH
   * attempt. Never shortened by the retry budget (see `RetryPolicy.maxElapsedMs`).
   */
  timeoutMs?: number;
}

/**
 * Reject a `timeoutMs` that has no meaning as a deadline.
 *
 * 🔴 `NaN` and `-Infinity` THROW. Through 0.25.0 a `NaN` reached `setTimeout`,
 * which coerces it to ~1 ms, so the call aborted at once. The 0.26.0 draft's
 * `Number.isFinite` guard turned that into the opposite: no timer, so NO
 * deadline at all. Failing loudly is the only reading that cannot silently
 * hang a caller who computed the value wrong. `Infinity` stays legal and means
 * "no deadline"; `undefined` means the default.
 */
function assertTimeoutMs(value: unknown, where: string): void {
  if (value === undefined || value === Infinity) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(
      `ai-client: ${where} timeoutMs must be a finite number of milliseconds or Infinity (got ${String(value)})`,
    );
  }
}

export class HttpClient {
  constructor(private readonly deps: HttpDeps) {
    assertTimeoutMs(deps.timeoutMs, 'client');
  }

  /**
   * Send a JSON request; expect a JSON response. Throws an AIServiceError
   * subclass on non-2xx.
   */
  async json<T>(opts: JsonRequestOptions): Promise<T> {
    const res = await this.raw(opts);
    const text = await res.text();
    const parsed = text.length > 0 ? safeJsonParse(text) : undefined;
    if (!res.ok) {
      // 🔴 `res.headers` is passed on purpose. This method used to throw
      // `errorFromResponse(res.status, parsed)` and DISCARD the `Response`,
      // which made every response header unreachable to every consumer of this
      // package — `Retry-After` on a 429 above all. Two products worked around
      // it by parsing the body only. Keep the headers threaded through.
      throw errorFromResponse(res.status, parsed, res.headers);
    }
    return parsed as T;
  }

  /**
   * Send a request and return the raw `Response`. Used for streaming
   * endpoints (SSE) where the consumer reads the body themselves. Caller
   * is responsible for closing the body.
   *
   * Retries transient failures when the request is idempotent — see
   * {@link RetryPolicy}. The timeout applies PER ATTEMPT, in full; the retry
   * budget only decides whether another attempt starts. The caller's `signal`
   * cancels the whole ladder, backoff included.
   */
  async raw(opts: JsonRequestOptions): Promise<Response> {
    assertTimeoutMs(opts.timeoutMs, 'per-call');
    const policy: RetryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      ...(this.deps.retry ?? {}),
      ...(opts.retry ?? {}),
    };
    const method = opts.method ?? 'GET';
    // GET is idempotent by HTTP semantics; anything else must say so.
    const idempotent = opts.idempotent ?? method === 'GET';
    const attempts = idempotent ? Math.max(1, Math.trunc(policy.attempts)) : 1;

    // The retry budget. It gates whether ANOTHER attempt (and the wait before
    // it) starts, and caps an attempt only when `timeoutMs` is the default.
    const startedAt = Date.now();
    const remainingMs = (): number =>
      policy.maxElapsedMs === Infinity
        ? Infinity
        : Math.max(0, policy.maxElapsedMs - (Date.now() - startedAt));

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res: Response;
      try {
        res = await this.attempt(opts, remainingMs());
      } catch (err) {
        // An abort is never retried — see `RetryPolicy`. `attempt()` has
        // already turned it into an AIServiceError with status 0.
        if (err instanceof AIServiceError) throw err;
        lastError = err;
        if (attempt === attempts) throw err;
        const wait = this.nextDelay(policy, attempt, undefined);
        // The wait would end past the retry budget: stop now and report the
        // real failure, rather than sleeping just to give up afterwards.
        if (wait >= remainingMs()) throw err;
        await this.sleep(wait, opts.signal);
        continue;
      }

      if (attempt === attempts || !isTransientStatus(res.status)) return res;

      const retryAfter = retryAfterMsFromHeaders(res.headers);

      // 🔴 A `Retry-After` LONGER than we are willing to wait means STOP, not
      // "come back sooner". ai-service answers `retryAfterMs: ctx.ttl` on a
      // 429, which reaches a full 60 s window — clamping that to `maxDelayMs`
      // and retrying at 20 s guaranteed three rejections and then a failure,
      // having spent three requests against the very bucket that was full.
      // Handing the 429 back instead gives the caller a `RateLimitError`
      // carrying the server's own `retryAfterMs`, which is the number it needs.
      if (retryAfter !== undefined && retryAfter > policy.maxDelayMs) return res;

      const wait = this.nextDelay(policy, attempt, retryAfter);
      // Same budget check: a wait that eats the whole budget leaves no room
      // to start the attempt it exists to enable.
      if (wait >= remainingMs()) return res;

      // Discard the body of the response we are about to replace. Leaving it
      // unread leaks a socket in undici until GC. Only ever after we have
      // committed to retrying — a response we may hand back must stay readable.
      void res.body?.cancel().catch(() => {});
      await this.sleep(wait, opts.signal);
    }

    // Unreachable: the loop either returns or throws on its last attempt.
    throw lastError ?? new AIServiceError('ai-client: retry loop exhausted', 0, {});
  }

  /**
   * How long to wait before the next attempt.
   *
   * `Retry-After` WINS when the server sent one — it is the server's own
   * stated wait, and guessing shorter is how a client turns a rate limit into
   * a stampede. It gets PADDING rather than a straight sleep: every client
   * rejected in the same window was handed the same number, so firing exactly
   * on it re-synchronises the whole herd onto one instant. Pad by up to 10%
   * (capped at 1 s) — always late, never early.
   *
   * Otherwise exponential (`base × 2^(n-1)`) with EQUAL JITTER (half fixed,
   * half random): full jitter can collapse to ~0 and re-fire immediately, no
   * jitter re-synchronises every client that failed together. Only this branch
   * is clamped by `maxDelayMs`; a longer `Retry-After` is handled by the
   * caller, which stops instead.
   */
  private nextDelay(policy: RetryPolicy, attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) {
      return retryAfterMs + Math.random() * Math.min(1_000, retryAfterMs * 0.1);
    }
    const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
    const jittered = exponential / 2 + Math.random() * (exponential / 2);
    return Math.min(Math.max(0, jittered), policy.maxDelayMs);
  }

  /**
   * An abortable sleep. Without the abort path, a caller that cancels
   * mid-backoff still pays out the whole ladder before noticing.
   */
  private sleep(delay: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortedError());
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortedError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delay);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * ONE attempt: build the request, apply the timeout, fetch.
   *
   * 🔴 An EXPLICIT timeout (the call's `timeoutMs`, else the client's) is used
   * UNCLAMPED. Applying `min(timeoutMs, budgetMs)` to it is the bug
   * (through 0.25.0) that cut every explicit timeout
   * above 30 s down to 30 s. Only the DEFAULT is clamped to `budgetMs`, which
   * keeps the 30 s total for callers that set nothing.
   */
  private async attempt(opts: JsonRequestOptions, budgetMs: number): Promise<Response> {
    const url = `${stripTrailingSlash(this.deps.baseUrl)}${opts.path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.deps.apiKey}`,
      ...(this.deps.org !== undefined ? { 'X-AI-Org': this.deps.org } : {}),
      Accept: 'application/json',
      ...(opts.headers ?? {}),
    };
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers,
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    const ctrl = new AbortController();
    const explicitTimeoutMs = opts.timeoutMs ?? this.deps.timeoutMs;
    const timeoutMs = explicitTimeoutMs ?? Math.min(DEFAULT_TIMEOUT_MS, budgetMs);
    // 🔴 `timedOut` is the AUTHORITY, not the shape of whatever the runtime
    // throws. The old code aborted with a plain `new Error(...)`, undici
    // rejected with that reason verbatim, and the name-matching detector below
    // did not recognise it — so a timeout was classified as a transient
    // network fault and RETRIED, three times, surfacing as a plain `Error`.
    // A flag we set ourselves cannot be defeated by a fetch implementation's
    // choice of error shape.
    let timedOut = false;
    // `Infinity` means no deadline. Passed raw, `setTimeout` would treat it
    // as overflow and fire after 1 ms. `NaN`/`-Infinity` never get here:
    // `assertTimeoutMs` threw at construction or at the top of `raw`.
    const timer = Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          timedOut = true;
          ctrl.abort(timeoutReason(timeoutMs));
        }, timeoutMs)
      : undefined;

    // Compose: the caller's signal also triggers our abort.
    //
    // 🔴 The listener is NAMED and removed in `finally`. An inline arrow with
    // `{ once: true }` looks self-cleaning but only fires on abort — a signal
    // that is never aborted accumulates ONE listener PER ATTEMPT, on a signal
    // the caller may hold for the life of a request or a whole worker. Node
    // warns at 11 and then leaks silently; a long-lived signal shared across a
    // retried batch reaches that in a handful of calls.
    const onCallerAbort = (): void => ctrl.abort(opts.signal?.reason);
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
      else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    init.signal = ctrl.signal;

    try {
      return await this.deps.fetchImpl(url, init);
    } catch (err) {
      // OUR controller fired ⇒ this rejection is our abort, whatever shape the
      // runtime gave it. Checking the controller rather than the error name is
      // what makes this robust: `isAbortLike` stays only as a fallback for a
      // fetch implementation that aborts without going through our signal.
      if (ctrl.signal.aborted || isAbortLike(err)) {
        throw timedOut
          ? new RequestAbortedError(
              'timeout',
              `ai-client request timed out after ${timeoutMs}ms`,
            )
          : new RequestAbortedError('cancel', 'ai-client request cancelled by the caller');
      }
      throw err;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/**
 * Transient = "ask again and the answer may differ".
 *
 * 408 request timeout, 425 too early, 429 rate limited, and every 5xx. A 501
 * (not implemented) is excluded on purpose: it is a permanent statement about
 * the route, and retrying it just delays the same failure.
 */
function isTransientStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status !== 501;
}

/**
 * `Retry-After`, in ms. HTTP allows delta-seconds OR an HTTP-date; both are
 * seen in the wild behind proxies, so both are read. A date in the past
 * yields 0, not a negative wait.
 *
 * ai-service ALSO answers `retryAfterMs` in the 429 body, which is what
 * `rateLimitRetryAfterMs` reads. We cannot use that here without consuming
 * the body of a response we may still hand back, so the header is the source
 * at this layer; ai-service sets both.
 */
function retryAfterMsFromHeaders(headers: Headers | undefined): number | undefined {
  const raw = headers?.get?.('retry-after')?.trim();
  if (!raw) return undefined;

  // A header that resolves to zero or the past is treated as ABSENT, not as
  // "retry immediately". Proxies emit `Retry-After: 0` as a placeholder, and
  // honouring it literally means hammering a server that just said no with no
  // backoff at all — worse than having no header. Fall through to the
  // exponential ladder, which is what an unhinted transient failure gets.
  const asMs = (ms: number): number | undefined => (ms > 0 ? ms : undefined);

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return asMs(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return asMs(at - Date.now());
}

/**
 * A cancel raised from inside a backoff wait — the ladder is abandoned, so it
 * is indistinguishable to a caller from a cancel during the request itself.
 * Only ever a cancel: the wall clock is enforced by not sleeping, not by
 * aborting a sleep.
 */
function abortedError(): RequestAbortedError {
  return new RequestAbortedError('cancel', 'ai-client request cancelled by the caller');
}

/**
 * The abort reason for a `timeoutMs` expiry.
 *
 * A `DOMException` named `TimeoutError` is what the platform itself uses
 * (`AbortSignal.timeout`), so anything reading `signal.reason` — including a
 * fetch implementation deciding what to throw — sees the shape it expects.
 * Falls back to a plain Error with the name set where `DOMException` is absent.
 */
function timeoutReason(ms: number): unknown {
  const message = `ai-client request timed out after ${ms}ms`;
  if (typeof DOMException === 'function') return new DOMException(message, 'TimeoutError');
  return Object.assign(new Error(message), { name: 'TimeoutError' });
}

function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}
