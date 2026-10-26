import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { backendFetch } from '$lib/server/auth';
import {
  contributorIdsToResolve,
  documentText,
  isClearedForLibrary,
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

  // 🔴 A Voz is `kind: 'audio'`; the filter is on `contentKind`.
  it('filters Voces on contentKind, never on the file format', () => {
    const qs = new URLSearchParams(libraryListQuery({ ...base, kind: 'testimonio' }));
    expect(qs.get('where[contentKind][equals]')).toBe('testimonio');
    expect(qs.get('where[kind][in]')).toBeNull();
  });

  it('filters a format to documentos only, so Audios never lists a Voz', () => {
    const qs = new URLSearchParams(libraryListQuery({ ...base, kind: 'audio' }));
    expect(qs.get('where[kind][in]')).toBe('audio');
    expect(qs.get('where[contentKind][equals]')).toBe('documento');
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
      { id: 3, name: 'Acta', kind: 'pdf', contentKind: 'documento', createdAt: '2026-08-01T00:00:00.000Z' },
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

  // 🔴 THE REAL SHAPE OF A VOZ: the format is `audio`, the content kind is
  // `testimonio`. Audit 2026-10-17: keyed on `kind`, this row read as an
  // ordinary audio and carried its uploader and its filename.
  it('🔴 treats {kind:audio, contentKind:testimonio} as a testimonio', () => {
    const item = toLibraryItem(
      {
        id: 4,
        name: 'Testimonio de María López.m4a',
        kind: 'audio',
        contentKind: 'testimonio',
        audioMeta: { durationSeconds: 60, language: 'tsotsil' },
      },
      'Ana',
    );
    expect(item.kind).toBe('testimonio');
    expect(item.title).toBe('Testimonio');
    expect(item.contributor).toBeNull();
    expect(item.audioMeta).toBeNull();
    const out = JSON.stringify(item);
    for (const leak of ['María', 'López', 'Ana', 'tsotsil']) expect(out).not.toContain(leak);
    expect(item.fromAudio).toBe(true);
  });

  // Backlog #12: the reader page keys the machine-transcript warning on this.
  it('marks a PDF Voz as not from audio', () => {
    expect(toLibraryItem({ id: 4, kind: 'pdf', contentKind: 'testimonio' }, null).fromAudio).toBe(false);
  });

  it('never shows the typed name on gated content, whatever the kind', () => {
    for (const contentKind of ['testimonio', 'conversacion', 'nope', undefined]) {
      const item = toLibraryItem({ id: 1, name: 'Juana Pérez', kind: 'pdf', contentKind }, null);
      expect(item.title).not.toContain('Juana');
    }
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
    expect(
      toLibraryItem(
        { id: 1, kind: 'audio', contentKind: 'documento', audioMeta: { durationSeconds: 60 } },
        null,
      ).audioMeta,
    ).toEqual({ durationSeconds: 60 });
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
      { kind: 'pdf', contentKind: 'documento', uploadedBy: '1' },
      { kind: 'testimonio', uploadedBy: '2' },
      { kind: 'audio', contentKind: 'documento', uploadedBy: 3 },
    ]);
    expect(ids).toEqual(['1', '3']);
  });

  // 🔴 The real shape of a Voz. Keyed on `kind`, this uploader was resolved.
  it('🔴 never includes the uploader of {kind:audio, contentKind:testimonio}', () => {
    const ids = contributorIdsToResolve([
      { kind: 'audio', contentKind: 'testimonio', uploadedBy: '2' },
      { kind: 'audio', contentKind: 'documento', uploadedBy: '3' },
    ]);
    expect(ids).toEqual(['3']);
  });

  it('fails closed on a row with no contentKind', () => {
    expect(contributorIdsToResolve([{ kind: 'pdf', uploadedBy: '1' }])).toEqual([]);
  });

  it('de-duplicates and tolerates a missing uploader', () => {
    const doc = { kind: 'pdf', contentKind: 'documento' };
    expect(
      contributorIdsToResolve([{ ...doc, uploadedBy: '1' }, { ...doc, uploadedBy: '1' }, doc]),
    ).toEqual(['1']);
  });
});

describe('documentText', () => {
  it('prefers the extraction / transcript', () => {
    expect(
      documentText({ contentKind: 'documento', extractedText: 'transcrito', bodyMarkdown: '# nota' }),
    ).toBe('transcrito');
  });

  it('falls back to the markdown body for a note', () => {
    expect(
      documentText({ contentKind: 'documento', extractedText: '   ', bodyMarkdown: '# nota' }),
    ).toBe('# nota');
  });

  // 🔴 Audit 2026-10-17: the reader showed a testimonio's unredacted original.
  it('🔴 reads ONLY redactedText on a testimonio, even when the original is present', () => {
    const row = {
      contentKind: 'testimonio',
      extractedText: 'Me llamo María López',
      bodyMarkdown: 'María López',
      redactedText: 'Me llamo [Persona A]',
    };
    expect(documentText(row)).toBe('Me llamo [Persona A]');
    expect(documentText({ ...row, redactedText: null })).toBe('');
  });

  // 🔴 Audit 2026-10-26: a published gated documento showed an empty body (the
  // backend hides `extractedText` from colleagues) and never read `redactedText`.
  it('🔴 reads ONLY redactedText on a documento filed for anonymisation', () => {
    const row = {
      contentKind: 'documento',
      anonymise: true,
      extractedText: 'Informe de Juan Pérez',
      bodyMarkdown: 'Juan Pérez',
      redactedText: 'Informe de [Persona A]',
    };
    expect(documentText(row)).toBe('Informe de [Persona A]');
    expect(documentText({ ...row, redactedText: null })).toBe('');
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
            { id: 1, name: 'Acta', kind: 'pdf', contentKind: 'documento', uploadedBy: '10' },
            { id: 2, name: 'Voz', kind: 'audio', contentKind: 'testimonio', anonymisationStatus: 'ready', uploadedBy: '11' },
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
        ? jsonResponse({ totalDocs: 1, docs: [{ id: 1, name: 'Acta', kind: 'pdf', contentKind: 'documento', uploadedBy: '10' }] })
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
            contentKind: 'documento',
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
            name: 'Testimonio de María López.m4a',
            kind: 'audio',
            contentKind: 'testimonio',
            organization: '7',
            publicationStatus: 'published',
            extractedText: 'lo que dijo María López',
            redactedText: 'lo que dijo [Persona A]',
            anonymisationStatus: 'ready',
            uploadedBy: '10',
          })
        : jsonResponse({ docs: [{ id: 10, displayName: 'Ana' }] }),
    );
    const out = await readPublished('tok', '7', '5');
    expect(out.state).toBe('ok');
    if (out.state === 'ok') {
      expect(out.doc.contributor).toBeNull();
      expect(out.doc.title).toBe('Testimonio');
      expect(out.doc.text).toBe('lo que dijo [Persona A]');
      const json = JSON.stringify(out.doc);
      for (const leak of ['Ana', 'María', 'López']) expect(json).not.toContain(leak);
    }
  });

  // 🔴 Audit 2026-10-26: the reader showed an empty body for a published gated documento.
  it('shows the redaction of a published gated documento, never the original', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
      path.startsWith('/api/documents')
        ? jsonResponse({
            id: 6,
            name: 'Informe de campo',
            kind: 'pdf',
            contentKind: 'documento',
            anonymise: true,
            organization: '7',
            publicationStatus: 'published',
            extractedText: 'Informe de Juan Pérez',
            redactedText: 'Informe de [Persona A]',
            anonymisationStatus: 'ready',
            uploadedBy: '10',
          })
        : jsonResponse({ docs: [{ id: 10, displayName: 'Ana' }] }),
    );
    const out = await readPublished('tok', '7', '6');
    expect(out.state).toBe('ok');
    if (out.state === 'ok') {
      expect(out.doc.text).toBe('Informe de [Persona A]');
      expect(JSON.stringify(out.doc)).not.toContain('Juan');
    }
  });

  it('reads a held gated documento as not-found', async () => {
    mockedBackendFetch.mockResolvedValue(
      jsonResponse({
        id: 6,
        contentKind: 'documento',
        anonymise: true,
        organization: '7',
        publicationStatus: 'published',
        anonymisationStatus: 'held',
      }),
    );
    expect((await readPublished('tok', '7', '6')).state).toBe('not-found');
  });

  it('asks the backend for redactedText', async () => {
    mockedBackendFetch.mockResolvedValue(jsonResponse({}, 404));
    await readPublished('tok', '7', '5');
    expect(String(mockedBackendFetch.mock.calls[0]![1])).toContain('select%5BredactedText%5D=true');
  });

  it('URL-encodes the id into the upstream path', async () => {
    mockedBackendFetch.mockResolvedValue(jsonResponse({}, 404));
    await readPublished('tok', '7', 'a b/../9');
    expect(mockedBackendFetch.mock.calls[0]![1] as string).toContain('/api/documents/a%20b%2F..%2F9?');
  });
});

// 🔴 Measured on dev, 2026-10-21: 13 HELD testimonios were `published` and the
// library showed them as empty "Testimonio" cards.
describe('🔴 the library never shows uncleared or empty gated content', () => {
  const base = { organizationId: '7', kind: 'todos' as const, search: '', page: 1 };

  it('the list query asks for documentos, or gated rows that are cleared and redacted', () => {
    for (const kind of ['todos', 'testimonio', 'audio'] as const) {
      const qs = new URLSearchParams(libraryListQuery({ ...base, kind }));
      // A documento NOT filed for anonymisation (false, or a legacy null)…
      expect(qs.get('where[or][0][and][0][contentKind][equals]')).toBe('documento');
      expect(qs.get('where[or][0][and][1][anonymise][equals]')).toBe('false');
      expect(qs.get('where[or][1][and][0][contentKind][equals]')).toBe('documento');
      expect(qs.get('where[or][1][and][1][anonymise][exists]')).toBe('false');
      // …or any gated row (testimonio, conversación, gated documento) the gate cleared.
      expect(qs.get('where[or][2][and][0][anonymisationStatus][in]')).toBe('ready,approved');
      expect(qs.get('where[or][2][and][1][redactedText][exists]')).toBe('true');
      expect(qs.get('where[or][0][contentKind][equals]')).toBeNull();
    }
  });

  it('selects anonymisationStatus so the list can re-check each row', () => {
    expect(LIBRARY_LIST_FIELDS).toContain('anonymisationStatus');
  });

  it.each([
    ['a held testimonio', { contentKind: 'testimonio', anonymisationStatus: 'held' }, false],
    ['a pending testimonio', { contentKind: 'testimonio', anonymisationStatus: 'pending' }, false],
    ['a testimonio with no status', { contentKind: 'testimonio' }, false],
    ['a ready testimonio with an empty redaction', { contentKind: 'testimonio', anonymisationStatus: 'ready', redactedText: '  ' }, false],
    ['a ready testimonio with no redaction', { contentKind: 'testimonio', anonymisationStatus: 'ready', redactedText: null }, false],
    ['a ready testimonio', { contentKind: 'testimonio', anonymisationStatus: 'ready', redactedText: 'texto' }, true],
    ['an approved conversación', { contentKind: 'conversacion', anonymisationStatus: 'approved', redactedText: 'texto' }, true],
    ['a list row (no text selected) that is ready', { contentKind: 'testimonio', anonymisationStatus: 'ready' }, true],
    ['a documento', { contentKind: 'documento', anonymisationStatus: 'n/a' }, true],
    // 🔴 Audit 2026-10-26: a documento filed for anonymisation is gated like a testimonio.
    ['a held gated documento', { contentKind: 'documento', anonymise: true, anonymisationStatus: 'held' }, false],
    ['a gated documento with no status', { contentKind: 'documento', anonymise: true }, false],
    ['a ready gated documento with an empty redaction', { contentKind: 'documento', anonymise: true, anonymisationStatus: 'ready', redactedText: ' ' }, false],
    ['a ready gated documento', { contentKind: 'documento', anonymise: true, anonymisationStatus: 'ready', redactedText: 'texto' }, true],
    ['a documento with anonymise false', { contentKind: 'documento', anonymise: false }, true],
  ])('isClearedForLibrary: %s → %s', (_case, row, expected) => {
    expect(isClearedForLibrary(row as Record<string, unknown>)).toBe(expected);
  });

  it('drops a held testimonio from a list page even if the backend returns it', async () => {
    mockedBackendFetch.mockImplementation(async () =>
      jsonResponse({
        totalDocs: 2,
        docs: [
          { id: 1, contentKind: 'testimonio', anonymisationStatus: 'held', kind: 'pdf' },
          { id: 2, contentKind: 'testimonio', anonymisationStatus: 'ready', kind: 'pdf' },
        ],
      }),
    );
    const out = await listPublished('tok', base);
    expect(out.items.map((i) => i.id)).toEqual(['2']);
  });

  it('reads a published-but-held testimonio as not-found, never as an empty card', async () => {
    mockedBackendFetch.mockResolvedValue(
      jsonResponse({
        id: 227,
        contentKind: 'testimonio',
        organization: '7',
        publicationStatus: 'published',
        anonymisationStatus: 'held',
        redactedText: null,
      }),
    );
    expect((await readPublished('tok', '7', '227')).state).toBe('not-found');
  });
});
