/**
 * `timeoutMs` is the per-attempt deadline, and the retry budget never shrinks it.
 *
 * 🔴 Regression through 0.25.0: each attempt's timeout
 * was `min(timeoutMs, maxElapsedMs remaining)`, and `maxElapsedMs` defaults to
 * 30 s. So `new AIClient({ timeoutMs: 120_000 })` aborted EVERY call at 30 s,
 * retried or not. Measured: a `/v1/generate/sync` aborted at
 * 29 979 ms and was billed for the partial generation.
 *
 * The DEFAULT (no `timeoutMs` anywhere) keeps the clamp: a caller that sets
 * nothing still waits at most 30 s in total — chat-backend sizes its boot
 * deadline on that. The last block below pins it.
 *
 * Fake timers drive every case: the server "answers at 45 s" on the fake clock,
 * so each test runs in milliseconds and asserts the decision, not a duration.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { AIClient } from './index.js';
import { AIServiceError, RequestAbortedError } from './errors.js';
import { DEFAULT_TIMEOUT_MS, HttpClient } from './http.js';

const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fail = (status: number) => new Response('{"message":"nope"}', { status });

/**
 * A server that answers each call after a scripted delay on the (fake) clock,
 * and rejects with the signal's reason on abort, the way undici does.
 */
function slowServer(script: Array<{ afterMs: number; res: () => Response }>) {
  const calls: Array<{ init: RequestInit; at: number }> = [];
  const impl = ((_url: string, init: RequestInit) => {
    const step = script[Math.min(calls.length, script.length - 1)]!;
    calls.push({ init, at: Date.now() });
    return new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(step.res()), step.afterMs);
      const onAbort = (): void => {
        clearTimeout(t);
        reject(init.signal?.reason ?? new Error('aborted'));
      };
      if (init.signal?.aborted) onAbort();
      else init.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const SYNC_REQ = { unit: { unitKey: 'u1', input: { q: 'hi' } } } as never;
const SYNC_BODY = { text: 'hello', modelUsed: 'm', provider: 'openrouter', costUsd: 0, traceId: 't' };

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Settle a promise into a tagged result so it never trips an unhandled rejection. */
function settle<T>(p: Promise<T>) {
  const out: { done: boolean; value?: T; error?: unknown } = { done: false };
  p.then(
    (value) => Object.assign(out, { done: true, value }),
    (error: unknown) => Object.assign(out, { done: true, error }),
  );
  return out;
}

describe('an explicit `timeoutMs` above the 30 s retry budget', () => {
  it('generate.sync with timeoutMs 120 s succeeds when the server answers at 45 s', async () => {
    const { impl, calls } = slowServer([{ afterMs: 45_000, res: () => ok(SYNC_BODY) }]);
    const client = new AIClient({ baseUrl: 'http://svc', apiKey: 'k', fetch: impl, timeoutMs: 120_000 });

    const r = settle(client.generate.sync(SYNC_REQ));
    await vi.advanceTimersByTimeAsync(30_001);
    // The old clamp aborted here, at the 30 s budget.
    expect(r.done).toBe(false);
    expect(calls[0]!.init.signal!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(r.error).toBeUndefined();
    expect(r.value).toMatchObject({ text: 'hello' });
    expect(calls).toHaveLength(1);
  });

  it('a GET (retried kind) with timeoutMs 120 s also gets the full deadline', async () => {
    const { impl } = slowServer([{ afterMs: 45_000, res: () => ok({ v: 1 }) }]);
    const http = new HttpClient({ baseUrl: 'http://svc', apiKey: 'k', fetchImpl: impl, timeoutMs: 120_000 });
    const r = settle(http.json({ path: '/v1/x' }));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(r.value).toEqual({ v: 1 });
  });

  it('generate.stream connect with timeoutMs 120 s succeeds when headers land at 45 s', async () => {
    const sse = () =>
      new Response('data: {"type":"done","text":"x"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    const { impl } = slowServer([{ afterMs: 45_000, res: sse }]);
    const client = new AIClient({ baseUrl: 'http://svc', apiKey: 'k', fetch: impl, timeoutMs: 120_000 });
    const r = settle(client.generate.streamRaw(SYNC_REQ));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(r.error).toBeUndefined();
    expect((r.value as Response).status).toBe(200);
  });

  it('still times out — at timeoutMs, not at the retry budget', async () => {
    const { impl } = slowServer([{ afterMs: 150_000, res: () => ok() }]);
    const client = new AIClient({ baseUrl: 'http://svc', apiKey: 'k', fetch: impl, timeoutMs: 120_000 });
    const r = settle(client.generate.sync(SYNC_REQ));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(r.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.error).toBeInstanceOf(RequestAbortedError);
    expect((r.error as RequestAbortedError).reason).toBe('timeout');
    expect((r.error as Error).message).toContain('120000ms');
  });

  it('`timeoutMs: Infinity` means no deadline, not a 1 ms setTimeout overflow', async () => {
    const { impl } = slowServer([{ afterMs: 200_000, res: () => ok({ v: 2 }) }]);
    const http = new HttpClient({ baseUrl: 'http://svc', apiKey: 'k', fetchImpl: impl, timeoutMs: Infinity });
    const r = settle(http.json({ path: '/v1/x' }));
    await vi.advanceTimersByTimeAsync(200_000);
    expect(r.value).toEqual({ v: 2 });
  });
});

describe('a `timeoutMs` that is not a deadline throws', () => {
  // 🔴 0.25.0 aborted a NaN timeout at ~1 ms (setTimeout coerces it); the
  // first 0.26.0 draft silently ran it with NO deadline. Neither is a reading a
  // caller asked for, so it is a TypeError — at construction for the client
  // option, before any fetch for the per-call one.
  const BAD = [NaN, -Infinity, '5000' as unknown as number];

  it.each(BAD)('client option %s throws at construction (AIClient and HttpClient)', (bad) => {
    const { impl } = slowServer([{ afterMs: 1, res: () => ok() }]);
    expect(() => new AIClient({ baseUrl: 'http://svc', apiKey: 'k', fetch: impl, timeoutMs: bad })).toThrow(
      TypeError,
    );
    expect(() => new HttpClient({ baseUrl: 'http://svc', apiKey: 'k', fetchImpl: impl, timeoutMs: bad })).toThrow(
      /timeoutMs must be a finite number/,
    );
  });

  it.each(BAD)('per-call %s rejects with TypeError and never fetches', async (bad) => {
    const { impl, calls } = slowServer([{ afterMs: 1, res: () => ok(SYNC_BODY) }]);
    const client = new AIClient({ baseUrl: 'http://svc', apiKey: 'k', fetch: impl });
    await expect(client.generate.sync(SYNC_REQ, { timeoutMs: bad })).rejects.toBeInstanceOf(TypeError);
    await expect(client.http.json({ path: '/v1/x', timeoutMs: bad })).rejects.toBeInstanceOf(TypeError);
    await expect(client.http.raw({ path: '/v1/x', timeoutMs: bad })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('`Infinity` stays legal on both the client and the call', async () => {
    const { impl } = slowServer([{ afterMs: 10, res: () => ok({ v: 3 }) }]);
    const client = new AIClient({ baseUrl: 'http://svc', apiKey: 'k', fetch: impl, timeoutMs: Infinity });
    const r = settle(client.http.json({ path: '/v1/x', timeoutMs: Infinity }));
    await vi.advanceTimersByTimeAsync(10);
    expect(r.value).toEqual({ v: 3 });
  });
});

describe('the retry budget still bounds RETRIES', () => {
  // Replaces 'clamps the per-attempt timeout to the budget remaining' (removed
  // from http.retry.test.ts): that test pinned the clamp itself, which is the
  // bug. The budget now gates only whether another attempt starts.

  it('does not start another attempt once the budget is spent', async () => {
    // Default budget 30 s. Attempt 1 fails transiently at 31 s: no attempt 2.
    const { impl, calls } = slowServer([
      { afterMs: 31_000, res: () => fail(503) },
      { afterMs: 0, res: () => ok() },
    ]);
    const http = new HttpClient({ baseUrl: 'http://svc', apiKey: 'k', fetchImpl: impl, timeoutMs: 120_000 });
    const r = settle(http.json({ path: '/v1/x' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.error).toBeInstanceOf(AIServiceError);
    expect((r.error as AIServiceError).status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('a retry started inside the budget keeps its FULL deadline, past the budget', async () => {
    // Attempt 1 fails at 10 s (inside the 30 s budget), attempt 2 answers 45 s
    // later — 55 s in total. Under the clamp, attempt 2 was cut at ~30 s.
    const { impl, calls } = slowServer([
      { afterMs: 10_000, res: () => fail(503) },
      { afterMs: 45_000, res: () => ok({ v: 3 }) },
    ]);
    const http = new HttpClient({
      baseUrl: 'http://svc',
      apiKey: 'k',
      fetchImpl: impl,
      timeoutMs: 120_000,
      retry: { baseDelayMs: 1 },
    });
    const r = settle(http.json({ path: '/v1/x' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual({ v: 3 });
    expect(calls).toHaveLength(2);
  });

  it('a small explicit budget does not shorten the attempt either', async () => {
    const { impl } = slowServer([{ afterMs: 1_000, res: () => ok({ v: 4 }) }]);
    const http = new HttpClient({
      baseUrl: 'http://svc',
      apiKey: 'k',
      fetchImpl: impl,
      timeoutMs: 5_000,
      retry: { maxElapsedMs: 40 },
    });
    const r = settle(http.json({ path: '/v1/x' }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.value).toEqual({ v: 4 });
  });
});

describe('per-call `timeoutMs`', () => {
  it('raises the client default for one call (generate.sync)', async () => {
    const { impl } = slowServer([{ afterMs: 45_000, res: () => ok(SYNC_BODY) }]);
    const client = new AIClient({ baseUrl: 'http://svc', apiKey: 'k', fetch: impl, timeoutMs: 10_000 });
    const r = settle(client.generate.sync(SYNC_REQ, { timeoutMs: 120_000 }));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(r.error).toBeUndefined();
    expect(r.value).toMatchObject({ text: 'hello' });
  });

  it('lowers it for one call (http.json)', async () => {
    const { impl } = slowServer([{ afterMs: 45_000, res: () => ok() }]);
    const http = new HttpClient({ baseUrl: 'http://svc', apiKey: 'k', fetchImpl: impl, timeoutMs: 120_000 });
    const r = settle(http.json({ path: '/v1/x', timeoutMs: 5_000, retry: { attempts: 1 } }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.error).toBeInstanceOf(RequestAbortedError);
    expect((r.error as RequestAbortedError).reason).toBe('timeout');
  });

  it('applies to http.raw too', async () => {
    const { impl } = slowServer([{ afterMs: 45_000, res: () => ok() }]);
    const http = new HttpClient({ baseUrl: 'http://svc', apiKey: 'k', fetchImpl: impl, timeoutMs: 10_000 });
    const r = settle(http.raw({ method: 'POST', path: '/v1/x', timeoutMs: 120_000 }));
    await vi.advanceTimersByTimeAsync(45_000);
    expect((r.value as Response).status).toBe(200);
  });

  it('generate.sync forwards a caller signal', async () => {
    const { impl } = slowServer([{ afterMs: 45_000, res: () => ok(SYNC_BODY) }]);
    const client = new AIClient({ baseUrl: 'http://svc', apiKey: 'k', fetch: impl, timeoutMs: 120_000 });
    const ctrl = new AbortController();
    const r = settle(client.generate.sync(SYNC_REQ, { signal: ctrl.signal }));
    await vi.advanceTimersByTimeAsync(1_000);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect((r.error as RequestAbortedError).reason).toBe('cancel');
  });
});

describe('no explicit `timeoutMs`: the 30 s total is unchanged', () => {
  it('the default timeout is 30 s', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it('a call that sets nothing still times out at 30 s', async () => {
    const { impl } = slowServer([{ afterMs: 45_000, res: () => ok(SYNC_BODY) }]);
    const client = new AIClient({ baseUrl: 'http://svc', apiKey: 'k', fetch: impl });
    const r = settle(client.generate.sync(SYNC_REQ));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(r.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((r.error as RequestAbortedError).reason).toBe('timeout');
  });

  it('a retried GET that sets nothing never runs past 30 s in total', async () => {
    // Attempt 1 fails at 10 s; attempt 2 hangs. Its default 30 s deadline is
    // cut to the ~20 s of budget left, so the call ends at ~30 s, not ~40 s.
    const { impl, calls } = slowServer([
      { afterMs: 10_000, res: () => fail(503) },
      { afterMs: 999_000, res: () => ok() },
    ]);
    const http = new HttpClient({ baseUrl: 'http://svc', apiKey: 'k', fetchImpl: impl, retry: { baseDelayMs: 1 } });
    const r = settle(http.json({ path: '/v1/x' }));
    await vi.advanceTimersByTimeAsync(30_001);
    expect(calls).toHaveLength(2);
    expect(r.error).toBeInstanceOf(RequestAbortedError);
    expect((r.error as RequestAbortedError).reason).toBe('timeout');
  });

  it('through AIClient: a retried GET that sets nothing never runs past 30 s in total', async () => {
    // 🔴 Pins the WIRING in `AIClient`'s constructor, not just HttpClient: the
    // client must leave `timeoutMs` UNSET when the caller sets none. Defaulting
    // it there (`opts.timeoutMs ?? 30_000`) makes it explicit, so attempt 2
    // gets a full 30 s and the call ends at ~40 s. A non-retried call (sync)
    // cannot see that difference, so this goes through a retried GET.
    const { impl, calls } = slowServer([
      { afterMs: 10_000, res: () => fail(503) },
      { afterMs: 999_000, res: () => ok() },
    ]);
    const client = new AIClient({ baseUrl: 'http://svc', apiKey: 'k', fetch: impl, retry: { baseDelayMs: 1 } });
    const r = settle(client.budget.get('org-1'));
    await vi.advanceTimersByTimeAsync(30_001);
    expect(calls).toHaveLength(2);
    expect(r.done).toBe(true);
    expect((r.error as RequestAbortedError).reason).toBe('timeout');
  });
});
