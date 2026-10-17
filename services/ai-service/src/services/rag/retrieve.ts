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
import { CorpusNotFoundError } from './errors.js';
import { callOpenRouterEmbedding } from '../ai/embeddings/openrouter.js';
import {
  callSparseEmbed,
  toSparsevecLiteral,
  type SparseEmbedder,
} from '../ai/embeddings/sparse-embed.js';
import { callRerank, type Reranker, type RerankResult } from '../ai/rerank/rerank-client.js';
import { clampPassageText, corpusPassageBound } from './passage-bound.js';
import { metadataFilterClause } from './metadata-filter.js';
import type {
  CorpusRow,
  RetrievalLeg,
  RetrieveRequest,
  RetrieveResult,
  RetrievedChunk,
} from './types.js';

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

/**
 * Minimal logger surface (matches Fastify's `log.warn` / `log.info`). `info` is
 * optional so a warn-only logger still type-checks; the success-path rerank line
 * (`RERANK_OK_MESSAGE`) is simply not written to one.
 */
export interface RetrieveLogger {
  warn(obj: unknown, msg?: string): void;
  info?(obj: unknown, msg?: string): void;
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

/**
 * The payload of the "retrieval leg returned zero rows" warning — a leg this
 * request ASKED for that came back with nothing.
 *
 * Exported because `onSilentLeg` (below) hands it to the caller verbatim: a
 * caller that decides to log it after all logs THIS object, so the log line is
 * identical whoever emitted it. Never carries the query text — that is caller
 * content and `traces` is the surface allowed to hold it.
 */
export interface SilentLegWarning {
  leg: RetrievalLeg;
  corpus: string;
  corpusId: string;
  mode: 'dense' | 'hybrid';
  org: string;
  project: string;
}

/**
 * The message `RetrieveService` logs a `SilentLegWarning` under. Exported so a
 * caller that defers the decision (see `onSilentLeg`) and later emits the warn
 * itself produces a byte-identical line — one grep still finds every silent leg
 * on every route. Importing the constant is what makes that compiler-checked.
 */
export const SILENT_LEG_MESSAGE = 'retrieval leg returned zero rows';

/**
 * Why the rerank rung contributed less than a full cross-encoder ordering.
 *
 * These are FOUR DIFFERENT operational facts and collapsing them into one
 * "rerank did not run" line would rebuild the problem this exists to solve:
 *   - `timeout`     — `RERANK_TIMEOUT_MS` fired and the call was aborted. The
 *                     reranker is alive and too slow; the BUDGET is the defect.
 *   - `error`       — the reranker threw, refused the connection, or answered
 *                     with an error envelope. The RERANKER is the defect.
 *   - `unavailable` — rerank was REQUESTED but none is configured
 *                     (`RERANK_ENABLED` / `RERANK_URL`). A DEPLOYMENT defect:
 *                     the consumer believes the rung is on and it is not.
 *   - `backfilled`  — the reranker answered, but with fewer usable results than
 *                     `topK`, so the tail is fused order carrying no
 *                     `rerankScore`. Partial, not absent.
 *
 * They demand different fixes, so the warning names which one happened.
 */
export type RerankDegradation = 'timeout' | 'error' | 'unavailable' | 'backfilled';

/**
 * The payload of the "rerank did not fully happen" warning.
 *
 * Exported for the reason `SilentLegWarning` is: a caller that takes the hook
 * logs THIS object, so the line is identical whoever emits it. Carries no query
 * text — that is caller content and `traces` is the surface allowed to hold it.
 */
export interface RerankDegradedWarning {
  reason: RerankDegradation;
  corpus: string;
  corpusId: string;
  org: string;
  project: string;
  model: string;
  /** Candidates handed to the reranker. */
  poolSize: number;
  /** Returned chunks carrying a `rerankScore`. 0 on a full fallback. */
  scored: number;
  topK: number;
  /** The budget in force, so a `timeout` line explains itself without a lookup. */
  timeoutMs: number;
  /** Error text on `error`/`timeout`. Never the query. */
  detail?: string;
}

/**
 * The message a `RerankDegradedWarning` is logged under. Exported for the same
 * reason as `SILENT_LEG_MESSAGE`: one grep finds every degraded rerank on every
 * route, and importing the constant is what makes that compiler-checked.
 */
export const RERANK_DEGRADED_MESSAGE =
  'rerank degraded; results are not fully cross-encoder ordered';

/**
 * The message a SUCCESSFUL rerank is logged under (info level), on both
 * `/v1/retrieve` and `/v1/retrieve/multi`. Item 0 of the aiinfra backlog: before
 * this, a rerank that worked wrote nothing, so a working PII scrub and a bypassed
 * one looked identical from outside. Emitted on every reranker RETURN, including
 * one that also warns `backfilled` — the scrub ran and the pool left either way.
 */
export const RERANK_OK_MESSAGE = 'rerank ok';

/**
 * The `RERANK_OK_MESSAGE` line. Counts and identifiers only — NEVER the query or
 * any chunk text, scrubbed or not.
 *
 * `piiMinimised` is true ONLY when the reranker returned an `egress` report,
 * i.e. `callRerank` ran the scrub. An injected reranker (eval/tests) reports
 * none, and a future seam that skipped the scrub would report none — which is
 * the point: the line says what was PROVEN, not what is configured.
 */
export interface RerankOkLine {
  /** One corpus on `/v1/retrieve`; the fused corpora list on `/multi`. */
  corpus: string | readonly string[];
  org: string;
  project: string;
  model: string;
  provider: string;
  /** Candidates sent to the reranker. */
  poolSize: number;
  /** Returned chunks carrying a `rerankScore`. */
  scored: number;
  topK: number;
  piiMinimised: boolean;
  /** Total redactions in the payload sent; `null` when `piiMinimised` is false. */
  piiRedactions: number | null;
  /** Non-zero redaction counts by PII kind; `null` when `piiMinimised` is false. */
  piiCounts: Record<string, number> | null;
}

/** Build the `RERANK_OK_MESSAGE` line. Shared by both routes so the shape cannot drift. */
export function rerankOkLine(
  base: Omit<RerankOkLine, 'provider' | 'piiMinimised' | 'piiRedactions' | 'piiCounts'>,
  egress: RerankResult['egress'],
): RerankOkLine {
  const piiCounts = egress
    ? Object.fromEntries(Object.entries(egress.counts).filter(([, n]) => n > 0))
    : null;
  return {
    ...base,
    provider: env.RERANK_PROVIDER,
    piiMinimised: egress !== undefined,
    piiRedactions: egress ? egress.redactions : null,
    piiCounts,
  };
}

export interface RetrieveContext {
  org: string;
  project: string;
  /**
   * Per-call sink for the silent-leg signal. Absent — which is every caller
   * except the multi-corpus fan-out — `retrieve` warns it on `logger` itself,
   * exactly as it always has. Present, `retrieve` calls this INSTEAD and logs
   * nothing: the caller now owns whether the signal is worth a log line.
   *
   * It exists because "a leg went silent" means different things on different
   * routes. On `/v1/retrieve` it is the whole point — the caller asked one
   * corpus a question and a leg had nothing to say. On `/v1/retrieve/multi` a
   * corpus that matches nothing is ROUTINE and is ALREADY reported, as a
   * `{ corpus, matched: 0 }` row; fanning out over five corpora would
   * otherwise emit three of these per ordinary request (six in hybrid mode,
   * two legs each), and a warning that fires on ordinary traffic is a warning
   * nobody reads.
   *
   * ⚠ The hook is called DURING the retrieve, but the multi route's verdict
   * depends on how the corpus RESOLVED — a corpus that matched but had one
   * silent leg (a dead sparse leg behind a working dense one) is an anomaly
   * nothing else reports and must still be heard. So this is a sink to collect
   * into, not a boolean to suppress with: buffer the warnings, then decide once
   * the promise settles.
   *
   * On `ctx` and not on the request because `RetrieveRequest` is the validated
   * wire body — a function has no place there. `ctx` is the per-call plumbing,
   * which also makes this concurrency-safe with nothing extra: two simultaneous
   * fan-outs over the same corpus hold separate `ctx` objects and cannot settle
   * each other's warnings.
   */
  onSilentLeg?: (warning: SilentLegWarning) => void;

  /**
   * Per-call sink for the rerank-degraded signal, with exactly the disposition
   * rule `onSilentLeg` has: present, `retrieve` calls this and logs nothing;
   * absent, it warns on `logger` itself. The caller owns whether the signal is
   * worth a log line, and living on `ctx` keeps it concurrency-safe for free —
   * two simultaneous retrieves hold separate `ctx` objects.
   *
   * 🔴 It exists because rerank is FAIL-SAFE: every error and every timeout
   * returns the fused order and the response is byte-identical to `rerank:
   * false` minus `rerankScore`. Measured, a real CPU rerank of a
   * 40-candidate pool of 800-token chunks takes ~99 s against a 5 s budget, so
   * the timeout path is not an edge case — it is what happens on every call.
   * Without this hook a rerank that never once succeeded is indistinguishable
   * from one that works.
   */
  onRerankDegraded?: (warning: RerankDegradedWarning) => void;
}

/** Thrown when `(org, project, name)` has no `corpora` row. Route layer maps to 404. */
export { CorpusNotFoundError };

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
  legs: Array<{ name: 'dense' | 'lexical' | 'sparse'; rows: CandidateRow[] }>,
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
      //
      // ⚠ ORDER CHANGED: the leg-count tier used to be FIRST, ahead of every
      // score. It read "found by both legs beats found by one", which sounds
      // like the most meaningful step in the chain and was in fact the only
      // BIASED one.
      //
      // Being found by two legs is not a property of the chunk. It is a
      // property of whether the second leg was ELIGIBLE to see it — and both
      // lexical legs filter on a nullable column that ingest backfills:
      // `sparseSearch` requires `sparse_embedding IS NOT NULL`, and
      // `lexicalSearch` matches nothing on a NULL `text_search` (every row
      // ingested before migration 0012). So on a PARTIALLY backfilled corpus —
      // which is every corpus during a backfill, and every corpus where
      // `SPARSE_ENABLED` was turned on after some content already existed —
      // the counter is not measuring "how many ways did this chunk match". It
      // is measuring "how many legs could have seen this chunk at all", and
      // then ranking on it as if it were evidence. Recently-ingested chunks
      // won every exact score tie against equally relevant older ones.
      //
      // The fix is ORDER, not removal. Cosine similarity is eligible for every
      // chunk (`embedding` is NOT NULL), so letting it decide first means
      // relevance settles the tie before eligibility gets a vote — but ONLY
      // while the dense scores differ. `lexicalScore` is itself an eligibility
      // tier: any lexical score beats the `-Infinity` an absent one falls back
      // to, so a chunk the lexical leg could not see still loses that tier for
      // the same reason the leg count used to punish it. The reorder puts the
      // bias behind relevance; it does not remove it.
      //
      // ⚠ And the leg-count tier below is now UNREACHABLE, for as long as a
      // hybrid retrieve runs exactly two legs. With two legs `legsFound === 2`
      // ⟺ both `denseScore` and `lexicalScore` are set, and `=== 1` ⟺ exactly
      // one is. So whenever the counts differ, one of the two score tiers
      // above has already compared a finite number against `-Infinity` and
      // returned. Measured: replacing the `af !== bf` line with a `throw` runs
      // 1822 unit + 224 integration tests with ZERO throws — including the
      // half-populated repro written to exercise this very tier, and including
      // the eval gate.
      //
      // ⚠ The severity above was also overstated, and this is the correction.
      // It read as a live bias at default parameters. At default parameters no
      // cross-leg-count exact tie can occur at all. RRF with parameter `k` over
      // a candidate pool of `N`: a two-leg document scores at least `2/(k+N)`,
      // a one-leg document at most `1/(k+1)`, and those two ranges are disjoint
      // whenever `N < k+2`. The defaults are `topK=10` ⇒ pool 50
      // (`HYBRID_POOL_MULTIPLIER`) and `rrfK=60`, so 50 < 62 and the two
      // populations cannot collide. Overlap begins only at `topK >= 13`. The
      // reorder is correct and harmless — it just was not putting out a fire.
      //
      // Kept rather than deleted because the declared next change brings it
      // back: fusing dense + tsvector + sparse gives three legs, and both
      // lexical legs write the SAME `lexicalScore` slot. A three-leg and a
      // two-leg document can then agree on `denseScore` and on `lexicalScore`
      // and still differ on the count, which is exactly the case this tier
      // decides — now from a position where it can no longer outrank a
      // similarity difference.
      //
      // Normalising the count by each chunk's eligible-leg count would be the
      // more principled fix, and is NOT implementable here: eligibility for a
      // leg that did not return a row is unknown without a second query. If
      // the union lane (dense + tsvector + sparse together) ever adds a
      // `sparse_populated` signal, revisit this with that number in hand.
      const ads = a.denseScore ?? -Infinity;
      const bds = b.denseScore ?? -Infinity;
      if (ads !== bds) return bds - ads;
      const als = a.lexicalScore ?? -Infinity;
      const bls = b.lexicalScore ?? -Infinity;
      if (als !== bls) return bls - als;
      const af = legsFound.get(a.id) ?? 0;
      const bf = legsFound.get(b.id) ?? 0;
      // Unreachable while a hybrid runs two legs (see above); live again under
      // the declared three-leg fusion.
      if (af !== bf) return bf - af; // found by both legs > found by one
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
export function competitionRanks(rows: ReadonlyArray<{ score: number }>): number[] {
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
    // Every leg this request actually ASKED for, with how many rows it came
    // back with. `legs` on the response is the subset that returned any; the
    // zero-row entries are what gets warned about below. Order is stable —
    // dense, then the lexical leg, then rerank — because a consumer diffing
    // `legs` across requests should see a set change, not a shuffle.
    const attempted: Array<{ name: RetrievalLeg; rows: number }> = [];

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
      // The two lexical legs are DIFFERENT legs and are named as such from here
      // on. They used to share the name `'lexical'` all the way to the wire,
      // which is what made a dead sparse leg indistinguishable from a working
      // tsvector one. `lexicalScore` and `ranks.lexical` keep their names — they
      // are the "second leg" score slot and renaming them would break every
      // consumer for no gain; `legs` is what says which leg filled them.
      const secondLeg: RetrievalLeg = useSparse ? 'sparse' : 'lexical';
      // Both legs in parallel — they are independent reads against the same
      // snapshot-consistent connection pool.
      const [dense, lexical] = await Promise.all([
        this.vectorSearch({
          corpusId: corpusRow.id,
          org: ctx.org,
          project: ctx.project,
          queryVec,
          limit: poolSize,
          includeEmbedding: useMmr,
          ...predicates,
        }),
        useSparse
          ? this.sparseSearch({
              corpusId: corpusRow.id,
              org: ctx.org,
              project: ctx.project,
              query: req.query,
              limit: poolSize,
              ...predicates,
            })
          : this.lexicalSearch({
              corpusId: corpusRow.id,
              org: ctx.org,
              project: ctx.project,
              query: req.query,
              textSearchConfig: corpusRow.textSearchConfig,
              limit: poolSize,
              ...predicates,
            }),
      ]);
      attempted.push(
        { name: 'dense', rows: dense.length },
        { name: secondLeg, rows: lexical.length },
      );
      pool = rrfFuse(
        [
          { name: 'dense', rows: dense },
          { name: secondLeg, rows: lexical },
        ],
        req.rrfK ?? DEFAULT_RRF_K,
        Math.min(poolSize, poolDepth),
      );
    } else {
      const candidates = await this.vectorSearch({
        corpusId: corpusRow.id,
        org: ctx.org,
        project: ctx.project,
        queryVec,
        limit: poolDepth,
        includeEmbedding: useMmr,
        ...predicates,
      });
      attempted.push({ name: 'dense', rows: candidates.length });
      // Dense mode: `score` stays the cosine value it has always been, and
      // `denseScore` mirrors it so consumers can read one field in both modes.
      pool = candidates.map((row) => ({ ...row, denseScore: row.score, denseRank: undefined }));
    }

    // ── Stage 2: pick the final topK. Exactly one rung runs. ─────────────────
    // Where a rerank-degraded warning goes. Built HERE because only this scope
    // holds the corpus row and `ctx`; `applyRerank` stays ignorant of both and
    // just reports what it saw. Same shape as the silent-leg disposition below.
    const rerankModel = req.rerankModel ?? env.RERANK_MODEL;
    const reportRerankDegraded = (
      reason: RerankDegradation,
      scored: number,
      detail?: string,
    ): void => {
      const warning: RerankDegradedWarning = {
        reason,
        corpus: req.corpus,
        corpusId: corpusRow.id,
        org: ctx.org,
        project: ctx.project,
        model: rerankModel,
        poolSize: pool.length,
        scored,
        topK,
        timeoutMs: env.RERANK_TIMEOUT_MS,
        ...(detail !== undefined ? { detail } : {}),
      };
      if (ctx.onRerankDegraded) ctx.onRerankDegraded(warning);
      else this.logger?.warn(warning, RERANK_DEGRADED_MESSAGE);
    };

    let selected: FusedCandidate[];
    if (wantRerank) {
      // Cross-encoder re-scoring over the fused pool, then topK. Fail-safe: on
      // any error/timeout this returns the fused order sliced to topK — a slow
      // or broken reranker must never fail the query. It reports WHY through
      // `reportRerankDegraded` so the fallback is not also silent.
      selected = await this.applyRerank(
        pool,
        req.query,
        rerankModel,
        topK,
        reportRerankDegraded,
        (scored, egress) =>
          this.logger?.info?.(
            rerankOkLine(
              {
                corpus: req.corpus,
                org: ctx.org,
                project: ctx.project,
                model: rerankModel,
                poolSize: pool.length,
                scored,
                topK,
              },
              egress,
            ),
            RERANK_OK_MESSAGE,
          ),
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

    // Asked for and never even attempted, because nothing is configured to
    // answer. `wantRerank` is false here, so no leg was pushed and the
    // silent-leg loop below cannot see it — this is the ONLY place that can.
    if (req.rerank === true && !rerankAvailable) reportRerankDegraded('unavailable', 0);

    // ── Stage 2.5: which legs returned candidates. ───────────────────────────
    // Note the unit is not uniform, and that is on purpose. `dense`, `lexical`
    // and `sparse` were counted at Stage 1 as rows into the POOL; a leg whose
    // rows all lost the fusion, or fell outside the final top-K, still counts
    // as having run. Rerank has no pool, so it is counted here off the OUTPUT.
    // Rerank counts as a leg that RAN only when at least one returned chunk
    // carries a `rerankScore`. That is deliberately read off the OUTPUT rather
    // than tracked as a flag inside `applyRerank`: the fail-safe there returns
    // the fused order on any error, producing a response byte-identical to
    // `rerank: false` minus `rerankScore`, and a flag could drift from what the
    // consumer actually received. Reading the rows cannot drift — `legs`
    // includes `rerank` exactly when `rerankScore` is present.
    if (wantRerank) {
      attempted.push({
        name: 'rerank',
        rows: selected.filter((row) => row.rerankScore !== undefined).length,
      });
    }

    // A leg that was asked for and came back empty is the silent-degradation
    // case this whole field exists to expose. `legs` tells the CALLER; this
    // tells US, because a consumer that never reads `legs` still leaves a trace
    // in the logs.
    //
    // Where it goes is the caller's call: `ctx.onSilentLeg` takes it if the
    // caller supplied one (the multi-corpus fan-out does, because a zero-match
    // corpus is routine THERE and already reported), otherwise it is logged
    // right here — which is every other caller, unchanged.
    for (const leg of attempted) {
      if (leg.rows > 0) continue;
      const warning: SilentLegWarning = {
        leg: leg.name,
        corpus: req.corpus,
        corpusId: corpusRow.id,
        mode: hybrid ? 'hybrid' : 'dense',
        org: ctx.org,
        project: ctx.project,
      };
      if (ctx.onSilentLeg) ctx.onSilentLeg(warning);
      else this.logger?.warn(warning, SILENT_LEG_MESSAGE);
    }

    const legs = attempted.filter((leg) => leg.rows > 0).map((leg) => leg.name);

    // ── Stage 3: serialize, honouring ai-service's OWN chunk-size contract. ──
    // Ingestion targets `corpus.chunk_size` tokens per chunk; retrieval clamps
    // stored text to that same bound (via the same `maxChunkChars`, so the two
    // cannot drift). Legacy rows, hand-inserted rows and any future ingester
    // bug are truncated HERE rather than handed to a consumer unbounded — and a
    // clamp that actually fires warns with the row's identifiers, because such
    // a row is an anomaly worth investigating. See `passage-bound.ts`.
    //
    // This is also the choke point for `/v1/retrieve/multi`: `RetrieveMulti-
    // Service` composes this method per corpus, so the bound applies there too.
    //
    // Deliberately the LAST step, after rerank/MMR: the clamp is an output
    // contract, not a retrieval knob. Selection therefore still sees the row as
    // stored, and an anomalous row cannot change which chunks win by having
    // been shortened first. The one consequence to know about is that the
    // single-corpus cross-encoder (`applyRerank`, above) scores the UNCLAMPED
    // text; `/v1/retrieve/multi` reranks after fusion and so scores clamped
    // text. Both are fine — over-bound rows are anomalies, not routine — but
    // the two rungs are not byte-identical in what they feed the reranker.
    const passageBound = corpusPassageBound(corpusRow);
    const chunks: RetrievedChunk[] = selected.map((row) => ({
      chunkId: row.id,
      documentId: row.document_id,
      ordinal: row.ordinal,
      text: clampPassageText(
        row.text,
        passageBound,
        {
          corpusId: corpusRow.id,
          corpus: req.corpus,
          documentId: row.document_id,
          chunkId: row.id,
          ordinal: row.ordinal,
        },
        this.logger,
      ),
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
    return { chunks, legs };
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
    onDegraded: (reason: RerankDegradation, scored: number, detail?: string) => void,
    onOk: (scored: number, egress: RerankResult['egress']) => void,
  ): Promise<FusedCandidate[]> {
    if (pool.length === 0) return [];

    const controller = new AbortController();
    const timeoutMs = env.RERANK_TIMEOUT_MS;
    // Set by the TIMER, not inferred from the error. An `AbortError` says the
    // call was aborted, never WHO aborted it — only the timer knows the budget
    // is what fired, and "the budget is too small" and "the reranker is broken"
    // are different defects with different owners.
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : undefined;

    try {
      const documents = pool.map((c) => c.text);
      const { results, egress } = await this.reranker({
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
      const scored = selected.length;
      if (selected.length < topK) {
        for (let i = 0; i < pool.length && selected.length < topK; i++) {
          if (seen.has(i)) continue;
          seen.add(i);
          selected.push(pool[i]!);
        }
        // Only a degradation when the pool HAD more to give. A pool smaller
        // than topK is a small corpus, not a misbehaving reranker, and warning
        // on it would make this fire on ordinary traffic.
        if (scored < Math.min(topK, pool.length)) onDegraded('backfilled', scored);
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
      // Replaces a bare `logger?.warn`: same information, but routed through
      // the hook so a caller can see it, and NAMING which of the two failures
      // happened instead of one undifferentiated line.
      onDegraded(
        timedOut ? 'timeout' : 'error',
        0,
        err instanceof Error ? err.message : String(err),
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
    org: string;
    project: string;
    queryVec: number[];
    limit: number;
    includeEmbedding: boolean;
    filter?: Record<string, unknown>;
    asOf?: string;
  }): Promise<CandidateRow[]> {
    const vecText = `[${opts.queryVec.join(',')}]`;

    const scopeClause = chunkScopeClause(opts.org, opts.project);
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
          WHERE "corpus_id" = ${opts.corpusId}::uuid${scopeClause}${filterClause}${validityClause}
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
          WHERE "corpus_id" = ${opts.corpusId}::uuid${scopeClause}${filterClause}${validityClause}
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
    org: string;
    project: string;
    query: string;
    textSearchConfig: string;
    limit: number;
    filter?: Record<string, unknown>;
    asOf?: string;
  }): Promise<CandidateRow[]> {
    const scopeClause = chunkScopeClause(opts.org, opts.project);
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
      WHERE "corpus_id" = ${opts.corpusId}::uuid${scopeClause}
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
    org: string;
    project: string;
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

      const scopeClause = chunkScopeClause(opts.org, opts.project);
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
        WHERE "corpus_id" = ${opts.corpusId}::uuid${scopeClause}
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
 * Chunk-layer tenancy fence. `chunks` carries its own NOT NULL `org` and
 * `project` (`src/db/schema/index.ts`), but every candidate query used to
 * filter on `corpus_id` alone — so isolation was INHERITED from the scoped
 * corpus lookup (`lookupCorpus`, which resolves `(org, project, name)` from the
 * bearer token) rather than ENFORCED where the rows are read.
 *
 * That held only because every caller happened to pass `corpusRow.id`. One
 * future caller passing a raw corpus id — a cache, a batch path, a job that
 * carries an id across a queue — would silently lose the fence with nothing to
 * fail. Defence in depth: the predicate is redundant TODAY and is exactly what
 * keeps it redundant tomorrow.
 *
 * 🔴 NOT free at runtime, on ONE path. An earlier version of this comment
 * claimed the clause was free; a later one over-corrected and claimed it hurt
 * dense retrieval too. Both were wrong. What reproduces, on a throwaway PG 16.14
 * with stock planner defaults, 60k chunks over 3 `(org, project)` pairs and
 * realistic 800-char chunk text:
 *
 *   deep pool (MMR, LIMIT 60), corpus_id only   Index Scan hnsw    2.24 ms
 *   deep pool, + org + project                  SEQ SCAN 60k     661.19 ms
 *   deep pool, fenced, + extended statistics    Index Scan hnsw    1.91 ms
 *
 * That is 295x, and a full recovery to better than the pre-fence baseline.
 *
 * ⚠ Dense top-K did NOT collapse and is not the reason this migration exists:
 * `LIMIT 10` stayed on the HNSW index fenced (0.135 ms) and unfenced (0.290 ms).
 * A "dense went 18x slower" figure circulated while this was being written; it
 * was arithmetic on a document, never a measurement, and it did not reproduce at
 * any parameterisation tried. The tsvector lexical leg is likewise unaffected
 * (23.997 → 23.833 ms, identical plan). The damage is specific to the DEEP
 * ordered ANN scan.
 *
 * The mechanism is the row ESTIMATE, not the predicate's cost. Postgres assumes
 * columns are independent, so it multiplies the selectivity of `org` and
 * `project` on top of `corpus_id`; the estimate for the fenced query comes out
 * at 2,271 rows against a true 20,000. At that estimate an ordered index scan
 * stops looking worth it and the planner takes a sequential scan instead.
 *
 * ⚠ The original comment cited `chunks_corpus_ordinal_idx` on `corpus_id` as its
 * evidence of safety. That index only becomes the entry point BECAUSE the
 * predicate broke the HNSW plan: the sentence was reading the damage as proof
 * that no damage had occurred.
 *
 * 🔴 REPRODUCING THIS NEEDS A REALISTIC HEAP, and that is not obvious.
 * `embedding` is `attstorage='e'`, so the vectors live out of line in TOAST and
 * the heap is tiny unless `text` is realistic. At 2.5k / 5k / 10k rows with
 * short filler text there is NO plan flip at all — the planner sits on a
 * bitmap or sequential path either way, and a sequential scan is genuinely the
 * right choice there. A casual re-measurement with toy rows will conclude this
 * was imagined and pull the migration. It was not: use large row counts AND
 * realistic chunk text, or you are measuring a different table.
 *
 * So this fence DEPENDS on Postgres extended statistics — migration
 * `0004_chunks_scope_deps` adds
 *
 *     CREATE STATISTICS IF NOT EXISTS chunks_scope_deps (dependencies)
 *       ON corpus_id, org, project FROM chunks;
 *
 * plus an `ANALYZE`. With those in place the planner knows `corpus_id` already
 * implies its tenant and goes back to the index scan. A deployment carrying
 * this predicate WITHOUT that migration runs deep-pool retrieval on a
 * sequential scan once a corpus is large enough to matter.
 *
 * ⚠ The migration is INERT until then: at dev's 615 chunks, and at zero on
 * stage and prod, it changes no plan. It only starts paying near ~20k chunks in
 * one tenant. It ships early because the alternative is discovering the need
 * during an incident.
 *
 * Bound as parameters, never interpolated — both values come from `req.auth`.
 */
function chunkScopeClause(org: string, project: string) {
  return sql` AND "org" = ${org} AND "project" = ${project}`;
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
