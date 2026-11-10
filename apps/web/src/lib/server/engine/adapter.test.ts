import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { backendFetch } from '$lib/server/auth';
import { makeChatDomainAdapter } from './adapter';
import { lenguaSummaryLine } from '$lib/lengua';

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;
const SCOPE = { refs: [{ kind: 'org' as const }] };

beforeEach(() => {
  mockedBackendFetch.mockReset();
  mockedBackendFetch.mockResolvedValue(
    new Response(JSON.stringify({ id: 7, name: 'Eco', slug: 'eco' }), { status: 200 }),
  );
});

describe('scopeHierarchy — the lengua line of the deterministic summary', () => {
  it('names the ecosistema’s languages, so "¿qué lenguas aparecen?" has a deterministic answer', async () => {
    const facets = [{ lengua: 'mixteco', documentos: 18 }, { lengua: 'mixe', documentos: 2 }];
    const adapter = makeChatDomainAdapter({
      token: 't',
      sessionId: '1',
      organizationId: 7,
      documents: [],
      lenguaFacets: async () => facets,
    });
    const { summaryText } = await adapter.scopeHierarchy(SCOPE);
    expect(summaryText).toContain('Ecosistema: Eco.');
    expect(summaryText).toContain(lenguaSummaryLine(facets));
  });

  it('says when the turn is filtered to one language', async () => {
    const adapter = makeChatDomainAdapter({
      token: 't',
      sessionId: '1',
      organizationId: 7,
      documents: [],
      lenguaFilter: 'mixe',
    });
    const { summaryText } = await adapter.scopeHierarchy(SCOPE);
    expect(summaryText).toMatch(/se limita a documentos sobre personas que hablan mixe/);
  });

  it('is best-effort: a failing facet read leaves the rest of the summary intact', async () => {
    const adapter = makeChatDomainAdapter({
      token: 't',
      sessionId: '1',
      organizationId: 7,
      documents: [],
      lenguaFacets: async () => {
        throw new Error('down');
      },
    });
    const { summaryText } = await adapter.scopeHierarchy(SCOPE);
    expect(summaryText).toContain('Ecosistema: Eco.');
    expect(summaryText).not.toContain('Lenguas');
  });
});

// 🔴 Audit 2026-10-17: an @-mentioned testimonio was inlined into the prompt as
// its unredacted original, under the uploader's filename.
describe('resolveEntity — a mentioned document', () => {
  // Published in this conversation's ecosistema (7), so I-10's scope lets it in.
  const adapterFor = (row: Record<string, unknown>) => {
    mockedBackendFetch.mockResolvedValue(
      new Response(JSON.stringify({ organization: 7, publicationStatus: 'published', ...row }), { status: 200 }),
    );
    return makeChatDomainAdapter({ token: 't', sessionId: '1', organizationId: 7, documents: [] });
  };

  it('🔴 inlines a testimonio as its redactedText under a neutral title', async () => {
    const adapter = adapterFor({
      id: 5,
      name: 'Testimonio de María López.m4a',
      kind: 'audio',
      contentKind: 'testimonio',
      extractedText: 'Me llamo María López',
      redactedText: 'Me llamo [Persona A]',
      anonymisationStatus: 'ready',
    });
    const block = await adapter.resolveEntity({ kind: 'document', id: 5 } as never);
    expect(block).toContain('Me llamo [Persona A]');
    expect(block).toContain('Testimonio');
    expect(block).not.toContain('María');
  });

  it('never falls back to the original when there is no redaction', async () => {
    const adapter = adapterFor({
      id: 5,
      contentKind: 'testimonio',
      extractedText: 'Me llamo María López',
      redactedText: null,
    });
    const block = await adapter.resolveEntity({ kind: 'document', id: 5 } as never);
    expect(block).not.toContain('María');
  });

  it.each(['held', 'pending', 'rejected', 'n/a', undefined])(
    '🔴 sends no text for a testimonio whose gate status is %s, even with a redactedText',
    async (status) => {
      const adapter = adapterFor({
        id: 5,
        contentKind: 'testimonio',
        extractedText: 'Me llamo María López',
        redactedText: 'Me llamo [Persona A]',
        ...(status ? { anonymisationStatus: status } : {}),
      });
      const block = await adapter.resolveEntity({ kind: 'document', id: 5 } as never);
      expect(block).not.toContain('María');
      expect(block).not.toContain('[Persona A]');
    },
  );

  it('inlines a documento as before', async () => {
    const adapter = adapterFor({ id: 6, name: 'Acta', contentKind: 'documento', extractedText: 'texto' });
    const block = await adapter.resolveEntity({ kind: 'document', id: 6 } as never);
    expect(block).toContain('Documento adjunto: Acta');
    expect(block).toContain('texto');
  });

  // Owner ruling 2026-10-26: "Anonimizar" — still a documento, text gated.
  it.each([
    ['ready', true],
    ['held', false],
  ])('🔴 a documento filed for anonymisation (%s): its title, never the original', async (status, shows) => {
    const adapter = adapterFor({
      id: 6,
      name: 'Acta visita',
      contentKind: 'documento',
      anonymise: true,
      extractedText: 'Asistió María López',
      redactedText: 'Asistió [Persona A]',
      anonymisationStatus: status,
    });
    const block = await adapter.resolveEntity({ kind: 'document', id: 6 } as never);
    // 🔴 P-13: no redacted title on the report yet → neutral, never `name`.
    expect(block).toContain('Documento adjunto: Documento');
    expect(block).not.toContain('Acta visita');
    expect(block).not.toContain('María');
    expect(block.includes('[Persona A]')).toBe(shows);
  });
});

// 🔴 P-13 (owner decision 2026-11-10): a gated documento's TITLE passes the
// gate too — the prompt, the summary and the `@` menu use `redactedTitle`.
describe('titles of a gated documento (P-13)', () => {
  const GATED = {
    id: 6,
    name: 'Entrevista a María López.pdf',
    contentKind: 'documento',
    anonymise: true,
    anonymisationStatus: 'ready',
    anonymisationReport: { redactedTitle: 'Entrevista a [Persona A].pdf' },
    redactedText: 'Asistió [Persona A]',
    organization: 7,
    publicationStatus: 'published',
  };

  it('🔴 resolveEntity titles it by its redacted title', async () => {
    mockedBackendFetch.mockResolvedValue(new Response(JSON.stringify(GATED), { status: 200 }));
    const adapter = makeChatDomainAdapter({ token: 't', sessionId: '1', organizationId: 7, documents: [] });
    const block = await adapter.resolveEntity({ kind: 'document', id: 6 } as never);
    expect(block).toContain('Documento adjunto: Entrevista a [Persona A].pdf');
    expect(block).not.toContain('María');
  });

  it('🔴 the fallback summary read names it by its redacted title', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
      path.startsWith('/api/documents')
        ? new Response(JSON.stringify({ docs: [GATED] }), { status: 200 })
        : new Response(JSON.stringify({ id: 7, name: 'Eco', slug: 'eco' }), { status: 200 }),
    );
    const text = await makeChatDomainAdapter({ token: 't', sessionId: '1', organizationId: 7 }).summary(SCOPE);
    expect(text).toContain('Entrevista a [Persona A].pdf');
    expect(text).not.toContain('María');
  });

  it('🔴 the `@` menu labels it by its redacted title and never matches the raw name', async () => {
    mockedBackendFetch.mockImplementation(async () =>
      new Response(JSON.stringify({ docs: [GATED] }), { status: 200 }),
    );
    const adapter = makeChatDomainAdapter({ token: 't', sessionId: '1' });
    const all = await adapter.searchEntities('document', '', {} as never);
    expect(all.map((r) => r.label)).toEqual(['Entrevista a [Persona A].pdf']);
    expect(await adapter.searchEntities('document', 'María', {} as never)).toEqual([]);
  });
});

// 🔴 I-08 (audit 2026-11-10): a failed read of the conversation's documents
// must not fall back to a second read whose rows carry the raw filename.
describe('summary — the conversation\'s documents (I-08)', () => {
  it('🔴 a failed read (`documents: null`) names no document and reads no list', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
      path.startsWith('/api/documents')
        ? new Response(
            JSON.stringify({ docs: [{ id: 5, name: 'Entrevista con María López Ruiz.mp3', contentKind: 'testimonio' }] }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ id: 7, name: 'Eco', slug: 'eco' }), { status: 200 }),
    );
    const adapter = makeChatDomainAdapter({ token: 't', sessionId: '1', organizationId: 7, documents: null });
    const text = await adapter.summary(SCOPE);
    expect(text).toContain('Ecosistema: Eco.');
    expect(text).not.toContain('María');
    expect(text).not.toContain('Documentos adjuntos');
    expect(mockedBackendFetch.mock.calls.some(([, p]) => String(p).startsWith('/api/documents'))).toBe(false);
  });

  it('🔴 the fallback read (no list handed over) still names a testimonio neutrally', async () => {
    mockedBackendFetch.mockImplementation(async (_t: unknown, path: string) =>
      path.startsWith('/api/documents')
        ? new Response(
            JSON.stringify({ docs: [{ id: 5, name: 'Entrevista con María López Ruiz.mp3', contentKind: 'testimonio' }] }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ id: 7, name: 'Eco', slug: 'eco' }), { status: 200 }),
    );
    const adapter = makeChatDomainAdapter({ token: 't', sessionId: '1', organizationId: 7 });
    const text = await adapter.summary(SCOPE);
    expect(text).toContain('Documentos adjuntos');
    expect(text).not.toContain('María');
  });

  it('a row whose name the backend hid reads as a title, never "undefined" (L-12)', async () => {
    const adapter = makeChatDomainAdapter({
      token: 't',
      sessionId: '1',
      organizationId: 7,
      documents: [{ id: 5, contentKind: 'documento' }],
    });
    const text = await adapter.summary(SCOPE);
    expect(text).toContain('Documento sin título');
    expect(text).not.toContain('undefined');
  });
});

// 🔴 I-10 (audit 2026-11-10): the browser's `contextRefs` are scoped to the
// conversation's ecosistema on the server.
describe('resolveEntity — scoped to the conversation (I-10)', () => {
  const rowAt = (row: Record<string, unknown>) =>
    mockedBackendFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: 6, name: 'Acta', contentKind: 'documento', extractedText: 'texto de A', ...row }), {
        status: 200,
      }),
    );
  const adapter = (documents: { id: number }[] | null = []) =>
    makeChatDomainAdapter({ token: 't', sessionId: '1', organizationId: 7, documents });

  it('🔴 drops a document published in another ecosistema', async () => {
    rowAt({ organization: 9, publicationStatus: 'published' });
    expect(await adapter().resolveEntity({ kind: 'document', id: 6 } as never)).toBe('');
  });

  it('🔴 drops a draft that is not this conversation\'s', async () => {
    rowAt({ organization: 7, publicationStatus: 'draft' });
    expect(await adapter().resolveEntity({ kind: 'document', id: 6 } as never)).toBe('');
  });

  it('🔴 drops an unpublished row when the conversation\'s list is unknown', async () => {
    rowAt({ organization: 7, publicationStatus: 'draft' });
    expect(await adapter(null).resolveEntity({ kind: 'document', id: 6 } as never)).toBe('');
  });

  it('keeps a document published in this ecosistema (populated relationship too)', async () => {
    rowAt({ organization: { id: 7 }, publicationStatus: 'published' });
    expect(await adapter().resolveEntity({ kind: 'document', id: 6 } as never)).toContain('texto de A');
  });

  it('keeps a draft of this conversation', async () => {
    rowAt({ organization: 7, publicationStatus: 'draft' });
    expect(await adapter([{ id: 6 }]).resolveEntity({ kind: 'document', id: '6' } as never)).toContain('texto de A');
  });

  it('🔴 drops another ecosistema as an org ref, and reads nothing for it', async () => {
    mockedBackendFetch.mockResolvedValue(new Response(JSON.stringify({ id: 9, name: 'Otro', slug: 'o' }), { status: 200 }));
    expect(await adapter().resolveEntity({ kind: 'org', id: 9 } as never)).toBe('');
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it('keeps this ecosistema as an org ref', async () => {
    expect(await adapter().resolveEntity({ kind: 'org', id: '7' } as never)).toContain('Ecosistema: Eco');
  });
});
