/**
 * Biblioteca card: "Testimonio · <tema or ecosistema>" plus an excerpt cut
 * server-side from `redactedText` (owner ruling 2026-10-23).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { backendFetch } from '$lib/server/auth';
import { libraryListQuery, listPublished, readPublished, toLibraryItem, LIBRARY_LIST_FIELDS } from './biblioteca';

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockedBackendFetch.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const RAW = 'Me llamo Juana Pérez y vivo en la colonia Las Flores, en Cuautla, desde hace mucho tiempo.';
const REDACTED = 'Me llamo [Persona A] y vivo en la colonia [Lugar B], en Cuautla, desde hace mucho tiempo.';

const voz = {
  id: 5,
  name: 'Testimonio de Juana Pérez.m4a',
  kind: 'audio',
  contentKind: 'testimonio',
  organization: '7',
  publicationStatus: 'published',
  anonymisationStatus: 'ready',
  extractedText: RAW,
  bodyMarkdown: RAW,
  redactedText: REDACTED,
  tema: 'discapacidad',
  uploadedBy: '10',
};

describe('toLibraryItem — testimonio label and excerpt', () => {
  it('🔴 the excerpt comes from redactedText; the raw name never appears', () => {
    const item = toLibraryItem(voz, 'Ana', 'Prevención del dengue');
    expect(item.excerpt).toBe(REDACTED);
    const json = JSON.stringify(item);
    for (const leak of ['Juana', 'Pérez', 'Las Flores', 'Ana']) expect(json).not.toContain(leak);
  });

  it('🔴 shows the first line, origin and age included, with BIBLIOTECA_EXCERPT_SKIP_INTRO unset (owner ruling 2026-10-23, option A)', () => {
    const intro = 'Nací hace 32 años en Huautla de Jiménez, Oaxaca, y ahí aprendí el mazateco.';
    const item = toLibraryItem({ ...voz, redactedText: `${intro}\n\n${REDACTED}` }, null);
    expect(item.excerpt).toBe(intro);
  });

  it('🔴 never sends the redacted text itself, only the excerpt', () => {
    const long = `${REDACTED} ${'y luego seguimos caminando por el monte '.repeat(10)}`;
    const item = toLibraryItem({ ...voz, redactedText: long }, null);
    expect(item.excerpt!.length).toBeLessThanOrEqual(120);
    expect(item).not.toHaveProperty('redactedText');
    expect(JSON.stringify(item)).not.toContain('monte y luego seguimos caminando por el monte y luego');
  });

  it('titles it "Testimonio · <tema>" when the row has a tema', () => {
    expect(toLibraryItem(voz, null, 'Eco').title).toBe('Testimonio · Discapacidad');
  });

  it('falls back to the ecosistema name with no tema', () => {
    expect(toLibraryItem({ ...voz, tema: null }, null, 'Prevención del dengue').title).toBe(
      'Testimonio · Prevención del dengue',
    );
    expect(toLibraryItem({ ...voz, tema: null }, null).title).toBe('Testimonio');
  });

  it.each(['pending', 'held', 'rejected', 'n/a', undefined])(
    '🔴 a %s testimonio gets no excerpt, even with text on the row',
    (anonymisationStatus) => {
      expect(toLibraryItem({ ...voz, anonymisationStatus }, null).excerpt).toBeNull();
    },
  );

  it('🔴 no redaction ⇒ no excerpt, never a fallback to the original', () => {
    expect(toLibraryItem({ ...voz, redactedText: null }, null).excerpt).toBeNull();
    expect(toLibraryItem({ ...voz, redactedText: '   ' }, null).excerpt).toBeNull();
  });

  // Kills `const testimonio = true`: a cleared row with a redaction that is
  // NOT a testimonio (a conversación, a documento) gets no excerpt.
  it.each(['conversacion', 'documento', undefined])(
    '🔴 a %s row with redactedText gets no excerpt',
    (contentKind) => {
      const item = toLibraryItem({ ...voz, contentKind }, null, 'Eco');
      expect(item.excerpt).toBeNull();
      expect(item.title).not.toMatch(/^Testimonio · /);
      expect(JSON.stringify(item)).not.toContain('[Persona A]');
    },
  );

  it('a documento keeps its real title and gets no excerpt', () => {
    const item = toLibraryItem(
      { id: 3, name: 'Acta de asamblea.pdf', kind: 'pdf', contentKind: 'documento', extractedText: 'Texto del acta', tema: 'dengue' },
      'Ana',
      'Eco',
    );
    expect(item.title).toBe('Acta de asamblea.pdf');
    expect(item.excerpt).toBeNull();
    expect(item.contributor).toBe('Ana');
  });
});

describe('the list read', () => {
  it('selects tema and redactedText, never the original text', () => {
    const qs = new URLSearchParams(libraryListQuery({ organizationId: '7', kind: 'todos', search: '', page: 1 }));
    expect(qs.get('select[tema]')).toBe('true');
    expect(qs.get('select[redactedText]')).toBe('true');
    expect(qs.get('select[extractedText]')).toBeNull();
    expect(qs.get('select[bodyMarkdown]')).toBeNull();
    expect(LIBRARY_LIST_FIELDS).not.toContain('extractedText');
  });

  it('🔴 the page handed to the browser carries the excerpt and no text field', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
      path.startsWith('/api/documents')
        ? jsonResponse({
            docs: [
              voz,
              { ...voz, id: 6, anonymisationStatus: 'held' },
              { id: 3, name: 'Acta.pdf', kind: 'pdf', contentKind: 'documento', organization: '7', publicationStatus: 'published', uploadedBy: '10' },
            ],
            totalDocs: 3,
          })
        : jsonResponse({ docs: [{ id: 10, displayName: 'Ana' }] }),
    );
    const page = await listPublished('tok', {
      organizationId: '7',
      kind: 'todos',
      search: '',
      page: 1,
      ecosystemName: 'Discapacidad',
    });
    // The held row is dropped by `isClearedForLibrary`.
    expect(page.items.map((i) => [i.id, i.title, i.excerpt])).toEqual([
      ['5', 'Testimonio · Discapacidad', REDACTED],
      ['3', 'Acta.pdf', null],
    ]);
    const json = JSON.stringify(page);
    for (const leak of ['redactedText', 'extractedText', 'bodyMarkdown', 'Juana', 'Las Flores']) {
      expect(json).not.toContain(leak);
    }
  });

  it('the reader titles a testimonio the same way', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
      path.startsWith('/api/documents') ? jsonResponse({ ...voz, tema: null }) : jsonResponse({ docs: [] }),
    );
    const out = await readPublished('tok', '7', '5', 'Discapacidad');
    expect(out.state).toBe('ok');
    if (out.state === 'ok') {
      expect(out.doc.title).toBe('Testimonio · Discapacidad');
      expect(out.doc.text).toBe(REDACTED);
      expect(JSON.stringify(out.doc)).not.toContain('Juana');
    }
  });
});
