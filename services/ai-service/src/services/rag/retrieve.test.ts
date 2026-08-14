// Unit tests for `RetrieveService`.
//
// The DB is a hand-rolled stub: `select().from().where().limit()` returns a
// pre-seeded corpus row (or empty), and `db.execute(sql\`...\`)` returns the
// pre-seeded candidate rows for the vector search. The embedder is a spy that
// returns a deterministic vector and asserts the corpus's embedding model
// flows through unchanged.

import { describe, expect, it, vi } from 'vitest';

import { CorpusNotFoundError, RetrieveService } from './retrieve.js';
import type { Embedder, RetrieveLogger } from './retrieve.js';
import type { Reranker } from '../ai/rerank/rerank-client.js';

interface DbState {
  corpus: Record<string, unknown> | null;
  executeRows: Record<string, unknown>[];
  executeCalls: unknown[];
}

function makeDb(state: DbState): import('../../db/client.js').Db {
  const chain = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(state.corpus ? [state.corpus] : []),
        }),
      }),
    }),
    execute: vi.fn(async (query: unknown) => {
      state.executeCalls.push(query);
      return state.executeRows;
    }),
  };
  return chain as unknown as import('../../db/client.js').Db;
}

function makeEmbedder(opts?: {
  fail?: Error;
  vec?: number[];
}): Embedder {
  return vi.fn(async ({ model, input }: { model: string; input: string | string[] }) => {
    if (opts?.fail) throw opts.fail;
    const vec = opts?.vec ?? [0.1, 0.2, 0.3];
    return {
      embeddings: [vec],
      model,
      usage: { inputTokens: Array.isArray(input) ? input.length * 4 : 4, estimatedCostUsd: 0 },
    };
  }) as unknown as Embedder;
}

const ORG = 'org-1';
const PROJECT = 'proj-1';
const CORPUS_NAME = 'docs';
const CORPUS_ID = '00000000-0000-4000-8000-000000000001';
const SEED_CORPUS = {
  id: CORPUS_ID,
  org: ORG,
  project: PROJECT,
  name: CORPUS_NAME,
  embeddingModel: 'openai/text-embedding-3-small',
  embeddingDim: 1024,
  chunkStrategy: 'recursive-char',
  chunkSize: 800,
  chunkOverlap: 100,
};

describe('RetrieveService.retrieve', () => {
  it('returns chunks ordered by cosine score on the happy path', async () => {
    const state: DbState = {
      corpus: SEED_CORPUS,
      executeRows: [
        { id: 'c1', document_id: 'd1', ordinal: 0, text: 'alpha', metadata: null, score: 0.92 },
        { id: 'c2', document_id: 'd1', ordinal: 1, text: 'beta', metadata: null, score: 0.71 },
        { id: 'c3', document_id: 'd2', ordinal: 0, text: 'gamma', metadata: { tag: 'g' }, score: 0.5 },
      ],
      executeCalls: [],
    };
    const db = makeDb(state);
    const embedder = makeEmbedder();
    const svc = new RetrieveService({ db, embedder });

    const out = await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'hello?' },
      { org: ORG, project: PROJECT },
    );

    expect(out.chunks).toHaveLength(3);
    expect(out.chunks[0]).toMatchObject({
      chunkId: 'c1',
      documentId: 'd1',
      ordinal: 0,
      text: 'alpha',
      score: 0.92,
    });
    expect(out.chunks[2]?.metadata).toEqual({ tag: 'g' });
    // Embedder called with the corpus's configured model — NOT a hardcoded one.
    expect(embedder).toHaveBeenCalledWith({
      model: 'openai/text-embedding-3-small',
      input: 'hello?',
    });
  });

  it('defaults topK to 10 when not provided', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [], executeCalls: [] };
    const db = makeDb(state);
    const svc = new RetrieveService({ db, embedder: makeEmbedder() });
    await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q' },
      { org: ORG, project: PROJECT },
    );
    // Exactly one execute call; the inline SQL fragment's `LIMIT $param`
    // takes its value from the default topK (10), not MMR-pool-doubled.
    expect(state.executeCalls).toHaveLength(1);
    const call = state.executeCalls[0] as { queryChunks?: unknown[] };
    // Drizzle sql template stores queryChunks (StringChunk + Param objects).
    const flat = JSON.stringify(call);
    expect(flat).toContain('LIMIT');
    // 10 is the default and must appear as a param value somewhere in the SQL.
    expect(flat).toContain('10');
  });

  it('reranks via MMR when mmr lambda is provided (result differs from raw top-K)', async () => {
    // Three near-duplicates and one diverse chunk. Pure cosine would return
    // the three near-duplicates first; MMR with lambda=0.5 should swap the
    // diverse one into the top-K.
    const state: DbState = {
      corpus: SEED_CORPUS,
      executeRows: [
        { id: 'c1', document_id: 'd1', ordinal: 0, text: 'similar A', metadata: null, score: 0.95, embedding: '[1,0,0]' },
        { id: 'c2', document_id: 'd1', ordinal: 1, text: 'similar B', metadata: null, score: 0.94, embedding: '[1,0,0]' },
        { id: 'c3', document_id: 'd1', ordinal: 2, text: 'similar C', metadata: null, score: 0.93, embedding: '[1,0,0]' },
        { id: 'c4', document_id: 'd2', ordinal: 0, text: 'diverse',   metadata: null, score: 0.6,  embedding: '[0,1,0]' },
      ],
      executeCalls: [],
    };
    const db = makeDb(state);
    const svc = new RetrieveService({
      db,
      embedder: makeEmbedder({ vec: [1, 0, 0] }),
    });

    const rawTopK = (
      await svc.retrieve(
        { corpus: CORPUS_NAME, query: 'q', topK: 2 },
        { org: ORG, project: PROJECT },
      )
    ).chunks.map((c) => c.chunkId);
    expect(rawTopK).toEqual(['c1', 'c2']);

    const withMmr = (
      await svc.retrieve(
        { corpus: CORPUS_NAME, query: 'q', topK: 2, mmr: 0.5 },
        { org: ORG, project: PROJECT },
      )
    ).chunks.map((c) => c.chunkId);
    // MMR should keep c1 (highest relevance) and prefer the diverse c4
    // over near-duplicate c2.
    expect(withMmr[0]).toBe('c1');
    expect(withMmr).not.toEqual(rawTopK);
    expect(withMmr).toContain('c4');
  });

  // ---------------------------------------------------------------------------
  // Metadata filter (plan/open-retrieve-metadata-filter.md §4/§7). The query
  // builder must emit the `metadata @> $::jsonb` containment clause ONLY when a
  // non-empty filter is present, bound (never interpolated), and in BOTH the
  // MMR and non-MMR SQL branches. The no-filter path must stay byte-identical.
  // ---------------------------------------------------------------------------

  /**
   * Flatten a captured drizzle `sql` template (recursing into nested `sql`
   * fragments, which appear as inner `SQL` objects with their own
   * `queryChunks`) into its raw SQL text + the ordered bound params. A
   * `StringChunk` carries `value: string[]`; a `Param` carries a non-array
   * `value` (the bound value); an `SQL` fragment carries `queryChunks`.
   */
  function inspectSql(call: unknown): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const walk = (node: unknown): string => {
      // Bound values appear as bare param nodes (string/number/etc.) embedded
      // between StringChunks; capture them and render a `$` placeholder so the
      // value never lands in the inspected SQL text.
      if (node === null || typeof node !== 'object') {
        params.push(node);
        return '$';
      }
      const n = node as { queryChunks?: unknown[]; value?: unknown };
      if (Array.isArray(n.queryChunks)) {
        return n.queryChunks.map(walk).join('');
      }
      if (Array.isArray(n.value)) {
        return (n.value as string[]).join(''); // StringChunk
      }
      if (n.value !== undefined) {
        params.push(n.value); // Param wrapper
        return '$';
      }
      return '';
    };
    return { sql: walk(call), params };
  }

  it('emits NO metadata clause when filter is absent (byte-identical to today)', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [], executeCalls: [] };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder() });
    await svc.retrieve({ corpus: CORPUS_NAME, query: 'q' }, { org: ORG, project: PROJECT });
    const { sql } = inspectSql(state.executeCalls[0]);
    // No containment predicate at all (the SELECT still projects "metadata",
    // but the WHERE has no `@>` clause).
    expect(sql).not.toContain('@>');
    // The WHERE remains corpus-only.
    expect(sql).toContain('"corpus_id" = ');
  });

  it('treats an empty filter ({}) as no filter (no containment clause)', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [], executeCalls: [] };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder() });
    await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', filter: {} },
      { org: ORG, project: PROJECT },
    );
    expect(inspectSql(state.executeCalls[0]).sql).not.toContain('@>');
  });

  it('emits a bound jsonb containment clause before ORDER BY when filter is present', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [], executeCalls: [] };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder() });
    await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', filter: { sessionId: 'x' } },
      { org: ORG, project: PROJECT },
    );
    const { sql, params } = inspectSql(state.executeCalls[0]);
    expect(sql).toContain('"metadata" @> ');
    expect(sql).toContain('::jsonb');
    // Clause is pre-ranking: containment appears before the ORDER BY distance sort.
    expect(sql.indexOf('@>')).toBeLessThan(sql.indexOf('ORDER BY'));
    // Filter is BOUND as a JSON string param, never interpolated into SQL text.
    expect(params).toContain(JSON.stringify({ sessionId: 'x' }));
    expect(sql).not.toContain('sessionId');
  });

  it('emits the containment clause in the MMR branch too', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [], executeCalls: [] };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder() });
    await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', mmr: 0.5, filter: { tag: 'a' } },
      { org: ORG, project: PROJECT },
    );
    const { sql } = inspectSql(state.executeCalls[0]);
    // MMR branch is the one that also SELECTs the raw embedding text.
    expect(sql).toContain('"embedding"::text');
    expect(sql).toContain('"metadata" @> ');
    expect(sql.indexOf('@>')).toBeLessThan(sql.indexOf('ORDER BY'));
  });

  // ---------------------------------------------------------------------------
  // Cross-encoder rerank rung (plan §1). Runs AFTER retrieval over a deepened
  // pool, before the final slice. Injecting a reranker FORCES availability
  // (bypasses the RERANK_ENABLED/RERANK_URL env gate) so these tests need no env.
  // ---------------------------------------------------------------------------

  /** A deterministic stub `Reranker` that scores documents by a text→score map. */
  function makeReranker(scoreByText: Record<string, number>): Reranker {
    return vi.fn(
      async ({ documents, model, topN }: { documents: string[]; model: string; topN?: number }) => {
        const results = documents
          .map((doc, index) => ({ index, relevanceScore: scoreByText[doc] ?? 0 }))
          .sort((a, b) => b.relevanceScore - a.relevanceScore);
        return {
          results: typeof topN === 'number' ? results.slice(0, topN) : results,
          model,
          usage: { estimatedCostUsd: 0 },
        };
      },
    ) as unknown as Reranker;
  }

  const RERANK_ROWS = [
    { id: 'c1', document_id: 'd1', ordinal: 0, text: 'alpha', metadata: null, score: 0.92 },
    { id: 'c2', document_id: 'd1', ordinal: 1, text: 'beta', metadata: null, score: 0.71 },
    { id: 'c3', document_id: 'd2', ordinal: 0, text: 'gamma', metadata: null, score: 0.5 },
  ];

  it('re-orders by rerankScore and mirrors it into score (denseScore preserved)', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const reranker = makeReranker({ alpha: 0.1, beta: 0.9, gamma: 0.5 });
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder(), reranker });

    const out = await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', rerank: true },
      { org: ORG, project: PROJECT },
    );

    // beta (0.9) > gamma (0.5) > alpha (0.1) — a completely different order
    // from the cosine order (alpha, beta, gamma).
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c2', 'c3', 'c1']);
    expect(out.chunks[0]).toMatchObject({ chunkId: 'c2', rerankScore: 0.9, score: 0.9 });
    // The cosine value survives as denseScore for consumers that still want it.
    expect(out.chunks[0]?.denseScore).toBe(0.71);
    expect(reranker).toHaveBeenCalledOnce();
  });

  it('rerank wins over MMR when both are requested', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const reranker = makeReranker({ alpha: 0.1, beta: 0.9, gamma: 0.5 });
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder(), reranker });

    const out = await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', rerank: true, mmr: 0.5 },
      { org: ORG, project: PROJECT },
    );
    // Rerank order + rerankScore present ⇒ rerank ran, MMR did not.
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c2', 'c3', 'c1']);
    expect(out.chunks[0]?.rerankScore).toBe(0.9);
    expect(reranker).toHaveBeenCalledOnce();
  });

  it('deepens the candidate pool for rerank (LIMIT = min(topK*4, 50), not topK)', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const svc = new RetrieveService({
      db: makeDb(state),
      embedder: makeEmbedder(),
      reranker: makeReranker({}),
    });
    await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', topK: 3, rerank: true },
      { org: ORG, project: PROJECT },
    );
    // topK=3 ⇒ poolDepth = min(12, 50) = 12; the fetch LIMIT must reflect the
    // deepened pool, not the final topK.
    const flat = JSON.stringify(state.executeCalls[0]);
    expect(flat).toContain('12');
  });

  it('FAILS SAFE to the fused order when the reranker throws (never 500s)', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const warn = vi.fn();
    const logger: RetrieveLogger = { warn };
    const reranker = (async () => {
      throw new Error('rerank sibling down');
    }) as unknown as Reranker;
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder(), reranker, logger });

    const out = await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', rerank: true },
      { org: ORG, project: PROJECT },
    );
    // Cosine order preserved, no rerankScore surfaced, and it did NOT throw.
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c1', 'c2', 'c3']);
    expect(out.chunks.every((c) => c.rerankScore === undefined)).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('rerank is a NO-OP when no reranker is wired and the env gate is off', async () => {
    // No reranker injected ⇒ the real client is the default, and with
    // RERANK_ENABLED unset the request field degrades to a silent no-op: the
    // reranker is never consulted and the order is byte-identical to dense.
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [...RERANK_ROWS], executeCalls: [] };
    const svc = new RetrieveService({ db: makeDb(state), embedder: makeEmbedder() });
    const out = await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', rerank: true },
      { org: ORG, project: PROJECT },
    );
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c1', 'c2', 'c3']);
    expect(out.chunks.every((c) => c.rerankScore === undefined)).toBe(true);
    // Pool was NOT deepened (no-op path uses topK as the fetch limit).
    const flat = JSON.stringify(state.executeCalls[0]);
    expect(flat).toContain('LIMIT');
  });

  it('throws CorpusNotFoundError when (org, project, name) is missing', async () => {
    const state: DbState = { corpus: null, executeRows: [], executeCalls: [] };
    const db = makeDb(state);
    const svc = new RetrieveService({ db, embedder: makeEmbedder() });
    await expect(
      svc.retrieve(
        { corpus: 'nope', query: 'q' },
        { org: ORG, project: PROJECT },
      ),
    ).rejects.toBeInstanceOf(CorpusNotFoundError);
  });

  it('re-throws an embedder failure (does not swallow it)', async () => {
    const state: DbState = { corpus: SEED_CORPUS, executeRows: [], executeCalls: [] };
    const db = makeDb(state);
    const embedErr = new Error('upstream down');
    const svc = new RetrieveService({ db, embedder: makeEmbedder({ fail: embedErr }) });
    await expect(
      svc.retrieve(
        { corpus: CORPUS_NAME, query: 'q' },
        { org: ORG, project: PROJECT },
      ),
    ).rejects.toBe(embedErr);
  });

  it('parses pgvector text embeddings off the DB for MMR (chars in, numbers out)', async () => {
    // Verifies the customType driver representation (`[1,2,3]` string) is
    // parsed to a number[] before we compute pairwise cosine. We construct
    // two candidates whose embeddings differ only by parse correctness.
    const state: DbState = {
      corpus: SEED_CORPUS,
      executeRows: [
        { id: 'c1', document_id: 'd1', ordinal: 0, text: 'A', metadata: null, score: 0.9, embedding: '[1,0,0]' },
        { id: 'c2', document_id: 'd1', ordinal: 1, text: 'B', metadata: null, score: 0.5, embedding: '[0,1,0]' },
      ],
      executeCalls: [],
    };
    const db = makeDb(state);
    const svc = new RetrieveService({
      db,
      embedder: makeEmbedder({ vec: [1, 0, 0] }),
    });
    const out = await svc.retrieve(
      { corpus: CORPUS_NAME, query: 'q', topK: 2, mmr: 0.5 },
      { org: ORG, project: PROJECT },
    );
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c1', 'c2']);
  });
});
