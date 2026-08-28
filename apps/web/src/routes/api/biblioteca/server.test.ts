import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/ecosystem', () => ({ resolveEcosystem: vi.fn() }));
vi.mock('$lib/server/biblioteca', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/biblioteca')>(
    '$lib/server/biblioteca',
  );
  return { ...actual, listPublished: vi.fn() };
});

import { GET } from './+server';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { listPublished } from '$lib/server/biblioteca';

const mockedResolve = resolveEcosystem as unknown as ReturnType<typeof vi.fn>;
const mockedList = listPublished as unknown as ReturnType<typeof vi.fn>;

type Locals = { user: { id: number } | null; token: string | undefined };

function makeEvent(opts: { locals?: Partial<Locals>; url?: string } = {}): Parameters<typeof GET>[0] {
  const locals: Locals = {
    user: opts.locals?.user === undefined ? { id: 1 } : opts.locals.user,
    token: opts.locals?.token === undefined ? 'tok' : opts.locals.token,
  };
  return {
    locals,
    cookies: { get: () => undefined, set: () => {}, delete: () => {} },
    url: new URL(opts.url ?? 'http://web.test/api/biblioteca'),
  } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockedResolve.mockReset();
  mockedList.mockReset();
  mockedResolve.mockResolvedValue({
    ok: true,
    selected: { id: '7', name: 'Ecosistema de prueba' },
    list: [],
    source: 'cookie',
  });
  mockedList.mockResolvedValue({ items: [], total: 0, page: 1, hasNextPage: false, ok: true });
});

describe('GET /api/biblioteca', () => {
  it('401s without a session, without resolving anything', async () => {
    const res = await GET(makeEvent({ locals: { user: null } }));
    expect(res.status).toBe(401);
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  // 🔴 The browser names no ecosistema. The server derives it from the session
  // and the selection cookie, which `resolveEcosystem` re-validates against the
  // caller's real memberships on every request.
  it('scopes the read to the resolved ecosistema, never to anything in the URL', async () => {
    await GET(makeEvent({ url: 'http://web.test/api/biblioteca?eco=999&organization=999' }));
    expect(mockedList.mock.calls[0]![1]).toMatchObject({ organizationId: '7' });
  });

  it('passes the normalised filter and search through', async () => {
    await GET(makeEvent({ url: 'http://web.test/api/biblioteca?kind=testimonio&q=%20acta%20&page=3' }));
    expect(mockedList.mock.calls[0]![1]).toMatchObject({
      kind: 'testimonio',
      search: 'acta',
      page: 3,
    });
  });

  it('falls back to todos and page 1 for junk parameters', async () => {
    await GET(makeEvent({ url: 'http://web.test/api/biblioteca?kind=nope&page=-4' }));
    expect(mockedList.mock.calls[0]![1]).toMatchObject({ kind: 'todos', page: 1 });
  });

  // ⚠ "We could not tell" is not "you belong to nothing". Saying the second
  // sends someone to ask for access they already have.
  it('reports unavailable when the membership read failed', async () => {
    mockedResolve.mockResolvedValue({ ok: false, selected: null, list: [], source: 'none' });
    const body = await (await GET(makeEvent())).json();
    expect(body.state).toBe('unavailable');
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('reports no-ecosystem when the caller really has none', async () => {
    mockedResolve.mockResolvedValue({ ok: true, selected: null, list: [], source: 'none' });
    const body = await (await GET(makeEvent())).json();
    expect(body.state).toBe('no-ecosystem');
    expect(mockedList).not.toHaveBeenCalled();
  });

  // ⚠ An empty list because the backend blinked must never render as "tu
  // ecosistema no ha publicado nada".
  it('reports unavailable when the document read failed', async () => {
    mockedList.mockResolvedValue({ items: [], total: 0, page: 1, hasNextPage: false, ok: false });
    const body = await (await GET(makeEvent())).json();
    expect(body.state).toBe('unavailable');
  });

  it('names the ecosistema it is showing', async () => {
    const body = await (await GET(makeEvent())).json();
    expect(body.state).toBe('ready');
    expect(body.ecosystem).toEqual({ id: '7', name: 'Ecosistema de prueba' });
  });
});
