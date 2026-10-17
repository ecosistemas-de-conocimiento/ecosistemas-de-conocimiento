import { describe, it, expect, vi, afterEach } from 'vitest';
import { retrieveContext, threadCorpus } from './retrieve.js';
import { prepareTurn } from './respond.js';
import { DEFAULT_ENGINE_CONFIG } from './config.js';
import type {
  AIClient,
  RetrievalPolicy,
  RetrieveMultiRequest,
  RetrieveMultiResult,
  RetrieveRequest,
  RetrieveResult,
} from './types.js';
import type { DomainAdapter } from './adapter.js';

/**
 * Hybrid retrieval machinery (0.6.0, #306 R1). Every assertion is on the WIRE
 * ARGS the stub received and on FIXTURE order — never on live ranking.
 */

const HYBRID: RetrievalPolicy = { mode: 'hybrid', perCorpusTopK: 10, limit: 6 };

function client(over: Partial<AIClient> = {}): AIClient {
  return {
    generateSync: async () => ({ text: 'ok', modelUsed: 'm', provider: 'p', costUsd: 0, traceId: 't' }),
    retrieve: async (): Promise<RetrieveResult> => ({ matches: [] }),
    ingest: async () => ({ ingested: 0, documentIds: [] }),
    ...over,
  };
}

const args = (aiClient: AIClient) => ({
  aiClient,
  orgId: 'org-1',
  fallbackScopeId: 'scope-1',
  corpora: [{ corpus: 'org-docs', scopeId: 'scope-1' }, { corpus: 'org-entities' }],
  threadId: 7,
  query: '  ¿qué dice el artículo 12?  ',
});

/** Fixture in SERVER order, deliberately NOT sorted by `score` (RRF + mixed legs). */
const SERVER_ORDER: RetrieveMultiResult['matches'] = [
  { documentId: 'd1', chunkId: 'lex-top', score: 0.016, lexicalScore: 0.4, text: 'A', corpus: 'org-docs' },
  { documentId: 'd2', chunkId: 'dense-mid', score: 0.033, denseScore: 0.5, text: 'B', corpus: 'org-entities' },
  { documentId: 'd3', chunkId: 'both', score: 0.021, denseScore: 0.48, lexicalScore: 0.2, text: 'C', corpus: 'chat:thread:7' },
];

function captureWarnings() {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { events: () => spy.mock.calls.map((c) => c[1]), restore: () => spy.mockRestore() };
}

afterEach(() => vi.restoreAllMocks());

describe('retrieveContext — no policy is the pre-0.6.0 behaviour', () => {
  it('sends today\'s request, byte for byte: no mode, no rerank, topK 5', async () => {
    const calls: RetrieveRequest[] = [];
    const multi = vi.fn();
    const out = await retrieveContext(
      args(client({
        retrieve: async (req) => { calls.push(req); return { matches: [] }; },
        retrieveMulti: multi,
      })),
    );
    expect(Array.isArray(out)).toBe(true);
    expect(multi).not.toHaveBeenCalled();
    expect(calls).toEqual([
      { orgId: 'org-1', scopeId: 'scope-1', corpus: 'org-docs', query: '¿qué dice el artículo 12?', topK: 5 },
      { orgId: 'org-1', scopeId: 'scope-1', corpus: 'org-entities', query: '¿qué dice el artículo 12?', topK: 5 },
      { orgId: 'org-1', scopeId: 'scope-1', corpus: threadCorpus(7), query: '¿qué dice el artículo 12?', topK: 5 },
    ]);
  });
});

describe('retrieveContext — hybrid policy with retrieveMulti', () => {
  it('makes ONE multi call with mode hybrid, topK, limit and every corpus', async () => {
    const multiCalls: RetrieveMultiRequest[] = [];
    const retrieve = vi.fn();
    await retrieveContext(
      {
        ...args(client({
          retrieve,
          retrieveMulti: async (req) => { multiCalls.push(req); return { matches: [], corpora: [] }; },
        })),
        filter: { sessionId: 's1' },
      },
      { ...HYBRID, rerank: true },
    );
    expect(retrieve).not.toHaveBeenCalled();
    expect(multiCalls).toEqual([
      {
        orgId: 'org-1',
        scopeId: 'scope-1',
        corpora: ['org-docs', 'org-entities', 'chat:thread:7'],
        query: '¿qué dice el artículo 12?',
        topK: 10,
        limit: 6,
        mode: 'hybrid',
        filter: { sessionId: 's1' },
        rerank: true,
      },
    ]);
  });

  it('keeps the SERVER order — no client re-sort by score', async () => {
    const { matches } = await retrieveContext(
      args(client({ retrieveMulti: async () => ({ matches: SERVER_ORDER, corpora: [] }) })),
      HYBRID,
    );
    expect(matches.map((m) => m.chunkId)).toEqual(['lex-top', 'dense-mid', 'both']);
    // The per-leg scores ride through untouched.
    expect(matches[1]).toMatchObject({ denseScore: 0.5, corpus: 'org-entities' });
    expect(matches[0]).toMatchObject({ lexicalScore: 0.4 });
  });

  it('returns corpora the server reported failed; not_found is a normal empty', async () => {
    const w = captureWarnings();
    const { failedCorpora } = await retrieveContext(
      args(client({
        retrieveMulti: async () => ({
          matches: [],
          corpora: [
            { corpus: 'org-docs', matched: 0, error: 'failed' },
            { corpus: 'org-entities', matched: 0, error: 'not_found' },
            { corpus: 'chat:thread:7', matched: 2 },
          ],
        }),
      })),
      HYBRID,
    );
    expect(failedCorpora).toEqual(['org-docs']);
    expect(w.events()).toEqual([{ event: 'retrieve.failed' }]);
  });

  it('a throwing multi call drops every corpus, visibly, and never breaks the turn', async () => {
    const w = captureWarnings();
    const err = Object.assign(new Error('secret body'), { name: 'UpstreamError', status: 503 });
    const out = await retrieveContext(
      args(client({ retrieveMulti: async () => { throw err; } })),
      HYBRID,
    );
    expect(out).toEqual({ matches: [], failedCorpora: ['org-docs', 'org-entities', 'chat:thread:7'] });
    expect(w.events()).toEqual([{ event: 'retrieve.failed', errorName: 'UpstreamError', status: 503 }]);
  });
});

describe('retrieveContext — hybrid policy without a usable retrieveMulti', () => {
  it('warns retrieve.multi_unavailable and runs dense per corpus, sorted by cosine', async () => {
    const w = captureWarnings();
    const calls: RetrieveRequest[] = [];
    const { matches } = await retrieveContext(
      args(client({
        retrieve: async (req) => {
          calls.push(req);
          return req.corpus === 'org-docs'
            ? { matches: [{ documentId: 'd', chunkId: 'low', score: 0.2, text: 'x' }] }
            : req.corpus === 'org-entities'
              ? { matches: [{ documentId: 'd', chunkId: 'high', score: 0.7, text: 'y' }] }
              : { matches: [] };
        },
      })),
      HYBRID,
    );
    expect(w.events()).toEqual([{ event: 'retrieve.multi_unavailable' }]);
    // Never hybrid per corpus: the RRF values could not be merged.
    expect(calls.map((c) => c.mode)).toEqual(['dense', 'dense', 'dense']);
    expect(calls.map((c) => c.topK)).toEqual([10, 10, 10]);
    expect(matches.map((m) => m.chunkId)).toEqual(['high', 'low']);
  });

  it('falls back too when the corpora span more than one scope', async () => {
    const w = captureWarnings();
    const multi = vi.fn();
    await retrieveContext(
      {
        ...args(client({ retrieveMulti: multi })),
        corpora: [{ corpus: 'other-project', scopeId: 'scope-2' }],
      },
      HYBRID,
    );
    expect(multi).not.toHaveBeenCalled();
    expect(w.events()).toEqual([{ event: 'retrieve.multi_unavailable' }]);
  });

  it('a dense policy honours perCorpusTopK and limit, and reports failed corpora', async () => {
    captureWarnings();
    const many = Array.from({ length: 5 }, (_, i) => ({ documentId: 'd', chunkId: `c${i}`, score: i / 10, text: 't' }));
    const out = await retrieveContext(
      args(client({
        retrieve: async (req) => {
          if (req.corpus === 'org-entities') throw new Error('down');
          return { matches: many };
        },
      })),
      { mode: 'dense', perCorpusTopK: 3, limit: 4 },
    );
    expect(out.matches).toHaveLength(4);
    expect(out.failedCorpora).toEqual(['org-entities']);
  });
});

describe('prepareTurn — retrievalPolicy flows through', () => {
  const adapter: DomainAdapter = {
    searchEntities: async () => [],
    resolveEntity: async () => '',
    scopeHierarchy: async () => ({ summaryText: '', corpora: [{ corpus: 'org-docs' }] }),
    syncEntity: async () => {},
    backfill: async () => {},
    summary: async () => '',
  };

  it('forwards the policy, copies per-leg scores into provenance, reports maxDenseScore', async () => {
    const multiCalls: RetrieveMultiRequest[] = [];
    const turn = await prepareTurn({
      config: DEFAULT_ENGINE_CONFIG,
      aiClient: client({
        retrieveMulti: async (req) => {
          multiCalls.push(req);
          return { matches: SERVER_ORDER, corpora: [{ corpus: 'org-docs', matched: 1, error: 'failed' }] };
        },
      }),
      adapter,
      orgId: 'org-1',
      userId: 'u1',
      scopeId: 'scope-1',
      threadId: 7,
      scope: { refs: [] },
      history: [],
      userMessage: 'artículo 12',
      retrievalPolicy: HYBRID,
    });
    vi.restoreAllMocks();
    expect(multiCalls).toHaveLength(1);
    expect(multiCalls[0]).toMatchObject({ mode: 'hybrid', limit: 6, topK: 10 });
    expect(turn.maxDenseScore).toBe(0.5);
    expect(turn.failedCorpora).toEqual(['org-docs']);
    expect(turn.provenance!.chunks.map((c) => c.chunkId)).toEqual(['lex-top', 'dense-mid', 'both']);
    expect(turn.provenance!.chunks[0]).toMatchObject({ lexicalScore: 0.4 });
    expect(turn.provenance!.chunks[0]).not.toHaveProperty('denseScore');
    expect(turn.provenance!.chunks[1]).toMatchObject({ denseScore: 0.5 });
    expect(turn.provenance!.chunks[2]).toMatchObject({ denseScore: 0.48, lexicalScore: 0.2 });
  });

  it('without a policy the provenance keeps the pre-0.6.0 shape', async () => {
    const turn = await prepareTurn({
      config: DEFAULT_ENGINE_CONFIG,
      aiClient: client({
        retrieve: async () => ({ matches: [{ documentId: 'd', chunkId: 'c', score: 0.6, text: 't' }] }),
      }),
      adapter,
      orgId: 'org-1',
      userId: 'u1',
      threadId: 7,
      scope: { refs: [] },
      history: [],
      userMessage: 'hola',
    });
    expect(Object.keys(turn.provenance!.chunks[0]!).sort()).toEqual(
      ['chunkId', 'corpus', 'documentId', 'metadata', 'score', 'text'],
    );
    expect(turn.maxDenseScore).toBe(0.6);
    expect(turn.failedCorpora).toEqual([]);
  });
});
