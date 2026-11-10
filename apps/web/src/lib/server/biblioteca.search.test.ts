import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { backendFetch } from '$lib/server/auth';
import { listPublished, resolveSearchIds, titleMatches } from './biblioteca';

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** One ecosistema's cleared, published rows, as the backend holds them. */
const ROWS = [
  { id: 1, contentKind: 'documento', kind: 'pdf', name: 'Vecinos y criaderos.pdf' },
  { id: 2, contentKind: 'testimonio', kind: 'audio', anonymisationStatus: 'ready', redactedText: 'texto',
    name: 'grabacion-0412.m4a', testimonioTitle: 'Vecinos limpian juntos sus calles y patios' },
  { id: 3, contentKind: 'testimonio', kind: 'audio', anonymisationStatus: 'ready', redactedText: 'texto',
    name: 'Vecinos-calle-5.m4a', testimonioTitle: 'Una vecina cuida a su vecina' },
  { id: 4, contentKind: 'documento', kind: 'pdf', name: 'Acta de la asamblea.pdf' },
];

/**
 * The backend as a member meets it: a `where` on `name` only matches
 * documentos (`constrainGatedQueries`), `testimonioTitle` cannot be queried
 * (400), and `like` is word-wise and case-insensitive.
 */
function fakeBackend(path: string): Response {
  const qs = new URLSearchParams(path.split('?')[1] ?? '');
  if ([...qs.keys()].some((k) => k.includes('[testimonioTitle]') && k.startsWith('where'))) {
    return jsonResponse({ errors: [{ message: 'The following path cannot be queried: testimonioTitle' }] }, 400);
  }
  let rows = ROWS.slice();
  const term = qs.get('where[name][like]') ?? qs.get('where[and][0][name][like]');
  if (term) rows = rows.filter((r) => r.contentKind === 'documento' && like(r.name, term));
  // The P-13 filter (`anonymise` false) the BFF adds to a name search.
  if (qs.get('where[and][1][or][1][anonymise][equals]') === 'false') {
    rows = rows.filter((r) => r.contentKind !== 'documento' || (r as { anonymise?: unknown }).anonymise === false || !('anonymise' in r));
  }
  const kind = qs.get('where[contentKind][equals]');
  if (kind) rows = rows.filter((r) => r.contentKind === kind);
  const ids = qs.get('where[id][in]');
  if (ids) rows = rows.filter((r) => ids.split(',').includes(String(r.id)));
  return jsonResponse({ docs: rows, totalDocs: rows.length, hasNextPage: false });
}

/** Payload's own `like`, kept apart from the code under test. */
function like(value: string, term: string): boolean {
  return term.toLowerCase().split(' ').filter(Boolean).every((w) => value.toLowerCase().includes(w));
}

const base = { organizationId: '7', kind: 'todos' as const, search: '', page: 1 };

function documentQueries(): URLSearchParams[] {
  return mockedBackendFetch.mock.calls
    .map((c) => c[1] as string)
    .filter((p) => p.startsWith('/api/documents'))
    .map((p) => new URLSearchParams(p.split('?')[1] ?? ''));
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockedBackendFetch.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
    path.startsWith('/api/documents') ? fakeBackend(path) : jsonResponse({ docs: [] }),
  );
});

describe('titleMatches — the backend `like`, for a title the BFF reads', () => {
  it.each([
    ['Vecinos limpian juntos', 'vecinos', true],
    ['Vecinos limpian juntos', 'LIMPIAN vecinos', true],
    ['Vecinos limpian juntos', 'vecinos barren', false],
    [null, 'vecinos', false],
    ['Vecinos', '', false],
  ])('%p ~ %p → %p', (title, search, expected) => {
    expect(titleMatches(title, search)).toBe(expected);
  });
});

describe('listPublished — search finds a testimonio by the title its card shows', () => {
  it('returns the Voz whose generated title matches, beside the documento whose name does', async () => {
    // 🔴 Dev, 2026-11-10: a word of a testimonio's own title found nothing.
    const out = await listPublished('tok', { ...base, search: 'vecinos' });

    expect(out.ok).toBe(true);
    expect(out.items.map((i) => i.id).sort()).toEqual(['1', '2']);
    expect(out.total).toBe(2);
  });

  it('never matches a testimonio by its hidden filename', async () => {
    const out = await listPublished('tok', { ...base, search: 'calle-5' });
    expect(out.items).toEqual([]);
  });

  it('pages the ids with the three constraints and no `name` clause', async () => {
    await listPublished('tok', { ...base, search: 'vecinos', page: 2 });
    const main = documentQueries().at(-1)!;

    expect(main.get('where[name][like]')).toBeNull();
    expect(main.get('where[id][in]')?.split(',').sort()).toEqual(['1', '2']);
    expect(main.get('where[organization][equals]')).toBe('7');
    expect(main.get('where[publicationStatus][equals]')).toBe('published');
    expect(main.get('where[or][2][and][0][anonymisationStatus][in]')).toBe('ready,approved');
    expect(main.get('page')).toBe('2');
  });

  it('ANDs the search with a lengua filter', async () => {
    const out = await listPublished('tok', { ...base, search: 'vecinos', documentIds: ['2', '4'] });
    expect(out.items.map((i) => i.id)).toEqual(['2']);
  });

  it('answers an empty page, and sends no empty `in`, when nothing matches', async () => {
    const out = await listPublished('tok', { ...base, search: 'mosquitero' });

    expect(out).toMatchObject({ ok: true, items: [], total: 0, hasNextPage: false });
    for (const q of documentQueries()) expect(q.get('where[id][in]')).not.toBe('');
  });

  // 🔴 P-13 (merge of main into the ola 4 branch, 2026-11-10): the id read by
  // name carries the same filter as the list, so a gated documento's raw name
  // never answers a search.
  it('🔴 the id read by name skips a documento whose title is gated', async () => {
    await resolveSearchIds('tok', '7', 'vecinos');
    const byName = documentQueries().find((q) => q.get('where[and][0][name][like]') === 'vecinos');
    expect(byName?.get('where[and][1][or][0][contentKind][not_equals]')).toBe('documento');
    expect(byName?.get('where[and][1][or][1][anonymise][equals]')).toBe('false');
    expect(byName?.get('where[name][like]')).toBeNull();
  });

  it('falls back to the title-only search when an id read fails', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) => {
      const qs = new URLSearchParams(path.split('?')[1] ?? '');
      if (qs.get('where[contentKind][equals]') === 'testimonio') return jsonResponse({}, 500);
      return fakeBackend(path);
    });

    const out = await listPublished('tok', { ...base, search: 'vecinos' });

    expect(out.ok).toBe(true);
    expect(out.items.map((i) => i.id)).toEqual(['1']);
    expect(documentQueries().at(-1)!.get('where[and][0][name][like]')).toBe('vecinos');
  });
});

describe('resolveSearchIds — the two reads', () => {
  it('reads testimonio titles only from cleared, published rows of this ecosistema', async () => {
    await resolveSearchIds('tok', '7', 'vecinos');
    const voces = documentQueries().find((q) => q.get('where[contentKind][equals]') === 'testimonio')!;

    expect(voces.get('where[organization][equals]')).toBe('7');
    expect(voces.get('where[publicationStatus][equals]')).toBe('published');
    expect(voces.get('where[or][2][and][0][anonymisationStatus][in]')).toBe('ready,approved');
    // 🔴 The pair `mayReadTestimonioTitle` needs on the projected row.
    expect(voces.get('select[testimonioTitle]')).toBe('true');
    expect(voces.get('select[anonymisationStatus]')).toBe('true');
    expect(voces.get('select[redactedText]')).toBeNull();
  });

  it('gives up past the ceiling rather than matching part of the ecosistema', async () => {
    mockedBackendFetch.mockImplementation(async () => jsonResponse({ docs: [{ id: 1 }], hasNextPage: true }));
    expect(await resolveSearchIds('tok', '7', 'vecinos')).toBeNull();
  });
});
