// Multi-corpus retrieval MACHINERY — parallel fan-out + score fusion, with an
// optional cheap query-rewrite step in front. Project-agnostic (ADR-0001), so every
// product gets "search across everything relevant in one call".
//
// Composition, not duplication: this service REUSES `RetrieveService` per
// corpus (so hybrid/MMR/filter/asOf all come for free and stay in one place)
// and only adds the fan-out, the fusion, and the rewrite orchestration.

import { env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { callRerank, type Reranker, type RerankResult } from '../ai/rerank/rerank-client.js';
import type { LLMRouter } from '../ai/router/types.js';
import { createOpenRouter } from '../ai/router/openrouter.js';
import { condenseQuery } from './condense.js';
import { fuseAcrossCorpora } from './fuse-across-corpora.js';
import {
  CorpusNotFoundError,
  RERANK_OK_MESSAGE,
  RetrieveService,
  SILENT_LEG_MESSAGE,
  rerankOkLine,
  type RetrieveContext,
  type RetrieveLogger,
  type SilentLegWarning,
} from './retrieve.js';
import type {
  CorpusDiagnostics,
  MultiRetrievedChunk,
  RetrieveMultiRequest,
  RetrieveMultiResult,
} from './types.js';

const DEFAULT_TOP_K = 10;

/**
 * RRF damping constant for the CROSS-CORPUS rung. Must track
 * `DEFAULT_RRF_K` in `retrieve.ts` (60, Cormack et al. 2009) and is overridden
 * by `req.rrfK` exactly as the per-corpus rung is, so an eval sweep moves both
 * together. Duplicated rather than imported only because `retrieve.ts` keeps it
 * private; the value is asserted equal in the tests.
 */
const DEFAULT_RRF_K = 60;

/**
 * Logged when a corpus matched chunks and then won NO slot in the fused result.
 * This is the exact fingerprint of the cross-corpus fusion defect
 * (`matched: 8, contributed: 0`) and of any future variant of it: the corpus was
 * indexed, was queried, DID match — and nothing it found reached the caller.
 * It can be legitimate (a genuinely weaker corpus under a tight `limit`), so it
 * is a warn and not an error. It exists so that outcome is never again silent.
 */
export const CORPUS_SHUTOUT_MESSAGE =
  'corpus matched but contributed no chunks to the fused result';

/**
 * Logged when a hybrid candidate reaches cross-corpus fusion carrying neither
 * `denseScore` nor `lexicalScore`. It cannot be placed on either global leg, so
 * it scores 0 and sinks to the tail rather than being dropped. Should be
 * unreachable — it means an upstream leg stopped surfacing its per-leg score.
 */
export const UNSCORED_CANDIDATE_MESSAGE =
  'hybrid candidates reached cross-corpus fusion with no per-leg score';

// ── Silent-leg warn gating for the fan-out ──────────────────────────────────
//
// `RetrieveService.retrieve` raises one signal per retrieval leg it ASKED for
// that came back with zero rows. On single `/v1/retrieve` it logs that itself,
// and that is the whole point: the caller asked one corpus a question and a leg
// went silent.
//
// On `/v1/retrieve/multi` a corpus that matches nothing is ROUTINE and is
// ALREADY reported — as a `{ corpus, matched: 0 }` row in `corpora`. Fanning
// out over five corpora where three legitimately match nothing would otherwise
// emit three of those warns per request (six in hybrid mode, two legs each),
// and a warning that fires on ordinary traffic is a warning nobody reads.
//
// So the fan-out supplies `ctx.onSilentLeg` per corpus — which makes `retrieve`
// hand the warning over instead of logging it — BUFFERS what it gets, and
// decides once that corpus's promise settles:
//   • the corpus returned chunks  → LOG them. A corpus that matched but had a
//     silent leg (a dead sparse leg behind a working dense one) is exactly the
//     anomaly this lane exists to expose, and nothing else reports it.
//   • the corpus returned nothing → drop them. `matched: 0` already said it.
//   • the leg threw               → LOG them. An errored leg is not routine,
//     and whatever it said on the way down is part of that story.
//
// Only the silent-leg signal is routed this way, because only it travels
// through `onSilentLeg`. Everything else a leg logs — the sparse-leg degrade
// warn, the passage-bound clamp warn, the single-corpus rerank fail-safe warn —
// goes straight to `opts.logger`, which is handed to the composed
// `RetrieveService` unwrapped. There is nothing in between to swallow them.

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
    // Forward the logger into the composed per-corpus service UNWRAPPED. Without
    // it the outbound passage-bound clamp would truncate SILENTLY on
    // `/v1/retrieve/multi` — the warn that makes an over-bound stored chunk
    // visible is emitted inside `RetrieveService.retrieve`, so a service built
    // without a logger swallows it. Nothing is interposed here: the one signal
    // this route judges differently is diverted at its source, per call, by
    // `ctx.onSilentLeg` in `retrieveMulti` below.
    this.retrieveService =
      opts.retrieveService ??
      new RetrieveService({
        db: opts.db,
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
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
      ...(req.asOf !== undefined ? { asOf: req.asOf } : {}),
    };
    // A `corpusFilters` entry REPLACES the shared `filter` for that corpus
    // only; every other corpus keeps `filter`. The contract already refused a
    // key outside `corpora`, so a typo cannot silently drop a filter.
    const filterFor = (corpus: string) => {
      const f = req.corpusFilters?.[corpus] ?? req.filter;
      return f !== undefined ? { filter: f } : {};
    };

    // De-duplicate corpora, preserving first-seen order (Set iteration order).
    // A repeated corpus name would otherwise issue a redundant per-corpus
    // retrieve (wasted DB/embedding work) and emit a duplicate diagnostics row.
    const corpora = [...new Set(req.corpora)];

    // ── 2. Fan out in parallel. Each leg is independent and fail-safe: a
    //    missing/erroring corpus contributes zero chunks and is recorded in
    //    diagnostics rather than failing the whole request.
    //    Each leg also gets its OWN `ctx` carrying its OWN silent-leg buffer,
    //    so the per-leg "returned zero rows" signal can be judged against what
    //    that leg actually contributed — see the notes at the top of this file.
    //    Per-call by construction: two concurrent fan-outs over the same corpus
    //    hold different buffers and cannot settle each other's warnings.
    const diagnostics: CorpusDiagnostics[] = [];
    const legs = await Promise.all(
      corpora.map(async (corpus): Promise<MultiRetrievedChunk[]> => {
        const silentLegs: SilentLegWarning[] = [];
        // Overriding any `onSilentLeg` on the incoming `ctx` is deliberate: on
        // this route the fan-out owns the verdict, and a caller cannot opt out
        // of being told `matched: 0` instead.
        const legCtx: RetrieveContext = {
          ...ctx,
          onSilentLeg: (w) => silentLegs.push(w),
        };
        // The ONE condition under which a buffered silent-leg warning is
        // dropped: this corpus contributed nothing AND said so in `corpora`.
        // Starts false so every other exit — chunks returned, corpus missing,
        // leg threw, an exception nobody anticipated — logs what it buffered.
        let alreadyReported = false;
        try {
          const r = await this.retrieveService.retrieve(
            { corpus, ...shared, ...filterFor(corpus) },
            legCtx,
          );
          diagnostics.push({ corpus, matched: r.chunks.length });
          alreadyReported = r.chunks.length === 0;
          return r.chunks.map((c) => ({ ...c, corpus }));
        } catch (err) {
          // An errored leg is NOT the routine zero-match case: `matched: 0`
          // here carries an `error`, and whatever the legs reported on the way
          // down is part of that story. Left to be logged.
          diagnostics.push({
            corpus,
            matched: 0,
            error: err instanceof CorpusNotFoundError ? 'not_found' : 'failed',
          });
          return [];
        } finally {
          // A corpus that matched but had a silent leg (a dead sparse leg
          // behind a working dense one) is the anomaly this lane exists to
          // expose, and NOTHING else reports it — so it must be heard. Logged
          // under the SAME message `RetrieveService` would have used, imported
          // from it, so one grep still finds every silent leg on every route.
          if (!alreadyReported) {
            for (const w of silentLegs) this.logger?.warn(w, SILENT_LEG_MESSAGE);
          }
        }
      }),
    );

    // ── 3. Fuse across corpora, dedupe by chunk (an alias + its target can
    //    both be queried). The FULLY deduped list (`fused`) is the candidate
    //    pool; the final cap happens in step 4.
    //
    //    TWO paths, and which one runs is reported back as `fusion`:
    //
    //    • `cross-corpus-rrf` — hybrid mode over MORE THAN ONE corpus. Here
    //      each leg's `score` is a per-corpus RRF value built from ranks inside
    //      that corpus's own pool, and those are NOT comparable across corpora:
    //      the deeper pool is systematically penalised, to the point where a
    //      180-chunk corpus with better matches lost every slot to a 10-chunk
    //      one (MEASURED). `fuseAcrossCorpora`
    //      rebuilds the ranks over one global pool per leg and re-runs RRF —
    //      see that module's header for the reasoning and the two rejected
    //      alternatives.
    //
    //    • `score` — the original stable sort on the raw `score`. This is what
    //      runs for a SINGLE corpus (nothing to normalise across; within one
    //      corpus the RRF scores already share a pool and are comparable) and
    //      for `dense` mode (`score` IS the cosine similarity against the same
    //      query vector, which is already cross-corpus comparable). Both are
    //      byte-identical to the pre-fix behaviour, ties and all — including
    //      the stable-sort order, which is why the single-corpus path is a
    //      strict no-op rather than merely an equivalent one.
    const useCrossCorpus = req.mode === 'hybrid' && corpora.length > 1;
    const fusion: 'score' | 'cross-corpus-rrf' = useCrossCorpus
      ? 'cross-corpus-rrf'
      : 'score';
    let fused: MultiRetrievedChunk[];
    if (useCrossCorpus) {
      const result = fuseAcrossCorpora(legs.flat(), req.rrfK ?? DEFAULT_RRF_K);
      fused = result.chunks;
      if (result.unscored > 0) {
        this.logger?.warn(
          { unscored: result.unscored, corpora, org: ctx.org, project: ctx.project },
          UNSCORED_CANDIDATE_MESSAGE,
        );
      }
    } else {
      const ordered = legs.flat().sort((a, b) => b.score - a.score);
      const seen = new Set<string>();
      fused = [];
      for (const c of ordered) {
        if (seen.has(c.chunkId)) continue;
        seen.add(c.chunkId);
        fused.push(c);
      }
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
      const model = req.rerankModel ?? env.RERANK_MODEL;
      chunks = await this.applyRerank(pool, fused, query, model, limit, (scored, egress) =>
        this.logger?.info?.(
          rerankOkLine(
            {
              corpus: corpora,
              org: ctx.org,
              project: ctx.project,
              model,
              poolSize: pool.length,
              scored,
              topK: limit,
            },
            egress,
          ),
          RERANK_OK_MESSAGE,
        ),
      );
    } else {
      chunks = fused.slice(0, limit);
    }

    // Report diagnostics in the request's corpus order (Promise.all preserves
    // input order for the results, but the pushes race — so re-sort by request).
    const order = new Map(corpora.map((c, i) => [c, i]));
    diagnostics.sort((a, b) => (order.get(a.corpus) ?? 0) - (order.get(b.corpus) ?? 0));

    // ── 5. Make fusion legible. `matched` has always said what each corpus
    //    FOUND; nothing said what each corpus KEPT. That gap is what let a
    //    corpus be indexed, queried, matched — and then silently shut out of
    //    every slot. `contributed` closes it, and a corpus that matched and
    //    contributed nothing is also WARNED, because "it succeeded and did
    //    nothing and nothing said so" is the failure mode this route keeps
    //    producing. Both are additive: existing consumers read `matched` as
    //    before.
    const kept = new Map<string, number>();
    for (const c of chunks) kept.set(c.corpus, (kept.get(c.corpus) ?? 0) + 1);
    for (const d of diagnostics) {
      d.contributed = kept.get(d.corpus) ?? 0;
      if (d.matched > 0 && d.contributed === 0) {
        this.logger?.warn(
          {
            corpus: d.corpus,
            matched: d.matched,
            corpora,
            fusion,
            limit,
            org: ctx.org,
            project: ctx.project,
          },
          CORPUS_SHUTOUT_MESSAGE,
        );
      }
    }

    return { query, rewritten, chunks, corpora: diagnostics, fusion };
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
    onOk: (scored: number, egress: RerankResult['egress']) => void,
  ): Promise<MultiRetrievedChunk[]> {
    if (pool.length === 0) return fused.slice(0, limit);

    const controller = new AbortController();
    const timeoutMs = env.RERANK_TIMEOUT_MS;
    const timer =
      timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    try {
      const documents = pool.map((c) => c.text);
      const { results, egress } = await this.reranker({
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
      const scored = selected.length;

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

      // Isolated: the rerank already SUCCEEDED here. Inside the bare `try`, a
      // throwing logger would fall into the fail-safe `catch` below, discard
      // this result and report a reranker failure that never happened.
      try {
        onOk(scored, egress);
      } catch {
        // A broken log sink must not change what the caller receives.
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
