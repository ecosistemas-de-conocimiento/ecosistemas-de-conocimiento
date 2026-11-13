import { beforeEach, describe, expect, it, vi } from 'vitest';

// `fetchMe` is the hook's call INTO the backend. Asserting it is never
// invoked for a health path is how we prove liveness touches no dependency.
const fetchMe = vi.fn(async () => null);

vi.mock('$lib/server/auth', () => ({
  SESSION_COOKIE: 'chat_auth',
  fetchMe: (...args: unknown[]) => fetchMe(...(args as [])),
}));

import { handle } from './hooks.server';

/** Minimal RequestEvent stand-in — the hook only touches url, cookies, locals. */
function event(pathname: string, opts: { cookie?: string; method?: string } = {}) {
  const deleted: string[] = [];
  return {
    url: new URL(`http://localhost${pathname}`),
    request: new Request(`http://localhost${pathname}`, { method: opts.method ?? 'GET' }),
    cookies: {
      get: () => opts.cookie,
      delete: (name: string) => deleted.push(name),
    },
    locals: {} as Record<string, unknown>,
    deleted,
  };
}

const resolved = new Response('routed', { status: 200 });
const resolve = vi.fn(async () => resolved);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('health-route exemption from the auth hook', () => {
  // 🔴 The regression this file exists for: before the health routes were
  // added, an unmatched `/api/health` fell into the block below and the hook
  // answered 401. A monitor read route-absence as an auth failure, which is a
  // permanent false negative — no amount of fixing auth would ever clear it.
  for (const path of ['/api/health', '/api/health/ready']) {
    it(`${path} resolves without auth, never 401 or 302`, async () => {
      const ev = event(path);
      const res = await handle({ event: ev as never, resolve: resolve as never });

      expect(res.status).toBe(200);
      expect(res).toBe(resolved);
      expect(resolve).toHaveBeenCalledOnce();
    });

    it(`${path} never calls into the backend, even with a stale cookie`, async () => {
      // Rule 2: liveness must check NO dependency. The exemption sits above
      // `fetchMe`, so a backend outage cannot slow or fail the probe path.
      const ev = event(path, { cookie: 'stale-jwt' });
      await handle({ event: ev as never, resolve: resolve as never });

      expect(fetchMe).not.toHaveBeenCalled();
    });
  }

  it('does not exempt look-alike paths', async () => {
    // The exemption is an exact-match set, not a prefix.
    const ev = event('/api/healthz');
    const res = await handle({ event: ev as never, resolve: resolve as never });

    expect(res.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('existing auth behaviour is unchanged', () => {
  it('still 401s an unauthenticated API route', async () => {
    const ev = event('/api/sessions');
    const res = await handle({ event: ev as never, resolve: resolve as never });

    expect(res.status).toBe(401);
    expect(fetchMe).toHaveBeenCalledOnce();
  });

  it('still redirects an unauthenticated page GET to /sign-in', async () => {
    const ev = event('/');
    await expect(
      handle({ event: ev as never, resolve: resolve as never }),
    ).rejects.toMatchObject({ status: 303, location: '/sign-in' });
  });

  it('lets a signed-out visitor reach /sign-up, so its "closed" redirect carries the note', async () => {
    // Sign-up is closed (UX backlog #6); the route redirects to
    // `/sign-in?registro=cerrado`. If the guard caught it first, an old link
    // would land on a bare `/sign-in` with no explanation.
    const res = await handle({ event: event('/sign-up') as never, resolve: resolve as never });
    expect(res).toBe(resolved);
  });

  it('/privacidad answers 200 to a signed-out visitor (the notice comes before any account)', async () => {
    const res = await handle({ event: event('/privacidad') as never, resolve: resolve as never });
    expect(res).toBe(resolved);
    expect(res.status).toBe(200);
  });

  it('still lets a public auth proxy through', async () => {
    const ev = event('/api/auth/login', { method: 'POST' });
    const res = await handle({ event: ev as never, resolve: resolve as never });

    expect(res).toBe(resolved);
  });
});
