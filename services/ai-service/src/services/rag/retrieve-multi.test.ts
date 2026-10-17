// Unit tests for the multi-corpus fan-out + fusion machinery. Both collaborators
// (the per-corpus RetrieveService and the router) are stubbed, so no DB or LLM
// is touched — we assert the composition: fan-out, fusion, dedupe, cap, corpus
// tagging, per-corpus fail-safe diagnostics, and the rewrite hand-off.

import { describe, expect, it, vi } from 'vitest';

import type { Reranker } from '../ai/rerank/rerank-client.js';
import type { LLMRouter } from '../ai/router/types.js';
import {
  CorpusNotFoundError,
  SILENT_LEG_MESSAGE,
  type RetrieveContext,
  type RetrieveLogger,
  type RetrieveService,
  type SilentLegWarning,
} from './retrieve.js';
import { RetrieveMultiService } from './retrieve-multi.js';
import type { RetrievalLeg, RetrievedChunk } from './types.js';

const CTX = { org: 'o1', project: 'p1' };

/**
 * What a per-corpus retrieve is actually called with: the caller's `ctx` PLUS
 * this route's own `onSilentLeg` sink (see the silent-leg gate at the bottom of
 * this file). Matched as a superset so the knob-forwarding cases stay about
 * knobs — the sink itself is asserted where it belongs.
 */
const LEG_CTX = expect.objectContaining(CTX);

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
      LEG_CTX,
    );
    // `contributed` is the fusion-visibility field: what each corpus KEPT
    // after fusion + cap, alongside what it `matched`. `limit: 3` drops b2.
    expect(res.corpora).toEqual([
      { corpus: 'a', matched: 2, contributed: 2 },
      { corpus: 'b', matched: 2, contributed: 1 },
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
      { corpus: 'a', matched: 1, contributed: 1 },
      { corpus: 'missing', matched: 0, error: 'not_found', contributed: 0 },
    ]);
  });

  it('classifies a non-not-found error as "failed"', async () => {
    const { service } = stubRetrieveService({ a: 'boom' });
    const svc = new RetrieveMultiService({ db: {} as never, retrieveService: service, router: noRewriteRouter });
    const res = await svc.retrieveMulti({ corpora: ['a'], query: 'q' }, CTX);
    expect(res.chunks).toHaveLength(0);
    expect(res.corpora).toEqual([{ corpus: 'a', matched: 0, error: 'failed', contributed: 0 }]);
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
      LEG_CTX,
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
        LEG_CTX,
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

  it('logs ONE `rerank ok` line on success — counts and ids, never text', async () => {
    const { RERANK_OK_MESSAGE } = await import('./retrieve.js');
    const { service } = stubRetrieveService({
      a: [chunk('a1', 0.9), chunk('a2', 0.4)],
      b: [chunk('b1', 0.7), chunk('b2', 0.2)],
    });
    const base = stubReranker([3, 1]);
    // The real `callRerank` reports `egress`; this stub stands in for it.
    const reranker: Reranker = async (args) => ({
      ...(await base.reranker(args)),
      egress: { redactions: 1, counts: { curp: 1, rfc: 0, email: 0, phone: 0, address: 0, person: 0 } },
    });
    const logger = { warn: vi.fn(), info: vi.fn() };
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: service,
      router: noRewriteRouter,
      reranker,
      logger,
    });

    await svc.retrieveMulti(
      { corpora: ['a', 'b'], query: 'hi', topK: 5, limit: 3, rerank: true, rerankModel: 'm1' },
      CTX,
    );

    const lines = logger.info.mock.calls.filter((c) => c[1] === RERANK_OK_MESSAGE);
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toEqual({
      corpus: ['a', 'b'],
      org: 'o1',
      project: 'p1',
      model: 'm1',
      provider: expect.any(String),
      poolSize: 4,
      scored: 2,
      topK: 3,
      piiMinimised: true,
      piiRedactions: 1,
      piiCounts: { curp: 1 },
    });
    expect(JSON.stringify(lines[0]![0])).not.toMatch(/text |hi/);
  });

  it('`rerank ok` says piiMinimised:false when the reranker reported no egress', async () => {
    const { RERANK_OK_MESSAGE } = await import('./retrieve.js');
    const { service } = stubRetrieveService({ a: [chunk('a1', 0.5)] });
    const logger = { warn: vi.fn(), info: vi.fn() };
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: service,
      router: noRewriteRouter,
      reranker: stubReranker([0]).reranker,
      logger,
    });
    await svc.retrieveMulti({ corpora: ['a'], query: 'q', rerank: true }, CTX);
    const line = logger.info.mock.calls.find((c) => c[1] === RERANK_OK_MESSAGE)?.[0];
    expect(line).toMatchObject({ piiMinimised: false, piiRedactions: null, piiCounts: null });
  });

  it('a THROWING `info` logger does not turn a successful rerank into the fused fallback', async () => {
    // Same defect class as single `/v1/retrieve`: a log call inside the rerank
    // `try` lets a logging fault discard a good result and warn "rerank failed".
    const { service } = stubRetrieveService({
      a: [chunk('a1', 0.9), chunk('a2', 0.4)],
      b: [chunk('b1', 0.7), chunk('b2', 0.2)],
    });
    const warn = vi.fn();
    const logger = {
      warn,
      info: () => {
        throw new Error('log sink down');
      },
    };
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: service,
      router: noRewriteRouter,
      reranker: stubReranker([3, 1]).reranker,
      logger,
    });
    const res = await svc.retrieveMulti(
      { corpora: ['a', 'b'], query: 'q', topK: 5, limit: 2, rerank: true },
      CTX,
    );
    // Fused order is a1, b1, a2, b2; the reranker picked pool[3]=b2 then pool[1]=b1.
    expect(res.chunks.map((c) => c.chunkId)).toEqual(['b2', 'b1']);
    expect(res.chunks.every((c) => typeof c.rerankScore === 'number')).toBe(true);
    // (Other warns — e.g. a corpus that contributed nothing — are fine here.)
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('rerank failed'))).toHaveLength(0);
  });

  it('writes no `rerank ok` line when the reranker throws', async () => {
    const { RERANK_OK_MESSAGE } = await import('./retrieve.js');
    const { service } = stubRetrieveService({ a: [chunk('a1', 0.5)] });
    const logger = { warn: vi.fn(), info: vi.fn() };
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: service,
      router: noRewriteRouter,
      reranker: async () => {
        throw new Error('down');
      },
      logger,
    });
    await svc.retrieveMulti({ corpora: ['a'], query: 'q', rerank: true }, CTX);
    expect(logger.info.mock.calls.filter((c) => c[1] === RERANK_OK_MESSAGE)).toHaveLength(0);
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
    expect(retrieve).toHaveBeenNthCalledWith(1, expect.objectContaining({ corpus: 'a' }), LEG_CTX);
    expect(retrieve).toHaveBeenNthCalledWith(2, expect.objectContaining({ corpus: 'b' }), LEG_CTX);
    // One diagnostics row per unique corpus, in first-seen order — no duplicate row.
    expect(res.corpora).toEqual([
      { corpus: 'a', matched: 1, contributed: 1 },
      { corpus: 'b', matched: 1, contributed: 1 },
    ]);
    expect(res.chunks.map((c) => c.chunkId)).toEqual(['a1', 'b1']);
  });
});

// ── The silent-leg warn gate ────────────────────────────────────────────────
//
// `RetrieveService.retrieve` raises one signal per retrieval leg it asked for
// that came back with zero rows. Left to itself it LOGS that, which on single
// `/v1/retrieve` is the signal the whole lane exists to raise. On
// `/v1/retrieve/multi` a corpus matching nothing is ROUTINE and already
// reported as `{ corpus, matched: 0 }` — so a five-corpus fan-out where three
// legitimately match nothing would fire three of those per request (six in
// hybrid mode), and a warning that fires on ordinary traffic is a warning
// nobody reads.
//
// The mechanism is a per-call hook: `retrieveMulti` puts an `onSilentLeg` sink
// on the `ctx` it hands each corpus retrieve, buffers what arrives, and decides
// once that corpus settles. So the stub below dispatches the signal EXACTLY the
// way `retrieve.ts` does — through `ctx.onSilentLeg` when the caller supplied
// one, through the logger otherwise — and every assertion here is about what
// `retrieveMulti` did with it. The `retrieve.ts` half of the contract (the
// signal goes to the hook, and NOTHING else does) is pinned in
// `retrieve-legs.test.ts`.

/** The warning `RetrieveService.retrieve` raises for a leg that returned nothing. */
function silentLegWarn(
  corpus: string,
  leg: RetrievalLeg,
  mode: 'dense' | 'hybrid' = 'hybrid',
): SilentLegWarning {
  return { leg, corpus, corpusId: `id-${corpus}`, mode, org: CTX.org, project: CTX.project };
}

// Two of the other warns `RetrieveService` raises on this path. Neither is a
// silent-leg signal, so neither travels through the hook — and both MUST come
// out. Losing them would reintroduce, one layer up, exactly the silence this
// lane removed.
const SPARSE_DEGRADE = [
  { err: new Error('sparsevec down'), corpusId: 'id-a' },
  'sparse leg failed (query embed or sparsevec DB query); degrading hybrid to dense-only for this request',
] as const;
const RERANK_FAILED = [
  { err: new Error('reranker down'), model: 'm', poolSize: 4 },
  'rerank failed; falling back to fused order',
] as const;

interface LegBehaviour {
  chunks?: RetrievedChunk[];
  throws?: unknown;
  /** Legs of this corpus that came back with zero rows. */
  silent?: readonly RetrievalLeg[];
  /** Everything else the retrieve logs, in order. Goes straight to the logger. */
  warns?: ReadonlyArray<readonly [unknown, string]>;
  /** An await point INSIDE the retrieve, to force a deterministic interleave. */
  hold?: Promise<void>;
}

/**
 * Dispatch a silent-leg warning the way `RetrieveService.retrieve` does: to
 * `ctx.onSilentLeg` if the caller supplied one, to the logger otherwise. Kept
 * as one function so no stub in this file can accidentally test a dispatch
 * production does not perform.
 */
function raiseSilentLeg(
  ctx: RetrieveContext,
  logger: RetrieveLogger | undefined,
  warning: SilentLegWarning,
): void {
  if (ctx.onSilentLeg) ctx.onSilentLeg(warning);
  else logger?.warn(warning, SILENT_LEG_MESSAGE);
}

/** A `RetrieveService` stub that reports warnings the way the real one does. */
function warningStub(
  byCorpus: Record<string, LegBehaviour>,
  logger: RetrieveLogger,
): { service: RetrieveService; retrieve: ReturnType<typeof vi.fn> } {
  const retrieve = vi.fn(
    async (req: { corpus: string; mode?: string }, ctx: RetrieveContext) => {
      const b = byCorpus[req.corpus] ?? {};
      for (const [obj, msg] of b.warns ?? []) logger.warn(obj, msg);
      const mode = req.mode === 'hybrid' ? 'hybrid' : 'dense';
      for (const leg of b.silent ?? []) {
        raiseSilentLeg(ctx, logger, silentLegWarn(req.corpus, leg, mode));
      }
      if (b.hold) await b.hold;
      if (b.throws) throw b.throws;
      return { chunks: b.chunks ?? [] };
    },
  );
  return { service: { retrieve } as unknown as RetrieveService, retrieve };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A multi service over a warning stub, both sharing one logger. */
function withGate(byCorpus: Record<string, LegBehaviour>): {
  svc: RetrieveMultiService;
  logger: { warn: ReturnType<typeof vi.fn> };
} {
  const logger = { warn: vi.fn() };
  const { service } = warningStub(byCorpus, logger);
  const svc = new RetrieveMultiService({
    db: {} as never,
    retrieveService: service,
    router: noRewriteRouter,
    logger,
  });
  return { svc, logger };
}

describe('RetrieveMultiService silent-leg warn gate', () => {
  it("hands the caller's logger to the composed retrieve UNWRAPPED", async () => {
    // Structural half of "no other warning is ever swallowed". The only thing
    // this route treats differently is the silent-leg signal, and that is
    // diverted at its SOURCE by a per-call `ctx` hook — so there is nothing
    // sitting between the composed `RetrieveService` and the caller's logger
    // that could drop a sparse-degrade, passage-clamp or rerank warn. Anything
    // interposed here would break this assertion.
    const logger = { warn: vi.fn() };
    const svc = new RetrieveMultiService({ db: {} as never, router: noRewriteRouter, logger });
    const composed = (svc as unknown as { retrieveService: { logger?: RetrieveLogger } })
      .retrieveService;
    expect(composed.logger).toBe(logger);
  });

  it('still warns for a silent leg on a corpus that DID match (the dead-sparse-leg anomaly)', async () => {
    // Dense returned rows, the sparse leg returned none: the corpus looks
    // healthy (`matched: 2`) and NOTHING else reports the dead leg. This is the
    // case the gate must never swallow — and the reason a plain "suppress on
    // /multi" boolean would be wrong. The verdict depends on how the corpus
    // RESOLVED, which is only known after the retrieve settles.
    const { svc, logger } = withGate({
      a: { chunks: [chunk('a1', 0.9), chunk('a2', 0.4)], silent: ['sparse'] },
    });

    const res = await svc.retrieveMulti({ corpora: ['a'], query: 'q', mode: 'hybrid' }, CTX);

    expect(res.corpora).toEqual([{ corpus: 'a', matched: 2, contributed: 2 }]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(silentLegWarn('a', 'sparse'), SILENT_LEG_MESSAGE);
  });

  it('does NOT warn for a /multi corpus that matched nothing — `matched: 0` already reports it', async () => {
    // Hybrid over a corpus with nothing to say: both legs come back empty,
    // which is two warns per corpus under the ungated wiring.
    const { svc, logger } = withGate({ a: { chunks: [], silent: ['dense', 'sparse'] } });

    const res = await svc.retrieveMulti({ corpora: ['a'], query: 'q', mode: 'hybrid' }, CTX);

    // Reported where it belongs — in the response, not the logs.
    expect(res.corpora).toEqual([{ corpus: 'a', matched: 0, contributed: 0 }]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays silent on the routine corpora and is heard on the one anomaly', async () => {
    // The shape of an ordinary request: five corpora, three legitimately match
    // nothing (6 leg warns under the ungated wiring), one matches with a dead
    // sparse leg, one matches cleanly. Exactly ONE warn must come out.
    const { svc, logger } = withGate({
      empty1: { chunks: [], silent: ['dense', 'sparse'] },
      empty2: { chunks: [], silent: ['dense', 'sparse'] },
      empty3: { chunks: [], silent: ['dense', 'sparse'] },
      // `denseScore` is set because a REAL hybrid leg always returns one, and
      // cross-corpus fusion ranks on it. A stub without it would trip the
      // `UNSCORED_CANDIDATE_MESSAGE` warn and make this test about the wrong
      // thing.
      halfDead: { chunks: [chunk('h1', 0.8, { denseScore: 0.8 })], silent: ['sparse'] },
      healthy: { chunks: [chunk('k1', 0.7, { denseScore: 0.7 })] },
    });

    const res = await svc.retrieveMulti(
      { corpora: ['empty1', 'empty2', 'empty3', 'halfDead', 'healthy'], query: 'q', mode: 'hybrid' },
      CTX,
    );

    expect(res.chunks.map((c) => c.chunkId)).toEqual(['h1', 'k1']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      silentLegWarn('halfDead', 'sparse'),
      SILENT_LEG_MESSAGE,
    );
  });

  it('never swallows the non-leg warns, even from a corpus that matched nothing', async () => {
    // The gate holds ONLY the silent-leg signal. The sparse-degrade warn and the
    // rerank fail-safe warn are the signals this lane added one layer down; if a
    // zero-match corpus could mute them, the silence would just move up.
    const { svc, logger } = withGate({
      a: { chunks: [], silent: ['dense'], warns: [SPARSE_DEGRADE, RERANK_FAILED] },
    });

    await svc.retrieveMulti({ corpora: ['a'], query: 'q', mode: 'hybrid' }, CTX);

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls.map((c) => c[1])).toEqual([SPARSE_DEGRADE[1], RERANK_FAILED[1]]);
    // The leg warn — and only the leg warn — was dropped.
    expect(logger.warn.mock.calls.map((c) => c[1])).not.toContain(SILENT_LEG_MESSAGE);
  });

  it("logs a leg's buffered warnings when the leg THREW (an errored leg is not routine)", async () => {
    const { svc, logger } = withGate({
      boom: { silent: ['dense'], throws: new Error('db exploded') },
      gone: {
        silent: ['dense'],
        throws: new CorpusNotFoundError({ corpus: 'gone', org: CTX.org, project: CTX.project }),
      },
    });

    const res = await svc.retrieveMulti({ corpora: ['boom', 'gone'], query: 'q' }, CTX);

    expect(res.corpora).toEqual([
      { corpus: 'boom', matched: 0, error: 'failed', contributed: 0 },
      { corpus: 'gone', matched: 0, error: 'not_found', contributed: 0 },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls.map((c) => c[1])).toEqual([
      SILENT_LEG_MESSAGE,
      SILENT_LEG_MESSAGE,
    ]);
  });

  it("concurrent fan-outs over the same corpus do not settle each other's warnings", async () => {
    // Crosstalk is STRUCTURALLY impossible in this design — the buffer is a
    // local closed over by the `ctx` object one `retrieveMulti` call builds for
    // one corpus, so there is no shared place for a second request to reach.
    // This test pins that property observably rather than by inspection.
    //
    // Same SERVICE INSTANCE, same corpus, two in-flight requests. For request
    // ONE 'x' matches nothing (routine — drop). For request TWO it matches,
    // with a dead sparse leg (anomalous — must be heard). Fully forced: each
    // retrieve parks on its own deferred and they resolve in a fixed order —
    // no sleeps, no polling.
    const logger = { warn: vi.fn() };
    const d1 = deferred();
    const d2 = deferred();
    const behaviours: LegBehaviour[] = [
      { chunks: [], hold: d1.promise, silent: ['dense', 'sparse'] },
      { chunks: [chunk('x1', 0.5)], hold: d2.promise, silent: ['sparse'] },
    ];
    let nth = 0;
    const retrieve = vi.fn(async (req: { corpus: string }, ctx: RetrieveContext) => {
      const b = behaviours[nth++]!;
      for (const leg of b.silent ?? []) {
        raiseSilentLeg(ctx, logger, silentLegWarn(req.corpus, leg));
      }
      await b.hold;
      return { chunks: b.chunks };
    });
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: { retrieve } as unknown as RetrieveService,
      router: noRewriteRouter,
      logger,
    });

    // Both calls run synchronously into their retrieve (the first await is the
    // hold), so both signals are buffered before either request settles.
    const p1 = svc.retrieveMulti({ corpora: ['x'], query: 'q', mode: 'hybrid' }, CTX);
    const p2 = svc.retrieveMulti({ corpora: ['x'], query: 'q', mode: 'hybrid' }, CTX);
    expect(nth).toBe(2);
    expect(logger.warn).not.toHaveBeenCalled();

    d1.resolve();
    await p1; // request one: routine zero-match, drops ITS warnings only
    expect(logger.warn).not.toHaveBeenCalled();

    d2.resolve();
    await p2; // request two: matched with a silent leg, must still be heard

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(silentLegWarn('x', 'sparse'), SILENT_LEG_MESSAGE);
  });

  it("the multi service's own rerank fail-safe warn still reaches the logger", async () => {
    // Buffered warnings are logged through the same `this.logger` `applyRerank`
    // uses. A regression there would mute the fan-out's own fail-safe warn, so
    // it is asserted here rather than assumed.
    const logger = { warn: vi.fn() };
    const { service } = warningStub({ a: { chunks: [chunk('a1', 0.9)] } }, logger);
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: service,
      router: noRewriteRouter,
      logger,
      reranker: async () => {
        throw new Error('reranker down');
      },
    });

    await svc.retrieveMulti({ corpora: ['a'], query: 'q', rerank: true }, CTX);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]![1])).toBe(
      'multi-corpus rerank failed; falling back to fused order',
    );
  });
});
