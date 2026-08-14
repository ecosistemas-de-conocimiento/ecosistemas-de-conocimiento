// Unit tests for the multi-corpus fan-out + fusion machinery. Both collaborators
// (the per-corpus RetrieveService and the router) are stubbed, so no DB or LLM
// is touched — we assert the composition: fan-out, fusion, dedupe, cap, corpus
// tagging, per-corpus fail-safe diagnostics, and the rewrite hand-off.

import { describe, expect, it, vi } from 'vitest';

import type { Reranker } from '../ai/rerank/rerank-client.js';
import type { LLMRouter } from '../ai/router/types.js';
import { CorpusNotFoundError, type RetrieveService } from './retrieve.js';
import { RetrieveMultiService } from './retrieve-multi.js';
import type { RetrievedChunk } from './types.js';

const CTX = { org: 'o1', project: 'p1' };

function chunk(id: string, score: number, extra: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    ordinal: 0,
    text: `text ${id}`,
    score,
    ...extra,
  };
}

/** A RetrieveService stub keyed by corpus name. Unlisted corpora throw not-found. */
function stubRetrieveService(byCorpus: Record<string, RetrievedChunk[] | 'not_found' | 'boom'>): {
  service: RetrieveService;
  retrieve: ReturnType<typeof vi.fn>;
} {
  const retrieve = vi.fn(async (req: { corpus: string }) => {
    const v = byCorpus[req.corpus];
    if (v === undefined || v === 'not_found') {
      throw new CorpusNotFoundError({ corpus: req.corpus, org: CTX.org, project: CTX.project });
    }
    if (v === 'boom') throw new Error('db exploded');
    return { chunks: v };
  });
  return { service: { retrieve } as unknown as RetrieveService, retrieve };
}

const noRewriteRouter: LLMRouter = { route: vi.fn() };

/**
 * A deterministic offline reranker. `order` lists the document indices (into the
 * pool the service passes) from most to least relevant; each gets a descending
 * `relevanceScore`. Injecting any reranker also FORCES rerank availability, so
 * these tests never touch the `RERANK_ENABLED`/`RERANK_URL` env gate.
 */
function stubReranker(order: number[]): { reranker: Reranker; calls: () => number } {
  let count = 0;
  const reranker: Reranker = async ({ documents }) => {
    count += 1;
    const results = order
      .filter((i) => i < documents.length)
      .map((index, rank) => ({ index, relevanceScore: 1 - rank * 0.1 }));
    return { results, model: 'stub-reranker', usage: { estimatedCostUsd: 0 } };
  };
  return { reranker, calls: () => count };
}

describe('RetrieveMultiService.retrieveMulti', () => {
  it('fans out, fuses by score, tags corpus, and caps at limit', async () => {
    const { service, retrieve } = stubRetrieveService({
      a: [chunk('a1', 0.9), chunk('a2', 0.4)],
      b: [chunk('b1', 0.7), chunk('b2', 0.2)],
    });
    const svc = new RetrieveMultiService({ db: {} as never, retrieveService: service, router: noRewriteRouter });

    const res = await svc.retrieveMulti(
      { corpora: ['a', 'b'], query: 'hi', topK: 5, limit: 3 },
      CTX,
    );

    expect(res.query).toBe('hi');
    expect(res.rewritten).toBe(false);
    expect(res.chunks.map((c) => c.chunkId)).toEqual(['a1', 'b1', 'a2']);
    expect(res.chunks.map((c) => c.corpus)).toEqual(['a', 'b', 'a']);
    // Both legs queried with the same (unrewritten) query + forwarded topK.
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ corpus: 'a', query: 'hi', topK: 5 }),
      CTX,
    );
    expect(res.corpora).toEqual([
      { corpus: 'a', matched: 2 },
      { corpus: 'b', matched: 2 },
    ]);
  });

  it('records a missing corpus in diagnostics without failing the request', async () => {
    const { service } = stubRetrieveService({
      a: [chunk('a1', 0.5)],
      missing: 'not_found',
    });
    const svc = new RetrieveMultiService({ db: {} as never, retrieveService: service, router: noRewriteRouter });

    const res = await svc.retrieveMulti({ corpora: ['a', 'missing'], query: 'q' }, CTX);

    expect(res.chunks.map((c) => c.chunkId)).toEqual(['a1']);
    expect(res.corpora).toEqual([
      { corpus: 'a', matched: 1 },
      { corpus: 'missing', matched: 0, error: 'not_found' },
    ]);
  });

  it('classifies a non-not-found error as "failed"', async () => {
    const { service } = stubRetrieveService({ a: 'boom' });
    const svc = new RetrieveMultiService({ db: {} as never, retrieveService: service, router: noRewriteRouter });
    const res = await svc.retrieveMulti({ corpora: ['a'], query: 'q' }, CTX);
    expect(res.chunks).toHaveLength(0);
    expect(res.corpora).toEqual([{ corpus: 'a', matched: 0, error: 'failed' }]);
  });

  it('dedupes chunks that appear in more than one corpus (alias + target)', async () => {
    const { service } = stubRetrieveService({
      real: [chunk('shared', 0.6)],
      alias: [chunk('shared', 0.9)], // alias points at the same chunk, higher on this leg
    });
    const svc = new RetrieveMultiService({ db: {} as never, retrieveService: service, router: noRewriteRouter });
    const res = await svc.retrieveMulti({ corpora: ['real', 'alias'], query: 'q' }, CTX);
    // Kept once, at the higher-scoring occurrence (corpus 'alias').
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0]).toMatchObject({ chunkId: 'shared', corpus: 'alias', score: 0.9 });
  });

  it('rewrites the query before fan-out when a rewrite directive is present', async () => {
    const { service, retrieve } = stubRetrieveService({ a: [chunk('a1', 0.5)] });
    const router: LLMRouter = {
      route: vi.fn(async () => ({ content: 'standalone rewritten query' }) as never),
    };
    const svc = new RetrieveMultiService({ db: {} as never, retrieveService: service, router });

    const res = await svc.retrieveMulti(
      {
        corpora: ['a'],
        query: 'and those?',
        rewrite: {
          instruction: 'rewrite it',
          history: [{ role: 'user', content: 'earlier' }],
        },
      },
      CTX,
    );

    expect(res.rewritten).toBe(true);
    expect(res.query).toBe('standalone rewritten query');
    // The rewritten query is what the corpus is searched with.
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ corpus: 'a', query: 'standalone rewritten query' }),
      CTX,
    );
  });

  it('forwards hybrid/mmr/filter/asOf knobs to every leg', async () => {
    const { service, retrieve } = stubRetrieveService({ a: [], b: [] });
    const svc = new RetrieveMultiService({ db: {} as never, retrieveService: service, router: noRewriteRouter });
    await svc.retrieveMulti(
      {
        corpora: ['a', 'b'],
        query: 'q',
        mode: 'hybrid',
        mmr: 0.5,
        rrfK: 40,
        filter: { k: 'v' },
        asOf: '2026-01-01T00:00:00Z',
      },
      CTX,
    );
    for (const corpus of ['a', 'b']) {
      expect(retrieve).toHaveBeenCalledWith(
        expect.objectContaining({
          corpus,
          mode: 'hybrid',
          mmr: 0.5,
          rrfK: 40,
          filter: { k: 'v' },
          asOf: '2026-01-01T00:00:00Z',
        }),
        CTX,
      );
    }
  });

  it('reranks the FUSED pool after fusion, surfacing rerankScore and re-ordering', async () => {
    // Fused order by score: a1(0.9), b1(0.7), a2(0.4), b2(0.2). The reranker
    // (over that pool, indices 0..3) promotes b2 then b1 then a1.
    const { service, retrieve } = stubRetrieveService({
      a: [chunk('a1', 0.9), chunk('a2', 0.4)],
      b: [chunk('b1', 0.7), chunk('b2', 0.2)],
    });
    const { reranker } = stubReranker([3, 1, 0, 2]);
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: service,
      router: noRewriteRouter,
      reranker,
    });

    const res = await svc.retrieveMulti(
      { corpora: ['a', 'b'], query: 'hi', topK: 5, limit: 3, rerank: true },
      CTX,
    );

    // Reranked, cross-corpus order; corpus provenance preserved.
    expect(res.chunks.map((c) => c.chunkId)).toEqual(['b2', 'b1', 'a1']);
    expect(res.chunks.map((c) => c.corpus)).toEqual(['b', 'b', 'a']);
    // rerankScore surfaced AND `score` overwritten to match it.
    for (const c of res.chunks) {
      expect(c.rerankScore).toBeTypeOf('number');
      expect(c.score).toBe(c.rerankScore);
    }
    // rerank is NOT forwarded to the per-corpus legs (it runs once, post-fusion).
    expect(retrieve.mock.calls[0]![0]).not.toHaveProperty('rerank');
    expect(retrieve.mock.calls[0]![0]).not.toHaveProperty('rerankModel');
  });

  it('drops mmr from the legs when rerank is active (mutually exclusive)', async () => {
    const { service, retrieve } = stubRetrieveService({ a: [chunk('a1', 0.5)] });
    const { reranker } = stubReranker([0]);
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: service,
      router: noRewriteRouter,
      reranker,
    });

    await svc.retrieveMulti({ corpora: ['a'], query: 'q', mmr: 0.5, rerank: true }, CTX);

    // rerank wins: mmr is not forwarded to the leg.
    expect(retrieve.mock.calls[0]![0]).not.toHaveProperty('mmr');
  });

  it('still forwards mmr to the legs when rerank is requested but NOT injected/wired', async () => {
    // No reranker injected and no env gate ⇒ rerank unavailable ⇒ degrades to
    // the fused order, and mmr keeps flowing to the legs as usual.
    const { service, retrieve } = stubRetrieveService({ a: [chunk('a1', 0.5)] });
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: service,
      router: noRewriteRouter,
    });

    const res = await svc.retrieveMulti(
      { corpora: ['a'], query: 'q', mmr: 0.5, rerank: true },
      CTX,
    );

    expect(retrieve.mock.calls[0]![0]).toMatchObject({ mmr: 0.5 });
    expect(res.chunks.map((c) => c.chunkId)).toEqual(['a1']);
    expect(res.chunks[0]).not.toHaveProperty('rerankScore');
  });

  it('fails safe to the fused order when the reranker throws', async () => {
    const { service } = stubRetrieveService({
      a: [chunk('a1', 0.9), chunk('a2', 0.4)],
      b: [chunk('b1', 0.7)],
    });
    const boomReranker: Reranker = async () => {
      throw new Error('reranker down');
    };
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: service,
      router: noRewriteRouter,
      reranker: boomReranker,
    });

    const res = await svc.retrieveMulti(
      { corpora: ['a', 'b'], query: 'q', limit: 3, rerank: true },
      CTX,
    );

    // Fused order, no rerankScore anywhere — a broken reranker never 500s.
    expect(res.chunks.map((c) => c.chunkId)).toEqual(['a1', 'b1', 'a2']);
    for (const c of res.chunks) expect(c).not.toHaveProperty('rerankScore');
  });

  it('never returns fewer chunks than the un-reranked path when limit exceeds the rerank pool cap', async () => {
    // 100 fused candidates: all of corpus 'a' (scores 1.00→0.951) rank above all
    // of corpus 'b' (0.90→0.851), so the fused order is a0..a49, b0..b49. With
    // limit:100 the rerank pool is capped at 50 (RERANK_POOL_CAP) = a0..a49, so
    // the reranker can score at most 50 chunks. Enabling rerank must STILL
    // return 100 — the fix backfills the tail (b0..b49) from the FULL fused
    // order, so toggling the polish flag never drops valid results.
    const aChunks = Array.from({ length: 50 }, (_, i) => chunk(`a${i}`, 1.0 - i * 0.001));
    const bChunks = Array.from({ length: 50 }, (_, i) => chunk(`b${i}`, 0.9 - i * 0.001));
    const { service } = stubRetrieveService({ a: aChunks, b: bChunks });
    // Reranker reverses the 50-chunk pool (a49 first … a0 last).
    const { reranker } = stubReranker(Array.from({ length: 50 }, (_, i) => 49 - i));
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: service,
      router: noRewriteRouter,
      reranker,
    });

    const base = { corpora: ['a', 'b'], query: 'q', topK: 50, limit: 100 };
    const off = await svc.retrieveMulti({ ...base, rerank: false }, CTX);
    const on = await svc.retrieveMulti({ ...base, rerank: true }, CTX);

    // Same count with rerank on vs off — the fix's core guarantee.
    expect(off.chunks).toHaveLength(100);
    expect(on.chunks).toHaveLength(100);
    expect(on.chunks.length).toBe(off.chunks.length);
    // Same SET of chunks either way — rerank only reorders the head.
    expect(new Set(on.chunks.map((c) => c.chunkId))).toEqual(
      new Set(off.chunks.map((c) => c.chunkId)),
    );

    // Reranked head first: the reversed pool (a49 … a0), each with a rerankScore.
    const head = on.chunks.slice(0, 50);
    expect(head.map((c) => c.chunkId)).toEqual(
      Array.from({ length: 50 }, (_, i) => `a${49 - i}`),
    );
    for (const c of head) {
      expect(c.rerankScore).toBeTypeOf('number');
      expect(c.score).toBe(c.rerankScore);
    }
    // Backfilled tail: the un-reranked fused remainder (b0 … b49), no rerankScore.
    const tail = on.chunks.slice(50);
    expect(tail.map((c) => c.chunkId)).toEqual(
      Array.from({ length: 50 }, (_, i) => `b${i}`),
    );
    for (const c of tail) expect(c).not.toHaveProperty('rerankScore');
  });

  it('de-duplicates the corpora list before fan-out (first-seen order preserved)', async () => {
    const { service, retrieve } = stubRetrieveService({
      a: [chunk('a1', 0.9)],
      b: [chunk('b1', 0.7)],
    });
    const svc = new RetrieveMultiService({ db: {} as never, retrieveService: service, router: noRewriteRouter });

    const res = await svc.retrieveMulti({ corpora: ['a', 'b', 'a'], query: 'q' }, CTX);

    // 'a' retrieved once despite appearing twice; no redundant per-corpus call.
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(retrieve).toHaveBeenNthCalledWith(1, expect.objectContaining({ corpus: 'a' }), CTX);
    expect(retrieve).toHaveBeenNthCalledWith(2, expect.objectContaining({ corpus: 'b' }), CTX);
    // One diagnostics row per unique corpus, in first-seen order — no duplicate row.
    expect(res.corpora).toEqual([
      { corpus: 'a', matched: 1 },
      { corpus: 'b', matched: 1 },
    ]);
    expect(res.chunks.map((c) => c.chunkId)).toEqual(['a1', 'b1']);
  });
});
