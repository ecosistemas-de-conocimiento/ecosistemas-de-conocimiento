/**
 * The retry loop's contract, exercised end to end through `HttpClient`.
 *
 * Every case here is one of the ways a retry loop goes wrong in production:
 * retrying a spend, retrying a decision, swallowing a cancel, ignoring the
 * server's own stated wait, or turning `timeoutMs` into `attempts × timeoutMs`.
 */

import EventEmitter from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { AIServiceError, RequestAbortedError } from './errors.js';
import { HttpClient, DEFAULT_RETRY_POLICY } from './http.js';

/** A fetch stub that replays a scripted list of outcomes and counts calls. */
function scriptedFetch(outcomes: Array<Response | Error | (() => Promise<Response>)>) {
  const calls: RequestInit[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next.clone();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/**
 * A server that never answers — it only ever rejects when the signal aborts,
 * exactly as undici does.
 *
 * 🔴 This replaces a FAKED `{ name: 'AbortError' }` rejection. The fake passed
 * while the real thing was broken: the timer aborted with a plain
 * `new Error(...)`, so the abort detector (which matched on name) missed it and
 * the timeout was RETRIED three times, surfacing as a plain `Error`. A stub
 * that hands back the shape the code is looking for cannot see that bug.
 */
function neverAnswers() {
  const calls: RequestInit[] = [];
  const impl = ((_url: string, init: RequestInit) => {
    calls.push(init);
    return new Promise<Response>((_resolve, reject) => {
      const fail = (): void => reject(init.signal?.reason ?? new Error('aborted'));
      if (init.signal?.aborted) fail();
      else init.signal?.addEventListener('abort', fail, { once: true });
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fail = (status: number, headers: Record<string, string> = {}) =>
  new Response('{"message":"nope"}', { status, headers });

const client = (fetchImpl: typeof fetch, retry = {}) =>
  new HttpClient({
    baseUrl: 'https://ai.test',
    apiKey: 'k',
    fetchImpl,
    timeoutMs: 5_000,
    // Near-zero delays: this suite asserts DECISIONS (how many attempts, which
    // ones), never elapsed milliseconds. A stored-time assertion would be a
    // flake generator, not a gate.
    // Each case states its own budget; `maxElapsedMs` is only under test in
    // the wall-clock block below.
    retry: { baseDelayMs: 1, maxElapsedMs: 60_000, ...retry },
  });

describe('retry: what gets resent', () => {
  it('retries a GET through transient failures and returns the eventual 200', async () => {
    const { impl, calls } = scriptedFetch([fail(503), fail(503), ok({ v: 1 })]);
    await expect(client(impl).json({ path: '/v1/x' })).resolves.toEqual({ v: 1 });
    expect(calls).toHaveLength(3);
  });

  it('NEVER resends a POST by default — a retried generate is a double spend', async () => {
    const { impl, calls } = scriptedFetch([fail(503)]);
    await expect(client(impl).json({ method: 'POST', path: '/v1/generate', body: {} })).rejects.toThrow(
      AIServiceError,
    );
    expect(calls).toHaveLength(1);
  });

  it('resends a POST only when the caller declares it idempotent', async () => {
    const { impl, calls } = scriptedFetch([fail(503), ok({ v: 2 })]);
    await expect(
      client(impl).json({ method: 'POST', path: '/v1/ingest', body: {}, idempotent: true }),
    ).resolves.toEqual({ v: 2 });
    expect(calls).toHaveLength(2);
  });

  it('stops at `attempts` and throws the last failure', async () => {
    const { impl, calls } = scriptedFetch([fail(500)]);
    await expect(client(impl).json({ path: '/v1/x' })).rejects.toThrow(AIServiceError);
    expect(calls).toHaveLength(DEFAULT_RETRY_POLICY.attempts);
  });

  it('`retry: { attempts: 1 }` opts a single call out entirely', async () => {
    const { impl, calls } = scriptedFetch([fail(500)]);
    await expect(client(impl).json({ path: '/v1/x', retry: { attempts: 1 } })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe('retry: what does NOT get resent', () => {
  // A 4xx is a decision. Re-asking gets the same answer, slower.
  it.each([400, 401, 403, 404, 409, 422, 501])('does not retry HTTP %i', async (status) => {
    const { impl, calls } = scriptedFetch([fail(status)]);
    await expect(client(impl).json({ path: '/v1/x' })).rejects.toThrow(AIServiceError);
    expect(calls).toHaveLength(1);
  });

  it.each([408, 425, 429, 500, 502, 503, 504])('DOES retry HTTP %i', async (status) => {
    const { impl, calls } = scriptedFetch([fail(status), ok()]);
    await client(impl).json({ path: '/v1/x' });
    expect(calls).toHaveLength(2);
  });

  it('retries a network error (no response at all)', async () => {
    const { impl, calls } = scriptedFetch([new TypeError('fetch failed'), ok({ v: 3 })]);
    await expect(client(impl).json({ path: '/v1/x' })).resolves.toEqual({ v: 3 });
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry a TIMEOUT, and surfaces it typed', async () => {
    // 🔴 Measured regression. Against a real never-answering server this used
    // to make THREE requests and reject with a plain `Error`: the timer aborted
    // with `new Error(...)`, so the name-matching abort detector missed it and
    // the retry loop treated a timeout as a transient network fault.
    const { impl, calls } = neverAnswers();
    const c = new HttpClient({
      baseUrl: 'https://ai.test',
      apiKey: 'k',
      fetchImpl: impl,
      timeoutMs: 20,
      retry: { baseDelayMs: 1, maxElapsedMs: 60_000 },
    });
    const err = await c.json({ path: '/v1/x' }).catch((e: unknown) => e);
    // The load-bearing number. If it becomes 3, `timeoutMs` has silently become
    // `attempts × timeoutMs` for every caller.
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(RequestAbortedError);
    expect(err).toBeInstanceOf(AIServiceError);
    expect((err as RequestAbortedError).reason).toBe('timeout');
    expect((err as AIServiceError).status).toBe(0);
  });

  it('does NOT retry a caller cancel, and reports it as a cancel not a timeout', async () => {
    const ctrl = new AbortController();
    const { impl, calls } = neverAnswers();
    const c = new HttpClient({
      baseUrl: 'https://ai.test',
      apiKey: 'k',
      fetchImpl: impl,
      timeoutMs: 60_000,
      retry: { baseDelayMs: 1, maxElapsedMs: 60_000 },
    });
    const p = c.json({ path: '/v1/x', signal: ctrl.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    ctrl.abort();
    const err = await p;
    expect(calls).toHaveLength(1);
    expect((err as RequestAbortedError).reason).toBe('cancel');
  });

  it('aborts with a `TimeoutError`-shaped reason the platform recognises', async () => {
    // `AbortSignal.timeout` uses a DOMException named `TimeoutError`; anything
    // reading `signal.reason` — a fetch implementation deciding what to throw,
    // above all — should see that shape and not a bare `Error`.
    const { impl, calls } = neverAnswers();
    await new HttpClient({
      baseUrl: 'https://ai.test',
      apiKey: 'k',
      fetchImpl: impl,
      timeoutMs: 20,
      retry: { attempts: 1 },
    })
      .json({ path: '/v1/x' })
      .catch(() => undefined);
    expect((calls[0]!.signal!.reason as Error).name).toBe('TimeoutError');
  });
});

describe('retry: the caller stays in control', () => {
  it('a caller abort DURING backoff rejects instead of paying out the ladder', async () => {
    const ctrl = new AbortController();
    const { impl, calls } = scriptedFetch([fail(503)]);
    const c = client(impl, { baseDelayMs: 10_000 });
    const p = c.json({ path: '/v1/x', signal: ctrl.signal });
    // Let the first attempt land and the backoff start.
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(RequestAbortedError);
    expect(calls).toHaveLength(1);
  });

  // `Retry-After` gets its own block below — the two cases that used to live
  // here asserted the CLAMP-AND-RETRY-EARLY behaviour that review rejected.

  it('applies the timeout PER ATTEMPT, not once for the whole ladder', async () => {
    const { impl, calls } = scriptedFetch([fail(503), ok()]);
    await client(impl).json({ path: '/v1/x' });
    // Each attempt built its own signal; a shared one would already be aborted
    // by the second attempt in the timeout case.
    expect(calls.map((c) => c.signal)).toHaveLength(2);
    expect(calls[0]!.signal).not.toBe(calls[1]!.signal);
  });
});


describe('the wall clock (`maxElapsedMs`)', () => {
  it('defaults to 30 s — the ceiling callers had BEFORE retry existed', () => {
    // 🔴 The behaviour-neutrality guarantee for callers that set no
    // `timeoutMs`. If this number rises, every consumer written against a 30 s
    // worst case (chat-backend sizes its boot deadline on it) silently gets a
    // longer one. An EXPLICIT `timeoutMs` is not bound by it (0.26.0).
    expect(DEFAULT_RETRY_POLICY.maxElapsedMs).toBe(30_000);
  });

  it('stops retrying once the budget is spent, even with attempts left', async () => {
    const { impl, calls } = scriptedFetch([fail(503)]);
    // Budget smaller than the first backoff: there is no room for attempt 2.
    const c = client(impl, { baseDelayMs: 5_000, maxElapsedMs: 20 });
    await expect(c.json({ path: '/v1/x' })).rejects.toThrow(AIServiceError);
    expect(calls).toHaveLength(1);
  });

  it('does not sleep out a budget it cannot use — fails fast on a network error', async () => {
    const { impl, calls } = scriptedFetch([new TypeError('fetch failed')]);
    const started = Date.now();
    await expect(
      client(impl, { baseDelayMs: 5_000, maxElapsedMs: 20 }).json({ path: '/v1/x' }),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(1);
    // Decision, not a duration: it must not have paid out the 5 s ladder.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('clamps the DEFAULT per-attempt timeout to the budget remaining', async () => {
    // A hung server plus a 40 ms wall, and NO explicit `timeoutMs`: the attempt
    // must be aborted by the wall, not run for the 30 s default.
    //
    // 0.26.0: this used to pass an explicit `timeoutMs: 5_000` and assert the
    // clamp on it. That clamp on an EXPLICIT value was the bug — it cut every
    // `timeoutMs` above 30 s to 30 s — so it now applies only to the default.
    // The explicit side is pinned in http.timeout.test.ts.
    const { impl: hang } = neverAnswers();
    const started = Date.now();
    await expect(
      new HttpClient({
        baseUrl: 'https://ai.test',
        apiKey: 'k',
        fetchImpl: hang,
        retry: { maxElapsedMs: 40 },
      }).json({ path: '/v1/x' }),
    ).rejects.toThrow(AIServiceError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('`maxElapsedMs: Infinity` opts out and lets the full ladder run', async () => {
    const { impl, calls } = scriptedFetch([fail(503), fail(503), ok({ v: 9 })]);
    await expect(
      client(impl, { maxElapsedMs: Infinity }).json({ path: '/v1/x' }),
    ).resolves.toEqual({ v: 9 });
    expect(calls).toHaveLength(3);
  });
});

describe('`Retry-After` longer than we will wait means STOP', () => {
  it('surfaces the 429 instead of retrying early against a full bucket', async () => {
    // 🔴 ai-service answers `retryAfterMs: ctx.ttl`, up to a 60 s window.
    // Clamping that to `maxDelayMs` and retrying at 20 s spent three requests
    // on a bucket that was still full, then failed anyway.
    const { impl, calls } = scriptedFetch([fail(429, { 'retry-after': '60' }), ok()]);
    await expect(
      client(impl, { maxDelayMs: 20_000 }).json({ path: '/v1/x' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1);
  });

  it('the surfaced error still carries the server\'s own wait for the caller', async () => {
    const { impl } = scriptedFetch([fail(429, { 'retry-after': '60' })]);
    // The body is NOT cancelled on this path, so the error can still be built.
    await expect(client(impl).json({ path: '/v1/x' })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 60_000,
    });
  });

  it('still retries a `Retry-After` that fits inside `maxDelayMs`', async () => {
    const { impl, calls } = scriptedFetch([fail(429, { 'retry-after': '0.001' }), ok({ v: 8 })]);
    await expect(client(impl, { maxDelayMs: 20_000 }).json({ path: '/v1/x' })).resolves.toEqual({
      v: 8,
    });
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['zero', '0'],
    ['blank', '   '],
    ['a past date', new Date(Date.now() - 60_000).toUTCString()],
    ['unparseable', 'soon-ish'],
  ])('treats a %s `Retry-After` as ABSENT and uses the exponential ladder', async (_n, value) => {
    // Honouring `Retry-After: 0` literally means hammering, with no backoff, a
    // server that just said no. Proxies emit it as a placeholder.
    //
    // 🔴 The construction is what makes this test able to FAIL. A plain
    // "does it retry?" assertion passes either way: honoured-as-0 retries
    // immediately, treated-as-absent retries after the ladder. So the budget is
    // set BELOW the exponential wait — absent ⇒ no room, stop at one attempt;
    // honoured-as-0 ⇒ a free immediate resend, two attempts.
    const { impl, calls } = scriptedFetch([fail(429, { 'retry-after': value }), ok({ v: 7 })]);
    await expect(
      client(impl, { baseDelayMs: 5_000, maxElapsedMs: 30 }).json({ path: '/v1/x' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1);
  });

  it('pads `Retry-After` rather than firing exactly on it', () => {
    // Every client rejected in the same window got the SAME number, so firing
    // on it re-synchronises the herd. Padding is always late, never early.
    const waits = new Set<number>();
    const c = client(scriptedFetch([ok()]).impl);
    const nextDelay = (c as unknown as {
      nextDelay(p: unknown, a: number, r?: number): number;
    }).nextDelay.bind(c);
    for (let i = 0; i < 50; i++) waits.add(nextDelay(DEFAULT_RETRY_POLICY, 1, 1_000));
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(1_000);
    expect(Math.max(...waits)).toBeLessThanOrEqual(1_100);
    expect(waits.size).toBeGreaterThan(1);
  });
});

describe('the abort listener does not accumulate', () => {
  it('removes its listener after every attempt, not only on abort', async () => {
    // 🔴 `{ once: true }` looks self-cleaning but only fires on abort. A signal
    // that is never aborted collected ONE listener PER ATTEMPT — on a signal a
    // worker may hold for its whole life. Node warns at 11, then leaks quietly.
    const ctrl = new AbortController();
    const { impl } = scriptedFetch([fail(503), fail(503), ok()]);
    await client(impl).json({ path: '/v1/x', signal: ctrl.signal });

    expect(EventEmitter.getEventListeners(ctrl.signal, 'abort')).toHaveLength(0);
  });

  it('stays flat across many sequential calls on one long-lived signal', async () => {
    const ctrl = new AbortController();
    const { impl } = scriptedFetch([ok()]);
    const c = client(impl);
    for (let i = 0; i < 15; i++) await c.json({ path: '/v1/x', signal: ctrl.signal });
    expect(EventEmitter.getEventListeners(ctrl.signal, 'abort')).toHaveLength(0);
  });
});
