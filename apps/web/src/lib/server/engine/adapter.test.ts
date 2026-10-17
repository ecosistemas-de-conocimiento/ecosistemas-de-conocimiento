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
