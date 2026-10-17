import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/ecosystem', () => ({ resolveEcosystem: vi.fn() }));
vi.mock('$lib/server/lenguas', () => ({ fetchLenguaIndex: vi.fn() }));

import { GET } from './+server';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { fetchLenguaIndex } from '$lib/server/lenguas';

const mockedResolve = resolveEcosystem as unknown as ReturnType<typeof vi.fn>;
const mockedIndex = fetchLenguaIndex as unknown as ReturnType<typeof vi.fn>;

function makeEvent(user: { id: number } | null = { id: 1 }, url = 'http://web.test/api/lenguas') {
  return {
    locals: { user, token: 'tok' },
    cookies: { get: () => undefined, set: () => {}, delete: () => {} },
    url: new URL(url),
  } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  mockedResolve.mockReset();
  mockedIndex.mockReset();
  mockedResolve.mockResolvedValue({ ok: true, selected: { id: '7', name: 'Eco' }, list: [], source: 'cookie' });
  mockedIndex.mockResolvedValue({
    ok: true,
    index: { lenguas: [{ lengua: 'mixe', documentos: 2 }], byDocument: { '3': 'mixe' } },
  });
});

describe('GET /api/lenguas', () => {
  it('401s without a session', async () => {
    expect((await GET(makeEvent(null))).status).toBe(401);
    expect(mockedIndex).not.toHaveBeenCalled();
  });

  // 🔴 The browser names no ecosistema; it is derived and re-validated.
  it('reads the RESOLVED ecosistema, never one named in the URL', async () => {
    await GET(makeEvent({ id: 1 }, 'http://web.test/api/lenguas?organization=999'));
    expect(mockedIndex).toHaveBeenCalledWith('tok', '7');
  });

  it('returns the facets only — the per-document map stays on the server', async () => {
    const body = await (await GET(makeEvent())).json();
    expect(body).toEqual({ ok: true, lenguas: [{ lengua: 'mixe', documentos: 2 }] });
  });

  it('answers an empty, not-ok list when there is no ecosistema or the read failed', async () => {
    mockedResolve.mockResolvedValue({ ok: true, selected: null, list: [], source: 'none' });
    expect(await (await GET(makeEvent())).json()).toEqual({ ok: true, lenguas: [] });
    mockedResolve.mockResolvedValue({ ok: true, selected: { id: '7', name: 'Eco' }, list: [], source: 'cookie' });
    mockedIndex.mockResolvedValue({ ok: false, index: { lenguas: [], byDocument: {} } });
    expect(await (await GET(makeEvent())).json()).toEqual({ ok: false, lenguas: [] });
  });
});
