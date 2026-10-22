/**
 * `withRetry` — the opt-in, call-level retry wrapper.
 *
 * Every timing assertion runs on vitest's fake timers (or an injected sleep and
 * clock). Nothing here sleeps for real: a suite that waited out a 61 s
 * `Retry-After` would be a suite nobody runs.
 */

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AIServiceError,
  AuthError,
  BadRequestError,
  BudgetExceededError,
  ConflictError,
  NotFoundError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  RateLimitError,
  RequestAbortedError,
} from './errors.js';
import { HttpClient } from './http.js';
import {
  DEFAULT_WITH_RETRY_OPTIONS,
  isRetryableError,
  withRetry,
  type WithRetryAttempts,
} from './with-retry.js';

const rateLimited = (retryAfterMs: number) => new RateLimitError('slow down', retryAfterMs);
const unavailable = (retryAfterMs = 0) =>
  new ProviderUnavailableError('breaker open', {}, { retryAfterMs });
const fetchFailed = () => new TypeError('fetch failed');
/** A 429 from ANOTHER copy of ai-client: same shape, different class identity. */
const foreignRateLimit = (retryAfterMs: number) =>
  Object.assign(new Error('slow down'), { name: 'RateLimitError', status: 429, retryAfterMs });

/** A `fn` that replays a script: an Error is thrown, anything else is returned. */
function scripted<T>(outcomes: Array<T | Error>) {
  const fn = vi.fn(async () => {
    const next = outcomes[Math.min(fn.mock.calls.length - 1, outcomes.length - 1)];
    if (next instanceof Error) throw next;
    return next as T;
  });
  return fn;
}

/** No jitter, so a wait is exactly the base the policy computed. */
const noJitter = { random: () => 0 };
const transient = { ...noJitter, retryTransient: true };

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('withRetry — 429', () => {
  it('retries a rate limit and returns the eventual success', async () => {
    const fn = scripted([rateLimited(2_000), 'ok']);
    const p = withRetry(fn, noJitter);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('waits exactly the server-stated Retry-After before the next attempt, not sooner', async () => {
    const fn = scripted([rateLimited(5_000), 'ok']);
    const p = withRetry(fn, noJitter);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(p).resolves.toBe('ok');
  });

  it('caps a Retry-After longer than maxRetryAfterMs (default 61 s)', async () => {
    const waits: number[] = [];
    const fn = scripted([rateLimited(300_000), 'ok']);
    const p = withRetry(fn, { ...noJitter, onRetry: ({ waitMs }) => waits.push(waitMs) });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(waits).toEqual([61_000]);
  });

  it('waits one full capped window when the 429 carried no hint (retryAfterMs 0)', async () => {
    const waits: number[] = [];
    const p = withRetry(scripted([rateLimited(0), 'ok']), {
      ...noJitter,
      onRetry: ({ waitMs }) => waits.push(waitMs),
    });
    await vi.runAllTimersAsync();
    await p;
    expect(waits).toEqual([61_000]);
  });

  it('adds jitter on top of Retry-After — always later, never earlier — up to 25%, capped at 5 s', async () => {
    const waits: number[] = [];
    const onRetry = ({ waitMs }: { waitMs: number }) => waits.push(waitMs);
    const a = withRetry(scripted([rateLimited(4_000), 'ok']), { random: () => 1, onRetry });
    await vi.runAllTimersAsync();
    await a;
    const b = withRetry(scripted([rateLimited(40_000), 'ok']), { random: () => 1, onRetry });
    await vi.runAllTimersAsync();
    await b;
    expect(waits).toEqual([5_000, 45_000]);
  });
});

describe('withRetry — a 429 from another copy of ai-client (duck-typed)', () => {
  it('retries it and honours its retryAfterMs, though `instanceof RateLimitError` is false', async () => {
    const waits: number[] = [];
    const foreign = foreignRateLimit(3_000);
    expect(foreign).not.toBeInstanceOf(RateLimitError);
    const fn = scripted([foreign, 'ok']);
    const p = withRetry(fn, { ...noJitter, onRetry: ({ waitMs }) => waits.push(waitMs) });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(waits).toEqual([3_000]);
  });

  it('matches a foreign RateLimitError by its name AND status, not by either alone', () => {
    expect(isRetryableError(foreignRateLimit(0))).toBe(true);
    expect(isRetryableError({ status: 429 })).toBe(false);
    expect(isRetryableError(Object.assign(new Error('x'), { name: 'RateLimitError' }))).toBe(false);
    expect(isRetryableError({ status: 400, name: 'BadRequestError' })).toBe(false);
  });
});

describe('withRetry — a 429 that is not ai-client\'s rate limit', () => {
  it.each([
    ['a plain { status: 429 }', () => ({ status: 429 })],
    ['a fetch Response', () => new Response(null, { status: 429 })],
    [
      'an OpenAI-style quota 429',
      () => Object.assign(new Error('quota'), { status: 429, code: 'insufficient_quota' }),
    ],
  ])('%s is rethrown at once, with no 61 s wait', async (_label, make) => {
    const err = make();
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, noJitter)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['on the error', { code: 'insufficient_quota' }],
    ['as the type', { type: 'insufficient_quota' }],
    ['in body.error', { body: { error: { code: 'insufficient_quota', type: 'x' } } }],
  ])('a quota code %s vetoes even a RateLimitError, transient or not', (_label, extra) => {
    const err = Object.assign(foreignRateLimit(1_000), { retryable: true }, extra);
    expect(isRetryableError(err)).toBe(false);
    expect(isRetryableError(err, { retryTransient: true })).toBe(false);
  });
});

describe('withRetry — 429 only by default', () => {
  it.each([
    ['a 503', unavailable()],
    ['a 504', new ProviderTimeoutError('slow provider')],
    ['a network fault', fetchFailed()],
    ['our own timeout', new RequestAbortedError('timeout', 'timed out')],
  ])('%s is rethrown at once without retryTransient', async (_label, err) => {
    const fn = scripted([err, 'ok']);
    await expect(withRetry(fn, noJitter)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('isRetryableError is 429-only unless asked for transient', () => {
    expect(isRetryableError(unavailable())).toBe(false);
    expect(isRetryableError(unavailable(), { retryTransient: true })).toBe(true);
    expect(isRetryableError(fetchFailed())).toBe(false);
    expect(isRetryableError(fetchFailed(), { retryTransient: true })).toBe(true);
  });
});

describe('withRetry — retryTransient: true', () => {
  it('retries a 503 with doubling backoff when the server gave no cool-down', async () => {
    const waits: number[] = [];
    const fn = scripted([unavailable(), unavailable(), unavailable(), 'ok']);
    const p = withRetry(fn, { ...transient, onRetry: ({ waitMs }) => waits.push(waitMs) });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(waits).toEqual([1_000, 2_000, 4_000]);
  });

  it("honours a 503's own retryAfterMs (the breaker cool-down) over the ladder", async () => {
    const waits: number[] = [];
    const p = withRetry(scripted([unavailable(7_000), 'ok']), {
      ...transient,
      onRetry: ({ waitMs }) => waits.push(waitMs),
    });
    await vi.runAllTimersAsync();
    await p;
    expect(waits).toEqual([7_000]);
  });

  it('goes by the typed `retryable` flag, not the status: a retryable 504 IS retried', async () => {
    const fn = scripted([new ProviderTimeoutError('slow provider'), 'ok']);
    const p = withRetry(fn, transient);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a 503 the server marked NOT retryable ("database unavailable") is rethrown at once', async () => {
    const db = new AIServiceError('database unavailable', 503, {}, { retryable: false });
    const fn = scripted([db, 'ok']);
    await expect(withRetry(fn, transient)).rejects.toBe(db);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reads `retryable` duck-typed, so an error from another ai-client copy also counts', async () => {
    const foreign = Object.assign(new Error('x'), { status: 502, retryable: true });
    const fn = scripted([foreign, 'ok']);
    const p = withRetry(fn, transient);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
  });

  it('retries a network failure: undici "fetch failed" and a socket code on `cause`', async () => {
    const reset = Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } });
    const fn = scripted([fetchFailed(), reset, 'ok']);
    const p = withRetry(fn, transient);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries our own timeout but never a caller cancel', async () => {
    const timeout = new RequestAbortedError('timeout', 'timed out');
    const t = withRetry(scripted([timeout, 'ok']), transient);
    await vi.runAllTimersAsync();
    await expect(t).resolves.toBe('ok');

    const cancel = new RequestAbortedError('cancel', 'cancelled');
    const fn = scripted([cancel, 'ok']);
    await expect(withRetry(fn, transient)).rejects.toBe(cancel);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withRetry — giving up rethrows the ORIGINAL last error', () => {
  it('stops BEFORE a sleep that would overrun the budget, still an `instanceof RateLimitError`', async () => {
    // Two capped 61 s waits = 122 s > the 120 s default: the second never starts.
    const last = rateLimited(0);
    const fn = scripted([rateLimited(0), last]);
    const caught = withRetry(fn, noJitter).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await caught;
    expect(err).toBe(last);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as WithRetryAttempts).retryAttempts).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stops after `attempts` total tries (default 4), carrying the count', async () => {
    const fn = scripted([unavailable()]);
    const caught = withRetry(fn, transient).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await caught;
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as WithRetryAttempts).retryAttempts).toBe(DEFAULT_WITH_RETRY_OPTIONS.attempts);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('attaches `retryAttempts` non-enumerably: logs and JSON stay as they were', async () => {
    const last = rateLimited(1_000);
    const caught = withRetry(scripted([last]), { ...noJitter, attempts: 2 }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    await caught;
    expect(Object.keys(last)).not.toContain('retryAttempts');
    expect(JSON.stringify(last)).not.toContain('retryAttempts');
    expect((last as WithRetryAttempts).retryAttempts).toBe(2);
  });

  it('counts the time the calls themselves take against the budget (wall clock)', async () => {
    // Each call takes 50 s, then 429s with a 5 s hint. 50 + 5 + 50 = 105 s;
    // the next 5 s wait would end at 110 s, still inside 120 s; the third call
    // ends at 160 s and the next wait would overrun.
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50_000));
      throw rateLimited(5_000);
    });
    const caught = withRetry(fn, noJitter).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await caught;
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as WithRetryAttempts).retryAttempts).toBe(3);
  });

  it.each([
    ['frozen', () => Object.freeze(rateLimited(1_000))],
    [
      'carrying a locked retryAttempts',
      () => Object.defineProperty(rateLimited(1_000), 'retryAttempts', { value: 9 }),
    ],
  ])('rethrows an error it cannot mark (%s) unchanged, not a TypeError', async (_label, make) => {
    const last = make();
    const caught = withRetry(scripted([last]), { ...noJitter, attempts: 2 }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await caught).toBe(last);
  });

  it('attempts: 1 means one try and no retry', async () => {
    const last = rateLimited(1_000);
    const fn = scripted([last, 'ok']);
    const caught = withRetry(fn, { attempts: 1 }).catch((e: unknown) => e);
    expect(await caught).toBe(last);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withRetry — option validation', () => {
  it.each([
    ['attempts', Number.NaN],
    ['attempts', -1],
    ['attempts', 0],
    ['attempts', 1.5],
    ['attempts', Number.POSITIVE_INFINITY],
    ['maxElapsedMs', Number.NaN],
    ['maxElapsedMs', -1],
    ['maxElapsedMs', Number.POSITIVE_INFINITY],
    ['maxRetryAfterMs', Number.NaN],
    ['maxRetryAfterMs', -1],
    ['maxRetryAfterMs', Number.POSITIVE_INFINITY],
    ['baseDelayMs', Number.NaN],
    ['baseDelayMs', -1],
    ['baseDelayMs', Number.POSITIVE_INFINITY],
  ])('rejects %s = %s with a RangeError naming the option, before calling fn', async (name, value) => {
    const fn = scripted(['ok']);
    const p = withRetry(fn, { [name]: value });
    await expect(p).rejects.toBeInstanceOf(RangeError);
    await expect(p).rejects.toThrow(new RegExp(`withRetry: \`${name}\``));
    expect(fn).not.toHaveBeenCalled();
  });

  it('accepts maxElapsedMs: 0 (no waiting at all) and fails after one try', async () => {
    const last = rateLimited(1_000);
    const fn = scripted([last, 'ok']);
    await expect(withRetry(fn, { maxElapsedMs: 0 })).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withRetry — signal', () => {
  it('an abort during the wait ends it at once and rethrows the abort reason', async () => {
    const ctrl = new AbortController();
    const fn = scripted([rateLimited(30_000), 'ok']);
    const caught = withRetry(fn, { ...noJitter, signal: ctrl.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const reason = new Error('user left');
    ctrl.abort(reason);
    expect(await caught).toBe(reason);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an injected sleep that would never resolve on its own', async () => {
    vi.useRealTimers();
    const ctrl = new AbortController();
    const caught = withRetry(scripted([rateLimited(1_000), 'ok']), {
      signal: ctrl.signal,
      sleep: () => new Promise<void>(() => {}),
    }).catch((e: unknown) => e);
    await Promise.resolve();
    ctrl.abort();
    const err = await caught;
    expect(err).toBe(ctrl.signal.reason);
    expect((err as Error).name).toBe('AbortError');
  });

  it('removes its abort listener when an injected sleep rejects', async () => {
    vi.useRealTimers();
    const ctrl = new AbortController();
    const add = vi.spyOn(ctrl.signal, 'addEventListener');
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener');
    const boom = new Error('sleep failed');
    const caught = withRetry(scripted([rateLimited(1_000), 'ok']), {
      signal: ctrl.signal,
      sleep: () => Promise.reject(boom),
    }).catch((e: unknown) => e);
    expect(await caught).toBe(boom);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
  });

  it('an already-aborted signal never calls fn', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fn = scripted(['ok']);
    await expect(withRetry(fn, { signal: ctrl.signal })).rejects.toBe(ctrl.signal.reason);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('withRetry — never retries a decision', () => {
  const decisions: Array<[string, Error]> = [
    ['400', new BadRequestError('bad')],
    ['401', new AuthError('who')],
    ['402', new BudgetExceededError('broke', { org: 'o', requested: 1, remaining: 0, shortfallUsd: 1 })],
    ['404', new NotFoundError('gone')],
    ['409', new ConflictError('dup')],
    ['500', new AIServiceError('boom', 500)],
    ['a plain Error', new Error('bug in the caller')],
  ];
  it.each(decisions)('%s is rethrown unchanged after one attempt, even with retryTransient', async (_label, err) => {
    const fn = scripted([err, 'ok']);
    await expect(withRetry(fn, { retryTransient: true })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(Object.getOwnPropertyNames(err)).not.toContain('retryAttempts');
  });
});

describe('withRetry — injection', () => {
  it('uses an injected sleep and clock, with no timers at all', async () => {
    vi.useRealTimers();
    let clock = 1_000;
    const sleeps: number[] = [];
    const fn = scripted([rateLimited(3_000), unavailable(), 'ok']);
    const result = await withRetry(fn, {
      ...transient,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    expect(result).toBe('ok');
    expect(sleeps).toEqual([3_000, 2_000]);
  });

  it('passes the 1-based attempt number to fn', async () => {
    const seen: number[] = [];
    const p = withRetry(
      async (attempt) => {
        seen.push(attempt);
        if (attempt < 3) throw rateLimited(10);
        return attempt;
      },
      noJitter,
    );
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(3);
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('isRetryableError', () => {
  it('classifies by ai-client typed errors', () => {
    const t = { retryTransient: true };
    expect(isRetryableError(rateLimited(0))).toBe(true);
    expect(isRetryableError(unavailable(), t)).toBe(true);
    expect(isRetryableError(new RequestAbortedError('timeout', 't'), t)).toBe(true);
    expect(isRetryableError(new RequestAbortedError('cancel', 'c'), t)).toBe(false);
    expect(isRetryableError(new BadRequestError('b'), t)).toBe(false);
    expect(isRetryableError(undefined, t)).toBe(false);
  });
});

describe('shipped text stays product-agnostic', () => {
  // README.md names `@edc/ai-client` by design. Only the source is checked.
  it.each(['src/with-retry.ts'])('%s names no consumer product', (rel) => {
    const text = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    expect(text).not.toMatch(/\bEDC\b|ecosistemas/i);
  });
});

describe('withRetry over the real transport', () => {
  it('waits out a 429 whose Retry-After exceeds the transport ladder, which hands it back', async () => {
    // `HttpClient` gives up on a Retry-After above `maxDelayMs` (20 s) and
    // throws `RateLimitError` — exactly the case this wrapper exists for.
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('{"message":"rate limited","retryAfterMs":30000}', {
          status: 429,
          headers: { 'retry-after': '30' },
        });
      }
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const http = new HttpClient({ baseUrl: 'https://ai.test', apiKey: 'k', fetchImpl });

    const p = withRetry(() => http.json<{ ok: boolean }>({ path: '/v1/x' }), noJitter);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});
