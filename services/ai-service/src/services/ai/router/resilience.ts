// Retry + circuit breaker + per-attempt timeout around the OpenRouter call.
//
// ---------------------------------------------------------------------------
// What this closes
// ---------------------------------------------------------------------------
//
// Before this module the router made EXACTLY ONE provider call per pass. A
// 429 from OpenRouter, a 502 from its edge, a socket reset — each ended the
// unit as a hard failure, refunded the reserve, and told the consumer the
// generation failed. Those are the three failure shapes that most often
// succeed on the very next attempt, and every consumer of this service
// (`@edc/ai-client`) already retries them at the HTTP layer — which
// means the SAME work is re-run end to end (spec resolution, context
// retrieval, prompt render, a fresh budget reserve) to recover from a fault
// that lives one function call away.
//
// It also had no back-pressure. When OpenRouter is genuinely down, every
// in-flight unit walks the full request timeout before failing, so a provider
// outage turns into a queue of workers each holding a socket open for
// `LLM_REQUEST_TIMEOUT_MS`.
//
// ---------------------------------------------------------------------------
// The three policies, and why they are nested in this order
// ---------------------------------------------------------------------------
//
//   wrap(retry, circuitBreaker, timeout)   ⇒   retry( breaker( timeout( call )))
//
// · `timeout` is INNERMOST so it bounds ONE attempt, not the ladder. Outside
//   the retry it would cancel the whole ladder on the first slow attempt.
// · `circuitBreaker` sits between them so EVERY attempt — not merely the first
//   — reports into the breaker, and so a retry made while the circuit is open
//   fails instantly instead of dialling a provider we already know is down.
// · `retry` is OUTERMOST because it is the only policy that may run the
//   function more than once.
//
// ---------------------------------------------------------------------------
// 🔴 WHAT IS NEVER RETRIED
// ---------------------------------------------------------------------------
//
// `OpenRouterAbortError` — NEVER, under any circumstance. It is the BILLING
// path: the streaming adapter throws it carrying a PARTIAL completion, and the
// router records those tokens as real spend and refunds only the remainder. A
// retry there would (a) bill the org for the partial AND a whole second call,
// and (b) run after the caller already hung up or the wall-clock deadline
// already fired, because that is what raised the abort in the first place —
// turning `LLM_REQUEST_TIMEOUT_MS` into `attempts × LLM_REQUEST_TIMEOUT_MS`.
// Same rule, same reasoning as `@edc/ai-client`'s HTTP retry ladder.
//
// A 4xx other than 408/429 is a DECISION (bad key, bad model, bad body).
// Re-asking gets the same answer more slowly.
//
// ---------------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------------
//
// The rules are COPIED from `packages/ai-client/src/http.ts` — deliberately
// copied and not imported: ai-service must not depend on its own client
// package (the dependency runs the other way, and would make the service's
// runtime behaviour hostage to a client release). The rules kept identical:
//
//   · `Retry-After` WINS over the exponential ladder when the server sent one.
//   · It is PADDED by up to 10% (capped at 1 s) so every client rejected in
//     the same window does not re-fire on the same instant.
//   · A header resolving to zero or the past is treated as ABSENT, not as
//     "retry immediately" — proxies emit `Retry-After: 0` as a placeholder.
//   · 🔴 A `Retry-After` LONGER than `maxDelayMs` means STOP, not "come back
//     sooner". Retrying early against a bucket the server just told us is full
//     spends an attempt to earn the same rejection.
//
// The last rule is expressed in the TRANSIENCE PREDICATE rather than in the
// backoff: cockatiel's retry has no "give up now" signal from a backoff, and
// declining to handle the error is the same outcome (the error propagates).
//
// ---------------------------------------------------------------------------
// 🔴 THE BACKOFF WAIT IS CANCELLABLE — and why that needed code here
// ---------------------------------------------------------------------------
//
// MEASURED in `cockatiel@4.0.0` (`dist/RetryPolicy.js`): the wait between
// attempts is `new Promise(r => setTimeout(r, duration))`. The signal handed to
// `.execute()` is consulted ONCE, *before* the sleep (`if (!signal.aborted…)`),
// and never again while it runs. There is no `CancellationToken` seam to thread
// and no option to pass — the timer is uncancellable by construction.
//
// That mattered because `Retry-After` WINS over the exponential ladder (above)
// and the give-up line is `maxDelayMs` = 20 s. A provider answering
// `Retry-After: 19` is still "transient", so the policy sits for ~19 s per
// attempt; at two attempts that is ~38 s of a caller's BUDGET RESERVATION held
// after the client already hung up. The abort signal reached the provider call
// and did nothing at all during the wait.
//
// So {@link createProviderResilience}'s `execute` RACES the whole policy
// against the caller's signal. Two constraints shaped it:
//
//  · 🔴 THE RACE IS ARMED ONLY BETWEEN ATTEMPTS, never while an attempt is in
//    flight. Winning the race against a live streaming call would discard the
//    `OpenRouterAbortError` the adapter is about to throw — and that error
//    carries the PARTIAL completion the router bills the org for (see the
//    never-retried rule above). Losing it would under-bill and file the trace
//    as `failed` instead of `aborted`. While `fn` runs we let the adapter's own
//    abort handling finish; it is already prompt, because the signal is
//    threaded into its `fetch`.
//  · The rejection is an `Error` named `'AbortError'` — the existing taxonomy.
//    `isTransientProviderError` (never retry) and `passFailureStatus` in
//    `router.ts` (the `aborted` metrics bucket) both key off that exact name.
//    The signal's own `reason` is attached as `cause` rather than rethrown,
//    because a wall-clock deadline aborts with a `TimeoutError` DOMException,
//    which would land in the `failure` bucket instead.
//
// `DEFAULT_MAX_DELAY_MS` is UNCHANGED at 20 s, so the `Retry-After` give-up
// line is exactly where it was.

import {
  ConsecutiveBreaker,
  CircuitState,
  circuitBreaker,
  handleWhen,
  retry,
  timeout,
  TimeoutStrategy,
  wrap,
  type CircuitBreakerPolicy,
  type IBackoff,
  type IPolicy,
  type IRetryBackoffContext,
} from 'cockatiel';

import { AiServiceError } from '../../../errors/base.js';
import {
  OpenRouterAbortError,
  OpenRouterHttpError,
  OpenRouterNoZdrEndpointError,
} from './adapters/openrouter.js';

/** Total attempts = 1 + this. Matches the task spec (`maxAttempts: 2`). */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 2;
/** Consecutive transient failures that open the circuit. */
export const DEFAULT_BREAKER_THRESHOLD = 5;
/** How long the circuit stays open before admitting one probe call. */
export const DEFAULT_HALF_OPEN_AFTER_MS = 10_000;
/** First exponential step; doubles per attempt before equal jitter. */
export const DEFAULT_BASE_DELAY_MS = 250;
/** Ceiling on one exponential wait — and the `Retry-After` give-up line. */
export const DEFAULT_MAX_DELAY_MS = 20_000;

/**
 * The provider is refusing work: the circuit opened after
 * `DEFAULT_BREAKER_THRESHOLD` consecutive transient failures, so this call was
 * never dialled.
 *
 * ── How this reaches the wire ─────────────────────────────────────────────
 * Through the taxonomy, like every other class: `status`, `retryable`,
 * `headers`, `midStream` and `bodyFields()`/`streamFields()` are read
 * GENERICALLY by `errors/generate-map.ts` and by the /v1 error handler, so
 * `/sync` sends a typed 503 body and `/stream` names this class in its
 * terminal frame. No route holds an `instanceof` arm for it any more.
 *
 * `statusCode` is kept as a mirror of `status` purely for the paths that never
 * reach a /v1 handler (a direct `reply.send(err)`), and must stay in sync.
 *
 * The exact bodies are pinned in `src/errors/wire-golden.test.ts`.
 */
export class ProviderUnavailable extends AiServiceError {
  readonly code = 'ERR_PROVIDER_UNAVAILABLE';
  /** As specified. Mirrors `statusCode`. */
  readonly status = 503;
  /** Fastify's default error handler reads THIS one. */
  readonly statusCode = 503;
  override readonly retryable = true;
  /** The breaker can open mid-stream, so this must name itself in a frame. */
  override readonly midStream = true;
  readonly retryAfterMs: number;
  override readonly headers: Record<string, string>;

  /**
   * `code` rides the BODY for this class (it predates the taxonomy and
   * consumers read it), which is why it is repeated here rather than left to
   * the base envelope.
   */
  protected override bodyFields() {
    return { code: this.code, retryAfterMs: this.retryAfterMs };
  }

  /**
   * On the stream the 503 status line and the `Retry-After` header are gone,
   * so the machine string and the retry hint both ride the frame. The frame's
   * field names predate the taxonomy: frame `errorCode` ≡ body `code`.
   */
  override streamFields() {
    return { errorCode: this.code, retryAfterMs: this.retryAfterMs };
  }

  constructor(retryAfterMs: number, cause?: unknown) {
    super(
      `The LLM provider is unavailable: the circuit breaker is open after ` +
        `${DEFAULT_BREAKER_THRESHOLD} consecutive transient failures, so this call ` +
        `was not dialled. Retry in ~${Math.ceil(retryAfterMs / 1000)}s.`,
    );
    this.name = 'ProviderUnavailable';
    this.retryAfterMs = retryAfterMs;
    // `Retry-After` is delta-SECONDS on the wire, and never 0 (a 0 reads as
    // "retry immediately", which is the opposite of what an open circuit means).
    this.headers = { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) };
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * `Retry-After` from a provider error, in ms, or `undefined`.
 *
 * Zero / past ⇒ `undefined` (treated as absent), matching the client.
 */
export function retryAfterMsFromError(err: unknown): number | undefined {
  if (!(err instanceof OpenRouterHttpError)) return undefined;
  const ms = err.retryAfterMs;
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  return ms;
}

/**
 * Is this error worth asking again about?
 *
 * `maxDelayMs` is a parameter because the "a longer `Retry-After` means stop"
 * rule lives HERE — see the module header.
 */
export function isTransientProviderError(
  err: unknown,
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
): boolean {
  // 🔴 An abort is never transient. First, and by identity — `name` is
  // 'AbortError' on this class, so a `name`-based check elsewhere would also
  // catch a plain fetch abort, which is equally never-retry.
  if (err instanceof OpenRouterAbortError) return false;
  if (err instanceof Error && err.name === 'AbortError') return false;
  // cockatiel's own aggressive-timeout cancellation. Also never a retry here:
  // the per-attempt timeout already IS the attempt's verdict.
  if (isCockatielFlag(err, 'isTaskCancelledError')) return false;
  // The breaker's own refusal — retrying it just re-refuses, instantly, and
  // burns the ladder before the half-open probe is due.
  if (err instanceof ProviderUnavailable) return false;
  if (isBrokenCircuit(err)) return false;
  // No Zero Data Retention endpoint: asking again cannot help, and the call is
  // never re-sent without `provider.zdr` (fail-closed).
  if (err instanceof OpenRouterNoZdrEndpointError) return false;

  if (err instanceof OpenRouterHttpError) {
    const after = retryAfterMsFromError(err);
    // The server named a wait longer than we will ever sit through. Stop.
    if (after !== undefined && after > maxDelayMs) return false;
    const s = err.status;
    if (s === 408 || s === 425 || s === 429) return true;
    // 501 excluded: a permanent statement about the route.
    return s >= 500 && s !== 501;
  }

  // Network / DNS / socket: `fetch` throws a TypeError with a `cause`, and
  // undici's system errors carry an errno-ish `code`. Both are "ask again".
  if (err instanceof TypeError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
  return false;
}

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Equal jitter, with `Retry-After` taking precedence — a straight port of
 * `HttpClient.nextDelay` in `packages/ai-client/src/http.ts`.
 *
 * cockatiel drives a backoff by calling `factory.next(ctx)` then reading
 * `.duration`, so each instance carries ONE resolved wait and hands the next
 * one back as a new instance. `ctx.result` carries the error that caused the
 * retry, which is how the header gets a look-in at all.
 */
export class RetryAfterAwareBackoff implements IBackoff<IRetryBackoffContext<unknown>> {
  constructor(
    private readonly baseDelayMs: number,
    private readonly maxDelayMs: number,
    readonly duration: number = 0,
    private readonly random: () => number = Math.random,
  ) {}

  next(context: IRetryBackoffContext<unknown>): IBackoff<IRetryBackoffContext<unknown>> {
    const err = (context.result as { error?: unknown }).error;
    const after = retryAfterMsFromError(err);
    const wait =
      after !== undefined
        ? // Always late, never early: pad by up to 10%, capped at 1 s.
          after + this.random() * Math.min(1_000, after * 0.1)
        : clampJitter(this.baseDelayMs, this.maxDelayMs, context.attempt, this.random);
    return new RetryAfterAwareBackoff(this.baseDelayMs, this.maxDelayMs, wait, this.random);
  }
}

function clampJitter(
  baseDelayMs: number,
  maxDelayMs: number,
  attempt: number,
  random: () => number,
): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  // Equal jitter — half fixed, half random. Full jitter can collapse to ~0 and
  // re-fire instantly; no jitter re-synchronises every client that failed
  // together.
  const jittered = exponential / 2 + random() * (exponential / 2);
  return Math.min(Math.max(0, jittered), maxDelayMs);
}

export interface ResilienceOptions {
  maxAttempts?: number;
  breakerThreshold?: number;
  halfOpenAfterMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Per-ATTEMPT wall clock. `0` (or absent) omits the timeout policy entirely
   * — the router's own `withRequestTimeout` deadline still bounds the whole
   * `route()` call through the composed signal.
   */
  attemptTimeoutMs?: number;
  /** Injectable for a deterministic jitter assertion. */
  random?: () => number;
  /** Named on the breaker gauge. One breaker per provider. */
  provider?: string;
}

export interface ProviderResilience {
  /**
   * Run `fn` under retry+breaker+timeout. `fn` receives the COMPOSED signal:
   * the caller's signal, plus the per-attempt timeout when one is configured.
   *
   * A breaker refusal surfaces as {@link ProviderUnavailable}, never as
   * cockatiel's `BrokenCircuitError` — the router's catch path and the HTTP
   * mappers should only ever see this repo's own error taxonomy.
   */
  execute<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Current breaker state, for the metrics gauge and for tests. */
  state(): CircuitState;
  /** How long until the circuit next admits a probe call. */
  halfOpenAfterMs: number;
  provider: string;
}

/**
 * Build one retry+breaker+timeout stack.
 *
 * ⚠ THE BREAKER IS STATE, AND STATE MUST BE SHARED. A breaker constructed per
 * call counts to five on its own and never opens. Hold ONE of these per
 * provider for the process's lifetime — {@link getSharedProviderResilience}
 * does exactly that; this factory exists so tests can hold their own.
 */
export function createProviderResilience(opts: ResilienceOptions = {}): ProviderResilience {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
  const breakerThreshold = opts.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
  const halfOpenAfterMs = opts.halfOpenAfterMs ?? DEFAULT_HALF_OPEN_AFTER_MS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 0;
  const random = opts.random ?? Math.random;
  const provider = opts.provider ?? 'openrouter';

  const transient = handleWhen((err) => isTransientProviderError(err, maxDelayMs));

  const retryPolicy = retry(transient, {
    maxAttempts,
    backoff: new RetryAfterAwareBackoff(baseDelayMs, maxDelayMs, 0, random),
  });
  const breakerPolicy = circuitBreaker(transient, {
    halfOpenAfter: halfOpenAfterMs,
    breaker: new ConsecutiveBreaker(breakerThreshold),
  });

  const policies: Array<IPolicy> = [retryPolicy, breakerPolicy];
  if (attemptTimeoutMs > 0) {
    // Aggressive: reject as soon as the attempt's clock runs out rather than
    // waiting for a cooperative function to notice its signal.
    policies.push(timeout(attemptTimeoutMs, TimeoutStrategy.Aggressive) as unknown as IPolicy);
  }
  const composed = wrap(...(policies as [IPolicy, IPolicy]));

  return {
    async execute<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      // Flipped around each attempt so the abort race can tell "waiting out a
      // backoff" (ours to cancel) from "a provider call is live" (the adapter's
      // to end, so its partial-billing error survives). See the module header.
      let attemptInFlight = false;
      const runAttempt = async (attemptSignal: AbortSignal): Promise<T> => {
        // cockatiel re-invokes after an uncancellable sleep without re-checking
        // the signal, so an abort during the wait would otherwise dial the
        // provider one more time on a request nobody is listening to.
        if (attemptSignal.aborted) throw abortErrorFrom(attemptSignal);
        attemptInFlight = true;
        try {
          return await fn(attemptSignal);
        } finally {
          attemptInFlight = false;
        }
      };

      try {
        const run = composed.execute((ctx) => runAttempt(ctx.signal), signal);
        return await (signal ? raceAbort(run, signal, () => attemptInFlight) : run);
      } catch (err) {
        if (isBrokenCircuit(err)) throw new ProviderUnavailable(halfOpenAfterMs, err);
        throw err;
      }
    },
    state: () => (breakerPolicy as CircuitBreakerPolicy).state,
    halfOpenAfterMs,
    provider,
  };
}

/**
 * A client cancellation, in this module's existing shape: a plain `Error` whose
 * `name` is `'AbortError'`. Deliberately NOT `OpenRouterAbortError` — that class
 * REQUIRES a partial completion and is the billing path; there is nothing
 * partial about a call that never left the retry backoff.
 */
function abortErrorFrom(signal: AbortSignal): Error {
  const err = new Error('The provider call was aborted while waiting to retry.');
  err.name = 'AbortError';
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason !== undefined) (err as { cause?: unknown }).cause = reason;
  return err;
}

/**
 * Settle as soon as `signal` aborts, instead of after cockatiel's uncancellable
 * backoff timer.
 *
 * 🔴 `isAttemptInFlight` is the whole safety interlock: while a provider call is
 * live we DO NOT win the race, so the adapter's `OpenRouterAbortError` (and the
 * partial spend it carries) still reaches the router. See the module header.
 *
 * `run` keeps a rejection handler attached in every branch — the losing policy
 * promise settles later with the abort the next attempt sees, and an unhandled
 * rejection there would take the process down under `--unhandled-rejections`.
 */
function raceAbort<T>(
  run: Promise<T>,
  signal: AbortSignal,
  isAttemptInFlight: () => boolean,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fnc: (v: never) => void, v: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fnc(v as never);
    };
    const onAbort = () => {
      if (isAttemptInFlight()) return; // the adapter owns this one.
      finish(reject, abortErrorFrom(signal));
    };

    run.then(
      (v) => finish(resolve, v),
      (e) => finish(reject, e),
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort);
  });
}

/**
 * ⚠ MATCHED BY cockatiel's OWN BRAND FLAG, NOT BY `name` OR `instanceof`.
 *
 * `BrokenCircuitError` never sets `this.name`, so it reports as plain
 * `'Error'` — a `name` check silently never fires, and the refusal escapes as
 * a 500. MEASURED: the first cut of this file matched on `name` and the
 * breaker test caught it (`expected Error: Execution prevented because the
 * ci… { isBrokenCircuitError: true } to be an instance of ProviderUnavailable`).
 * `instanceof` would work today but breaks the moment two copies of cockatiel
 * exist in the tree; the brand flag survives both.
 */
function isBrokenCircuit(err: unknown): boolean {
  return isCockatielFlag(err, 'isBrokenCircuitError');
}

function isCockatielFlag(err: unknown, flag: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<string, unknown>)[flag] === true
  );
}

let shared: ProviderResilience | undefined;

/** The process-wide breaker. See the warning on {@link createProviderResilience}. */
export function getSharedProviderResilience(): ProviderResilience {
  shared ??= createProviderResilience();
  return shared;
}

/** Test seam only — drops the process-wide breaker's accumulated state. */
export function resetSharedProviderResilience(): void {
  shared = undefined;
}

export { CircuitState };
