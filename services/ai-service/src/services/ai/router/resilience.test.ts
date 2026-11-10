// Retry + circuit breaker around the provider call.
//
// ⚠ The adapter module is NOT mocked here (unlike `router.test.ts`, which
// replaces `OpenRouterHttpError` with a bare stub). The whole subject of this
// file is which REAL error classes are transient, so a stubbed taxonomy would
// make every assertion vacuous.
//
// Every Router in this file gets its OWN `createProviderResilience(...)`. The
// breaker is process-wide state by design; sharing it across tests would let
// one file's five failures open the circuit for the next test in line.

import { describe, expect, it, vi } from 'vitest';

import {
  OpenRouterAbortError,
  OpenRouterHttpError,
  type OpenRouterCompletion,
} from './adapters/openrouter.js';
import {
  CircuitState,
  ProviderUnavailable,
  RetryAfterAwareBackoff,
  createProviderResilience,
  isTransientProviderError,
  retryAfterMsFromError,
} from './resilience.js';
import { RouterCache } from './cache.js';
import { EmptyCompletion } from './empty-completion.js';
import { getTaskProfile } from './task-profiles.js';
import type { RouteRequest } from './types.js';

vi.mock('../validators/index.js', () => ({ runValidators: () => [] }));
vi.mock('../../../config/env.js', () => ({
  env: {
    OPENROUTER_API_KEY: 'env-key-for-tests',
    LLM_REQUEST_TIMEOUT_MS: 0,
    LLM_STREAM_STALL_TIMEOUT_MS: 0,
  },
}));

const { Router } = await import('./router.js');

// --- fixtures ------------------------------------------------------------ //

function completion(over: Partial<{ contentText: string; costUsd: number }> = {}): OpenRouterCompletion {
  return {
    contentText: over.contentText ?? 'ok',
    finishReason: 'stop',
    model: 'deepseek/deepseek-chat-v3.1',
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      costUsd: over.costUsd ?? 0.001,
      costSource: 'openrouter',
    },
  };
}

function makeReq(over: Partial<RouteRequest> = {}): RouteRequest {
  const profile = getTaskProfile('standard');
  return {
    label: 'unit:x',
    unitKey: 'unit-1',
    unitType: 'x',
    org: 'acme',
    project: 'proj-a',
    messages: [{ role: 'user', content: 'hello' }],
    model: profile.model ?? 'deepseek/deepseek-chat-v3.1',
    effortLevel: 'standard',
    effortProfile: profile,
    ...over,
  };
}

function makeBudget() {
  return {
    reserve: vi.fn().mockResolvedValue({ remainingUsd: 1000, softCap: false }),
    refund: vi.fn().mockResolvedValue(undefined),
    adjust: vi.fn().mockResolvedValue(undefined),
    settleReservations: vi.fn().mockResolvedValue(undefined),
  };
}

/** A fast, deterministic stack: no real waiting, no jitter randomness. */
function fastResilience(over: Parameters<typeof createProviderResilience>[0] = {}) {
  return createProviderResilience({ baseDelayMs: 1, maxDelayMs: 50, random: () => 0, ...over });
}

/**
 * ⚠ FRESH CACHE PER ROUTER. The default is `getSharedRouterCache()`, which is
 * process-wide — and every test here sends the same short prompt, so without
 * this the second test in the file gets the first one's completion back with
 * `cached: true` and never dials the adapter at all. Diagnosed exactly that
 * way: a breaker test asserting a throw was handed `content: 'second try'`.
 */
function makeRouter(over: Record<string, unknown> = {}) {
  return { router: new Router({ cache: new RouterCache({ max: 50 }), ...over } as never) };
}

const http = (status: number, retryAfter?: string): OpenRouterHttpError =>
  new OpenRouterHttpError({
    status,
    message: `HTTP ${status}`,
    retryAfterMs: retryAfter === undefined ? undefined : Number(retryAfter) * 1000,
  });

// --- the transience predicate -------------------------------------------- //

describe('isTransientProviderError', () => {
  it('retries 408, 425, 429 and 5xx (except 501)', () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isTransientProviderError(http(s)), `status ${s}`).toBe(true);
    }
    expect(isTransientProviderError(http(501))).toBe(false);
  });

  it('never retries a decision-shaped 4xx', () => {
    for (const s of [400, 401, 402, 403, 404, 422]) {
      expect(isTransientProviderError(http(s)), `status ${s}`).toBe(false);
    }
  });

  it('🔴 NEVER retries an abort — that is the partial-billing path', () => {
    const abort = new OpenRouterAbortError(completion());
    expect(isTransientProviderError(abort)).toBe(false);
    // Also by name, for a plain fetch abort that carries no partial.
    const bare = new Error('aborted');
    bare.name = 'AbortError';
    expect(isTransientProviderError(bare)).toBe(false);

    // ⚠ THE TWO ABOVE PASS EVEN WITH THE ABORT GUARD DELETED — nothing else in
    // the predicate matches them either, so they fall through to `false` by
    // accident. MEASURED: commenting the guard out left this test green. These
    // two DO fail without it: an abort raised by a socket reset carries a
    // network `code`, and one raised mid-request can arrive as a `TypeError`
    // from `fetch` — both of which the network branch below WOULD retry.
    const resetAbort = Object.assign(new OpenRouterAbortError(completion()), {
      code: 'ECONNRESET',
    });
    expect(isTransientProviderError(resetAbort)).toBe(false);
    const fetchAbort = Object.assign(new TypeError('fetch failed'), { name: 'AbortError' });
    expect(isTransientProviderError(fetchAbort)).toBe(false);
  });

  it('retries network faults', () => {
    expect(isTransientProviderError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientProviderError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientProviderError(Object.assign(new Error('nope'), { code: 'ENOSPC' }))).toBe(false);
  });

  it('🔴 STOPS on a Retry-After longer than we are willing to wait', () => {
    // 60 s ask, 20 s ceiling: retrying early spends an attempt to earn the
    // same rejection from the same full bucket.
    expect(isTransientProviderError(http(429, '60'), 20_000)).toBe(false);
    expect(isTransientProviderError(http(429, '5'), 20_000)).toBe(true);
  });

  it('treats Retry-After: 0 as absent, not as "retry now"', () => {
    expect(retryAfterMsFromError(http(429, '0'))).toBeUndefined();
    expect(isTransientProviderError(http(429, '0'))).toBe(true); // still a 429
  });
});

// --- the backoff --------------------------------------------------------- //

describe('RetryAfterAwareBackoff', () => {
  const ctx = (error: unknown, attempt: number) =>
    ({ attempt, result: { error }, signal: new AbortController().signal }) as never;

  it('honours Retry-After over the exponential ladder', () => {
    const b = new RetryAfterAwareBackoff(250, 20_000, 0, () => 0);
    expect(b.next(ctx(http(429, '3'), 1)).duration).toBe(3_000);
  });

  it('pads Retry-After so a rejected herd does not re-fire in lockstep', () => {
    const b = new RetryAfterAwareBackoff(250, 20_000, 0, () => 1);
    // 3 s + min(1 s, 10% of 3 s) = 3.3 s.
    expect(b.next(ctx(http(429, '3'), 1)).duration).toBeCloseTo(3_300, 5);
  });

  it('uses equal jitter and clamps at maxDelayMs otherwise', () => {
    const lo = new RetryAfterAwareBackoff(1_000, 20_000, 0, () => 0);
    const hi = new RetryAfterAwareBackoff(1_000, 20_000, 0, () => 1);
    // attempt 2 ⇒ exponential 2 000; equal jitter ⇒ [1 000, 2 000].
    expect(lo.next(ctx(http(500), 2)).duration).toBe(1_000);
    expect(hi.next(ctx(http(500), 2)).duration).toBe(2_000);
    const clamped = new RetryAfterAwareBackoff(1_000, 1_200, 0, () => 1);
    expect(clamped.next(ctx(http(500), 5)).duration).toBe(1_200);
  });
});

// --- the router integration ---------------------------------------------- //

describe('Router — retry around the provider call', () => {
  it('retries a transient failure and returns the succeeding attempt', async () => {
    const adapter = vi
      .fn()
      .mockRejectedValueOnce(http(503))
      .mockResolvedValueOnce(completion({ contentText: 'second try' }));
    const budget = makeBudget();
    const { router } = makeRouter({ adapter, budget, resilience: fastResilience() });

    const out = await router.route(makeReq());

    expect(out.content).toBe('second try');
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts and rethrows the ORIGINAL provider error', async () => {
    const adapter = vi.fn().mockRejectedValue(http(500));
    const budget = makeBudget();
    const { router } = makeRouter({ adapter, budget, resilience: fastResilience() });

    await expect(router.route(makeReq())).rejects.toBeInstanceOf(OpenRouterHttpError);
    // maxAttempts: 2 retries ⇒ 3 dials total.
    expect(adapter).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-transient failure', async () => {
    const adapter = vi.fn().mockRejectedValue(http(401));
    const { router } = makeRouter({ adapter, budget: makeBudget(), resilience: fastResilience() });

    await expect(router.route(makeReq())).rejects.toBeInstanceOf(OpenRouterHttpError);
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('🔴 NEVER retries an abort, and preserves its partial for the billing path', async () => {
    const partial = completion({ contentText: 'half a sen', costUsd: 0.0004 });
    const adapter = vi.fn().mockRejectedValue(new OpenRouterAbortError(partial));
    const budget = makeBudget();
    const { router } = makeRouter({ adapter, budget, resilience: fastResilience() });

    await expect(router.route(makeReq())).rejects.toBeInstanceOf(OpenRouterAbortError);
    expect(adapter).toHaveBeenCalledTimes(1);
    // The partial survived the wrapper: the refund is reserve MINUS the
    // partial's real cost, not the whole reserve.
    const refund = budget.refund.mock.calls[0]?.[0] as { amountUsd: number };
    const reserved = getTaskProfile('standard').estimatedCostUsdPerCall;
    expect(refund.amountUsd).toBeCloseTo(reserved - 0.0004, 9);
  });

  it('🔴 reserves the budget EXACTLY ONCE across a whole retry ladder', async () => {
    const adapter = vi
      .fn()
      .mockRejectedValueOnce(http(429))
      .mockRejectedValueOnce(http(502))
      .mockResolvedValueOnce(completion());
    const budget = makeBudget();
    const { router } = makeRouter({ adapter, budget, resilience: fastResilience() });

    await router.route(makeReq());

    expect(adapter).toHaveBeenCalledTimes(3);
    // Three dials, ONE hold. A per-attempt reserve would hold 3× the estimate
    // against the org's cap for one completion.
    expect(budget.reserve).toHaveBeenCalledTimes(1);
    expect(budget.refund).not.toHaveBeenCalled();
    // The true-up settles against the FINAL attempt's usage — the only tokens
    // that were actually billed.
    const adjust = budget.adjust.mock.calls[0]?.[0] as { deltaUsd: number };
    const reserved = getTaskProfile('standard').estimatedCostUsdPerCall;
    expect(adjust.deltaUsd).toBeCloseTo(reserved - 0.001, 9);
  });

  it('does not retry once tokens have already been streamed to the client', async () => {
    // A mid-stream fault AFTER deltas went out: retrying would append a second
    // generation's tokens to the first one's on the consumer's screen.
    const adapter = vi.fn().mockImplementation(async (opts: { onDelta?: (t: string) => void }) => {
      opts.onDelta?.('partial ');
      throw http(502);
    });
    const { router } = makeRouter({ adapter, budget: makeBudget(), resilience: fastResilience() });

    await expect(router.route(makeReq({ onDelta: () => {} }))).rejects.toBeInstanceOf(
      OpenRouterHttpError,
    );
    expect(adapter).toHaveBeenCalledTimes(1);
  });
});

describe('Router — circuit breaker', () => {
  it('opens after 5 consecutive transient failures and refuses the 6th call', async () => {
    const adapter = vi.fn().mockRejectedValue(http(503));
    // One retry attempt off, so each `route()` is exactly one dial and the
    // count of consecutive failures is unambiguous.
    const resilience = fastResilience({ maxAttempts: 0, halfOpenAfterMs: 60_000 });
    const { router } = makeRouter({ adapter, budget: makeBudget(), resilience });

    for (let i = 0; i < 5; i++) {
      await expect(router.route(makeReq({ traceId: `t-${i}` }))).rejects.toBeInstanceOf(
        OpenRouterHttpError,
      );
    }
    expect(adapter).toHaveBeenCalledTimes(5);
    expect(resilience.state()).toBe(CircuitState.Open);

    // The 6th is refused WITHOUT dialling the provider.
    await expect(router.route(makeReq({ traceId: 't-6' }))).rejects.toBeInstanceOf(
      ProviderUnavailable,
    );
    expect(adapter).toHaveBeenCalledTimes(5);
  });

  it('the open-circuit error carries a 503 and a Retry-After header', async () => {
    const adapter = vi.fn().mockRejectedValue(http(503));
    const resilience = fastResilience({ maxAttempts: 0, halfOpenAfterMs: 10_000 });
    const { router } = makeRouter({ adapter, budget: makeBudget(), resilience });
    for (let i = 0; i < 5; i++) {
      await router.route(makeReq({ traceId: `u-${i}` })).catch(() => {});
    }

    const err = await router.route(makeReq({ traceId: 'u-6' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderUnavailable);
    const pu = err as ProviderUnavailable;
    expect(pu.status).toBe(503);
    // Fastify's DEFAULT error handler reads `statusCode` + `headers`, which is
    // how this reaches the wire without a routes-lane edit.
    expect(pu.statusCode).toBe(503);
    expect(pu.retryable).toBe(true);
    expect(pu.headers['retry-after']).toBe('10');
  });

  it('an empty answer is retried but never opens the circuit', async () => {
    expect(isTransientProviderError(new EmptyCompletion())).toBe(true);
    const adapter = vi.fn().mockResolvedValue(completion({ contentText: '' }));
    const resilience = fastResilience({ maxAttempts: 2 });
    const { router } = makeRouter({ adapter, budget: makeBudget(), resilience });

    // 4 calls × 3 attempts = 12 consecutive empties, past the 5 that open it.
    for (let i = 0; i < 4; i++) {
      await expect(router.route(makeReq({ traceId: `e-${i}` }))).rejects.toBeInstanceOf(
        EmptyCompletion,
      );
    }
    expect(adapter).toHaveBeenCalledTimes(12);
    expect(resilience.state()).toBe(CircuitState.Closed);
  });

  it('a non-transient failure does not count towards opening the circuit', async () => {
    const adapter = vi.fn().mockRejectedValue(http(400));
    const resilience = fastResilience({ maxAttempts: 0 });
    const { router } = makeRouter({ adapter, budget: makeBudget(), resilience });

    for (let i = 0; i < 8; i++) {
      await router.route(makeReq({ traceId: `v-${i}` })).catch(() => {});
    }
    expect(resilience.state()).toBe(CircuitState.Closed);
    expect(adapter).toHaveBeenCalledTimes(8);
  });
});

// --- the retry wait is cancellable --------------------------------------- //
//
// ⚠ REAL CLOCK ON PURPOSE. The claim under test is "this settles WITHOUT
// waiting out the backoff", which is a wall-clock claim. Under fake timers the
// backoff timer never fires unless the test advances it, so a still-broken
// implementation would hang rather than fail on a number — the diagnosis lands
// as a suite timeout instead of a duration. A 10 s injected backoff measured
// against a 500 ms bound is a 20× margin, which is honest on a loaded machine.

describe('createProviderResilience — abort during the retry backoff', () => {
  /** Exponential 10 s with `random: () => 1` ⇒ 5 000 + 5 000 = a 10 s wait. */
  const slowBackoff = () =>
    createProviderResilience({
      maxAttempts: 2,
      baseDelayMs: 10_000,
      maxDelayMs: 20_000,
      random: () => 1,
    });

  it('🔴 settles in under 500 ms with an AbortError instead of sitting out the wait', async () => {
    const resilience = slowBackoff();
    const ctrl = new AbortController();
    const dial = vi.fn(async () => {
      // First attempt fails transiently, which puts the policy into its 10 s
      // wait — the window the client's abort used to be invisible in.
      queueMicrotask(() => setTimeout(() => ctrl.abort(), 20));
      throw http(503);
    });

    const started = performance.now();
    const err = await resilience
      .execute(() => dial(), ctrl.signal)
      .catch((e: unknown) => e);
    const elapsed = performance.now() - started;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError');
    expect(elapsed).toBeLessThan(500);
    // Never dialled a second time: the caller hung up mid-wait.
    expect(dial).toHaveBeenCalledTimes(1);
  });

  it('carries the signal reason as `cause`, so a timeout is still diagnosable', async () => {
    const resilience = slowBackoff();
    const ctrl = new AbortController();
    const reason = new DOMException('wall clock', 'TimeoutError');
    // ⚠ The TS lib in this project types `abort()` as zero-arg; Node has taken
    // a reason since 17.2 and `withRequestTimeout` relies on it.
    const abortWith = (r: unknown) => (ctrl as { abort(r?: unknown): void }).abort(r);
    const err = await resilience
      .execute(async () => {
        setTimeout(() => abortWith(reason), 20);
        throw http(429);
      }, ctrl.signal)
      .catch((e: unknown) => e);

    expect((err as Error).name).toBe('AbortError');
    expect((err as { cause?: unknown }).cause).toBe(reason);
  });

  it('🔴 does NOT pre-empt an in-flight attempt, so the partial-billing error survives', async () => {
    // The interlock. If the race fired while the adapter was still unwinding,
    // the router would lose `OpenRouterAbortError.partial` and under-bill.
    const resilience = slowBackoff();
    const ctrl = new AbortController();
    const partial = completion({ contentText: 'half a sen', costUsd: 0.0004 });

    const err = await resilience
      .execute(async () => {
        ctrl.abort();
        // The adapter takes a few ticks to assemble its partial, exactly as the
        // streaming path does.
        await new Promise((r) => setTimeout(r, 30));
        throw new OpenRouterAbortError(partial);
      }, ctrl.signal)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenRouterAbortError);
    expect((err as OpenRouterAbortError).partial.usage.costUsd).toBe(0.0004);
  });

  it('an unaborted signal still returns the completion normally', async () => {
    const resilience = slowBackoff();
    const ctrl = new AbortController();
    await expect(resilience.execute(async () => completion(), ctrl.signal)).resolves.toMatchObject({
      contentText: 'ok',
    });
  });
});
