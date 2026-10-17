import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { backendFetch } from '$lib/server/auth';
import {
  contributorIdsToResolve,
  documentText,
  isLibraryVisible,
  libraryListQuery,
  listPublished,
  readPublished,
  toLibraryItem,
  LIBRARY_LIST_FIELDS,
  LIBRARY_PAGE_SIZE,
} from './biblioteca';

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockedBackendFetch.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('libraryListQuery — the two constraints', () => {
  const base = { organizationId: '7', kind: 'todos' as const, search: '', page: 1 };

  // 🔴 THE TENANT FILTER. `Documents.visibleToCaller` returns bare `true` for a
  // platform admin, so access control cannot be the tenant filter here.
  it('always scopes to the ecosistema', () => {
    const qs = new URLSearchParams(libraryListQuery(base));
    expect(qs.get('where[organization][equals]')).toBe('7');
  });

  // 🔴 THE PUBLICATION FILTER. The backend deliberately shows a caller their own
  // drafts; on this page that generosity is the bug.
  it('always constrains to published', () => {
    const qs = new URLSearchParams(libraryListQuery(base));
    expect(qs.get('where[publicationStatus][equals]')).toBe('published');
  });

  it('keeps both constraints under every filter and every search', () => {
    for (const kind of ['todos', 'testimonio', 'audio', 'pdf'] as const) {
      for (const search of ['', 'acta', '  minuta  ']) {
        const qs = new URLSearchParams(libraryListQuery({ ...base, kind, search }));
        expect(qs.get('where[organization][equals]')).toBe('7');
        expect(qs.get('where[publicationStatus][equals]')).toBe('published');
      }
    }
  });

  it('does not constrain kind for todos', () => {
    const qs = new URLSearchParams(libraryListQuery(base));
    expect(qs.get('where[kind][in]')).toBeNull();
  });

  it('constrains kind when one is chosen', () => {
    const qs = new URLSearchParams(libraryListQuery({ ...base, kind: 'testimonio' }));
    expect(qs.get('where[kind][in]')).toBe('testimonio');
  });

  it('searches on the title only, trimmed', () => {
    const qs = new URLSearchParams(libraryListQuery({ ...base, search: '  acta  ' }));
    expect(qs.get('where[name][like]')).toBe('acta');
  });

  it('omits the search constraint when there is no term', () => {
    expect(new URLSearchParams(libraryListQuery(base)).get('where[name][like]')).toBeNull();
  });

  it('pages, newest first', () => {
    const qs = new URLSearchParams(libraryListQuery({ ...base, page: 3 }));
    expect(qs.get('page')).toBe('3');
    expect(qs.get('limit')).toBe(String(LIBRARY_PAGE_SIZE));
    expect(qs.get('sort')).toBe('-createdAt');
  });

  it.each([0, -4, Number.NaN])('never asks for page %p', (page) => {
    expect(new URLSearchParams(libraryListQuery({ ...base, page })).get('page')).toBe('1');
  });

  // ⚠ The list never shows a word of the text; carrying it would be megabytes
  // of JSON to render a list of titles.
  it('does not select extractedText for the list', () => {
    const qs = libraryListQuery(base);
    expect(qs).not.toContain('extractedText');
    for (const field of LIBRARY_LIST_FIELDS) {
      expect(qs).toContain(`select%5B${field}%5D=true`);
    }
  });
});

describe('libraryListQuery — the lengua filter', () => {
  const base = { organizationId: '7', kind: 'todos' as const, search: '', page: 1 };

  // `where[lengua]` is refused by the backend for non-override callers (field
  // read access needs the row), so the filter arrives as the documento ids
  // `/api/lenguas` named for that language.
  it('constrains to the given document ids, keeping both constraints', () => {
    const qs = new URLSearchParams(libraryListQuery({ ...base, documentIds: ['3', '9'] }));
    expect(qs.get('where[id][in]')).toBe('3,9');
    expect(qs.get('where[organization][equals]')).toBe('7');
    expect(qs.get('where[publicationStatus][equals]')).toBe('published');
    expect(qs.get('where[lengua][equals]')).toBeNull();
  });

  it('does not constrain ids without a lengua filter', () => {
    expect(new URLSearchParams(libraryListQuery(base)).get('where[id][in]')).toBeNull();
  });

  // 🔴 Documents.ts `lenguaReadable`: a projection without `contentKind`
  // hides `lengua` on every row, silently.
  it('selects contentKind beside lengua', () => {
    expect(LIBRARY_LIST_FIELDS).toContain('lengua');
    expect(LIBRARY_LIST_FIELDS).toContain('contentKind');
  });
});

describe('isLibraryVisible — the re-check a read-by-id needs', () => {
  const row = { publicationStatus: 'published', organization: '7' };

  it('accepts a published row from this ecosistema', () => {
    expect(isLibraryVisible(row, '7')).toBe(true);
  });

  it('accepts an organization sent as a number or an object', () => {
    expect(isLibraryVisible({ ...row, organization: 7 }, '7')).toBe(true);
    expect(isLibraryVisible({ ...row, organization: { id: 7 } }, '7')).toBe(true);
  });

  // 🔴 The reader's OWN draft is rejected too. `visibleToCaller` would hand it
  // over happily; a draft on a shared-library page reads as shared.
  it.each(['draft', 'publishing', 'unpublishing', undefined, null, 'PUBLISHED'])(
    'rejects publicationStatus %p',
    (status) => {
      expect(isLibraryVisible({ ...row, publicationStatus: status }, '7')).toBe(false);
    },
  );

  // 🔴 The cross-tenant case. A platform admin's read-by-id returns any row.
  it('rejects a row from another ecosistema', () => {
    expect(isLibraryVisible({ ...row, organization: '8' }, '7')).toBe(false);
  });

  it.each([null, undefined])('rejects %p', (raw) => {
    expect(isLibraryVisible(raw, '7')).toBe(false);
  });
});

describe('toLibraryItem', () => {
  it('maps a document and keeps its contributor', () => {
    const item = toLibraryItem(
      { id: 3, name: 'Acta', kind: 'pdf', createdAt: '2026-08-01T00:00:00.000Z' },
      'Ana',
    );
    expect(item).toMatchObject({ id: '3', title: 'Acta', kind: 'pdf', contributor: 'Ana' });
    expect(item.createdAt).toBe(Date.parse('2026-08-01T00:00:00.000Z'));
  });

  // 🔴 THE ANONYMITY RULE, ENFORCED IN THE MAPPER. Even handed a name, a
  // testimonio must not carry one out of the server.
  it('drops the contributor of a testimonio even when one is supplied', () => {
    const item = toLibraryItem({ id: 4, name: 'Voz', kind: 'testimonio' }, 'Ana');
    expect(item.contributor).toBeNull();
    expect(JSON.stringify(item)).not.toContain('Ana');
  });

  it('carries the lengua of a documento', () => {
    expect(toLibraryItem({ id: 1, contentKind: 'documento', lengua: 'mixe' }, null).lengua).toBe('mixe');
    expect(toLibraryItem({ id: 1, contentKind: 'documento' }, null).lengua).toBeNull();
  });

  // 🔴 The backend already hides it; the mapper does not rely on that.
  it('never carries a lengua on anything but a documento', () => {
    for (const contentKind of ['testimonio', 'conversacion', undefined, null]) {
      const item = toLibraryItem({ id: 1, kind: 'audio', contentKind, lengua: 'tsotsil' }, null);
      expect(item.lengua).toBeNull();
      expect(JSON.stringify(item)).not.toContain('tsotsil');
    }
  });

  it('falls back to a title rather than showing an empty one', () => {
    expect(toLibraryItem({ id: 1 }, null).title).toBe('Documento sin título');
  });

  it('keeps audioMeta only for audio, and only when it is an object', () => {
    expect(toLibraryItem({ id: 1, kind: 'audio', audioMeta: { durationSeconds: 60 } }, null).audioMeta)
      .toEqual({ durationSeconds: 60 });
    expect(toLibraryItem({ id: 1, kind: 'audio', audioMeta: 'x' }, null).audioMeta).toBeNull();
    expect(toLibraryItem({ id: 1, kind: 'pdf', audioMeta: { a: 1 } }, null).audioMeta).toBeNull();
  });

  it('degrades an unknown kind to otro rather than hiding the row', () => {
    expect(toLibraryItem({ id: 1, kind: 'holograma' }, null).kind).toBe('otro');
  });
});

describe('contributorIdsToResolve', () => {
  // 🔴 A testimonio's uploader is not even ASKED about. The investigador who
  // filed it is not the person whose voice it is.
  it('never includes a testimonio uploader', () => {
    const ids = contributorIdsToResolve([
      { kind: 'pdf', uploadedBy: '1' },
      { kind: 'testimonio', uploadedBy: '2' },
      { kind: 'audio', uploadedBy: 3 },
    ]);
    expect(ids).toEqual(['1', '3']);
  });

  it('de-duplicates and tolerates a missing uploader', () => {
    expect(contributorIdsToResolve([{ kind: 'pdf', uploadedBy: '1' }, { kind: 'pdf', uploadedBy: '1' }, { kind: 'pdf' }])).toEqual(['1']);
  });
});

describe('documentText', () => {
  it('prefers the extraction / transcript', () => {
    expect(documentText({ extractedText: 'transcrito', bodyMarkdown: '# nota' })).toBe('transcrito');
  });

  it('falls back to the markdown body for a note', () => {
    expect(documentText({ extractedText: '   ', bodyMarkdown: '# nota' })).toBe('# nota');
  });

  it('is empty when there is nothing', () => {
    expect(documentText({})).toBe('');
  });
});

describe('listPublished', () => {
  it('reports ok:false on a backend failure rather than an empty library', async () => {
    mockedBackendFetch.mockResolvedValue(jsonResponse({}, 403));
    const out = await listPublished('tok', {
      organizationId: '7',
      kind: 'todos',
      search: '',
      page: 1,
    });
    expect(out.ok).toBe(false);
    expect(out.items).toEqual([]);
  });

  it('resolves contributor names for documents and never for voces', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) => {
      if (path.startsWith('/api/documents')) {
        return jsonResponse({
          totalDocs: 2,
          hasNextPage: false,
          docs: [
            { id: 1, name: 'Acta', kind: 'pdf', uploadedBy: '10' },
            { id: 2, name: 'Voz', kind: 'testimonio', uploadedBy: '11' },
          ],
        });
      }
      // ⚠ The users read must never be asked about the testimonio's uploader.
      expect(path).toContain('where%5Bid%5D%5Bin%5D=10');
      expect(path).not.toContain('11');
      return jsonResponse({ docs: [{ id: 10, displayName: 'Ana' }] });
    });

    const out = await listPublished('tok', {
      organizationId: '7',
      kind: 'todos',
      search: '',
      page: 1,
    });
    expect(out.ok).toBe(true);
    expect(out.items[0]!.contributor).toBe('Ana');
    expect(out.items[1]!.contributor).toBeNull();
  });

  it('degrades to no contributor names when the users read fails', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
      path.startsWith('/api/documents')
        ? jsonResponse({ totalDocs: 1, docs: [{ id: 1, name: 'Acta', kind: 'pdf', uploadedBy: '10' }] })
        : jsonResponse({}, 500),
    );
    const out = await listPublished('tok', {
      organizationId: '7',
      kind: 'todos',
      search: '',
      page: 1,
    });
    expect(out.ok).toBe(true);
    expect(out.items[0]!.contributor).toBeNull();
  });
});

describe('readPublished', () => {
  it('returns the document with its text', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
      path.startsWith('/api/documents')
        ? jsonResponse({
            id: 5,
            name: 'Acta',
            kind: 'pdf',
            organization: '7',
            publicationStatus: 'published',
            extractedText: 'contenido',
            uploadedBy: '10',
          })
        : jsonResponse({ docs: [{ id: 10, displayName: 'Ana' }] }),
    );
    const out = await readPublished('tok', '7', '5');
    expect(out.state).toBe('ok');
    if (out.state === 'ok') {
      expect(out.doc.text).toBe('contenido');
      expect(out.doc.contributor).toBe('Ana');
    }
  });

  // 🔴 The reader's own draft. The backend hands it over; this must not.
  it('reports not-found for a draft', async () => {
    mockedBackendFetch.mockResolvedValue(
      jsonResponse({ id: 5, organization: '7', publicationStatus: 'draft' }),
    );
    expect((await readPublished('tok', '7', '5')).state).toBe('not-found');
  });

  // 🔴 The cross-tenant case.
  it('reports not-found for another ecosistema’s published document', async () => {
    mockedBackendFetch.mockResolvedValue(
      jsonResponse({ id: 5, organization: '8', publicationStatus: 'published' }),
    );
    expect((await readPublished('tok', '7', '5')).state).toBe('not-found');
  });

  it.each([403, 404])('reports not-found on a %s, never a 403 of its own', async (status) => {
    mockedBackendFetch.mockResolvedValue(jsonResponse({}, status));
    expect((await readPublished('tok', '7', '5')).state).toBe('not-found');
  });

  it('separates a backend failure from a missing document', async () => {
    mockedBackendFetch.mockResolvedValue(jsonResponse({}, 500));
    expect((await readPublished('tok', '7', '5')).state).toBe('unavailable');
  });

  it('never sends a name for a published testimonio', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
      path.startsWith('/api/documents')
        ? jsonResponse({
            id: 5,
            name: 'Voz',
            kind: 'testimonio',
            organization: '7',
            publicationStatus: 'published',
            extractedText: 'lo que dijo',
            uploadedBy: '10',
          })
        : jsonResponse({ docs: [{ id: 10, displayName: 'Ana' }] }),
    );
    const out = await readPublished('tok', '7', '5');
    expect(out.state).toBe('ok');
    if (out.state === 'ok') {
      expect(out.doc.contributor).toBeNull();
      expect(JSON.stringify(out.doc)).not.toContain('Ana');
    }
  });

  it('URL-encodes the id into the upstream path', async () => {
    mockedBackendFetch.mockResolvedValue(jsonResponse({}, 404));
    await readPublished('tok', '7', 'a b/../9');
    expect(mockedBackendFetch.mock.calls[0]![1] as string).toContain('/api/documents/a%20b%2F..%2F9?');
  });
});
