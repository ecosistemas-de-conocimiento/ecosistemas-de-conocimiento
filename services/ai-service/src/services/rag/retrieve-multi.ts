// Multi-corpus retrieval MACHINERY — parallel fan-out + score fusion, with an
// optional cheap query-rewrite step in front. Project-agnostic (ADR-0001):
// extracted from a prototype's `services/chat/respond.ts#retrieveContext` so every
// product gets "search across everything relevant in one call".
//
// Composition, not duplication: this service REUSES `RetrieveService` per
// corpus (so hybrid/MMR/filter/asOf all come for free and stay in one place)
// and only adds the fan-out, the fusion, and the rewrite orchestration.

import { env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { callRerank, type Reranker } from '../ai/rerank/rerank-client.js';
import type { LLMRouter } from '../ai/router/types.js';
import { createOpenRouter } from '../ai/router/openrouter.js';
import { condenseQuery } from './condense.js';
import {
  CorpusNotFoundError,
  RetrieveService,
  type RetrieveContext,
  type RetrieveLogger,
} from './retrieve.js';
import type {
  CorpusDiagnostics,
  MultiRetrievedChunk,
  RetrieveMultiRequest,
  RetrieveMultiResult,
} from './types.js';

const DEFAULT_TOP_K = 10;

/**
 * Rerank pool depth for the multi-corpus path — the cross-encoder re-scores this
 * many FUSED candidates (drawn from across all corpora) before the final
 * `slice(limit)`. Same shape/knobs as the single-corpus reranker in
 * `retrieve.ts` (multiplier × final-cap, hard-capped at 50): fusion already did
 * the cheap cross-corpus recall, the reranker only sharpens the head. Kept as
 * its own constants rather than imported so the two rungs can diverge later
 * (this pool is post-fusion, the single-corpus one is post-RRF).
 */
const RERANK_POOL_MULTIPLIER = 4;
const RERANK_POOL_CAP = 50;

export interface RetrieveMultiServiceOptions {
  db: Db;
  /** Injectable for tests; defaults to a `RetrieveService` over `db`. */
  retrieveService?: RetrieveService;
  /** Injectable for tests; defaults to the shared OpenRouter router. */
  router?: LLMRouter;
  /**
   * Injectable cross-encoder reranker for the post-fusion rerank rung. Defaults
   * to the real `callRerank` client (which reads `env.RERANK_URL`). Passing a
   * stub here also FORCES rerank availability, bypassing the
   * `RERANK_ENABLED`/`RERANK_URL` production gate — so tests exercise the rerank
   * path deterministically with zero network, while production still requires
   * the env gate. Mirrors `RetrieveService`'s seam exactly.
   */
  reranker?: Reranker;
  /** Optional logger for the rerank fail-safe path; absent ⇒ warnings are swallowed. */
  logger?: RetrieveLogger;
}

export class RetrieveMultiService {
  private readonly retrieveService: RetrieveService;
  private readonly router: LLMRouter;
  private readonly reranker: Reranker;
  /** True when a reranker was injected — forces rerank availability (see options). */
  private readonly rerankInjected: boolean;
  private readonly logger: RetrieveLogger | undefined;

  constructor(opts: RetrieveMultiServiceOptions) {
    this.retrieveService = opts.retrieveService ?? new RetrieveService({ db: opts.db });
    this.router = opts.router ?? createOpenRouter();
    this.reranker = opts.reranker ?? callRerank;
    this.rerankInjected = opts.reranker !== undefined;
    this.logger = opts.logger;
  }

  async retrieveMulti(
    req: RetrieveMultiRequest,
    ctx: RetrieveContext,
  ): Promise<RetrieveMultiResult> {
    // ── 1. Optional query rewrite. Fail-safe: `condenseQuery` returns the raw
    //    query on the first turn or any error, so this never blocks retrieval.
    let query = req.query;
    let rewritten = false;
    if (req.rewrite) {
      const condensed = await condenseQuery(this.router, {
        directive: req.rewrite,
        question: req.query,
        ctx,
      });
      if (condensed && condensed !== req.query) {
        query = condensed;
        rewritten = true;
      }
    }

    const topK = req.topK ?? DEFAULT_TOP_K;
    const limit = req.limit ?? topK;

    // Rerank availability mirrors `RetrieveService`: an injected reranker
    // (tests) always counts; the real client requires the production env gate
    // (`RERANK_ENABLED` + a configured `RERANK_URL`). A `rerank: true` request on
    // an environment where rerank isn't wired degrades to the fused order.
    const rerankAvailable =
      this.rerankInjected || (env.RERANK_ENABLED && Boolean(env.RERANK_URL));
    const wantRerank = req.rerank === true && rerankAvailable;

    // Knobs forwarded identically to every per-corpus retrieve. Only present
    // keys are spread so each leg's request is byte-identical to what a direct
    // single-corpus call would send. `rerank`/`rerankModel` are intentionally
    // NOT forwarded — reranking runs ONCE after cross-corpus fusion (below), not
    // per corpus. `mmr` is dropped when rerank is active so the two rungs stay
    // mutually exclusive exactly as they are in single `/v1/retrieve`.
    const shared = {
      query,
      topK,
      ...(req.mmr !== undefined && !wantRerank ? { mmr: req.mmr } : {}),
      ...(req.mode !== undefined ? { mode: req.mode } : {}),
      ...(req.rrfK !== undefined ? { rrfK: req.rrfK } : {}),
      ...(req.filter !== undefined ? { filter: req.filter } : {}),
      ...(req.asOf !== undefined ? { asOf: req.asOf } : {}),
    };

    // De-duplicate corpora, preserving first-seen order (Set iteration order).
    // A repeated corpus name would otherwise issue a redundant per-corpus
    // retrieve (wasted DB/embedding work) and emit a duplicate diagnostics row.
    const corpora = [...new Set(req.corpora)];

    // ── 2. Fan out in parallel. Each leg is independent and fail-safe: a
    //    missing/erroring corpus contributes zero chunks and is recorded in
    //    diagnostics rather than failing the whole request.
    const diagnostics: CorpusDiagnostics[] = [];
    const legs = await Promise.all(
      corpora.map(async (corpus): Promise<MultiRetrievedChunk[]> => {
        try {
          const r = await this.retrieveService.retrieve({ corpus, ...shared }, ctx);
          diagnostics.push({ corpus, matched: r.chunks.length });
          return r.chunks.map((c) => ({ ...c, corpus }));
        } catch (err) {
          diagnostics.push({
            corpus,
            matched: 0,
            error: err instanceof CorpusNotFoundError ? 'not_found' : 'failed',
          });
          return [];
        }
      }),
    );

    // ── 3. Fuse: highest score first, dedupe by chunk (an alias + its target
    //    can both be queried). Score is comparable across corpora that share an
    //    embedding model and mode — the prototype invariant. The FULLY deduped list
    //    (`fused`) is the candidate pool; the final cap happens in step 4.
    const ordered = legs.flat().sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const fused: MultiRetrievedChunk[] = [];
    for (const c of ordered) {
      if (seen.has(c.chunkId)) continue;
      seen.add(c.chunkId);
      fused.push(c);
    }

    // ── 4. Optional cross-encoder rerank of the fused candidates, then cap.
    //    When rerank is off this is a plain `slice(limit)` — byte-identical to
    //    the old early-break loop (same sort, same dedupe, same first `limit`).
    //    When on, only a capped top-N of `fused` is SENT to the cross-encoder
    //    (cost control) — the pool spans multiple corpora, which is fine, the
    //    reranker scores each (query, chunk) pair independently of its source.
    //    The cap bounds the RERANKER'S input, NOT the final result count:
    //    `applyRerank` backfills from the FULL fused order up to `limit`, so
    //    enabling rerank returns the same COUNT as disabling it (it only
    //    reorders the head). Fail-safe: any rerank error/timeout returns the
    //    fused order sliced to `limit`.
    let chunks: MultiRetrievedChunk[];
    if (wantRerank) {
      const poolDepth = Math.min(limit * RERANK_POOL_MULTIPLIER, RERANK_POOL_CAP);
      const pool = fused.slice(0, poolDepth);
      chunks = await this.applyRerank(
        pool,
        fused,
        query,
        req.rerankModel ?? env.RERANK_MODEL,
        limit,
      );
    } else {
      chunks = fused.slice(0, limit);
    }

    // Report diagnostics in the request's corpus order (Promise.all preserves
    // input order for the results, but the pushes race — so re-sort by request).
    const order = new Map(corpora.map((c, i) => [c, i]));
    diagnostics.sort((a, b) => (order.get(a.corpus) ?? 0) - (order.get(b.corpus) ?? 0));

    return { query, rewritten, chunks, corpora: diagnostics };
  }

  /**
   * Re-score a capped FUSED (cross-corpus) candidate `pool` with the
   * cross-encoder, then return up to `limit` chunks — the reranked head first,
   * backfilled from the FULL `fused` order — preserving each chunk's `corpus`
   * provenance.
   *
   * The `pool` (a prefix of `fused`) bounds only what is SENT to the reranker,
   * for cost control; it must NOT bound the final result count. So when the
   * reranker yields fewer than `limit` usable chunks, the tail is backfilled
   * from `fused` (deduped by `chunkId`, in fused order) — never from the capped
   * pool. This guarantees enabling rerank returns the SAME count as the
   * un-reranked `fused.slice(limit)` path (it only reorders the head).
   *
   * This mirrors `RetrieveService.applyRerank` — same fail-safe contract — but
   * operates one layer up, on the post-fusion candidates, because reranking
   * multi-corpus results must happen AFTER fusion, not per leg. It REUSES the
   * rerank CLIENT/seam (`callRerank` / the injected `Reranker`); only the
   * fail-safe orchestration is re-expressed here, since the single-corpus
   * version is a private method holding a different (per-corpus) candidate list.
   *
   * FAIL-SAFE is the whole contract: any failure — a slow reranker hitting the
   * timeout, a down sibling service, a malformed response — falls back to the
   * fused order sliced to `limit`. The query never 500s because the reranker
   * misbehaved. On success `score` is overwritten with the cross-encoder score
   * (so the primary ranking field matches the returned order) and `rerankScore`
   * is surfaced alongside; `denseScore`/`lexicalScore`/`corpus` are left intact.
   */
  private async applyRerank(
    pool: MultiRetrievedChunk[],
    fused: MultiRetrievedChunk[],
    query: string,
    model: string,
    limit: number,
  ): Promise<MultiRetrievedChunk[]> {
    if (pool.length === 0) return fused.slice(0, limit);

    const controller = new AbortController();
    const timeoutMs = env.RERANK_TIMEOUT_MS;
    const timer =
      timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    try {
      const documents = pool.map((c) => c.text);
      const { results } = await this.reranker({
        model,
        query,
        documents,
        topN: limit,
        signal: controller.signal,
      });

      // Map results back to the pool by index; higher relevanceScore first.
      // Defensive re-sort — a compliant backend already sorts, but ordering IS
      // the output, so we do not rely on it.
      const ordered = results
        .slice()
        .sort((a, b) => b.relevanceScore - a.relevanceScore);
      const selected: MultiRetrievedChunk[] = [];
      const seen = new Set<string>();
      for (const r of ordered) {
        const cand = pool[r.index];
        if (!cand || seen.has(cand.chunkId)) continue;
        seen.add(cand.chunkId);
        selected.push({ ...cand, rerankScore: r.relevanceScore, score: r.relevanceScore });
        if (selected.length >= limit) break;
      }

      // Backfill from the FULL fused order (not the capped pool) if the reranker
      // yielded fewer than `limit` usable candidates — never return fewer chunks
      // than the un-reranked `fused.slice(limit)` path would have. The pool cap
      // is cost control on the reranker's INPUT only; it must not shrink the
      // result. Backfilled chunks keep their fused score and carry no
      // `rerankScore`, and preserve fused order for the tail. Deduped by
      // `chunkId` so already-reranked pool chunks are not re-added.
      if (selected.length < limit) {
        for (let i = 0; i < fused.length && selected.length < limit; i++) {
          const cand = fused[i]!;
          if (seen.has(cand.chunkId)) continue;
          seen.add(cand.chunkId);
          selected.push(cand);
        }
      }

      return selected;
    } catch (err) {
      this.logger?.warn(
        { err, model, poolSize: pool.length },
        'multi-corpus rerank failed; falling back to fused order',
      );
      return fused.slice(0, limit);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
