import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ dev: true, browser: false, building: false, version: 'test' }));
vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { GET, POST } from './+server';
import { backendFetch } from '$lib/server/auth';

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

type CookieJar = { get: (n: string) => string | undefined; sets: [string, string][]; deleted: string[] };

function makeCookies(initial?: Record<string, string>): CookieJar & {
  set: (n: string, v: string) => void;
  delete: (n: string) => void;
} {
  const store: Record<string, string> = { ...(initial ?? {}) };
  const sets: [string, string][] = [];
  const deleted: string[] = [];
  return {
    get: (n: string) => store[n],
    set: (n: string, v: string) => {
      store[n] = v;
      sets.push([n, v]);
    },
    delete: (n: string) => {
      delete store[n];
      deleted.push(n);
    },
    sets,
    deleted,
  };
}

function makeEvent(opts: {
  user?: { id: number; email: string } | null;
  cookies?: ReturnType<typeof makeCookies>;
  body?: unknown;
}) {
  return {
    locals: {
      user: opts.user === undefined ? { id: 1, email: 'u@test' } : opts.user,
      token: 'tok',
    },
    cookies: opts.cookies ?? makeCookies(),
    request: new Request('http://web.test/api/ecosistemas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? {}),
    }),
  } as unknown as Parameters<typeof POST>[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Two memberships, as Payload's membership-scoped list returns them. */
function twoOrgs(): Response {
  return jsonResponse({
    docs: [
      { id: 1, name: 'Ecosistema Norte', slug: 'norte' },
      { id: 2, name: 'Ecosistema Sur', slug: 'sur' },
    ],
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockedBackendFetch.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('GET /api/ecosistemas', () => {
  it('401s without a session', async () => {
    const res = await GET(makeEvent({ user: null }));
    expect(res.status).toBe(401);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('never filters by a client-supplied user or org — the list is Payload-scoped', async () => {
    mockedBackendFetch.mockImplementation(async () => twoOrgs());
    await GET(makeEvent({}));
    const path = decodeURIComponent(String(mockedBackendFetch.mock.calls[0]?.[1]));
    expect(path.startsWith('/api/organizations?')).toBe(true);
    expect(path).not.toContain('where[');
  });

  it('honours a stored selection that is a real membership', async () => {
    mockedBackendFetch.mockImplementation(async () => twoOrgs());
    const cookies = makeCookies({ eco_selected: '2' });
    const res = await GET(makeEvent({ cookies }));
    const body = await res.json();
    expect(body.selectedId).toBe('2');
    expect(body.ecosistemas).toHaveLength(2);
    // Already correct: nothing to rewrite.
    expect(cookies.sets).toEqual([]);
  });

  it('🔴 ignores a stored id that is not a membership, and rewrites the cookie', async () => {
    mockedBackendFetch.mockImplementation(async () => twoOrgs());
    const cookies = makeCookies({ eco_selected: '999' });
    const res = await GET(makeEvent({ cookies }));
    const body = await res.json();
    // A forged cookie selects nothing: it falls back to a real membership...
    expect(body.selectedId).toBe('1');
    // ...and the stale value is replaced so it stops riding on every request.
    expect(cookies.sets).toEqual([['eco_selected', '1']]);
  });

  it('defaults to the first membership when nothing is stored', async () => {
    mockedBackendFetch.mockImplementation(async () => twoOrgs());
    const res = await GET(makeEvent({}));
    expect((await res.json()).selectedId).toBe('1');
  });

  it('reports zero memberships as an empty list, not as degraded', async () => {
    mockedBackendFetch.mockImplementation(async () => jsonResponse({ docs: [] }));
    const body = await (await GET(makeEvent({}))).json();
    expect(body).toEqual({ ecosistemas: [], selectedId: null });
  });

  it('⚠ a failed read is `degraded`, NOT "you belong to no ecosistema"', async () => {
    // The zero-membership screen tells people to go ask for access. Showing it
    // because the backend is down tells someone with access to request access.
    mockedBackendFetch.mockImplementation(async () => jsonResponse({}, 500));
    const body = await (await GET(makeEvent({}))).json();
    expect(body.ecosistemas).toEqual([]);
    expect(body.selectedId).toBeNull();
    expect(body.degraded).toBe(true);
  });

  it('does not clobber a stored choice when the list read fails', async () => {
    mockedBackendFetch.mockImplementation(async () => jsonResponse({}, 503));
    const cookies = makeCookies({ eco_selected: '2' });
    await GET(makeEvent({ cookies }));
    expect(cookies.sets).toEqual([]);
    expect(cookies.deleted).toEqual([]);
    expect(cookies.get('eco_selected')).toBe('2');
  });
});

describe('POST /api/ecosistemas', () => {
  it('401s without a session', async () => {
    const res = await POST(makeEvent({ user: null, body: { id: '1' } }));
    expect(res.status).toBe(401);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('selects a membership and remembers it', async () => {
    mockedBackendFetch.mockImplementation(async () => twoOrgs());
    const cookies = makeCookies();
    const res = await POST(makeEvent({ cookies, body: { id: '2' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).selected).toEqual({
      id: '2',
      name: 'Ecosistema Sur',
      slug: 'sur',
    });
    expect(cookies.sets).toEqual([['eco_selected', '2']]);
  });

  it('accepts a numeric id as well as a string one', async () => {
    mockedBackendFetch.mockImplementation(async () => twoOrgs());
    const res = await POST(makeEvent({ body: { id: 2 } }));
    expect(res.status).toBe(200);
    expect((await res.json()).selected.id).toBe('2');
  });

  it('🔴 REFUSES an ecosistema the caller does not belong to, and stores nothing', async () => {
    mockedBackendFetch.mockImplementation(async () => twoOrgs());
    const cookies = makeCookies({ eco_selected: '1' });
    const res = await POST(makeEvent({ cookies, body: { id: '999' } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('not_a_member');
    // Nothing written: the caller stays exactly where they were.
    expect(cookies.sets).toEqual([]);
    expect(cookies.get('eco_selected')).toBe('1');
  });

  it('🔴 refuses rather than silently selecting a different ecosistema', async () => {
    // The read path falls back to the first membership; the WRITE path must not.
    // Answering 200 with somebody else's ecosistema selected is how a user ends
    // up publishing into a tenant they never chose.
    mockedBackendFetch.mockImplementation(async () => twoOrgs());
    const res = await POST(makeEvent({ body: { id: '999' } }));
    expect(res.status).not.toBe(200);
  });

  it('409s `no_ecosystem` when the caller has no memberships', async () => {
    mockedBackendFetch.mockImplementation(async () => jsonResponse({ docs: [] }));
    const res = await POST(makeEvent({ body: { id: '1' } }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('no_ecosystem');
  });

  it('🔴 refuses when membership cannot be verified — never writes an unchecked id', async () => {
    mockedBackendFetch.mockImplementation(async () => jsonResponse({}, 500));
    const cookies = makeCookies();
    const res = await POST(makeEvent({ cookies, body: { id: '1' } }));
    expect(res.status).toBe(503);
    expect(cookies.sets).toEqual([]);
  });

  it('400s on a body with no usable id', async () => {
    for (const body of [{}, { id: null }, { id: { $ne: 1 } }, 'not json']) {
      mockedBackendFetch.mockReset();
      const res = await POST(makeEvent({ body }));
      expect(res.status).toBe(400);
      expect(mockedBackendFetch).not.toHaveBeenCalled();
    }
  });
});
