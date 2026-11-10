import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { backendFetch } from '$lib/server/auth';
import {
  fetchPublishedTitleScan,
  foldTitle,
  matchDocumentTitle,
  MIN_TITLE_CHARS,
  publishedTitlesQuery,
  titleRetrievalFilter,
  withTitleRef,
  type TitledDoc,
} from './titleMatch';

/** UX backlog #35: a question naming a document by its title pins it. */

const DOCS: TitledDoc[] = [
  { id: '31', name: 'Diagnóstico Comunitario de Salud.pdf' },
  { id: '32', name: 'Plan_de_Riego-2025.docx' },
  { id: '33', name: 'Acta' },
  { id: '34', name: 'La casa' },
  { id: '35', name: 'Informe 2' },
];

describe('foldTitle', () => {
  it('drops accents and case, and collapses punctuation', () => {
    expect(foldTitle('  Diagnóstico — COMUNITARIO, de Salud!  ')).toBe('diagnostico comunitario de salud');
    expect(foldTitle('Ñuu Savi')).toBe('nuu savi');
  });
});

describe('matchDocumentTitle', () => {
  it('an exact title match pins that document', () => {
    expect(matchDocumentTitle('¿Qué dice el Diagnóstico Comunitario de Salud?', DOCS)?.id).toBe('31');
  });

  it('is accent- and case-folded, and ignores the file extension and separators', () => {
    expect(matchDocumentTitle('resume el diagnostico comunitario de salud', DOCS)?.id).toBe('31');
    expect(matchDocumentTitle('¿Qué propone el PLAN DE RIEGO 2025?', DOCS)?.id).toBe('32');
  });

  it(`🔴 never matches a short title (< ${MIN_TITLE_CHARS} chars or one word) on common words`, () => {
    expect(matchDocumentTitle('Lee el acta y dime qué pasó en la casa con el informe 2', DOCS)).toBeNull();
  });

  it('needs whole words: a title inside a longer word does not match', () => {
    expect(matchDocumentTitle('el plan de riego 20250 no existe', DOCS)).toBeNull();
  });

  it('a message that is only part of a title does not match', () => {
    expect(matchDocumentTitle('¿qué hay sobre salud comunitaria?', DOCS)).toBeNull();
  });

  it('the longer title wins over one it contains', () => {
    const docs = [
      { id: '1', name: 'Plan de riego' },
      { id: '2', name: 'Plan de riego 2025' },
    ];
    expect(matchDocumentTitle('explica el plan de riego 2025', docs)?.id).toBe('2');
    expect(matchDocumentTitle('explica el plan de riego', docs)?.id).toBe('1');
  });

  it('pins nothing when two documents match: same folded title, or two titles named', () => {
    const twins = [
      { id: '1', name: 'Plan de riego.pdf' },
      { id: '2', name: 'plan de riego' },
    ];
    expect(matchDocumentTitle('el plan de riego', twins)).toBeNull();
    expect(
      matchDocumentTitle('compara el plan de riego 2025 con el diagnóstico comunitario de salud', DOCS),
    ).toBeNull();
  });

  describe('a numbered series (21 near-identical seeded titles)', () => {
    const series: TitledDoc[] = Array.from({ length: 21 }, (_, i) => ({
      id: String(100 + i + 1),
      name: `Carta de presentación — traducción en salud (${String(i + 1).padStart(2, '0')})`,
      contentKind: 'testimonio',
    }));

    it('🔴 without the number, matches nothing', () => {
      expect(matchDocumentTitle('¿Qué dice la carta de presentación sobre traducción en salud?', series)).toBeNull();
      expect(matchDocumentTitle('Carta de presentación — traducción en salud', series)).toBeNull();
    });

    it('with the number, as written or without the zero, matches that one', () => {
      expect(matchDocumentTitle('Resume la Carta de presentación — traducción en salud (03)', series)?.id).toBe('103');
      expect(matchDocumentTitle('resume la carta de presentacion traduccion en salud 3', series)?.id).toBe('103');
      expect(matchDocumentTitle('carta de presentación, traducción en salud 13', series)?.id).toBe('113');
    });

    it('a number no title has matches nothing', () => {
      expect(matchDocumentTitle('carta de presentación traducción en salud 30', series)).toBeNull();
    });
  });

  it('no documents, no match', () => {
    expect(matchDocumentTitle('Diagnóstico Comunitario de Salud', [])).toBeNull();
  });
});

describe('publishedTitlesQuery', () => {
  it('🔴 is scoped to the ecosistema, published, documentos only, names only', () => {
    const qs = new URLSearchParams(publishedTitlesQuery('7'));
    expect(qs.get('where[organization][equals]')).toBe('7');
    expect(qs.get('where[publicationStatus][equals]')).toBe('published');
    expect(qs.get('where[contentKind][in]')).toBe('documento,testimonio');
    expect(qs.get('select[name]')).toBe('true');
    // Without these the backend hides a testimonio's name even from its uploader.
    expect(qs.get('select[contentKind]')).toBe('true');
    expect(qs.get('select[uploadedBy]')).toBe('true');
    expect(qs.get('select[anonymisationStatus]')).toBe('true');
    // `isClearedForLibrary` reads it: without it a documento filed for
    // anonymisation and not cleared would be named in chat.
    expect(qs.get('select[anonymise]')).toBe('true');
    // 🔴 P-13: the redacted title of a gated documento lives on the report.
    expect(qs.get('select[anonymisationReport]')).toBe('true');
    expect(qs.has('select[extractedText]')).toBe(false);
  });
});

// 🔴 P-13 (owner decision 2026-11-10): a gated documento is matched, pinned and
// listed by its redacted title, never by its raw filename.
describe('fetchPublishedTitleScan — a gated documento', () => {
  const ROWS = [
    {
      id: 1,
      name: 'Entrevista a María López Ruiz.pdf',
      contentKind: 'documento',
      anonymise: true,
      anonymisationStatus: 'ready',
      anonymisationReport: { redactedTitle: 'Entrevista a [Persona A].pdf' },
      publicationStatus: 'published',
    },
    {
      id: 2,
      name: 'Diario de campo de Pedro Gómez.pdf',
      contentKind: 'documento',
      anonymise: true,
      anonymisationStatus: 'approved',
      publicationStatus: 'published',
    },
    { id: 3, name: 'Plan de riego 2025.pdf', contentKind: 'documento', anonymise: false, publicationStatus: 'published' },
  ];
  const scan = async () => {
    (backendFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ docs: ROWS }), { status: 200 }),
    );
    return (await fetchPublishedTitleScan('t', 7)).docs;
  };

  it('🔴 lists it by its redacted title (or "Documento"), never the raw name', async () => {
    expect((await scan()).map((d) => d.name)).toEqual([
      'Entrevista a [Persona A].pdf',
      'Documento',
      'Plan de riego 2025.pdf',
    ]);
  });

  it('🔴 a message naming the raw filename pins nothing', async () => {
    const docs = await scan();
    expect(matchDocumentTitle('háblame de Entrevista a María López Ruiz', docs)).toBeNull();
    expect(matchDocumentTitle('qué dice el Diario de campo de Pedro Gómez', docs)).toBeNull();
    expect(withTitleRef([], matchDocumentTitle('resume el plan de riego 2025', docs))).toEqual([
      { kind: 'document', id: '3', label: 'Plan de riego 2025.pdf' },
    ]);
  });
});

describe('withTitleRef', () => {
  it('appends the matched document after the user refs, once', () => {
    const match = { id: '31', name: 'Diagnóstico.pdf' };
    expect(withTitleRef([{ kind: 'org' }], match)).toEqual([
      { kind: 'org' },
      { kind: 'document', id: '31', label: 'Diagnóstico.pdf' },
    ]);
    expect(withTitleRef([{ kind: 'document', id: '31' }], match)).toEqual([{ kind: 'document', id: '31' }]);
    expect(withTitleRef(undefined, null)).toEqual([]);
  });

  it('🔴 a testimonio ref is labelled "Testimonio", never its name', () => {
    const ref = withTitleRef([], { id: '41', name: 'Entrevista con Juana (01)', contentKind: 'testimonio' });
    expect(ref).toEqual([{ kind: 'document', id: '41', label: 'Testimonio' }]);
  });
});

// 🔴 ai-service compares metadata by jsonb containment (`metadata @> filter`,
// services/ai-service `metadata-filter.ts`), so `"71"` never matches `71`. The
// backend writes `docId: String(doc.id)` (`chunkMetadata`, apps/backend
// `lib/contentKind.ts`), so the filter must send a string too.
describe('titleRetrievalFilter', () => {
  it('🔴 docId is a STRING, the type chunk metadata stores, even off a numeric row id', () => {
    const filter = titleRetrievalFilter(undefined, { id: 71 as unknown as string, name: 'x' });
    expect(filter).toEqual({ docId: '71' });
    expect(typeof filter!.docId).toBe('string');
  });

  it('keeps the base filter beside it; no match leaves the base alone', () => {
    expect(titleRetrievalFilter({ lengua: 'mixe' }, DOCS[0]!)).toEqual({ lengua: 'mixe', docId: '31' });
    expect(titleRetrievalFilter({ lengua: 'mixe' }, null)).toEqual({ lengua: 'mixe' });
    expect(titleRetrievalFilter(undefined, null)).toBeUndefined();
  });
});
