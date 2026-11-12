import { describe, expect, it } from 'vitest';

import { backendErrorDetail, backendJson, rateLimitHeaders } from './backendResponse';

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

describe('backendErrorDetail', () => {
  // A Payload-shaped body whose message quotes a row, as a hook that rethrows
  // a database error's text would write it.
  const payloadBody = JSON.stringify({
    errors: [{ message: 'Juana Pérez declaró en la audiencia' }],
  });

  it('a 4xx passes Payload\'s own errors[].message on', () => {
    expect(backendErrorDetail(400, JSON.stringify({ errors: [{ message: 'title is required' }] }))).toBe(
      'title is required',
    );
  });

  it('🔴 a 5xx passes nothing, even in Payload\'s shape', () => {
    for (const status of [500, 502, 503]) {
      expect(backendErrorDetail(status, payloadBody)).toBe('');
    }
  });
});
