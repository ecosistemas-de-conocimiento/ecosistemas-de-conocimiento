/**
 * Retrieve orchestration — fan out over the resolved corpora PLUS an
 * always-appended per-thread/session corpus, swallow per-corpus failures, tag
 * each match by corpus, sort by score, cap.
 *
 * The optional ai-service metadata `filter` is forwarded to every corpus.
 *
 * `fuseMatches()` lives here too: the pure Reciprocal-Rank-Fusion merge used
 * when a SECOND, non-vector ranked list (a graph path) contributes to the same
 * turn. It is exported and called from `prepareTurn`, not from inside
 * `retrieveContext`, so the two retrieval paths can run concurrently.
 */

import type { AIClient, ResolvedCorpus, RetrievedChunk } from './types.js';

/**
 * Canonical per-thread/session chat-docs corpus name — the ONE shared helper.
 * Every consumer that ingests, retrieves, or deletes a thread's uploaded-docs
 * corpus MUST derive the name from here (never hand-copy the literal): the
 * ingest hook, the retrieval path, and corpus teardown have to agree or the
 * corpus leaks / retrieval silently misses.
 *
 * Format follows the `<prefix>:<id>` corpus-namespace convention:
 * `chat:thread:<id>`.
 */
export function threadCorpus(threadId: number | string): string {
  return `chat:thread:${threadId}`;
}

/** How many merged chunks survive the cap. */
export const DEFAULT_MERGED_CAP = 8;
/** Per-corpus topK. */
export const DEFAULT_PER_CORPUS_TOPK = 5;
/**
 * RRF constant in `Σ 1/(k + rank)`. 60 is the value ai-service's hybrid
 * retriever uses (`services/ai-service/src/services/rag/retrieve.ts`); the two
 * fusions are deliberately the same shape.
 */
export const DEFAULT_RRF_K = 60;

export interface RetrieveContextArgs {
  aiClient: AIClient;
  orgId: string;
  /** Fallback scope for corpora that have no single scope (per-thread). */
  fallbackScopeId: string;
  corpora: ResolvedCorpus[];
  threadId: number | string;
  query: string;
  /** Optional ai-service metadata filter, forwarded to every corpus retrieve. */
  filter?: Record<string, string | number | boolean>;
  /** Per-corpus topK. Defaults to `DEFAULT_PER_CORPUS_TOPK` (5). */
  perCorpusTopK?: number;
  /** How many merged chunks survive the cap. Defaults to `DEFAULT_MERGED_CAP` (8). */
  mergedCap?: number;
}

/**
 * Best-effort retrieval. The resolver-supplied corpora PLUS the per-thread
 * chat-docs corpus, each fetched independently; any side may fail/empty without
 * killing the turn. Merged by score, capped.
 */
export async function retrieveContext(
  args: RetrieveContextArgs,
): Promise<RetrievedChunk[]> {
  const trimmed = args.query.trim();
  if (!trimmed) return [];
  const queryText = trimmed.slice(0, 2000);
  const topK = args.perCorpusTopK ?? DEFAULT_PER_CORPUS_TOPK;

  const targets: ResolvedCorpus[] = [
    ...args.corpora,
    { corpus: threadCorpus(args.threadId), scopeId: args.fallbackScopeId },
  ];

  const fetchOne = ({ corpus, scopeId }: ResolvedCorpus) =>
    args.aiClient
      .retrieve({
        orgId: args.orgId,
        scopeId: scopeId || args.fallbackScopeId,
        corpus,
        query: queryText,
        topK,
        ...(args.filter ? { filter: args.filter } : {}),
      })
      .then((r) =>
        (r.matches ?? []).map((m) => ({ ...m, corpus }) as RetrievedChunk),
      )
      .catch(() => [] as RetrievedChunk[]);

  const results = await Promise.all(targets.map(fetchOne));
  const tagged: RetrievedChunk[] = results.flat();
  // ONE merge code path: `fuseMatches` with an empty second leg IS the plain
  // descending-score sort + cap this function has always done (see its header).
  return fuseMatches(tagged, [], {
    ...(args.mergedCap !== undefined ? { mergedCap: args.mergedCap } : {}),
  });
}

export interface FuseMatchesOptions {
  /** RRF constant in `Σ 1/(k + rank)`. Defaults to `DEFAULT_RRF_K` (60). */
  k?: number;
  /** How many fused chunks survive the cap. Defaults to `DEFAULT_MERGED_CAP` (8). */
  mergedCap?: number;
}

/**
 * Merge two ranked chunk lists into one.
 *
 * ── When the second list is EMPTY ────────────────────────────────────────────
 * The result is byte-identical to a plain `sort((a, b) => b.score - a.score)`
 * followed by `slice(0, mergedCap)` — same records, same order, duplicates and
 * all. That is deliberate, for two reasons:
 *
 *   1. Within ONE modality the scores ARE commensurable. Every chunk in
 *      `vectorMatches` was scored by the same cosine metric, so the magnitudes
 *      carry real information about how much better the top hit is than the
 *      next one. RRF throws magnitudes away and keeps only the ordering; doing
 *      that to a single-modality list would discard usable information for
 *      nothing in return.
 *   2. It keeps the existing behaviour — and the existing tests — untouched.
 *      The no-graph path is the overwhelmingly common one and it must not
 *      change just because an optional graph path was wired in elsewhere.
 *
 * ── When the second list has entries ─────────────────────────────────────────
 * The scores are NOT commensurable across the two paths (a cosine score and
 * whatever a graph-expanded path scores with live on different scales, with
 * different floors, ceilings and corpus dependence), so we fuse with pure
 * Reciprocal Rank Fusion — `rrf(d) = Σ_legs 1 / (k + rank_leg(d))`, 1-based
 * ranks, legs a chunk is absent from contributing nothing. Any fixed weighting
 * of the two raw scores would be a hidden per-corpus tuning constant that is
 * silently wrong for the next corpus. This is exactly ai-service's answer to
 * the same problem between cosine and `ts_rank_cd`
 * (`services/ai-service/src/services/rag/retrieve.ts:126-146`), down to k=60
 * and the modified-competition ranking of tie blocks.
 *
 * Chunks are deduped by `chunkId`, keeping the richer record.
 *
 * NOTE the RRF score orders the result but never overwrites
 * `RetrievedChunk.score`: that field is persisted into provenance and rendered
 * to the user as a relevance percentage by `provenanceToCitations`, so it has
 * to stay on the scale the retriever produced it on.
 *
 * Pure — no I/O, and neither input array is mutated.
 */
export function fuseMatches(
  vectorMatches: RetrievedChunk[],
  graphMatches: RetrievedChunk[],
  opts: FuseMatchesOptions = {},
): RetrievedChunk[] {
  const cap = opts.mergedCap ?? DEFAULT_MERGED_CAP;
  const k = opts.k ?? DEFAULT_RRF_K;

  // The no-graph path: today's behaviour, exactly. See the header.
  if (graphMatches.length === 0) {
    return [...vectorMatches].sort((a, b) => b.score - a.score).slice(0, cap);
  }

  const legs: Array<{ name: 'vector' | 'graph'; rows: RetrievedChunk[] }> = [
    { name: 'vector', rows: byDescendingScore(vectorMatches) },
    { name: 'graph', rows: byDescendingScore(graphMatches) },
  ];

  interface FusedEntry {
    chunk: RetrievedChunk;
    /** Σ 1/(k + rank) across the legs this chunk appeared in. */
    rrf: number;
    /** How many legs found it (1 or 2) — the first tie-break. */
    legsFound: number;
    vectorScore: number;
    graphScore: number;
  }

  const byId = new Map<string, FusedEntry>();

  for (const leg of legs) {
    const ranks = competitionRanks(leg.rows);
    const seenInLeg = new Set<string>();
    leg.rows.forEach((row, i) => {
      const rank = ranks[i]!;
      let entry = byId.get(row.chunkId);
      if (!entry) {
        entry = {
          chunk: row,
          rrf: 0,
          legsFound: 0,
          vectorScore: -Infinity,
          graphScore: -Infinity,
        };
        byId.set(row.chunkId, entry);
      } else if (isRicher(row, entry.chunk)) {
        entry.chunk = row;
      }
      // A chunk that came back twice within ONE leg (the same chunk id in two
      // corpora) is one vote, not two — otherwise a duplicate on its own could
      // outrank a genuine rank-1 hit.
      if (seenInLeg.has(row.chunkId)) return;
      seenInLeg.add(row.chunkId);
      entry.legsFound += 1;
      if (leg.name === 'vector') entry.vectorScore = row.score;
      else entry.graphScore = row.score;
      entry.rrf += 1 / (k + rank);
    });
  }

  return [...byId.values()]
    .sort((a, b) => {
      if (b.rrf !== a.rrf) return b.rrf - a.rrf;
      // Tie-break chain, most to least meaningful — every step derived from
      // CONTENT, with the chunk id only as a last resort (ai-service learned
      // the hard way that tie-breaking straight to a regenerated uuid makes
      // identical data produce different orderings on different runs).
      if (a.legsFound !== b.legsFound) return b.legsFound - a.legsFound;
      if (a.vectorScore !== b.vectorScore) return b.vectorScore - a.vectorScore;
      if (a.graphScore !== b.graphScore) return b.graphScore - a.graphScore;
      return a.chunk.chunkId < b.chunk.chunkId
        ? -1
        : a.chunk.chunkId > b.chunk.chunkId
          ? 1
          : 0;
    })
    .slice(0, cap)
    .map((e) => e.chunk);
}

/** Copy, sorted by descending score. `Array#sort` is stable, so ties keep the caller's order. */
function byDescendingScore(rows: RetrievedChunk[]): RetrievedChunk[] {
  return [...rows].sort((a, b) => b.score - a.score);
}

/**
 * Modified competition ranking ("1334"): equal scores share the LAST rank of
 * their group, so a leg that cannot distinguish N candidates is credited at the
 * confidence it actually expressed ("somewhere at the bottom of what I
 * returned") instead of every member of the tie block collecting a runner-up's
 * reciprocal. Same rule, and same reasoning, as ai-service's `competitionRanks`.
 *
 * `rows` must already be sorted by descending score.
 */
function competitionRanks(rows: RetrievedChunk[]): number[] {
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

/**
 * "Keep the richer record": the same chunk can come back from both legs with
 * different amounts of detail attached. Richer = more metadata keys, then
 * longer grounding text. A tie keeps the incumbent (so the vector leg wins),
 * which makes the choice deterministic.
 */
function isRicher(candidate: RetrievedChunk, incumbent: RetrievedChunk): boolean {
  const ck = candidate.metadata ? Object.keys(candidate.metadata).length : 0;
  const ik = incumbent.metadata ? Object.keys(incumbent.metadata).length : 0;
  if (ck !== ik) return ck > ik;
  return (candidate.text?.length ?? 0) > (incumbent.text?.length ?? 0);
}
