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
  const adapterFor = (row: Record<string, unknown>) => {
    mockedBackendFetch.mockResolvedValue(new Response(JSON.stringify(row), { status: 200 }));
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
    expect(block).toContain('Documento adjunto: Acta visita');
    expect(block).not.toContain('María');
    expect(block.includes('[Persona A]')).toBe(shows);
  });
});
