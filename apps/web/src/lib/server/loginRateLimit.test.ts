import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isActionFailure } from '@sveltejs/kit';

/**
 * 🔴 ONE IP CANNOT KEEP SOMEONE ELSE'S ACCOUNT LOCKED (audit 2026-11-10, A-11).
 *
 * Both sign-in doors — `/api/auth/login` (JS) and the `/sign-in` action (no
 * JS) — share `signIn`, and both must stop an IP that has spent its failed
 * attempts BEFORE it reaches the backend, where each try moves the target's
 * lockout counter.
 */

const envState: Record<string, string | undefined> = { BACKEND_URL: 'http://backend.test:3002' };
vi.mock('$env/dynamic/private', () => ({ env: envState }));

let ip = '203.0.113.7';
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    request: new Request('http://edc.test/', { headers: { 'x-forwarded-for': ip } }),
    getClientAddress: () => '172.18.0.5',
  }),
}));

const { POST: loginApi } = await import('../../routes/api/auth/login/+server');
const { actions } = await import('../../routes/sign-in/+page.server');
const { AUTH_ERROR_COPY } = await import('./auth');
const { LOGIN_FAIL_WINDOW_MS, resetLoginRateLimit } = await import('./loginRateLimit');

const WRONG_PASSWORD = { errors: [{ message: 'The email or password provided is incorrect.' }] };
const LOCKED = {
  errors: [{ message: 'This user is locked due to having too many failed login attempts.' }],
};
const OK = { token: 'jwt', user: { id: 1, email: 'ana@example.org' } };

function backend(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const cookies = () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() });

async function viaApi(): Promise<number> {
  const request = new Request('http://edc.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ana@example.org', password: 'x' }),
  });
  return (await loginApi({ request, cookies: cookies() } as never)).status;
}

async function viaForm(): Promise<number> {
  const request = new Request('http://edc.test/sign-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'ana@example.org', password: 'x' }),
  });
  try {
    const out = await actions.default!({ request, cookies: cookies() } as never);
    return isActionFailure(out) ? out.status : 200;
  } catch (thrown) {
    return (thrown as { status: number }).status;
  }
}

beforeEach(() => {
  resetLoginRateLimit();
  ip = '203.0.113.7';
  envState.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX = '3';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete envState.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('failed sign-ins per IP', () => {
  it('the JSON door stops a spent IP before the backend sees it', async () => {
    const fetchFn = backend(401, WRONG_PASSWORD);
    for (let i = 0; i < 3; i += 1) expect(await viaApi()).toBe(401);
    expect(await viaApi()).toBe(429);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('the form door shares the same count', async () => {
    const fetchFn = backend(401, WRONG_PASSWORD);
    await viaApi();
    await viaForm();
    await viaApi();
    expect(await viaForm()).toBe(429);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('counts a locked account as a failure', async () => {
    backend(401, LOCKED);
    for (let i = 0; i < 3; i += 1) await viaApi();
    expect(await viaApi()).toBe(429);
  });

  it('does not count successes', async () => {
    backend(200, OK);
    for (let i = 0; i < 10; i += 1) expect(await viaApi()).toBe(200);
  });

  it('does not count a backend outage', async () => {
    backend(500, { message: 'down' });
    for (let i = 0; i < 10; i += 1) expect(await viaApi()).toBe(503);
  });

  it('keeps IPs apart', async () => {
    backend(401, WRONG_PASSWORD);
    for (let i = 0; i < 3; i += 1) await viaApi();
    ip = '198.51.100.1';
    expect(await viaApi()).toBe(401);
  });

  it('a forged left X-Forwarded-For entry buys no fresh budget', async () => {
    backend(401, WRONG_PASSWORD);
    for (let i = 0; i < 3; i += 1) {
      ip = `10.0.0.${i}, 203.0.113.7`;
      await viaApi();
    }
    ip = '192.0.2.1, 203.0.113.7';
    expect(await viaApi()).toBe(429);
  });

  it('opens again after the hour', async () => {
    vi.useFakeTimers();
    backend(401, WRONG_PASSWORD);
    for (let i = 0; i < 3; i += 1) await viaApi();
    vi.advanceTimersByTime(LOGIN_FAIL_WINDOW_MS + 1000);
    expect(await viaApi()).toBe(401);
  });

  it("maps the backend's own 429 to the same Spanish sentence, never Payload's English", async () => {
    backend(429, { errors: [{ message: 'Too many failed sign-ins. Retry in 3600s.' }] });
    const request = new Request('http://edc.test/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ana@example.org', password: 'x' }),
    });
    const res = await loginApi({ request, cookies: cookies() } as never);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: AUTH_ERROR_COPY['rate-limited'] });
  });

  it('defaults to 15 an hour', async () => {
    delete envState.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX;
    backend(401, WRONG_PASSWORD);
    for (let i = 0; i < 15; i += 1) expect(await viaApi()).toBe(401);
    expect(await viaApi()).toBe(429);
  });
});
