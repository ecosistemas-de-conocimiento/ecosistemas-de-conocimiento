// RAG retrieval service — cosine top-K via pgvector with optional MMR rerank.
//
// Plan: plan/m3-m4-decisions.md §10 (per-corpus embedding model; vector dim
// re-cut to 1024 for the open multilingual default in migration 0013)
// and §12 (cosine top-K + optional MMR; no BM25 hybrid, no filters in v1).
//
// Contract:
//   - Look up `(org, project, corpus)` → 404 (`CorpusNotFoundError`) on miss.
//   - Embed the query using the **corpus's** configured `embeddingModel` — ingest
//     and retrieve MUST stay in lockstep on the model that produced the index.
//   - SELECT … 1 - (embedding <=> $1) AS score FROM chunks ORDER BY embedding
//     <=> $1 LIMIT topK. `<=>` is pgvector's cosine-distance operator.
//   - Optional MMR rerank (lambda from `req.mmr`) over the top-`min(topK*2, 50)`
//     candidates. MMR is pure Node code; needs the chunk embeddings alongside
//     their text, which we ask the DB for in the same SELECT.

import { and, eq, sql } from 'drizzle-orm';

import { env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { corpora, corpusAliases } from '../../db/schema/index.js';
import { callOpenRouterEmbedding } from '../ai/embeddings/openrouter.js';
import {
  callSparseEmbed,
  toSparsevecLiteral,
  type SparseEmbedder,
} from '../ai/embeddings/sparse-embed.js';
import { callRerank, type Reranker } from '../ai/rerank/rerank-client.js';
import type { CorpusRow, RetrieveRequest, RetrieveResult, RetrievedChunk } from './types.js';

const DEFAULT_TOP_K = 10;
const MMR_POOL_CAP = 50;

/**
 * Rerank pool depth — the cross-encoder re-scores this many fused candidates
 * before the final `slice(topK)`. Cross-encoder cost is O(N) forward passes, so
 * N is the cost/latency knob: RRF already did the cheap recall work, the
 * reranker only sharpens the head. Kept modest (multiplier × topK, hard-capped
 * at 50 — the natural `HYBRID_POOL_CAP` ceiling) per the plan §1.1/§1.6.
 */
const RERANK_POOL_MULTIPLIER = 4;
const RERANK_POOL_CAP = 50;

/**
 * RRF damping constant from Cormack et al. 2009. Large enough that the top few
 * ranks are not wildly over-weighted, small enough that rank order still
 * dominates. Overridable per-request via `rrfK` for eval sweeps.
 */
const DEFAULT_RRF_K = 60;

/**
 * Per-leg candidate pool for hybrid retrieval. Each leg fetches this many rows
 * (capped) before fusion. Deeper than `topK` on purpose: RRF's whole value is
 * that a chunk ranked #23 by the dense leg and #2 by the lexical leg beats a
 * chunk that is #8 on one leg and absent from the other, and that can only
 * happen if the pool is deep enough to contain the #23.
 */
const HYBRID_POOL_MULTIPLIER = 5;
const HYBRID_POOL_CAP = 100;

/** Embedder signature — injectable for tests. Matches `callOpenRouterEmbedding`. */
export type Embedder = typeof callOpenRouterEmbedding;

/** Minimal logger surface for the rerank fail-safe warning (matches Fastify's `log.warn`). */
export interface RetrieveLogger {
  warn(obj: unknown, msg?: string): void;
}

export interface RetrieveServiceOptions {
  db: Db;
  embedder?: Embedder;
  /**
   * Injectable cross-encoder reranker. Defaults to the real `callRerank` client
   * (which reads `env.RERANK_URL`). Passing a stub here also FORCES rerank
   * availability, bypassing the `RERANK_ENABLED`/`RERANK_URL` production gate —
   * so eval + tests exercise the rerank path deterministically with zero
   * network, while production still requires the env gate to be set.
   */
  reranker?: Reranker;
  /**
   * Injectable learned-sparse (bge-m3) embedder. Defaults to the real
   * `callSparseEmbed` client (which reads `env.SPARSE_EMBED_URL`). Passing a stub
   * here also FORCES sparse availability, bypassing the `SPARSE_ENABLED` +
   * `SPARSE_EMBED_URL` production gate — so eval + tests exercise the sparse
   * lexical leg deterministically with zero network, while production still
   * requires the env gate to be set. When active (and `mode: 'hybrid'`), the
   * sparse leg REPLACES the `tsvector` lexical leg in the RRF fusion.
   */
  sparseEmbedder?: SparseEmbedder;
  /** Optional logger for the rerank fail-safe path; absent ⇒ warnings are swallowed. */
  logger?: RetrieveLogger;
}

export interface RetrieveContext {
  org: string;
  project: string;
}

/** Thrown when `(org, project, name)` has no `corpora` row. Route layer maps to 404. */
export class CorpusNotFoundError extends Error {
  public readonly corpus: string;
  public readonly org: string;
  public readonly project: string;
  constructor(opts: { corpus: string; org: string; project: string }) {
    super(`corpus '${opts.corpus}' not found in (org=${opts.org}, project=${opts.project})`);
    this.name = 'CorpusNotFoundError';
    this.corpus = opts.corpus;
    this.org = opts.org;
    this.project = opts.project;
  }
}

/** Raw row shape coming back from the cosine-distance SELECT. */
interface CandidateRow {
  id: string;
  document_id: string;
  ordinal: number;
  text: string;
  metadata: unknown;
  score: number;
  /** Present only when MMR is requested — we need the vector to compute pairwise sim. */
  embedding?: number[];
}

/** A candidate carrying its provenance through fusion. */
interface FusedCandidate extends CandidateRow {
  denseScore?: number;
  lexicalScore?: number;
  denseRank?: number;
  lexicalRank?: number;
  /** Cross-encoder score, set only when this candidate survived the rerank rung. */
  rerankScore?: number;
}

/**
 * Reciprocal Rank Fusion over N ranked lists.
 *
 * `rrf(d) = Σ_legs 1 / (k + rank_leg(d))`, 1-based ranks, legs the document is
 * absent from contributing nothing.
 *
 * Why RRF rather than a weighted sum of the two scores: cosine similarity and
 * `ts_rank_cd` are not commensurable. Cosine lives in a narrow band (real
 * corpora cluster around 0.3–0.8 with a corpus-dependent floor), `ts_rank_cd`
 * is unbounded above and depends on document length and term frequency. Any
 * fixed weighting of the two is really a hidden per-corpus tuning constant that
 * will silently be wrong for the next corpus. RRF throws the magnitudes away
 * and keeps only the ordering, which is the part that transfers.
 */
function rrfFuse(
  legs: Array<{ name: 'dense' | 'lexical'; rows: CandidateRow[] }>,
  k: number,
  limit: number,
): FusedCandidate[] {
  const byId = new Map<string, FusedCandidate>();
  const legsFound = new Map<string, number>();

  for (const leg of legs) {
    const ranks = competitionRanks(leg.rows);
    leg.rows.forEach((row, i) => {
      const rank = ranks[i]!;
      legsFound.set(row.id, (legsFound.get(row.id) ?? 0) + 1);
      let entry = byId.get(row.id);
      if (!entry) {
        entry = { ...row, score: 0 };
        byId.set(row.id, entry);
      }
      if (leg.name === 'dense') {
        entry.denseScore = row.score;
        entry.denseRank = rank;
        // The dense leg is the only one that carries embeddings (for MMR).
        if (row.embedding) entry.embedding = row.embedding;
      } else {
        entry.lexicalScore = row.score;
        entry.lexicalRank = rank;
      }
      entry.score += 1 / (k + rank);
    });
  }

  return [...byId.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-break chain, most to least meaningful. Every step is derived from
      // CONTENT, never from a row id, until the very last resort. An earlier
      // version tie-broke straight to `chunks.id`, which is a random uuid
      // regenerated on every ingest — so identical data produced different
      // top-K orderings on different runs, and the eval suite flapped.
      const af = legsFound.get(a.id) ?? 0;
      const bf = legsFound.get(b.id) ?? 0;
      if (af !== bf) return bf - af; // found by both legs > found by one
      const ads = a.denseScore ?? -Infinity;
      const bds = b.denseScore ?? -Infinity;
      if (ads !== bds) return bds - ads;
      const als = a.lexicalScore ?? -Infinity;
      const bls = b.lexicalScore ?? -Infinity;
      if (als !== bls) return bls - als;
      if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, limit);
}

/**
 * Modified competition ranking ("1334"): equal scores share the LAST rank of
 * their group.
 *
 * This matters much more than it looks, and the direction is counter-intuitive
 * enough to be worth spelling out.
 *
 * `ts_rank_cd` routinely produces a huge tie block. For a query like
 * "section 47", every chunk containing the stem "section" and none of the
 * other query lexemes scores identically — and in a corpus of numbered
 * sections that is *every chunk in the corpus*. Three ways to rank a tie block of 30 sitting at
 * positions 2–31, and they behave very differently under RRF:
 *
 *   - ordinal (2, 3, 4, …): invents an ordering the scorer never expressed and
 *     hands 1/(k+2) to whichever row the database happened to return first.
 *     Arbitrary, and non-reproducible when the tie-break is a random uuid.
 *   - standard competition (all get 2): every one of the 30 is credited as if
 *     it were the runner-up. Measured on the golden set this DROPPED the
 *     exact-identifier slice from 95% to 76% — thirty noise chunks each
 *     collecting 1/(k+2) drown the one chunk that genuinely ranked first.
 *   - modified competition (all get 31): the group is credited at the
 *     confidence the leg actually expressed about it, which is "somewhere in
 *     the bottom of what I returned".
 *
 * The third is the honest one: rank is a proxy for confidence, and a leg that
 * cannot distinguish 30 candidates should not be rewarded for its indecision.
 * A genuine rank-1 hit keeps its 1/(k+1) and wins; the tie block contributes
 * almost nothing and the other leg decides the order within it.
 *
 * `rows` must already be sorted by descending score.
 */
function competitionRanks(rows: CandidateRow[]): number[] {
  const out: number[] = new Array(rows.length);
  let groupStart = 0;
  for (let i = 0; i <= rows.length; i++) {
    const atEnd = i === rows.length;
    if (atEnd || rows[i]!.score !== rows[groupStart]!.score) {
      // The group spans [groupStart, i); credit every member with the last
      // position it occupies (1-based).
      for (let j = groupStart; j < i; j++) out[j] = i;
      groupStart = i;
    }
  }
  return out;
}

/** Parse a pgvector text encoding (`[v1,v2,...]`) into a `number[]`. */
function parseVector(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === 'string') {
    // pgvector returns `[1,2,3]` — valid JSON.
    return JSON.parse(raw) as number[];
  }
  return [];
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Rerank `candidates` by Maximal Marginal Relevance.
 *
 * Greedy: pick the highest-relevance candidate first; for each subsequent pick,
 * score the remaining candidates as
 *   lambda * relevance(c)
 *   - (1 - lambda) * max_{p in picked} cosine(c.embedding, p.embedding)
 * and take the maximum. Stops after `k` picks (or when candidates run out).
 */
function mmrRerank(
  candidates: CandidateRow[],
  lambda: number,
  k: number,
): CandidateRow[] {
  if (candidates.length === 0) return [];
  const pool = candidates.slice();
  const picked: CandidateRow[] = [];
  // First pick: highest relevance.
  pool.sort((a, b) => b.score - a.score);
  const first = pool.shift();
  if (!first) return [];
  picked.push(first);

  while (picked.length < k && pool.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      const cEmb = c.embedding ?? [];
      let maxSimToPicked = 0;
      for (const p of picked) {
        const pEmb = p.embedding ?? [];
        const sim = cosineSim(cEmb, pEmb);
        if (sim > maxSimToPicked) maxSimToPicked = sim;
      }
      const mmrScore = lambda * c.score - (1 - lambda) * maxSimToPicked;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    picked.push(pool.splice(bestIdx, 1)[0]!);
  }
  return picked;
}

export class RetrieveService {
  private readonly db: Db;
  private readonly embedder: Embedder;
  private readonly reranker: Reranker;
  /** True when a reranker was injected — forces rerank availability (see options). */
  private readonly rerankInjected: boolean;
  private readonly sparseEmbedder: SparseEmbedder;
  /** True when a sparse embedder was injected — forces sparse availability (see options). */
  private readonly sparseInjected: boolean;
  private readonly logger: RetrieveLogger | undefined;

  constructor(opts: RetrieveServiceOptions) {
    this.db = opts.db;
    this.embedder = opts.embedder ?? callOpenRouterEmbedding;
    this.reranker = opts.reranker ?? callRerank;
    this.rerankInjected = opts.reranker !== undefined;
    this.sparseEmbedder = opts.sparseEmbedder ?? callSparseEmbed;
    this.sparseInjected = opts.sparseEmbedder !== undefined;
    this.logger = opts.logger;
  }

  async retrieve(req: RetrieveRequest, ctx: RetrieveContext): Promise<RetrieveResult> {
    const corpusRow = await this.lookupCorpus(req.corpus, ctx);
    if (!corpusRow) {
      throw new CorpusNotFoundError({ corpus: req.corpus, org: ctx.org, project: ctx.project });
    }

    const topK = req.topK ?? DEFAULT_TOP_K;
    // Rerank availability: an injected reranker (eval/tests) always counts; the
    // real client requires the production env gate (`RERANK_ENABLED` + a
    // configured `RERANK_URL`). A `rerank: true` request on an environment where
    // rerank isn't wired degrades to a silent no-op — the un-reranked order.
    const rerankAvailable = this.rerankInjected || (env.RERANK_ENABLED && Boolean(env.RERANK_URL));
    const wantRerank = req.rerank === true && rerankAvailable;
    // Rerank and MMR are alternatives, not a stack (they optimise opposite
    // things — relevance vs diversity). Rerank wins if both are set.
    const useMmr = typeof req.mmr === 'number' && !wantRerank;
    const hybrid = req.mode === 'hybrid';
    // Depth of the candidate pool handed to the post-retrieval rung. Rerank
    // wants a modest, capped pool; MMR its own; a plain request needs only topK.
    const poolDepth = wantRerank
      ? Math.min(topK * RERANK_POOL_MULTIPLIER, RERANK_POOL_CAP)
      : useMmr
        ? Math.min(topK * 2, MMR_POOL_CAP)
        : topK;

    // Shared candidate-set predicates. BOTH legs get the identical WHERE
    // clause — that is what makes `asOf` a retrieval-time filter rather than a
    // post-filter: a superseded chunk is never a candidate on either leg, so
    // it cannot consume a slot, cannot influence MMR diversity, and cannot
    // appear in the output.
    const predicates = {
      ...(req.filter !== undefined ? { filter: req.filter } : {}),
      ...(req.asOf !== undefined ? { asOf: req.asOf } : {}),
    };

    // Embed the query against the corpus's configured embedding model — ingest
    // and retrieve MUST agree on the model. Failures bubble up unchanged.
    const embedResult = await this.embedder({
      model: corpusRow.embeddingModel,
      input: req.query,
    });
    const queryVec = embedResult.embeddings[0];
    if (!queryVec) {
      throw new Error('RetrieveService.retrieve: embedder returned no vector');
    }

    // ── Stage 1: build the candidate POOL (before the final selection). ──────
    // `pool` is deep enough for whichever post-retrieval rung runs next (rerank,
    // MMR, or a plain slice), and is byte-identical to the old fetch when none
    // of the deepening knobs is set (`poolDepth === topK`).
    let pool: FusedCandidate[];

    if (hybrid) {
      const poolSize = Math.min(topK * HYBRID_POOL_MULTIPLIER, HYBRID_POOL_CAP);
      // Which lexical leg carries the hybrid's second leg. The `tsvector` leg is
      // the DEFAULT; the learned-sparse (bge-m3) leg REPLACES it only when the
      // sparse seam is active (an injected embedder for tests/eval, or the
      // `SPARSE_ENABLED` + `SPARSE_EMBED_URL` production gate). Same fusion,
      // ranks and response shape either way — the sparse inner-product score is
      // surfaced as `lexicalScore`, exactly like `ts_rank_cd` is.
      const useSparse =
        this.sparseInjected || (env.SPARSE_ENABLED && Boolean(env.SPARSE_EMBED_URL));
      // Both legs in parallel — they are independent reads against the same
      // snapshot-consistent connection pool.
      const [dense, lexical] = await Promise.all([
        this.vectorSearch({
          corpusId: corpusRow.id,
          queryVec,
          limit: poolSize,
          includeEmbedding: useMmr,
          ...predicates,
        }),
        useSparse
          ? this.sparseSearch({
              corpusId: corpusRow.id,
              query: req.query,
              limit: poolSize,
              ...predicates,
            })
          : this.lexicalSearch({
              corpusId: corpusRow.id,
              query: req.query,
              textSearchConfig: corpusRow.textSearchConfig,
              limit: poolSize,
              ...predicates,
            }),
      ]);
      pool = rrfFuse(
        [
          { name: 'dense', rows: dense },
          { name: 'lexical', rows: lexical },
        ],
        req.rrfK ?? DEFAULT_RRF_K,
        Math.min(poolSize, poolDepth),
      );
    } else {
      const candidates = await this.vectorSearch({
        corpusId: corpusRow.id,
        queryVec,
        limit: poolDepth,
        includeEmbedding: useMmr,
        ...predicates,
      });
      // Dense mode: `score` stays the cosine value it has always been, and
      // `denseScore` mirrors it so consumers can read one field in both modes.
      pool = candidates.map((row) => ({ ...row, denseScore: row.score, denseRank: undefined }));
    }

    // ── Stage 2: pick the final topK. Exactly one rung runs. ─────────────────
    let selected: FusedCandidate[];
    if (wantRerank) {
      // Cross-encoder re-scoring over the fused pool, then topK. Fail-safe: on
      // any error/timeout this returns the fused order sliced to topK — a slow
      // or broken reranker must never fail the query.
      selected = await this.applyRerank(
        pool,
        req.query,
        req.rerankModel ?? env.RERANK_MODEL,
        topK,
      );
    } else if (useMmr) {
      // MMR after fusion, over the fused ordering. Only the dense leg supplies
      // embeddings, so a lexical-only chunk has no vector; `cosineSim` returns
      // 0 for an empty vector, which reads as "maximally diverse" and keeps
      // such chunks in play rather than silently dropping them.
      selected = mmrRerank(pool, req.mmr as number, topK) as FusedCandidate[];
    } else {
      selected = pool.slice(0, topK);
    }

    const chunks: RetrievedChunk[] = selected.map((row) => ({
      chunkId: row.id,
      documentId: row.document_id,
      ordinal: row.ordinal,
      text: row.text,
      score: row.score,
      ...(row.denseScore !== undefined ? { denseScore: row.denseScore } : {}),
      ...(row.lexicalScore !== undefined ? { lexicalScore: row.lexicalScore } : {}),
      ...(row.rerankScore !== undefined ? { rerankScore: row.rerankScore } : {}),
      ...(hybrid
        ? {
            ranks: {
              ...(row.denseRank !== undefined ? { dense: row.denseRank } : {}),
              ...(row.lexicalRank !== undefined ? { lexical: row.lexicalRank } : {}),
            },
          }
        : {}),
      metadata: (row.metadata ?? undefined) as Record<string, unknown> | undefined,
    }));
    return { chunks };
  }

  /**
   * Re-score a fused candidate pool with the cross-encoder and return the topK
   * in rerank order.
   *
   * FAIL-SAFE is the whole contract: reranking is a relevance-polish rung, not
   * a correctness gate, so ANY failure — a slow reranker hitting the timeout, a
   * down sibling service, a malformed response — falls back to the fused order
   * sliced to topK. The query never 500s because the reranker misbehaved. The
   * fallback lives HERE (not in the client) because this is the layer that
   * still holds the fused candidate list.
   *
   * When rerank succeeds, `score` is overwritten with the cross-encoder score
   * (so the primary ranking field is consistent with the returned order) and
   * `rerankScore` is surfaced alongside; `denseScore`/`lexicalScore` are left
   * intact for debugging and for consumers that still want the similarity.
   */
  private async applyRerank(
    pool: FusedCandidate[],
    query: string,
    model: string,
    topK: number,
  ): Promise<FusedCandidate[]> {
    if (pool.length === 0) return [];

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
        topN: topK,
        signal: controller.signal,
      });

      // Map results back to the pool by index; higher relevanceScore first.
      // Defensive re-sort — a compliant backend already sorts, but we do not
      // rely on it since ordering IS the output.
      const ordered = results
        .slice()
        .sort((a, b) => b.relevanceScore - a.relevanceScore);
      const selected: FusedCandidate[] = [];
      const seen = new Set<number>();
      for (const r of ordered) {
        const cand = pool[r.index];
        if (!cand || seen.has(r.index)) continue;
        seen.add(r.index);
        selected.push({ ...cand, rerankScore: r.relevanceScore, score: r.relevanceScore });
        if (selected.length >= topK) break;
      }

      // Backfill from the fused order if the reranker scored fewer than topK
      // usable candidates — never return fewer chunks than the un-reranked path
      // would have. Backfilled chunks keep their fused score and carry no
      // `rerankScore`.
      if (selected.length < topK) {
        for (let i = 0; i < pool.length && selected.length < topK; i++) {
          if (seen.has(i)) continue;
          seen.add(i);
          selected.push(pool[i]!);
        }
      }

      return selected;
    } catch (err) {
      this.logger?.warn(
        { err, model, poolSize: pool.length },
        'rerank failed; falling back to fused order',
      );
      return pool.slice(0, topK);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Resolve a corpus name to its config row. The name may be either a real
   * corpus or an ALIAS (a `corpus_aliases` pointer to another corpus in the
   * same scope). A real corpus wins on a name clash, but the alias service
   * forbids creating an alias whose name collides with a corpus, so in practice
   * the two namespaces are disjoint. Alias resolution costs one extra indexed
   * lookup ONLY when the name is not a real corpus — no re-embedding ever.
   */
  private async lookupCorpus(
    name: string,
    ctx: RetrieveContext,
  ): Promise<CorpusRow | null> {
    const direct = await this.selectCorpusByName(name, ctx);
    if (direct) return direct;

    // Not a real corpus — is it an alias? Resolve alias → target corpus id,
    // then load the target's config (the target carries the embedding model the
    // chunks were indexed with).
    const aliasRows = await this.db
      .select({ targetCorpusId: corpusAliases.targetCorpusId })
      .from(corpusAliases)
      .where(
        and(
          eq(corpusAliases.org, ctx.org),
          eq(corpusAliases.project, ctx.project),
          eq(corpusAliases.name, name),
        ),
      )
      .limit(1);
    const targetId = aliasRows[0]?.targetCorpusId;
    if (!targetId) return null;

    const targetRows = await this.selectCorpusColumns()
      .where(
        and(
          eq(corpora.org, ctx.org),
          eq(corpora.project, ctx.project),
          eq(corpora.id, targetId),
        ),
      )
      .limit(1);
    return targetRows[0] ?? null;
  }

  private selectCorpusColumns() {
    return this.db
      .select({
        id: corpora.id,
        org: corpora.org,
        project: corpora.project,
        name: corpora.name,
        embeddingModel: corpora.embeddingModel,
        embeddingDim: corpora.embeddingDim,
        chunkStrategy: corpora.chunkStrategy,
        chunkSize: corpora.chunkSize,
        chunkOverlap: corpora.chunkOverlap,
        textSearchConfig: corpora.textSearchConfig,
      })
      .from(corpora);
  }

  private async selectCorpusByName(
    name: string,
    ctx: RetrieveContext,
  ): Promise<CorpusRow | null> {
    const rows = await this.selectCorpusColumns()
      .where(
        and(
          eq(corpora.org, ctx.org),
          eq(corpora.project, ctx.project),
          eq(corpora.name, name),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Cosine top-K via pgvector's `<=>` operator. `1 - distance` becomes the
   * score (higher = more similar). When `includeEmbedding` is true we also
   * return the raw vector text so MMR can compute pairwise similarity in Node.
   */
  private async vectorSearch(opts: {
    corpusId: string;
    queryVec: number[];
    limit: number;
    includeEmbedding: boolean;
    filter?: Record<string, unknown>;
    asOf?: string;
  }): Promise<CandidateRow[]> {
    const vecText = `[${opts.queryVec.join(',')}]`;

    const filterClause = metadataFilterClause(opts.filter);
    const validityClause = validityFilterClause(opts.asOf);

    const result = opts.includeEmbedding
      ? await this.db.execute(sql`
          SELECT
            "id"::text AS id,
            "document_id"::text AS document_id,
            "ordinal" AS ordinal,
            "text" AS text,
            "metadata" AS metadata,
            1 - ("embedding" <=> ${vecText}::vector) AS score,
            "embedding"::text AS embedding
          FROM "chunks"
          WHERE "corpus_id" = ${opts.corpusId}::uuid${filterClause}${validityClause}
          ORDER BY "embedding" <=> ${vecText}::vector
          LIMIT ${opts.limit}
        `)
      : await this.db.execute(sql`
          SELECT
            "id"::text AS id,
            "document_id"::text AS document_id,
            "ordinal" AS ordinal,
            "text" AS text,
            "metadata" AS metadata,
            1 - ("embedding" <=> ${vecText}::vector) AS score
          FROM "chunks"
          WHERE "corpus_id" = ${opts.corpusId}::uuid${filterClause}${validityClause}
          ORDER BY "embedding" <=> ${vecText}::vector
          LIMIT ${opts.limit}
        `);

    const rows = rowsFromExecute(result);
    return rows.map((r) => {
      const out: CandidateRow = {
        id: String(r['id']),
        document_id: String(r['document_id']),
        ordinal: Number(r['ordinal']),
        text: String(r['text']),
        metadata: r['metadata'] ?? undefined,
        score: Number(r['score']),
      };
      if (opts.includeEmbedding && r['embedding'] !== undefined) {
        out.embedding = parseVector(r['embedding']);
      }
      return out;
    });
  }

  /**
   * Lexical leg of a hybrid retrieve: full-text search over `chunks.text_search`
   * using the corpus's configured text search configuration.
   *
   * QUERY CONSTRUCTION — the subtle part.
   *
   * Postgres's ready-made query parsers are all CONJUNCTIVE:
   * `plainto_tsquery` and `websearch_to_tsquery` both AND their terms
   * together. That is correct for a search box with a "no results" state and
   * completely wrong for a retrieval leg. `section 70 disclosure duties`
   * becomes `'section' & '70' & 'disclosur' & 'duti'`, and the chunk that IS
   * section 70 — which contains three of those four terms — matches nothing at
   * all, because it happens not to use the word "duties". The leg silently
   * returns zero rows for exactly the
   * queries it was added to fix. (Measured: this alone cost 5 items on the
   * exact-identifier slice of the golden set.)
   *
   * So the query is built DISJUNCTIVELY instead: run the text through
   * `to_tsvector` — which applies the same stemming, stopword removal and
   * normalisation the index was built with — then OR the resulting lexemes
   * together. Ranking, not matching, decides which chunk wins, which is how a
   * BM25-style retriever is supposed to behave.
   *
   * Building the query from `to_tsvector` output also removes the injection
   * surface that raw `to_tsquery` has: the lexemes are produced by Postgres,
   * not by the user, and each is passed through `quote_literal`. There is no
   * user punctuation left to break the parse, so this cannot 500 on a stray
   * parenthesis the way `to_tsquery(<user text>)` would.
   *
   * `ts_rank_cd` (cover density) rather than `ts_rank`: it rewards matches
   * whose terms appear close together, which is what makes "section 16"
   * outrank a chunk that merely mentions "section" often and "16" once.
   * Normalisation flag 32 maps the rank into (0,1) — irrelevant to RRF, which
   * only reads order, but it keeps the `lexicalScore` we hand back to
   * consumers on a comprehensible scale.
   *
   * The `@@` predicate is what lets this use the GIN index; the ranking
   * function runs only over rows that already matched. Chunks with a NULL
   * `text_search` (ingested before migration 0012) match nothing and are
   * simply absent from this leg — the dense leg still covers them.
   */
  private async lexicalSearch(opts: {
    corpusId: string;
    query: string;
    textSearchConfig: string;
    limit: number;
    filter?: Record<string, unknown>;
    asOf?: string;
  }): Promise<CandidateRow[]> {
    const filterClause = metadataFilterClause(opts.filter);
    const validityClause = validityFilterClause(opts.asOf);
    // Bound as a parameter and cast to regconfig — NEVER interpolated. The
    // value comes from a corpus row, but corpus rows are consumer-writable, so
    // treating it as untrusted is the only safe posture.
    const cfg = sql`${opts.textSearchConfig}::regconfig`;

    // The OR-ed tsquery, built once in a CTE and cross-joined in. `''::tsquery`
    // is the empty query — it matches nothing — which is the right degenerate
    // behaviour when the query is all stopwords: this leg contributes no
    // candidates and the dense leg carries the request on its own.
    const result = await this.db.execute(sql`
      WITH q AS (
        SELECT COALESCE(
                 (SELECT string_agg(quote_literal(lexeme), ' | ')
                    FROM unnest(to_tsvector(${cfg}, ${opts.query}))),
                 ''
               )::tsquery AS tsq
      )
      SELECT
        "id"::text AS id,
        "document_id"::text AS document_id,
        "ordinal" AS ordinal,
        "text" AS text,
        "metadata" AS metadata,
        ts_rank_cd("text_search", q.tsq, 32) AS score
      FROM "chunks", q
      WHERE "corpus_id" = ${opts.corpusId}::uuid
        AND "text_search" @@ q.tsq${filterClause}${validityClause}
      ORDER BY score DESC, "id"
      LIMIT ${opts.limit}
    `);

    return rowsFromExecute(result).map((r) => ({
      id: String(r['id']),
      document_id: String(r['document_id']),
      ordinal: Number(r['ordinal']),
      text: String(r['text']),
      metadata: r['metadata'] ?? undefined,
      score: Number(r['score']),
    }));
  }

  /**
   * Learned-sparse (bge-m3) leg of a hybrid retrieve — the OPT-IN alternative to
   * `lexicalSearch`. Embeds the query with the sparse sibling, then does a
   * max-inner-product top-N over `chunks.sparse_embedding` via pgvector's `<#>`
   * (negative inner product; ascending order = most similar first), recovering
   * the inner-product score as `-(sparse_embedding <#> $q)`.
   *
   * WHY this can stand in for the `tsvector` leg: bge-m3's sparse vector is a
   * language-agnostic learned-lexical signal — it fires on the same exact
   * identifiers / keywords the `tsvector` leg exists to catch (numbers, codes,
   * names), but without a per-language regconfig, stemming, or the conjunctive-
   * parser footgun. It slots into the SAME RRF fusion with the SAME leg name
   * (`lexical`), so the response shape, ranks and tie-break chain are unchanged;
   * only the candidate source differs.
   *
   * FAIL-SAFE: if ANY step of the sparse leg fails — the sibling embed call
   * (down service, timeout, malformed response) OR the sparsevec DB query itself
   * (SPARSE_DIM drift, statement timeout, connection blip) — this returns []
   * rather than throwing, so the hybrid retrieve degrades to dense-only for this
   * request, exactly the way an un-backfilled `text_search` degrades. The whole
   * body runs under one try/catch (MED #2) precisely because `sparseSearch` runs
   * inside a `Promise.all` with the dense leg: a bare throw from the DB query
   * would reject the whole retrieve (500) instead of degrading. Reworking one leg
   * must never fail the whole query.
   *
   * `WHERE sparse_embedding IS NOT NULL` keeps chunks ingested before the sparse
   * column was populated (or under the gate-off path) out of this leg — they are
   * still covered by the dense leg.
   */
  private async sparseSearch(opts: {
    corpusId: string;
    query: string;
    limit: number;
    filter?: Record<string, unknown>;
    asOf?: string;
  }): Promise<CandidateRow[]> {
    const timeoutMs = env.SPARSE_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    // ONE try/catch spans BOTH the embed call and the sparsevec DB query (MED
    // #2). The DB query used to sit outside the catch, so a DB-side sparse error
    // (SPARSE_DIM drift, statement timeout) would reject the enclosing
    // `Promise.all` and 500 the whole hybrid retrieve instead of degrading to
    // dense-only. Any failure in here now returns [] → dense-only degrade.
    try {
      const embed = await this.sparseEmbedder({
        model: env.SPARSE_EMBED_MODEL,
        input: opts.query,
        signal: controller.signal,
      });
      const qvec = embed.sparse[0];
      if (!qvec) {
        // No sparse vector for the query ⇒ nothing to match. Degrade to dense.
        return [];
      }
      const literal = toSparsevecLiteral(qvec, env.SPARSE_DIM);

      // An empty sparse query (`{}/dim`) has zero inner product with everything —
      // no point querying. Degrade to dense-only.
      if (literal.startsWith('{}/')) return [];

      const filterClause = metadataFilterClause(opts.filter);
      const validityClause = validityFilterClause(opts.asOf);

      const result = await this.db.execute(sql`
        SELECT
          "id"::text AS id,
          "document_id"::text AS document_id,
          "ordinal" AS ordinal,
          "text" AS text,
          "metadata" AS metadata,
          ("sparse_embedding" <#> ${literal}::sparsevec) * -1 AS score
        FROM "chunks"
        WHERE "corpus_id" = ${opts.corpusId}::uuid
          AND "sparse_embedding" IS NOT NULL${filterClause}${validityClause}
        ORDER BY "sparse_embedding" <#> ${literal}::sparsevec
        LIMIT ${opts.limit}
      `);

      return rowsFromExecute(result).map((r) => ({
        id: String(r['id']),
        document_id: String(r['document_id']),
        ordinal: Number(r['ordinal']),
        text: String(r['text']),
        metadata: r['metadata'] ?? undefined,
        score: Number(r['score']),
      }));
    } catch (err) {
      this.logger?.warn(
        { err, corpusId: opts.corpusId },
        'sparse leg failed (query embed or sparsevec DB query); degrading hybrid to dense-only for this request',
      );
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Optional pre-ranking metadata containment predicate
 * (plan/open-retrieve-metadata-filter.md §4/§5). Emitted ONLY when a non-empty
 * `filter` is present — an absent or `{}` filter produces the identical SQL we
 * ran before this feature (byte-for-byte backward compat). Bound as a single
 * `::jsonb` param; never interpolated into SQL text.
 */
function metadataFilterClause(filter?: Record<string, unknown>) {
  const hasFilter = filter !== undefined && Object.keys(filter).length > 0;
  return hasFilter ? sql` AND "metadata" @> ${JSON.stringify(filter)}::jsonb` : sql``;
}

/**
 * Point-in-time validity predicate. Half-open interval semantics:
 * a chunk is eligible at instant T when `valid_from <= T < valid_to`, with a
 * NULL bound meaning unbounded on that side.
 *
 * The NULL handling is the whole point. Every chunk ingested before migration
 * 0012 — and every chunk from a consumer that has no notion of validity — has
 * both bounds NULL and therefore satisfies this predicate at every instant. So
 * adding `asOf` to a request against such a corpus changes nothing, which is
 * what makes the parameter safely additive.
 *
 * Emitted only when `asOf` is present; absent ⇒ no temporal clause at all.
 */
function validityFilterClause(asOf?: string) {
  if (asOf === undefined) return sql``;
  return sql` AND ("valid_from" IS NULL OR "valid_from" <= ${asOf}::timestamptz)
        AND ("valid_to" IS NULL OR "valid_to" > ${asOf}::timestamptz)`;
}

function rowsFromExecute(out: unknown): Array<Record<string, unknown>> {
  if (!out) return [];
  if (Array.isArray(out)) return out as Array<Record<string, unknown>>;
  const maybe = out as { rows?: Array<Record<string, unknown>> };
  return maybe.rows ?? [];
}
