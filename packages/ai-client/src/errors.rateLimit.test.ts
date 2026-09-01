/**
 * 🔴 THE 429 THE CLIENT COULD NOT SEE.
 *
 * ai-service caps `/v1` at 100 requests per minute per API key and `/v1/generate`
 * at 30. A seed that published 285 documents at concurrency hit that wall, and
 * `@edc/ai-client` mapped every refusal onto a bare `AIServiceError` — no
 * status-specific class, `Retry-After` never read, `retryAfterMs` in the body
 * ignored. No consumer could back off, because no consumer could TELL a
 * "slow down, come back in 47 seconds" apart from a "your key is wrong".
 *
 * What these tests pin down:
 *   · a 429 becomes a `RateLimitedError`, by discriminator AND by bare status
 *     (the second matters — a proxy in front of ai-service sends neither our
 *     discriminator nor our body shape);
 *   · the wait comes from the header first, then the body, then a safe default;
 *   · the wait is NEVER zero, NaN, or negative, so a caller can sleep on it
 *     without validating it — a zero wait is a hot loop against a server that
 *     just said stop;
 *   · `http.ts` actually hands the response headers to the dispatcher. That was
 *     the concrete defect: the header existed on the wire and was discarded one
 *     line before it could be read.
 */

import { describe, expect, it } from 'vitest';

import {
  AIServiceError,
  AuthError,
  DEFAULT_RETRY_AFTER_SECONDS,
  MAX_RETRY_AFTER_SECONDS,
  RateLimitedError,
  errorFromResponse,
  retryAfterFrom,
} from './errors.js';
import { HttpClient } from './http.js';

/** The exact body ai-service's `errorResponseBuilder` puts on the wire today. */
function serverBody(retryAfterMs: number) {
  return {
    error: 'RateLimitExceeded',
    message: `Rate limit exceeded. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`,
    retryAfterMs,
  };
}

describe('errorFromResponse — 🔴 a 429 is now a typed, retryable error', () => {
  it('maps ai-service’s own 429 body onto RateLimitedError', () => {
    const err = errorFromResponse(429, serverBody(47_000));
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toBeInstanceOf(AIServiceError); // hierarchy preserved
    expect(err.status).toBe(429);
    expect(err.name).toBe('RateLimitedError');
    expect((err as RateLimitedError).retryAfterSeconds).toBe(47);
  });

  it('🔴 maps a BARE 429 with no discriminator and no body', () => {
    // The proxy case. Nothing but the status code arrives, and it still has to
    // be retryable — otherwise a throttle we do not control is indistinguishable
    // from a permanent failure.
    const err = errorFromResponse(429, undefined);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_SECONDS);
  });

  it('leaves every other status mapping exactly as it was', () => {
    expect(errorFromResponse(401, { message: 'nope' })).toBeInstanceOf(AuthError);
    expect(errorFromResponse(500, { message: 'boom' })).toBeInstanceOf(AIServiceError);
    expect(errorFromResponse(500, { message: 'boom' })).not.toBeInstanceOf(RateLimitedError);
  });
});

describe('retryAfterFrom — where the wait comes from, in order', () => {
  // ⚠ CHECKS THE NAME. A fake that answers every `get()` with the same value
  // would pass even if the code read some other header entirely.
  const headers = (v: string | null) => ({
    get: (name: string) => (name.toLowerCase() === 'retry-after' ? v : null),
  });

  it('🔴 the Retry-After header WINS over the body', () => {
    // An intermediary sets the header and knows nothing about our body shape.
    // If the body ever disagreed, the hop closest to the throttle is right.
    expect(retryAfterFrom(headers('12'), serverBody(90_000))).toBe(12);
  });

  it('accepts Retry-After as an HTTP-date', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const at = new Date('2026-01-01T00:00:30Z').toUTCString();
    expect(retryAfterFrom(headers(at), {}, now)).toBe(30);
  });

  it('ignores an HTTP-date already in the past and falls through', () => {
    const now = new Date('2026-01-01T00:01:00Z');
    const past = new Date('2026-01-01T00:00:00Z').toUTCString();
    // Falls through to the body rather than yielding a zero (hot-loop) wait.
    expect(retryAfterFrom(headers(past), serverBody(20_000), now)).toBe(20);
  });

  it('reads `retryAfterSeconds` from the body when there is no header', () => {
    expect(retryAfterFrom(undefined, { retryAfterSeconds: 9 })).toBe(9);
  });

  it('🔴 also reads `retryAfterMs` — the field ai-service ACTUALLY sends', () => {
    // The documented name is `retryAfterSeconds`; the wire carries
    // `retryAfterMs`. A client that only understood the documented name would
    // silently wait the 60s default on every real refusal.
    expect(retryAfterFrom(undefined, serverBody(5_000))).toBe(5);
  });

  it('rounds UP, so a sub-second wait never lands back inside the closed window', () => {
    expect(retryAfterFrom(undefined, { retryAfterMs: 400 })).toBe(1);
  });

  it('never returns zero, negative, or NaN whatever the server says', () => {
    for (const body of [
      { retryAfterMs: 0 },
      { retryAfterMs: -5000 },
      { retryAfterSeconds: Number.NaN },
      { retryAfterSeconds: 'not a number' },
      {},
    ]) {
      const n = retryAfterFrom(headers('garbage'), body as Record<string, unknown>);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  it('clamps an absurd wait, so a bad header cannot park a caller for hours', () => {
    expect(retryAfterFrom(headers('99999'), {})).toBe(MAX_RETRY_AFTER_SECONDS);
  });
});

describe('HttpClient — 🔴 the headers reach the dispatcher', () => {
  function clientAnswering(status: number, body: unknown, headerPairs: [string, string][]) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: new Headers(headerPairs),
      })) as unknown as typeof fetch;
    return new HttpClient({
      baseUrl: 'https://ai.example',
      apiKey: 'k',
      fetchImpl,
      timeoutMs: 1000,
    });
  }

  it('surfaces Retry-After from a real Response on a 429', async () => {
    // This is THE regression. `json()` used to call `errorFromResponse(status,
    // body)` and drop `res.headers` on the floor one line before anyone could
    // read them.
    const http = clientAnswering(429, serverBody(60_000), [['retry-after', '23']]);
    await expect(http.json({ path: '/v1/ingest', method: 'POST', body: {} })).rejects.toMatchObject(
      { name: 'RateLimitedError', status: 429, retryAfterSeconds: 23 },
    );
  });

  it('falls back to the body when the response carries no Retry-After', async () => {
    const http = clientAnswering(429, serverBody(31_000), []);
    await expect(http.json({ path: '/v1/ingest', method: 'POST', body: {} })).rejects.toMatchObject(
      { name: 'RateLimitedError', retryAfterSeconds: 31 },
    );
  });
});
