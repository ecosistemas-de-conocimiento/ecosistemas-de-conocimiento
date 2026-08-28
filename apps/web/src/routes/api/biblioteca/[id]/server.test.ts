import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/ecosystem', () => ({ resolveEcosystem: vi.fn() }));
vi.mock('$lib/server/biblioteca', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/biblioteca')>(
    '$lib/server/biblioteca',
  );
  return { ...actual, readPublished: vi.fn() };
});

import { GET } from './+server';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { readPublished } from '$lib/server/biblioteca';

const mockedResolve = resolveEcosystem as unknown as ReturnType<typeof vi.fn>;
const mockedRead = readPublished as unknown as ReturnType<typeof vi.fn>;

type Locals = { user: { id: number } | null; token: string | undefined };

function makeEvent(opts: { locals?: Partial<Locals>; id?: string } = {}): Parameters<typeof GET>[0] {
  const locals: Locals = {
    user: opts.locals?.user === undefined ? { id: 1 } : opts.locals.user,
    token: opts.locals?.token === undefined ? 'tok' : opts.locals.token,
  };
  return {
    locals,
    params: { id: opts.id ?? '5' },
    cookies: { get: () => undefined, set: () => {}, delete: () => {} },
    url: new URL('http://web.test/api/biblioteca/5'),
  } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockedResolve.mockReset();
  mockedRead.mockReset();
  mockedResolve.mockResolvedValue({
    ok: true,
    selected: { id: '7', name: 'Eco' },
    list: [],
    source: 'cookie',
  });
});

describe('GET /api/biblioteca/[id]', () => {
  it('401s without a session', async () => {
    const res = await GET(makeEvent({ locals: { user: null } }));
    expect(res.status).toBe(401);
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('400s on a blank id (%p)', async (id) => {
    expect((await GET(makeEvent({ id }))).status).toBe(400);
    expect(mockedRead).not.toHaveBeenCalled();
  });

  // 🔴 The ecosistema comes from the session, never from the request.
  it('reads under the resolved ecosistema', async () => {
    mockedRead.mockResolvedValue({ state: 'not-found' });
    await GET(makeEvent({ id: '5' }));
    expect(mockedRead.mock.calls[0]!.slice(1)).toEqual(['7', '5']);
  });

  // ⚠ 404, never 403. A 403 confirms the id exists in some other ecosistema.
  it('404s a document that is not published or not ours', async () => {
    mockedRead.mockResolvedValue({ state: 'not-found' });
    const res = await GET(makeEvent());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('separates a backend failure from a missing document', async () => {
    mockedRead.mockResolvedValue({ state: 'unavailable' });
    expect((await GET(makeEvent())).status).toBe(502);
  });

  it('502s rather than 404s when we could not resolve the membership', async () => {
    mockedResolve.mockResolvedValue({ ok: false, selected: null, list: [], source: 'none' });
    expect((await GET(makeEvent())).status).toBe(502);
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it('404s when the caller belongs to no ecosistema at all', async () => {
    mockedResolve.mockResolvedValue({ ok: true, selected: null, list: [], source: 'none' });
    expect((await GET(makeEvent())).status).toBe(404);
  });

  it('returns the document and the ecosistema it belongs to', async () => {
    mockedRead.mockResolvedValue({
      state: 'ok',
      doc: { id: '5', title: 'Acta', kind: 'pdf', text: 'x', contributor: 'Ana' },
    });
    const body = await (await GET(makeEvent())).json();
    expect(body.doc.title).toBe('Acta');
    expect(body.ecosystem).toEqual({ id: '7', name: 'Eco' });
  });
});
