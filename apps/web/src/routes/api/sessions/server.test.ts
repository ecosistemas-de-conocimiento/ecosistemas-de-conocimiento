import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ dev: true, browser: false, building: false, version: 'test' }));
vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { GET, POST } from './+server';
import { backendFetch } from '$lib/server/auth';

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

function makeCookies(initial?: Record<string, string>) {
  const store: Record<string, string> = { ...(initial ?? {}) };
  const sets: [string, string][] = [];
  return {
    get: (n: string) => store[n],
    set: (n: string, v: string) => {
      store[n] = v;
      sets.push([n, v]);
    },
    delete: (n: string) => delete store[n],
    sets,
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
    request: new Request('http://web.test/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts.body ?? {}),
    }),
  } as unknown as Parameters<typeof POST>[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Two MEMBERSHIPS, in the shape the backend really answers with.
 *
 * ⚠ Resolving ecosistemas takes two reads — `/api/users/me`, then memberships
 * filtered by that id — because "tenants I may read" and "tenants I belong to"
 * diverge for a platform admin, whose access rule short-circuits to everything.
 */
const ME = { user: { id: 7 } };
const ORGS = {
  docs: [
    { id: 11, isActive: true, organization: { id: 1, name: 'Ecosistema Norte', slug: 'norte', isActive: true } },
    { id: 12, isActive: true, organization: { id: 2, name: 'Ecosistema Sur', slug: 'sur', isActive: true } },
  ],
};

/** Answer the organizations read with two memberships; anything else with `rest`. */
function backendWith(rest: (path: string) => Response) {
  mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) => {
    if (String(path).startsWith('/api/users/me')) return jsonResponse(ME);
    if (String(path).startsWith('/api/memberships')) return jsonResponse(ORGS);
    return rest(String(path));
  });
}

function calledPaths(): string[] {
  return mockedBackendFetch.mock.calls.map((c) => decodeURIComponent(String(c[1])));
}

function calledBody(n: number): Record<string, unknown> {
  const init = mockedBackendFetch.mock.calls[n]?.[2] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockedBackendFetch.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('GET /api/sessions', () => {
  it('401s without a session', async () => {
    const res = await GET(makeEvent({ user: null }));
    expect(res.status).toBe(401);
  });

  it('🔴 lists only the SELECTED ecosistema — Payload would return all of them', async () => {
    // `sessions` access is per-user, not per-ecosistema: without this filter a
    // switch would leave the previous ecosistema's conversations in the sidebar,
    // which reads exactly like a cross-tenant leak.
    backendWith(() => jsonResponse({ docs: [] }));
    await GET(makeEvent({ cookies: makeCookies({ eco_selected: '2' }) }));
    const sessionsRead = calledPaths().find((p) => p.startsWith('/api/sessions?'));
    expect(sessionsRead).toContain('where[organization][equals]=2');
  });

  it('scopes to the fallback ecosistema when nothing is selected yet', async () => {
    backendWith(() => jsonResponse({ docs: [] }));
    await GET(makeEvent({}));
    const sessionsRead = calledPaths().find((p) => p.startsWith('/api/sessions?'));
    expect(sessionsRead).toContain('where[organization][equals]=1');
  });

  it('🔴 a foreign selection cookie cannot widen the read', async () => {
    backendWith(() => jsonResponse({ docs: [] }));
    await GET(makeEvent({ cookies: makeCookies({ eco_selected: '999' }) }));
    const sessionsRead = calledPaths().find((p) => p.startsWith('/api/sessions?'));
    expect(sessionsRead).toContain('where[organization][equals]=1');
    expect(sessionsRead).not.toContain('999');
  });

  it('returns an empty list, and reads no sessions, with no memberships', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, p: string) =>
      String(p).startsWith('/api/users/me') ? jsonResponse(ME) : jsonResponse({ docs: [] }),
    );
    const res = await GET(makeEvent({}));
    expect(await res.json()).toEqual({ docs: [], totalDocs: 0 });
    expect(calledPaths().some((p) => p.startsWith('/api/sessions?'))).toBe(false);
  });

  it('degrades rather than listing unscoped when the ecosistema is unknown', async () => {
    mockedBackendFetch.mockImplementation(async () => jsonResponse({}, 500));
    const body = await (await GET(makeEvent({}))).json();
    expect(body.docs).toEqual([]);
    expect(body.degraded).toBe(true);
    expect(calledPaths().some((p) => p.startsWith('/api/sessions?'))).toBe(false);
  });

  it('still maps contextScope relationships back to refs', async () => {
    backendWith(() =>
      jsonResponse({
        docs: [{ id: 5, contextScope: [{ relationTo: 'organizations', value: { id: 1, name: 'Norte' } }] }],
      }),
    );
    const body = await (await GET(makeEvent({}))).json();
    expect(body.docs[0].contextScope.refs[0].kind).toBe('org');
  });

  it('exposes each conversation\'s kind; a row made before the split is generales', async () => {
    backendWith(() =>
      jsonResponse({ docs: [{ id: 5, kind: 'resonancias' }, { id: 6 }, { id: 7, kind: 'otra' }] }),
    );
    const body = await (await GET(makeEvent({}))).json();
    expect(body.docs.map((d: { kind: string }) => d.kind)).toEqual(['resonancias', 'generales', 'generales']);
  });
});

describe('POST /api/sessions', () => {
  it('401s without a session', async () => {
    const res = await POST(makeEvent({ user: null }));
    expect(res.status).toBe(401);
  });

  it('🔴 a backend 429 keeps its Retry-After, and is not cached', async () => {
    backendWith(
      () =>
        new Response(JSON.stringify({ errors: [{ message: 'Too many conversations' }] }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'Retry-After': '42' },
        }),
    );
    const res = await POST(makeEvent({}));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('any other backend failure carries no Retry-After', async () => {
    backendWith(() => jsonResponse({ errors: [] }, 500));
    const res = await POST(makeEvent({}));
    expect(res.status).toBe(500);
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  it('stamps the SELECTED ecosistema on the new conversation', async () => {
    backendWith(() => jsonResponse({ doc: { id: 9 } }, 201));
    const res = await POST(makeEvent({ cookies: makeCookies({ eco_selected: '2' }) }));
    expect(res.status).toBe(201);
    const createIdx = calledPaths().findIndex((p) => p === '/api/sessions');
    // Numeric, because Payload relationships on a numeric-id database are.
    expect(calledBody(createIdx).organization).toBe(2);
  });

  it('🔴 ignores an organization the client tries to smuggle into the body', async () => {
    backendWith(() => jsonResponse({ doc: { id: 9 } }, 201));
    await POST(
      makeEvent({
        cookies: makeCookies({ eco_selected: '1' }),
        body: { title: 'x', organization: 999 },
      }),
    );
    const createIdx = calledPaths().findIndex((p) => p === '/api/sessions');
    expect(calledBody(createIdx).organization).toBe(1);
  });

  it('🔴 a forged selection cookie cannot name a foreign ecosistema', async () => {
    backendWith(() => jsonResponse({ doc: { id: 9 } }, 201));
    await POST(makeEvent({ cookies: makeCookies({ eco_selected: '999' }) }));
    const createIdx = calledPaths().findIndex((p) => p === '/api/sessions');
    expect(calledBody(createIdx).organization).toBe(1);
  });

  it('creates a Resonancias conversation when the body asks for one', async () => {
    backendWith(() => jsonResponse({ doc: { id: 9 } }, 201));
    await POST(makeEvent({ body: { title: 'x', kind: 'resonancias' } }));
    const createIdx = calledPaths().findIndex((p) => p === '/api/sessions');
    expect(calledBody(createIdx).kind).toBe('resonancias');
  });

  it('no kind, or an unknown one, creates a Generales conversation', async () => {
    backendWith(() => jsonResponse({ doc: { id: 9 } }, 201));
    await POST(makeEvent({ body: { title: 'x' } }));
    await POST(makeEvent({ body: { title: 'x', kind: 'admin' } }));
    const bodies = calledPaths()
      .map((p, i) => (p === '/api/sessions' ? calledBody(i).kind : undefined))
      .filter((k) => k !== undefined);
    expect(bodies).toEqual(['generales', 'generales']);
  });

  it('409s `no_ecosystem` with no memberships, and creates nothing', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, p: string) =>
      String(p).startsWith('/api/users/me') ? jsonResponse(ME) : jsonResponse({ docs: [] }),
    );
    const res = await POST(makeEvent({}));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('no_ecosystem');
    expect(calledPaths()).not.toContain('/api/sessions');
  });

  it('⚠ distinguishes "no memberships" from "could not check"', async () => {
    // 409 drives a permanent Spanish screen; a backend blip must not trigger it.
    mockedBackendFetch.mockImplementation(async () => jsonResponse({}, 500));
    const res = await POST(makeEvent({}));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('ecosystems_unavailable');
  });
});
