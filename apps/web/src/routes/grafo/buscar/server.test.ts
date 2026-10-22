import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted((): Record<string, string | undefined> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));
vi.mock('$lib/server/ecosystem', () => ({ resolveEcosystem: vi.fn() }));
vi.mock('$lib/server/graph', () => ({ fetchGraphView: vi.fn() }));

import { POST } from './+server';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { fetchGraphView } from '$lib/server/graph';

const mockedResolve = resolveEcosystem as unknown as ReturnType<typeof vi.fn>;
const mockedView = fetchGraphView as unknown as ReturnType<typeof vi.fn>;

function makeEvent(body: unknown, user: Record<string, unknown> | null = { id: 1 }) {
  return {
    locals: { user, token: 'tok' },
    cookies: { get: () => undefined, set: () => {}, delete: () => {} },
    request: new Request('http://web.test/grafo/buscar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof POST>[0];
}

const view = (ids: string[]) => ({
  ok: true,
  view: { entities: ids.map((id) => ({ id, type: 'tema', label: id, support: 1 })), hidden: 0 },
});

beforeEach(() => {
  delete env.GRAPH_SEARCH_ENABLED;
  mockedResolve.mockReset();
  mockedView.mockReset();
  mockedResolve.mockResolvedValue({ ok: true, selected: { id: '7', name: 'Eco' }, list: [], source: 'cookie' });
  mockedView.mockResolvedValue(view(['3', '5']));
});

describe('POST /grafo/buscar', () => {
  it('answers the ids of the matching entities', async () => {
    const res = await POST(makeEvent({ q: ' migración ' }));
    expect(await res.json()).toEqual({ ids: ['3', '5'] });
    expect(mockedView).toHaveBeenCalledWith('tok', { organizationId: '7', q: 'migración' });
  });

  it('401s without a session', async () => {
    expect((await POST(makeEvent({ q: 'x' }, null))).status).toBe(401);
    expect(mockedView).not.toHaveBeenCalled();
  });

  // 🔴 A member's `eco` is ignored: the ecosistema is the re-validated cookie's.
  it('ignores `eco` from a member', async () => {
    await POST(makeEvent({ q: 'x', eco: '999' }));
    expect(mockedView).toHaveBeenCalledWith('tok', { organizationId: '7', q: 'x' });
  });

  it('lets a platform admin name the ecosistema (backend re-authorises)', async () => {
    await POST(makeEvent({ q: 'x', eco: '12' }, { id: 1, isPlatformAdmin: true }));
    expect(mockedView).toHaveBeenCalledWith('tok', { organizationId: '12', q: 'x' });
  });

  it('answers no ids, without a backend call, for an empty query', async () => {
    expect(await (await POST(makeEvent({ q: '   ' }))).json()).toEqual({ ids: [] });
    expect(mockedView).not.toHaveBeenCalled();
  });

  it('caps the query', async () => {
    await POST(makeEvent({ q: 'a'.repeat(500) }));
    expect(mockedView.mock.calls[0]?.[1].q).toHaveLength(120);
  });

  it('502s when the backend read fails, so the map is not dimmed by an outage', async () => {
    mockedView.mockResolvedValue({ ok: false, view: { entities: [] } });
    expect((await POST(makeEvent({ q: 'x' }))).status).toBe(502);
  });

  it('404s when GRAPH_SEARCH_ENABLED is off', async () => {
    env.GRAPH_SEARCH_ENABLED = 'false';
    expect((await POST(makeEvent({ q: 'x' }))).status).toBe(404);
    expect(mockedView).not.toHaveBeenCalled();
  });
});
