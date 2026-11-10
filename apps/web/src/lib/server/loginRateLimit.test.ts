import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isActionFailure } from '@sveltejs/kit';

/**
 * 🔴 ONE IP CANNOT KEEP SOMEONE ELSE'S ACCOUNT LOCKED (audit 2026-11-10, A-11).
 *
 * Both sign-in doors — `/api/auth/login` (JS) and the `/sign-in` action (no
 * JS) — share `signIn`, and both must stop a spent (IP, email) pair, or a spent
 * IP, BEFORE it reaches the backend, where each try moves the target's lockout
 * counter. Each `fetch` below is one backend password check.
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

function backend(status: number, body: unknown, delayMs = 0) {
  const fn = vi.fn(async () => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Wrong password for every email but `ok`, whose password is right. */
function backendKnowing(ok: string, delayMs = 0) {
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const { email } = JSON.parse(String(init.body)) as { email: string };
    return email === ok
      ? new Response(JSON.stringify(OK), { status: 200 })
      : new Response(JSON.stringify(WRONG_PASSWORD), { status: 401 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const cookies = () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() });

async function viaApi(email = 'ana@example.org'): Promise<number> {
  const request = new Request('http://edc.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'x' }),
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
  envState.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_MAX = '3';
  envState.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX = '10';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete envState.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_MAX;
  delete envState.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_WINDOW_S;
  delete envState.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('failed sign-ins per (IP, email)', () => {
  it('the JSON door stops a spent pair before the backend sees it', async () => {
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

  it('a concurrent burst of 50 reaches the backend at most `limit` times', async () => {
    // The bug this guards: the check only looked and the count came after the
    // backend answered, so every concurrent request passed the look.
    const fetchFn = backend(401, WRONG_PASSWORD, 20);
    const burst = await Promise.all(Array.from({ length: 50 }, () => viaApi()));
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(burst.filter((s) => s === 401)).toHaveLength(3);
    expect(burst.filter((s) => s === 429)).toHaveLength(47);
  });

  it('after that burst, the same IP still signs in to another account', async () => {
    backendKnowing('colleague@example.org', 20);
    await Promise.all(Array.from({ length: 50 }, () => viaApi()));
    expect(await viaApi('colleague@example.org')).toBe(200);
  });

  it('keys on the normalised email, so case and spaces buy no fresh budget', async () => {
    const fetchFn = backend(401, WRONG_PASSWORD);
    for (const email of ['ana@example.org', ' ANA@example.org', 'Ana@Example.Org ']) await viaApi(email);
    expect(await viaApi('ANA@EXAMPLE.ORG')).toBe(429);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('refunds successes', async () => {
    backend(200, OK);
    for (let i = 0; i < 20; i += 1) expect(await viaApi()).toBe(200);
  });

  it('refunds a backend outage', async () => {
    backend(500, { message: 'down' });
    for (let i = 0; i < 20; i += 1) expect(await viaApi()).toBe(503);
  });

  it("refunds the backend's own 429", async () => {
    const fetchFn = backend(429, { errors: [{ message: 'Too many failed sign-ins.' }] });
    for (let i = 0; i < 20; i += 1) expect(await viaApi()).toBe(429);
    expect(fetchFn).toHaveBeenCalledTimes(20);
  });

  it('answers our own 429 with a Retry-After for the route', async () => {
    backend(401, WRONG_PASSWORD);
    const { signIn } = await import('./auth');
    for (let i = 0; i < 3; i += 1) await signIn('ana@example.org', 'x', cookies(), false);
    const refused = await signIn('ana@example.org', 'x', cookies(), false);
    expect(refused).toMatchObject({ ok: false, status: 429 });
    expect(refused.ok === false && refused.retryAfterSeconds).toBeGreaterThan(0);
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

  it('opens again after its hour', async () => {
    vi.useFakeTimers();
    backend(401, WRONG_PASSWORD);
    for (let i = 0; i < 3; i += 1) await viaApi();
    vi.advanceTimersByTime(60 * 60_000 + 1000);
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

  it('defaults to 4 per 10 minutes, one below the account lockout', async () => {
    delete envState.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_MAX;
    backend(401, WRONG_PASSWORD);
    for (let i = 0; i < 4; i += 1) expect(await viaApi()).toBe(401);
    expect(await viaApi()).toBe(429);
  });
});

describe('failed sign-ins per IP, across every email', () => {
  const sprayed = (i: number) => `user${i}@example.org`;

  it('caps spraying from one IP under a concurrent burst', async () => {
    const fetchFn = backend(401, WRONG_PASSWORD, 20);
    const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => viaApi(sprayed(i))));
    expect(fetchFn).toHaveBeenCalledTimes(10);
    expect(burst.filter((s) => s === 429)).toHaveLength(20);
  });

  it('a refusal by the ceiling spends nothing in the per-email bucket', async () => {
    backend(401, WRONG_PASSWORD);
    for (let i = 0; i < 10; i += 1) await viaApi(sprayed(i));
    expect(await viaApi('ana@example.org')).toBe(429);
    envState.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX = '100';
    for (let i = 0; i < 3; i += 1) expect(await viaApi('ana@example.org')).toBe(401);
  });

  it('opens again after the hour', async () => {
    vi.useFakeTimers();
    backend(401, WRONG_PASSWORD);
    for (let i = 0; i < 10; i += 1) await viaApi(sprayed(i));
    expect(await viaApi(sprayed(99))).toBe(429);
    vi.advanceTimersByTime(LOGIN_FAIL_WINDOW_MS + 1000);
    expect(await viaApi(sprayed(99))).toBe(401);
  });

  it('defaults to 100 an hour', async () => {
    delete envState.IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX;
    backend(401, WRONG_PASSWORD);
    for (let i = 0; i < 100; i += 1) expect(await viaApi(sprayed(i))).toBe(401);
    expect(await viaApi(sprayed(100))).toBe(429);
  });
});
