// Retrieval metering (AIS-7, retrieval half) and the on-the-wire rerank signal
// (AIS-10) for `RetrieveService.retrieve` and `RetrieveMultiService.retrieveMulti`.
//
// The DB is a minimal stub: the corpus lookup returns one row and `execute`
// returns the candidate rows. Tenant scoping is NOT what this file is about —
// `retrieve.test.ts` pins that with a predicate recorder. The budget is a fake
// with the enforcer's `reserve` / `refund` / `adjust` surface, recording calls
// in order alongside the embedder and reranker so the bracket can be asserted.

import { describe, expect, it, vi } from 'vitest';

import { BudgetExceeded } from '../budget/errors.js';
import type { Reranker } from '../ai/rerank/rerank-client.js';
import type { LLMRouter } from '../ai/router/types.js';
import { priceForEmbedding } from '../ai/router/task-profiles.js';
import { RetrieveService, type Embedder } from './retrieve.js';
import { RetrieveMultiService } from './retrieve-multi.js';
import type { RetrievalBudget } from './retrieval-meter.js';
import type { RetrieveResult } from './types.js';

const CTX = { org: 'org-1', project: 'proj-1' };
const MODEL = 'openai/text-embedding-3-small'; // priced in MODEL_PRICING
const QUERY = 'q'.repeat(4_000); // 1,000 estimated tokens ⇒ a non-zero reserve
const SEED_CORPUS = {
  id: '00000000-0000-4000-8000-000000000001',
  org: CTX.org,
  project: CTX.project,
  name: 'docs',
  embeddingModel: MODEL,
  embeddingDim: 1024,
  chunkStrategy: 'recursive-char',
  chunkSize: 800,
  chunkOverlap: 100,
};
const ROWS = [
  { id: 'c1', document_id: 'd1', ordinal: 0, text: 'alpha', metadata: null, score: 0.9 },
  { id: 'c2', document_id: 'd1', ordinal: 1, text: 'beta', metadata: null, score: 0.8 },
];

function makeDb(): import('../../db/client.js').Db {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [SEED_CORPUS] }) }),
    }),
    execute: vi.fn(async () => ROWS),
  } as unknown as import('../../db/client.js').Db;
}

/** A call log shared by the fakes, so ORDER across budget/embed/rerank is assertable. */
type Call = [string, ...unknown[]];

function makeBudget(log: Call[], opts: { refuse?: boolean; softCap?: boolean } = {}) {
  const budget = {
    reserve: vi.fn(async (input: { org: string; amountUsd: number }) => {
      log.push(['reserve', input.amountUsd]);
      if (opts.refuse) throw new BudgetExceeded(input.org, input.amountUsd, 0);
      return { remainingUsd: 1, softCap: opts.softCap ?? false };
    }),
    refund: vi.fn(async (input: { amountUsd: number }) => {
      log.push(['refund', input.amountUsd]);
    }),
    adjust: vi.fn(async (input: { deltaUsd: number }) => {
      log.push(['adjust', input.deltaUsd]);
    }),
  };
  return budget as typeof budget & RetrievalBudget;
}

function makeEmbedder(log: Call[], opts: { fail?: Error; inputTokens?: number } = {}): Embedder {
  return vi.fn(async ({ model }: { model: string }) => {
    log.push(['embed']);
    if (opts.fail) throw opts.fail;
    return {
      embeddings: [[0.1, 0.2, 0.3]],
      model,
      usage: { inputTokens: opts.inputTokens ?? 500, estimatedCostUsd: 0 },
    };
  }) as unknown as Embedder;
}

function okReranker(log: Call[], costUsd = 0): Reranker {
  return vi.fn(async ({ documents, model }) => {
    log.push(['rerank']);
    return {
      results: documents.map((_: string, index: number) => ({ index, relevanceScore: 1 - index / 10 })),
      model,
      usage: { estimatedCostUsd: costUsd },
    };
  }) as Reranker;
}

function failingReranker(): Reranker {
  return vi.fn(async () => {
    throw new Error('connection refused http://reranker.internal:8000');
  }) as Reranker;
}

const ESTIMATE = priceForEmbedding(MODEL, 1_000);
const ACTUAL_EMBED = priceForEmbedding(MODEL, 500);

describe('RetrieveService — budget metering', () => {
  it('reserves the embed estimate BEFORE the embed and trues up to the actual after', async () => {
    const log: Call[] = [];
    const svc = new RetrieveService({
      db: makeDb(),
      embedder: makeEmbedder(log),
      budget: makeBudget(log),
    });
    await svc.retrieve({ corpus: 'docs', query: QUERY }, CTX);
    expect(ESTIMATE).toBeGreaterThan(0);
    expect(log.map((c) => c[0])).toEqual(['reserve', 'embed', 'adjust']);
    expect(log[0]![1]).toBeCloseTo(ESTIMATE, 12);
    expect(log[2]![1]).toBeCloseTo(ESTIMATE - ACTUAL_EMBED, 12);
  });

  it('over budget fails with BudgetExceeded (402) and never calls the embedder', async () => {
    const log: Call[] = [];
    const embedder = makeEmbedder(log);
    const svc = new RetrieveService({
      db: makeDb(),
      embedder,
      budget: makeBudget(log, { refuse: true }),
    });
    const err = await svc.retrieve({ corpus: 'docs', query: QUERY }, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceeded);
    expect((err as BudgetExceeded).status).toBe(402);
    expect(embedder).not.toHaveBeenCalled();
  });

  it('refunds the whole reserve when the embed fails, and rethrows', async () => {
    const log: Call[] = [];
    const svc = new RetrieveService({
      db: makeDb(),
      embedder: makeEmbedder(log, { fail: new Error('embed down') }),
      budget: makeBudget(log),
    });
    await expect(svc.retrieve({ corpus: 'docs', query: QUERY }, CTX)).rejects.toThrow('embed down');
    expect(log.map((c) => c[0])).toEqual(['reserve', 'embed', 'refund']);
    expect(log[2]![1]).toBeCloseTo(ESTIMATE, 12);
  });

  it('charges the rerank cost the reranker reported at the true-up', async () => {
    const log: Call[] = [];
    const svc = new RetrieveService({
      db: makeDb(),
      embedder: makeEmbedder(log),
      reranker: okReranker(log, 0.003),
      budget: makeBudget(log),
    });
    await svc.retrieve({ corpus: 'docs', query: QUERY, rerank: true }, CTX);
    expect(log.map((c) => c[0])).toEqual(['reserve', 'embed', 'rerank', 'adjust']);
    expect(log[3]![1]).toBeCloseTo(ESTIMATE - ACTUAL_EMBED - 0.003, 12);
  });

  it('surfaces a soft-cap crossing as a BUDGET_SOFT_CAP warning', async () => {
    const log: Call[] = [];
    const svc = new RetrieveService({
      db: makeDb(),
      embedder: makeEmbedder(log),
      budget: makeBudget(log, { softCap: true }),
    });
    const out = await svc.retrieve({ corpus: 'docs', query: QUERY }, CTX);
    expect(out.warnings).toEqual([expect.objectContaining({ code: 'BUDGET_SOFT_CAP' })]);
  });
});

describe('RetrieveService — rerank degradation reaches the response', () => {
  it('a failing reranker returns 200-shaped chunks AND a RERANK_DEGRADED/error warning', async () => {
    const svc = new RetrieveService({
      db: makeDb(),
      embedder: makeEmbedder([]),
      reranker: failingReranker(),
    });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', rerank: true }, CTX);
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c1', 'c2']);
    expect(out.legs).not.toContain('rerank');
    expect(out.warnings).toEqual([{ code: 'RERANK_DEGRADED', reason: 'error', message: expect.any(String) }]);
    // Upstream error text stays in the log; it never reaches the wire.
    expect(JSON.stringify(out.warnings)).not.toContain('reranker.internal');
  });

  it('rerank asked for on a server with none configured warns `unavailable`', async () => {
    const svc = new RetrieveService({ db: makeDb(), embedder: makeEmbedder([]) });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', rerank: true }, CTX);
    expect(out.warnings).toEqual([expect.objectContaining({ code: 'RERANK_DEGRADED', reason: 'unavailable' })]);
  });

  it('a successful rerank carries no warnings field at all', async () => {
    const svc = new RetrieveService({
      db: makeDb(),
      embedder: makeEmbedder([]),
      reranker: okReranker([]),
    });
    const out = await svc.retrieve({ corpus: 'docs', query: 'q', rerank: true }, CTX);
    expect(out.legs).toContain('rerank');
    expect(out).not.toHaveProperty('warnings');
  });
});

// ── /v1/retrieve/multi ─────────────────────────────────────────────────────

const noRewrite: LLMRouter = { route: vi.fn() } as unknown as LLMRouter;

function stubService(byCorpus: Record<string, RetrieveResult | Error>) {
  return {
    retrieve: vi.fn(async (req: { corpus: string }) => {
      const v = byCorpus[req.corpus];
      if (v instanceof Error) throw v;
      return v!;
    }),
  } as unknown as RetrieveService;
}

const chunk = (id: string, score: number) => ({
  chunkId: id,
  documentId: `d-${id}`,
  ordinal: 0,
  text: id,
  score,
  denseScore: score,
});

describe('RetrieveMultiService — legs and warnings', () => {
  it('returns the UNION of per-corpus legs in stable order', async () => {
    const multi = new RetrieveMultiService({
      db: makeDb(),
      router: noRewrite,
      retrieveService: stubService({
        a: { chunks: [chunk('a1', 0.9)], legs: ['dense', 'sparse'] },
        b: { chunks: [chunk('b1', 0.8)], legs: ['dense', 'lexical'] },
      }),
    });
    const out = await multi.retrieveMulti({ corpora: ['a', 'b'], query: 'q' }, CTX);
    expect(out.legs).toEqual(['dense', 'lexical', 'sparse']);
    expect(out).not.toHaveProperty('warnings');
  });

  it('adds `rerank` to legs when the post-fusion cross-encoder scored rows', async () => {
    const multi = new RetrieveMultiService({
      db: makeDb(),
      router: noRewrite,
      reranker: okReranker([]),
      retrieveService: stubService({ a: { chunks: [chunk('a1', 0.9)], legs: ['dense'] } }),
    });
    const out = await multi.retrieveMulti({ corpora: ['a'], query: 'q', rerank: true }, CTX);
    expect(out.legs).toEqual(['dense', 'rerank']);
  });

  it('a failing post-fusion rerank warns RERANK_DEGRADED/error on the wire', async () => {
    const multi = new RetrieveMultiService({
      db: makeDb(),
      router: noRewrite,
      reranker: failingReranker(),
      retrieveService: stubService({ a: { chunks: [chunk('a1', 0.9)], legs: ['dense'] } }),
    });
    const out = await multi.retrieveMulti({ corpora: ['a'], query: 'q', rerank: true }, CTX);
    expect(out.legs).toEqual(['dense']);
    expect(out.warnings).toEqual([expect.objectContaining({ code: 'RERANK_DEGRADED', reason: 'error' })]);
  });

  it('rerank asked for with none configured warns `unavailable`', async () => {
    const multi = new RetrieveMultiService({
      db: makeDb(),
      router: noRewrite,
      retrieveService: stubService({ a: { chunks: [chunk('a1', 0.9)], legs: ['dense'] } }),
    });
    const out = await multi.retrieveMulti({ corpora: ['a'], query: 'q', rerank: true }, CTX);
    expect(out.warnings).toEqual([expect.objectContaining({ code: 'RERANK_DEGRADED', reason: 'unavailable' })]);
  });

  it('forwards per-corpus warnings once each, deduplicated', async () => {
    const soft = { code: 'BUDGET_SOFT_CAP' as const, message: 'low' };
    const multi = new RetrieveMultiService({
      db: makeDb(),
      router: noRewrite,
      retrieveService: stubService({
        a: { chunks: [chunk('a1', 0.9)], legs: ['dense'], warnings: [soft] },
        b: { chunks: [chunk('b1', 0.8)], legs: ['dense'], warnings: [soft] },
      }),
    });
    const out = await multi.retrieveMulti({ corpora: ['a', 'b'], query: 'q' }, CTX);
    expect(out.warnings).toEqual([soft]);
  });

  it('a budget refusal in one corpus fails the WHOLE call (not a `failed` diagnostics row)', async () => {
    const multi = new RetrieveMultiService({
      db: makeDb(),
      router: noRewrite,
      retrieveService: stubService({
        a: { chunks: [chunk('a1', 0.9)], legs: ['dense'] },
        b: new BudgetExceeded(CTX.org, 0.01, 0),
      }),
    });
    await expect(multi.retrieveMulti({ corpora: ['a', 'b'], query: 'q' }, CTX)).rejects.toBeInstanceOf(
      BudgetExceeded,
    );
  });

  it('meters the per-corpus embeds AND the post-fusion rerank cost', async () => {
    const log: Call[] = [];
    const budget = makeBudget(log);
    const metered = new RetrieveMultiService({
      db: makeDb(),
      router: noRewrite,
      reranker: okReranker(log, 0.002),
      budget,
      retrieveService: new RetrieveService({ db: makeDb(), embedder: makeEmbedder(log), budget }),
    });
    await metered.retrieveMulti({ corpora: ['docs'], query: QUERY, rerank: true }, CTX);
    expect(log.map((c) => c[0])).toEqual(['reserve', 'embed', 'adjust', 'reserve', 'rerank', 'adjust']);
    // The rerank reserve is $0 (no price table) and its true-up charges the cost.
    expect(log[3]![1]).toBe(0);
    expect(log[5]![1]).toBeCloseTo(-0.002, 12);
  });
});
