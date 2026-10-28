import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/ecosystem', () => ({ resolveEcosystem: vi.fn() }));
vi.mock('$lib/server/admin', () => ({ readEcosystem: vi.fn(), listAllEcosystems: vi.fn() }));
vi.mock('$lib/server/lenguas', () => ({ fetchLenguaIndex: vi.fn() }));
vi.mock('$lib/server/features', async () => {
  const { resolveFeatures } = await import('$lib/features');
  return { fetchFeatures: vi.fn(async () => resolveFeatures(null)) };
});
vi.mock('$lib/server/graph', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/graph')>('$lib/server/graph');
  return { ...actual, fetchGraphView: vi.fn(), fetchGraphEntity: vi.fn() };
});

import { load } from './+page.server';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { listAllEcosystems, readEcosystem } from '$lib/server/admin';
import { fetchLenguaIndex } from '$lib/server/lenguas';
import { fetchGraphView } from '$lib/server/graph';
import { GRAPH_COMBINED_ORGANIZATION } from '$lib/graph';
import { fetchFeatures } from '$lib/server/features';
import { resolveFeatures } from '$lib/features';

const mockedResolve = resolveEcosystem as unknown as ReturnType<typeof vi.fn>;
const mockedDirectory = listAllEcosystems as unknown as ReturnType<typeof vi.fn>;
const mockedRead = readEcosystem as unknown as ReturnType<typeof vi.fn>;
const mockedLengua = fetchLenguaIndex as unknown as ReturnType<typeof vi.fn>;
const mockedView = fetchGraphView as unknown as ReturnType<typeof vi.fn>;

const A = { id: '1', name: 'Alfa', slug: 'alfa' };
const B = { id: '2', name: 'Beta', slug: 'beta' };
const C = { id: '3', name: 'Gamma', slug: 'gamma' };

type Data = {
  state: string;
  combined: boolean;
  ecosystem: { id: string } | null;
  scope: { combined: boolean; notFound: boolean; admin: boolean } | null;
};

async function run(url: string, opts: { admin?: boolean; list?: (typeof A)[] } = {}): Promise<Data> {
  const list = opts.list ?? [A, B];
  mockedResolve.mockResolvedValue({ list, ok: true, selected: list[0] ?? null, source: 'requested' });
  const event = {
    locals: { user: { id: 9, ...(opts.admin ? { isPlatformAdmin: true } : {}) }, token: 'tok' },
    cookies: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    url: new URL(url, 'http://web.test'),
  } as unknown as Parameters<typeof load>[0];
  return (await load(event)) as unknown as Data;
}

/** The `organizationId` the loader asked the backend's view for. */
function viewedOrganization(): unknown {
  return (mockedView.mock.calls.at(-1)?.[1] as { organizationId?: unknown } | undefined)?.organizationId;
}

const mockedFeatures = fetchFeatures as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedFeatures.mockResolvedValue(resolveFeatures(null));
  mockedDirectory.mockResolvedValue({ rows: [C], totalDocs: 1, truncated: false, ok: true, search: '' });
  mockedRead.mockResolvedValue(null);
  mockedLengua.mockResolvedValue({ index: { lenguas: [], byDocument: {} } });
  mockedView.mockResolvedValue({
    view: { entities: [], hidden: 0, minSupport: 1, publishedDocuments: 0 },
    ok: true,
  });
});

describe('/grafo load — member pick and the combined graph', () => {
  it('a member of 2+ ecosistemas may pick one of their own with ?eco=', async () => {
    const data = await run('/grafo?eco=2');
    expect(data.ecosystem?.id).toBe('2');
    expect(viewedOrganization()).toBe('2');
    expect(data.combined).toBe(false);
    expect(data.scope).toMatchObject({ admin: false, combined: true, notFound: false });
  });

  it('🔴 a member naming an ecosistema they do not belong to gets their own, flagged not found', async () => {
    const data = await run('/grafo?eco=3');
    expect(data.ecosystem?.id).toBe('1');
    expect(viewedOrganization()).toBe('1');
    expect(data.scope?.notFound).toBe(true);
  });

  it('?eco=todos opens the combined graph for a member of 2+', async () => {
    const data = await run('/grafo?eco=todos');
    expect(data.combined).toBe(true);
    expect(data.ecosystem?.id).toBe('todos');
    expect(viewedOrganization()).toBe(GRAPH_COMBINED_ORGANIZATION);
    // One lengua read per membership, never a client-named list.
    expect(mockedLengua.mock.calls.map((c) => c[1])).toEqual(['1', '2']);
  });

  it('🔴 a member of ONE ecosistema is not offered the combined graph, even by URL', async () => {
    const data = await run('/grafo?eco=todos', { list: [A] });
    expect(data.combined).toBe(false);
    expect(data.scope).toBeNull();
    expect(viewedOrganization()).toBe('1');
  });

  it('a platform admin may open the combined graph without memberships', async () => {
    const data = await run('/grafo?eco=todos', { admin: true, list: [] });
    expect(data.combined).toBe(true);
    expect(viewedOrganization()).toBe(GRAPH_COMBINED_ORGANIZATION);
    expect(data.scope).toMatchObject({ admin: true, combined: true });
    // Admin: lengua reads follow the directory, not memberships.
    expect(mockedLengua.mock.calls.map((c) => c[1])).toEqual(['3']);
  });

  it('a platform admin`s ?eco= is read from the directory, not membership', async () => {
    mockedRead.mockResolvedValue(C);
    const data = await run('/grafo?eco=3', { admin: true });
    expect(mockedRead).toHaveBeenCalledWith('tok', '3');
    expect(data.ecosystem?.id).toBe('3');
    expect(viewedOrganization()).toBe('3');
    expect(data.combined).toBe(false);
  });
});

describe('/grafo load — the ecosistema switches (`$lib/features`)', () => {
  it('graph off: the page says so and never asks for the graph', async () => {
    mockedFeatures.mockResolvedValue(resolveFeatures({ graph: false }));
    const data = (await run('/grafo')) as Data & { graphOff?: boolean };
    expect(data.graphOff).toBe(true);
    expect(mockedView).not.toHaveBeenCalled();
    expect(mockedFeatures.mock.calls[0]?.[1]).toBe('1');
  });

  it('graph3d off: 2D only', async () => {
    mockedFeatures.mockResolvedValue(resolveFeatures({ graph3d: false }));
    const data = (await run('/grafo')) as Data & { allow3d?: boolean };
    expect(data.allow3d).toBe(false);
  });

  it('defaults: graph and 3D on', async () => {
    const data = (await run('/grafo')) as Data & { allow3d?: boolean; graphOff?: boolean };
    expect(data.allow3d).toBe(true);
    expect(data.graphOff).toBeUndefined();
  });

  // ── `?eco=<orgId>` as a LINK (a chat answer links to an ecosistema's graph).
  // The person following it may belong to just one ecosistema, or none of the
  // linked one. It opens when they may see it and falls back otherwise, and the
  // fallback never says anything about the ecosistema the link named.

  it('a member of ONE ecosistema following a link to it opens it', async () => {
    const data = await run('/grafo?eco=1', { list: [A] });
    expect(data.ecosystem?.id).toBe('1');
    expect(viewedOrganization()).toBe('1');
  });

  it('🔴 a link to a foreign ecosistema falls back to the current one and leaks nothing', async () => {
    const data = (await run('/grafo?eco=3', { list: [A] })) as Data & {
      ecosystemNames: Record<string, string>;
    };
    expect(data.ecosystem?.id).toBe('1');
    expect(viewedOrganization()).toBe('1');
    expect(mockedView.mock.calls.every((c) => (c[1] as { organizationId: unknown }).organizationId === '1')).toBe(true);
    // Not even its name: a member never triggers the direct read or the directory.
    expect(mockedRead).not.toHaveBeenCalled();
    expect(mockedDirectory).not.toHaveBeenCalled();
    expect(Object.keys(data.ecosystemNames)).toEqual(['1']);
  });

  it('🔴 following a link never re-points the ecosistema cookie', async () => {
    const set = vi.fn();
    mockedResolve.mockResolvedValue({ list: [A, B], ok: true, selected: A, source: 'requested' });
    const event = {
      locals: { user: { id: 9 }, token: 'tok' },
      cookies: { get: vi.fn(), set, delete: vi.fn() },
      url: new URL('/grafo?eco=2', 'http://web.test'),
    } as unknown as Parameters<typeof load>[0];
    const data = (await load(event)) as unknown as Data;
    expect(data.ecosystem?.id).toBe('2');
    expect(set).not.toHaveBeenCalled();
  });

  it('a platform admin`s link to an id that does not exist falls back, flagged not found', async () => {
    mockedRead.mockResolvedValue(null);
    const data = await run('/grafo?eco=99', { admin: true });
    expect(data.ecosystem?.id).toBe('1');
    expect(viewedOrganization()).toBe('1');
    expect(data.scope?.notFound).toBe(true);
  });
});

