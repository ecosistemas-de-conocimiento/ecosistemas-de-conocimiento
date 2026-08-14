// Unit tests for fetchOpenRouterCredits.
//
// Stubs the global `fetch` per-test. Covers:
//   - happy path: maps `data.{total_credits,total_usage}` -> stable shape.
//   - cache hit on the second call within the 30s TTL.
//   - cache miss after expiry (advance the system clock).
//   - 4xx and 5xx upstream errors -> `OpenRouterCreditsError`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetOpenRouterCreditsCacheForTests,
  fetchOpenRouterCredits,
  OpenRouterCreditsError,
} from './openrouter-credits.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/credits';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  __resetOpenRouterCreditsCacheForTests();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fetchOpenRouterCredits — happy path', () => {
  it('maps total_credits / total_usage onto the stable shape', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse(200, { data: { total_credits: 100, total_usage: 37.5 } }),
      );

    const result = await fetchOpenRouterCredits({ apiKey: 'sk-or-test' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe(ENDPOINT);
    const headers = (call[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-or-test');
    expect(result.totalCredits).toBe(100);
    expect(result.totalUsage).toBe(37.5);
    expect(result.remainingCredits).toBe(62.5);
    expect(typeof result.updatedAt).toBe('string');
    expect(() => new Date(result.updatedAt).toISOString()).not.toThrow();
  });
});

describe('fetchOpenRouterCredits — caching', () => {
  it('serves the second call within 30s from cache (no extra fetch)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse(200, { data: { total_credits: 10, total_usage: 4 } }),
      );

    const first = await fetchOpenRouterCredits({ apiKey: 'k' });
    const second = await fetchOpenRouterCredits({ apiKey: 'k' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('hits the network again after the cache TTL expires', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { total_credits: 10, total_usage: 4 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { total_credits: 10, total_usage: 5 } }),
      );

    const first = await fetchOpenRouterCredits({ apiKey: 'k' });
    expect(first.remainingCredits).toBe(6);

    // Advance past the 30s TTL.
    vi.setSystemTime(new Date(Date.now() + 31_000));

    const second = await fetchOpenRouterCredits({ apiKey: 'k' });
    expect(second.remainingCredits).toBe(5);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('fetchOpenRouterCredits — error mapping', () => {
  it('throws OpenRouterCreditsError on 4xx', async () => {
    // `mockImplementation` returns a fresh Response per call — important
    // because a Response body can only be read once.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(401, { error: { message: 'invalid key' } }),
    );
    await expect(fetchOpenRouterCredits({ apiKey: 'bad' })).rejects.toBeInstanceOf(
      OpenRouterCreditsError,
    );
    try {
      await fetchOpenRouterCredits({ apiKey: 'bad' });
      expect.unreachable('should throw');
    } catch (e) {
      const err = e as OpenRouterCreditsError;
      expect(err.status).toBe(401);
      expect(err.message).toContain('invalid key');
    }
  });

  it('throws OpenRouterCreditsError on 5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(503, { error: { message: 'temporarily unavailable' } }),
    );
    await expect(fetchOpenRouterCredits({ apiKey: 'k' })).rejects.toBeInstanceOf(
      OpenRouterCreditsError,
    );
  });

  it('does not cache a failed response', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(500, { error: { message: 'boom' } }))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { total_credits: 8, total_usage: 1 } }),
      );

    await expect(fetchOpenRouterCredits({ apiKey: 'k' })).rejects.toBeInstanceOf(
      OpenRouterCreditsError,
    );
    const second = await fetchOpenRouterCredits({ apiKey: 'k' });
    expect(second.remainingCredits).toBe(7);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
