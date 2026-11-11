import { describe, expect, it } from 'vitest';

import { backendJson, rateLimitHeaders } from './backendResponse';

const backend = (status: number, headers: Record<string, string> = {}) =>
  new Response('{}', { status, headers });

describe('backendJson / rateLimitHeaders', () => {
  it('a 429 keeps the backend status, its Retry-After, and adds no-store', async () => {
    const res = backendJson({ error: 'slow down' }, backend(429, { 'Retry-After': '30' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'slow down' });
  });

  it('a 429 without Retry-After still says no-store and invents no wait', () => {
    expect(rateLimitHeaders(backend(429))).toEqual({ 'cache-control': 'no-store' });
  });

  it('any other status adds nothing, even with a Retry-After (a 503 is not this helper\'s call)', () => {
    expect(rateLimitHeaders(backend(503, { 'Retry-After': '5' }))).toEqual({});
    expect(rateLimitHeaders(backend(200))).toEqual({});
  });
});
