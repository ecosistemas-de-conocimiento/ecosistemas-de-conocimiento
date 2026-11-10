import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE BFF FORWARDS THE BROWSER'S IP (audit 2026-11-10, A-08).
 *
 * Every backend call used to leave without `X-Forwarded-For`, so the backend's
 * `clientIp()` was `'unknown'` for every browser and `/api/v1/identity/me` kept
 * ONE per-IP bucket for the whole installation. These tests pin both halves of
 * what the web now does: which IP it believes, and that it sends it.
 */

vi.mock('$env/dynamic/private', () => ({ env: { BACKEND_URL: 'http://backend.test:3002' } }));

/** The request being served, as `getRequestEvent` would hand it over. */
let current: { request: Request; getClientAddress: () => string } | null = null;
vi.mock('$app/server', () => ({
  getRequestEvent: () => {
    if (!current) throw new Error('outside a request');
    return current;
  },
}));

const { clientIpOf, currentClientIp } = await import('./clientIp');
const { backendFetch, fetchMe, loginWithBackend } = await import('./auth');
const { readIdentity } = await import('./holds');

function serving(xff: string | null, socket = '172.18.0.5') {
  current = {
    request: new Request('http://edc.test/', { headers: xff ? { 'x-forwarded-for': xff } : {} }),
    getClientAddress: () => socket,
  };
}

/** Capture the headers of every backend call. */
function captureFetch(status = 200, body: unknown = {}) {
  const seen: Headers[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return seen;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  current = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('clientIpOf', () => {
  it('trusts the rightmost X-Forwarded-For entry, the one Traefik appended', () => {
    serving('6.6.6.6, 203.0.113.7');
    expect(currentClientIp()).toBe('203.0.113.7');
  });

  it('falls back to the socket peer when no proxy is in front', () => {
    serving(null, '127.0.0.1');
    expect(currentClientIp()).toBe('127.0.0.1');
  });

  it('is null outside a request', () => {
    expect(currentClientIp()).toBeNull();
  });

  it('is null when the adapter cannot tell either', () => {
    const event = {
      request: new Request('http://edc.test/'),
      getClientAddress: () => {
        throw new Error('no address');
      },
    };
    expect(clientIpOf(event)).toBeNull();
  });
});

describe('backend calls carry the browser IP', () => {
  it('backendFetch sends ONE entry: the browser, never the forged left part', async () => {
    serving('6.6.6.6, 203.0.113.7');
    const seen = captureFetch();
    await backendFetch('jwt', '/api/anything');
    expect(seen[0]?.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(seen[0]?.get('authorization')).toBe('JWT jwt');
  });

  it('the identity read behind the layout, /revision and /miembros carries it', async () => {
    serving('203.0.113.7');
    const seen = captureFetch(200, { principal: {} });
    await readIdentity('jwt');
    expect(seen[0]?.get('x-forwarded-for')).toBe('203.0.113.7');
  });

  it('two browsers are two different IPs on the wire', async () => {
    const seen = captureFetch(200, { principal: {} });
    serving('203.0.113.7');
    await readIdentity('jwt');
    serving('198.51.100.1');
    await readIdentity('jwt');
    expect(seen.map((h) => h.get('x-forwarded-for'))).toEqual(['203.0.113.7', '198.51.100.1']);
  });

  it('login and the session check carry it too', async () => {
    serving('203.0.113.7');
    const seen = captureFetch(401, {});
    await loginWithBackend('a@b.mx', 'x');
    await fetchMe('jwt');
    expect(seen.map((h) => h.get('x-forwarded-for'))).toEqual(['203.0.113.7', '203.0.113.7']);
  });

  it('an explicit caller header cannot override it', async () => {
    serving('203.0.113.7');
    const seen = captureFetch();
    await backendFetch('jwt', '/api/anything', { headers: { 'X-Forwarded-For': '6.6.6.6' } });
    expect(seen[0]?.get('x-forwarded-for')).toBe('203.0.113.7');
  });

  it('sends nothing outside a request, rather than inventing an address', async () => {
    const seen = captureFetch();
    await backendFetch('jwt', '/api/anything');
    expect(seen[0]?.has('x-forwarded-for')).toBe(false);
  });
});
