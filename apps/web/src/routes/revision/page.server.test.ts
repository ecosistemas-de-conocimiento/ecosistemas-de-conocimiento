import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/ecosystem', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/ecosystem')>(
    '$lib/server/ecosystem',
  );
  return { ...actual, listEcosystems: vi.fn() };
});
vi.mock('$lib/server/admin', () => ({ readEcosystem: vi.fn(), listAllEcosystems: vi.fn() }));
vi.mock('$lib/server/holds', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/holds')>('$lib/server/holds');
  return { ...actual, readReviewCapability: vi.fn(), listHolds: vi.fn() };
});

vi.mock('$lib/server/published', () => ({ listPublished: vi.fn(), rejectPublishedDoc: vi.fn() }));

import { actions, load } from './+page.server';
import { listPublished, rejectPublishedDoc } from '$lib/server/published';
import { ECOSYSTEM_COOKIE, listEcosystems } from '$lib/server/ecosystem';
import { listAllEcosystems, readEcosystem } from '$lib/server/admin';
import { listHolds, readReviewCapability } from '$lib/server/holds';
import { ECOSYSTEM_DEPENDENCY } from '$lib/ecosystems';

const mockedList = listEcosystems as unknown as ReturnType<typeof vi.fn>;
const mockedRead = readEcosystem as unknown as ReturnType<typeof vi.fn>;
const mockedDirectory = listAllEcosystems as unknown as ReturnType<typeof vi.fn>;
const mockedHolds = listHolds as unknown as ReturnType<typeof vi.fn>;
const mockedCap = readReviewCapability as unknown as ReturnType<typeof vi.fn>;
const mockedPublished = listPublished as unknown as ReturnType<typeof vi.fn>;
const mockedReject = rejectPublishedDoc as unknown as ReturnType<typeof vi.fn>;

const A = { id: '1', name: 'Alfa', slug: 'alfa' };
const B = { id: '2', name: 'Beta', slug: 'beta' };
const C = { id: '3', name: 'Gamma', slug: 'gamma' };

type Result = { selected: { id: string } | null; notFound: boolean };

function run(opts: { cookie?: string; url?: string } = {}) {
  const jar = new Map<string, string>();
  if (opts.cookie !== undefined) jar.set(ECOSYSTEM_COOKIE, opts.cookie);
  const cookies = {
    get: (name: string) => jar.get(name),
    set: vi.fn(),
    delete: vi.fn(),
  };
  const depends = vi.fn();
  const event = {
    locals: { user: { id: 9 }, token: 'tok' },
    url: new URL(opts.url ?? 'http://web.test/revision'),
    cookies,
    depends,
  } as unknown as Parameters<typeof load>[0];
  return {
    cookies,
    depends,
    result: load(event) as Promise<Result>,
  };
}

function holdsEco(): string | undefined {
  return mockedHolds.mock.calls.at(-1)?.[1] as string | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCap.mockResolvedValue({ isPlatformAdmin: false, slugs: ['alfa', 'beta'], ok: true });
  mockedList.mockResolvedValue({ list: [A, B, C], ok: true });
  mockedRead.mockResolvedValue(null);
  mockedDirectory.mockResolvedValue({ rows: [C], totalDocs: 1, truncated: false, ok: true, search: '' });
  mockedHolds.mockImplementation(async (_t: string, eco: string) => ({
    state: 'ready',
    value: [{ id: `hold-of-${eco}` }],
  }));
  mockedPublished.mockImplementation(async (_t: string, eco: string) => ({
    state: 'ready',
    value: [{ id: `pub-of-${eco}`, title: 'La siembra', updatedAt: null }],
  }));
});

describe('/revision load — follows the sidebar picker', () => {
  it('opens on the ecosistema the picker selected, not the first reviewable one', async () => {
    const { result } = run({ cookie: B.id });
    const data = await result;
    expect(data.selected?.id).toBe(B.id);
    expect(holdsEco()).toBe(B.id);
  });

  it('switching in the picker changes the queue', async () => {
    const first = await run({ cookie: A.id }).result;
    const second = await run({ cookie: B.id }).result;
    expect(first.selected?.id).toBe(A.id);
    expect(second.selected?.id).toBe(B.id);
    expect(mockedHolds.mock.calls.map((c) => c[1])).toEqual([A.id, B.id]);
  });

  it('declares the dependency the picker invalidates', async () => {
    const { result, depends } = run({ cookie: A.id });
    await result;
    expect(depends).toHaveBeenCalledWith(ECOSYSTEM_DEPENDENCY);
  });

  it('?eco= still overrides the picker', async () => {
    mockedRead.mockResolvedValue(A);
    const data = await run({ cookie: B.id, url: 'http://web.test/revision?eco=1' }).result;
    expect(data.selected?.id).toBe(A.id);
    expect(data.notFound).toBe(false);
  });

  it('a picked ecosistema the member may not review falls back to one they may', async () => {
    const data = await run({ cookie: C.id }).result;
    expect(data.selected?.id).toBe(A.id);
    expect(holdsEco()).toBe(A.id);
  });

  it('a cookie naming a non-membership is ignored, and never rewritten here', async () => {
    const { result, cookies } = run({ cookie: '999' });
    const data = await result;
    expect(data.selected?.id).toBe(A.id);
    expect(cookies.set).not.toHaveBeenCalled();
    expect(cookies.delete).not.toHaveBeenCalled();
  });

  it('a member cannot reach a non-membership via ?eco= either', async () => {
    // readEcosystem with the caller's token returns the row, but no capability.
    mockedRead.mockResolvedValue({ id: '50', name: 'Ajeno', slug: 'ajeno' });
    const data = await run({ cookie: B.id, url: 'http://web.test/revision?eco=50' }).result;
    expect(data.selected?.id).toBe(B.id);
    expect(data.notFound).toBe(true);
  });

  it('a platform admin follows the picker too', async () => {
    mockedCap.mockResolvedValue({ isPlatformAdmin: true, slugs: [], ok: true });
    const data = await run({ cookie: C.id }).result;
    expect(data.selected?.id).toBe(C.id);
  });
});

// Owner rule 2026-10-24: participants' testimonios publish automatically, so
// review is after the fact. Revisión lists the published ones and can reject.
describe('/revision — published testimonios', () => {
  it('lists the selected ecosistema’s published testimonios', async () => {
    const data = (await run({ cookie: B.id }).result) as Result & { published: Array<{ id: string }> };
    expect(mockedPublished.mock.calls.at(-1)?.[1]).toBe(B.id);
    expect(data.published).toEqual([{ id: `pub-of-${B.id}`, title: 'La siembra', updatedAt: null }]);
  });

  it('an unreadable list is empty, not an error page', async () => {
    mockedPublished.mockResolvedValue({ state: 'unavailable' });
    const data = (await run({ cookie: B.id }).result) as Result & { published: unknown[] };
    expect(data.published).toEqual([]);
  });

  function rejectEvent(form: Record<string, string>) {
    const body = new FormData();
    for (const [k, v] of Object.entries(form)) body.set(k, v);
    return {
      locals: { user: { id: 9 }, token: 'tok' },
      request: new Request('http://web.test/revision?/rechazar', { method: 'POST', body }),
    } as unknown as Parameters<NonNullable<typeof actions.rechazar>>[0];
  }

  it('rejects one and redirects, so a refresh cannot repeat it', async () => {
    mockedReject.mockResolvedValue({ state: 'ready', value: { id: '7' } });
    await expect(actions.rechazar!(rejectEvent({ id: '7' }))).rejects.toMatchObject({
      status: 303,
      location: '/revision?hecho=rejected',
    });
    expect(mockedReject).toHaveBeenCalledWith('tok', '7', undefined);
  });

  it('a refused reject is a 404 failure, not a redirect', async () => {
    mockedReject.mockResolvedValue({ state: 'not-found' });
    const out = (await actions.rechazar!(rejectEvent({ id: '7' }))) as { status: number };
    expect(out.status).toBe(404);
  });

  it('a non-reviewer is refused before anything is sent', async () => {
    mockedCap.mockResolvedValue({ isPlatformAdmin: false, slugs: [], ok: true });
    await expect(actions.rechazar!(rejectEvent({ id: '7' }))).rejects.toBeTruthy();
    expect(mockedReject).not.toHaveBeenCalled();
  });
});
