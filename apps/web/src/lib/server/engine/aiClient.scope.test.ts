/**
 * 🔴 Student-view scope (`scopeDocumentIds`) in `makeEngineAIClient`: every
 * leg, the shared corpus included, keeps only the scoped documents; an empty
 * scope reaches nothing; hybrid is not offered under a scope.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
  env: { AI_SERVICE_URL: 'http://ai.test', AI_SERVICE_API_KEY: 'k' },
}));

import { makeEngineAIClient } from './aiClient';
import type { AIServiceClient } from '$lib/server/aiService';

const ECO = 'eco-8';
const DRAFT = 'eco-8-draft-1';
const ASOF = '2026-10-27T00:00:00Z';
const noClient = {} as unknown as AIServiceClient;

const chunk = (docId: string) => ({ chunkId: `${docId}#1`, documentId: `u-${docId}`, text: docId, score: 1, metadata: { docId } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify({ chunks: ['1', '2', '3', '4'].map(chunk) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const req = (corpus: string) => ({ orgId: 'o', scopeId: 's', corpus, query: 'q', topK: 5 });
const ids = (r: { matches: { metadata?: Record<string, unknown> }[] }) => r.matches.map((m) => m.metadata?.docId);
const base = { sessionId: 's', asOf: ASOF, allowedCorpora: [ECO, DRAFT], publishedCorpus: ECO, sessionDocumentIds: new Set(['3', '4']) };

describe('scopeDocumentIds', () => {
  it('narrows the SHARED corpus too, and over-fetches', async () => {
    const ai = makeEngineAIClient(noClient, { ...base, scopeDocumentIds: new Set(['2', '4']) });
    expect(ids(await ai.retrieve(req(ECO)))).toEqual(['2', '4']);
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as { topK: number };
    expect(sent.topK).toBe(50);
  });

  it('the draft leg keeps the session ∩ scope', async () => {
    const ai = makeEngineAIClient(noClient, { ...base, scopeDocumentIds: new Set(['2', '4']) });
    expect(ids(await ai.retrieve(req(DRAFT)))).toEqual(['4']);
  });

  it('🔴 an empty scope retrieves nothing, with no round trip', async () => {
    const ai = makeEngineAIClient(noClient, { ...base, scopeDocumentIds: new Set() });
    expect((await ai.retrieve(req(ECO))).matches).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no scope: today’s behaviour on the shared corpus', async () => {
    const ai = makeEngineAIClient(noClient, base);
    expect(ids(await ai.retrieve(req(ECO)))).toEqual(['1', '2', '3', '4']);
  });

  it('hybrid is not offered under a scope', () => {
    expect(makeEngineAIClient(noClient, { ...base, hybrid: true, scopeDocumentIds: new Set(['1']) }).retrieveMulti).toBeUndefined();
    expect(makeEngineAIClient(noClient, { ...base, hybrid: true }).retrieveMulti).toBeTypeOf('function');
  });
});
