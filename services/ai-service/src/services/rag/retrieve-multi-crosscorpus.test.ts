// Cross-corpus score normalization before rank fusion — the defect measured,
// and the two properties the repair must not break.
//
// Everything here drives the PUBLIC surface (`RetrieveMultiService`) with a
// stubbed per-corpus `RetrieveService`, on purpose: the whole file can be
// dropped onto the UNFIXED tree and run, and the defect cases go red on
// assertions rather than on a missing import. That is how the red was proved.
//
// RED PROVED — this file copied verbatim onto `origin/main` (1429a50):
//   ✗ shuts the deeper corpus out of every slot   (got o1..o8, thread got none)
//   ✗ reports which corpus contributed            (`contributed` undefined)
//   ✗ resolves a tie the same way whatever order  (order followed the request)
//   ✗ warns when a corpus matched but contributed (no warn emitted)
//   ✗ single-corpus hybrid is untouched           (ORDER matched; red only on
//                                                  the new `fusion` field)
//   ✗ multi-corpus dense is untouched              (same — order matched)
// ⚠ Read that honestly: the last two prove NOTHING about the ordering defect.
//   Their ordering assertions passed on the unfixed tree, which is the point of
//   a no-op guard. Their ability to fail on ORDER was established separately by
//   a positive control — see their note below.

import { describe, expect, it, vi } from 'vitest';

import type { LLMRouter } from '../ai/router/types.js';
import type { RetrieveLogger, RetrieveService } from './retrieve.js';
import { CORPUS_SHUTOUT_MESSAGE, RetrieveMultiService } from './retrieve-multi.js';
import type { RetrievedChunk } from './types.js';

const CTX = { org: 'o1', project: 'p1' };
const noRewriteRouter: LLMRouter = { route: vi.fn() };

/** RRF damping constant — the value `retrieve.ts` uses (Cormack et al. 2009). */
const K = 60;

/**
 * A hybrid chunk exactly as `RetrieveService.retrieve` emits one: `score` is
 * the per-corpus RRF value (built from ranks INSIDE that corpus's own pool),
 * `denseScore`/`lexicalScore` are the raw per-leg scores. The gap between those
 * two facts is the entire defect.
 */
function hybridChunk(
  id: string,
  opts: { denseRank: number; lexicalRank: number; denseScore: number; lexicalScore: number },
): RetrievedChunk {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    ordinal: 0,
    text: `text ${id}`,
    score: 1 / (K + opts.denseRank) + 1 / (K + opts.lexicalRank),
    denseScore: opts.denseScore,
    lexicalScore: opts.lexicalScore,
    ranks: { dense: opts.denseRank, lexical: opts.lexicalRank },
  };
}

function stubRetrieveService(byCorpus: Record<string, RetrievedChunk[]>): RetrieveService {
  const retrieve = vi.fn(async (req: { corpus: string }) => ({
    chunks: byCorpus[req.corpus] ?? [],
  }));
  return { retrieve } as unknown as RetrieveService;
}

// ── The measured shape ──────────────────────────────────────────────────────
//
// `org-7` holds 10 chunks; its 8 hits therefore sit at ranks 1–8 of a 10-deep
// pool — near the arithmetic maximum an RRF score can reach.
// `thread-49` holds 180 chunks; its BEST chunk is dense-rank 1 but only
// lexical-rank 22 inside its own 180-deep pool.
//
// The per-leg SCORES say `org-7`'s o1/o2 lead and then `thread-49` takes over.
// The per-corpus RRF SCORES say `org-7` wins all eight slots, because rank is a
// within-corpus statistic and the deeper pool is punished for its depth.
const ORG_HITS = [
  hybridChunk('o1', { denseRank: 1, lexicalRank: 1, denseScore: 0.8, lexicalScore: 0.5 }),
  hybridChunk('o2', { denseRank: 2, lexicalRank: 2, denseScore: 0.78, lexicalScore: 0.48 }),
  // o3–o8: still ranks 3–8 of a 10-deep pool, but on the raw per-leg scores
  // they sit BELOW every `thread-49` hit.
  ...([[3, 0.5, 0.3], [4, 0.49, 0.29], [5, 0.48, 0.28], [6, 0.47, 0.27], [7, 0.46, 0.26], [8, 0.45, 0.25]] as const).map(
    ([i, d, l]) => hybridChunk(`o${i}`, { denseRank: i, lexicalRank: i, denseScore: d, lexicalScore: l }),
  ),
];
const THREAD_HITS = ([[1, 0.72, 0.4], [2, 0.71, 0.39], [3, 0.7, 0.38], [4, 0.69, 0.37], [5, 0.68, 0.36], [6, 0.67, 0.35], [7, 0.66, 0.34], [8, 0.65, 0.33]] as const).map(
  ([i, d, l]) => hybridChunk(`t${i}`, { denseRank: i, lexicalRank: 21 + i, denseScore: d, lexicalScore: l }),
);

describe('cross-corpus score normalization before rank fusion', () => {
  it('does not shut a 180-chunk corpus out of every slot for being deeper', async () => {
    // The precondition that makes this a real reproduction, asserted rather
    // than assumed: under the OLD rule every `org-7` hit outscores every
    // `thread-49` hit, so a plain sort on `score` hands `org-7` all 8 slots.
    const worstOrg = Math.min(...ORG_HITS.map((c) => c.score));
    const bestThread = Math.max(...THREAD_HITS.map((c) => c.score));
    expect(bestThread).toBeLessThan(worstOrg);
    expect(bestThread).toBeCloseTo(0.02859, 5); // measured: 0.02863
    expect(worstOrg).toBeCloseTo(0.02941, 5); // measured: 0.02941
    // …while on the per-leg scores the thread chunk is plainly the stronger.
    expect(THREAD_HITS[0]!.lexicalScore!).toBeGreaterThan(ORG_HITS[7]!.lexicalScore!);
    expect(THREAD_HITS[0]!.denseScore!).toBeGreaterThan(ORG_HITS[7]!.denseScore!);

    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: stubRetrieveService({ 'org-7': ORG_HITS, 'thread-49': THREAD_HITS }),
      router: noRewriteRouter,
    });

    const res = await svc.retrieveMulti(
      { corpora: ['org-7', 'thread-49'], query: 'what does the attachment say', mode: 'hybrid', topK: 8, limit: 8 },
      CTX,
    );

    // Ranked on GLOBAL per-leg ranks: o1, o2 genuinely lead, then the thread
    // chunks take over. The attachment reaches the model.
    expect(res.chunks.map((c) => c.chunkId)).toEqual([
      'o1', 'o2', 't1', 't2', 't3', 't4', 't5', 't6',
    ]);
    expect(res.fusion).toBe('cross-corpus-rrf');
    // `score` is the global RRF value and matches the returned order.
    expect(res.chunks.map((c) => c.score)).toEqual(
      [...res.chunks.map((c) => c.score)].sort((a, b) => b - a),
    );
    expect(res.chunks[0]!.score).toBeCloseTo(2 / (K + 1), 10);
    // Per-leg evidence is left intact for consumers that threshold on it.
    expect(res.chunks[2]).toMatchObject({ chunkId: 't1', corpus: 'thread-49', denseScore: 0.72 });
  });

  it('reports what each corpus contributed, not just what it matched', async () => {
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: stubRetrieveService({ 'org-7': ORG_HITS, 'thread-49': THREAD_HITS }),
      router: noRewriteRouter,
    });

    const res = await svc.retrieveMulti(
      { corpora: ['org-7', 'thread-49'], query: 'q', mode: 'hybrid', topK: 8, limit: 8 },
      CTX,
    );

    expect(res.corpora).toEqual([
      { corpus: 'org-7', matched: 8, contributed: 2 },
      { corpus: 'thread-49', matched: 8, contributed: 6 },
    ]);
  });

  it('warns when a corpus matched and then contributed nothing', async () => {
    // `limit: 2` lets only o1/o2 through, so `thread-49` really is shut out —
    // legitimately this time. The point is that it is no longer SILENT.
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: stubRetrieveService({ 'org-7': ORG_HITS, 'thread-49': THREAD_HITS }),
      router: noRewriteRouter,
      logger: logger as unknown as RetrieveLogger,
    });

    const res = await svc.retrieveMulti(
      { corpora: ['org-7', 'thread-49'], query: 'q', mode: 'hybrid', topK: 8, limit: 2 },
      CTX,
    );

    expect(res.corpora[1]).toMatchObject({ corpus: 'thread-49', matched: 8, contributed: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ corpus: 'thread-49', matched: 8, fusion: 'cross-corpus-rrf' }),
      CORPUS_SHUTOUT_MESSAGE,
    );
  });

  it('resolves a tie the same way whichever corpus the caller lists first', async () => {
    // Two chunks that are identical on every ranking signal. `Array.sort` is
    // stable and the fan-out built its list in request-corpus order, so the old
    // rule gave the win to whichever corpus was named first. A tie-break must not be able to see
    // the request order.
    const same = { denseRank: 1, lexicalRank: 1, denseScore: 0.6, lexicalScore: 0.3 };
    const service = stubRetrieveService({
      org: [hybridChunk('z-org', same)],
      thread: [hybridChunk('a-thread', same)],
    });
    const svc = new RetrieveMultiService({ db: {} as never, retrieveService: service, router: noRewriteRouter });

    const orgFirst = await svc.retrieveMulti(
      { corpora: ['org', 'thread'], query: 'q', mode: 'hybrid', topK: 2, limit: 2 },
      CTX,
    );
    const threadFirst = await svc.retrieveMulti(
      { corpora: ['thread', 'org'], query: 'q', mode: 'hybrid', topK: 2, limit: 2 },
      CTX,
    );

    expect(orgFirst.chunks.map((c) => c.chunkId)).toEqual(
      threadFirst.chunks.map((c) => c.chunkId),
    );
    // And both tied chunks score identically, so neither is being nudged.
    expect(orgFirst.chunks[0]!.score).toBe(orgFirst.chunks[1]!.score);
  });

  // ── No-op guards ──────────────────────────────────────────────────────────
  //
  // ⚠ These two assert that the new path does NOT run. On the unfixed tree
  // their ORDER assertions pass — by construction, that is what a no-op guard
  // means — so they are regression guards, not defect proofs, and must not be
  // counted as red-then-green.
  //
  // Their ability to fail ON ORDER was established by POSITIVE CONTROL
  // (MEASURED): replacing the
  // `req.mode === 'hybrid' && corpora.length > 1` gate with
  //   • `req.mode === 'hybrid'`  → ONLY "single-corpus hybrid" goes red (the
  //     `zz`/`aa` tie flips to `aa`/`zz`, and `score` is rewritten).
  //   • `corpora.length > 1`     → ONLY "multi-corpus DENSE" goes red.
  // Each control turns exactly its own guard red and nothing else, so neither
  // is a control that cannot fail.

  it('leaves a single-corpus hybrid query byte-identical, ties included', async () => {
    // A tie block whose order the cross-corpus tie-break WOULD rewrite: `zz`
    // precedes `aa` here and must keep doing so, because within one corpus the
    // ranks already share a pool and there is nothing to normalise across.
    const tied = { denseRank: 3, lexicalRank: 3, denseScore: 0.5, lexicalScore: 0.2 };
    const rows = [
      hybridChunk('lead', { denseRank: 1, lexicalRank: 1, denseScore: 0.9, lexicalScore: 0.7 }),
      hybridChunk('zz', tied),
      hybridChunk('aa', tied),
    ];
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: stubRetrieveService({ only: rows }),
      router: noRewriteRouter,
    });

    const res = await svc.retrieveMulti(
      { corpora: ['only'], query: 'q', mode: 'hybrid', topK: 3, limit: 3 },
      CTX,
    );

    expect(res.chunks.map((c) => c.chunkId)).toEqual(['lead', 'zz', 'aa']);
    // Scores are the per-corpus RRF values the leg returned, UNTOUCHED.
    expect(res.chunks.map((c) => c.score)).toEqual(rows.map((r) => r.score));
    expect(res.fusion).toBe('score');
  });

  it('leaves a multi-corpus DENSE query on the plain score sort', async () => {
    // In `dense` mode `score` IS cosine against the same query vector, which is
    // already comparable across corpora. Nothing to renormalise, so chat and
    // frontend code — which does not pass `mode: 'hybrid'` — take the old path exactly.
    const dense = (id: string, score: number): RetrievedChunk => ({
      chunkId: id,
      documentId: `doc-${id}`,
      ordinal: 0,
      text: `text ${id}`,
      score,
      denseScore: score,
    });
    const svc = new RetrieveMultiService({
      db: {} as never,
      retrieveService: stubRetrieveService({ a: [dense('a1', 0.9), dense('a2', 0.4)], b: [dense('b1', 0.7)] }),
      router: noRewriteRouter,
    });

    const res = await svc.retrieveMulti({ corpora: ['a', 'b'], query: 'q', topK: 5, limit: 3 }, CTX);

    expect(res.chunks.map((c) => c.chunkId)).toEqual(['a1', 'b1', 'a2']);
    expect(res.chunks.map((c) => c.score)).toEqual([0.9, 0.7, 0.4]);
    expect(res.fusion).toBe('score');
  });
});
