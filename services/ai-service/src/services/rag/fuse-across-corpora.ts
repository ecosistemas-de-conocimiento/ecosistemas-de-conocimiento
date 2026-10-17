// Cross-corpus score normalization before rank fusion.
//
// ── The defect this exists to fix ───────────────────────────────────────────
//
// `RetrieveService.retrieve` in `mode: 'hybrid'` returns `score` as a
// Reciprocal Rank Fusion value: `Σ_legs 1 / (k + rank_leg(d))`, where every
// `rank` is a position WITHIN THAT CORPUS'S OWN candidate pool.
//
// RRF is built to fuse several LEGS over ONE collection. `/v1/retrieve/multi`
// was using it to fuse ACROSS collections — it sorted the per-corpus RRF
// scores against each other. Rank is a within-collection statistic, so those
// numbers are not comparable, and the error is systematic in one direction:
// the DEEPER pool is penalised for being deeper.
//
// MEASURED (the incident that produced this file):
// a `thread-49` corpus of 180 chunks and an `org-7` corpus of 10 chunks were
// fused. `thread-49`'s best chunk was dense-rank 1 but lexical-rank ~22 inside
// its own 180-deep pool, scoring 1/(60+1) + 1/(60+22) = 0.02859. Every one of
// `org-7`'s 8 hits sat at ranks 1–8 of a 10-deep pool, so its WORST scored
// 1/(60+8) + 1/(60+8) = 0.02941 and beat it. The thread corpus had the higher
// LEXICAL scores and still lost every slot. Nothing reported it.
//
// ── The repair, and why this one ────────────────────────────────────────────
//
// Restore RRF to its designed use: fuse legs over ONE pool. We re-rank the
// fused candidates GLOBALLY — build one dense leg and one lexical leg spanning
// every corpus, rank inside those, and run the same RRF over them. Ranks are
// then computed over a single pool and are comparable by construction.
//
// This is sound because BOTH per-leg scores are pure functions of
// (query, document) with NO corpus-level statistics in them:
//   • dense   — cosine against the same query vector; the same embedding model
//     is required across the corpora a caller fans out over
//     (`RetrieveService` refuses to mix dims anyway).
//   • lexical — Postgres `ts_rank_cd(text_search, tsq, 32)` is cover density
//     over the row's OWN tsvector. Unlike BM25 it carries no IDF and no
//     collection statistics, so the same passage scores the same in a 10-chunk
//     corpus and a 10-million-chunk one.
// Their RANKS are corpus-relative; their VALUES are not. So a global sort per
// leg is well defined, and it is the ranks — the broken part — that we rebuild.
//
// Two alternatives were considered and rejected:
//   • MIN-MAX normalising each corpus's fused scores onto [0,1]. Rejected: it
//     maps every corpus's best chunk to 1.0, including a corpus whose best
//     chunk is junk. A corpus of irrelevant text would take the top slot. The
//     absolute quality signal is exactly what must survive, and min-max
//     deletes it.
//   • Fusing on per-corpus NORMALISED RANK (`rank / poolSize`). Rejected: it
//     inverts the bug instead of removing it. A 1-chunk corpus holding a
//     perfect match sits at normalised rank 1.0 — the worst possible position.
// Both of those fuse per-corpus lists and then try to make the outputs
// comparable. This module makes the INPUTS comparable and fuses once, which is
// the thing RRF is actually specified for.
//
// ── Recall boundary (stated, not hidden) ────────────────────────────────────
//
// The per-corpus retrieve has already truncated to its own `topK` before we see
// anything, so this is a merge of top-K lists, not a re-run over the full
// corpora. A chunk cut inside its own corpus never reaches this stage. That is
// a `topK` recall knob, not the comparability defect — it is unchanged by this
// fix, and it is not what shut `thread-49` out.

import type { MultiRetrievedChunk } from './types.js';
import { competitionRanks } from './retrieve.js';

/** A chunk that carried NEITHER leg score — see `unscored` on the result. */
function hasNoLegScore(c: MultiRetrievedChunk): boolean {
  return c.denseScore === undefined && c.lexicalScore === undefined;
}

export interface CrossCorpusFusion {
  /** The globally re-scored, deduped candidates, best first. */
  chunks: MultiRetrievedChunk[];
  /**
   * How many candidates arrived carrying neither `denseScore` nor
   * `lexicalScore`. They cannot be placed on either global leg, so they score 0
   * and sort to the tail. Non-zero means an upstream leg stopped surfacing its
   * score and the caller should be told rather than left to wonder — this
   * module refuses to be the silent step.
   */
  unscored: number;
}

/**
 * Deduplicate by `chunkId`, then re-rank every candidate on GLOBAL per-leg
 * ranks and re-run RRF with the same `k` the per-corpus legs used.
 *
 * `score` is OVERWRITTEN with the global RRF value, because the primary
 * ranking field must match the order returned — the same invariant
 * `applyRerank` upholds when the cross-encoder re-scores. The magnitude range
 * is unchanged (`Σ 1/(k + rank)` over at most two legs, same `k`), so a
 * consumer's hybrid-score threshold sees the same scale it always did.
 * `denseScore` / `lexicalScore` / `ranks` / `corpus` are left untouched.
 */
export function fuseAcrossCorpora(
  candidates: MultiRetrievedChunk[],
  k: number,
): CrossCorpusFusion {
  // ── Dedupe first, so one chunk occupies one position on each global leg.
  //    A chunk reachable through two corpus names (an alias and its target) is
  //    the same row with the same text, so its dense and lexical scores are
  //    identical whichever name surfaced it. We keep the copy with the
  //    strongest evidence and fall back to first-seen — deliberately NOT to
  //    "highest `score`", which is the incomparable per-corpus number this
  //    whole module exists to stop trusting.
  const byId = new Map<string, MultiRetrievedChunk>();
  for (const c of candidates) {
    const prev = byId.get(c.chunkId);
    if (!prev) {
      byId.set(c.chunkId, c);
      continue;
    }
    if (
      (c.denseScore ?? -Infinity) > (prev.denseScore ?? -Infinity) ||
      ((c.denseScore ?? -Infinity) === (prev.denseScore ?? -Infinity) &&
        (c.lexicalScore ?? -Infinity) > (prev.lexicalScore ?? -Infinity))
    ) {
      byId.set(c.chunkId, c);
    }
  }
  const pool = [...byId.values()];

  const score = new Map<string, number>();
  const legsFound = new Map<string, number>();
  for (const c of pool) {
    score.set(c.chunkId, 0);
    legsFound.set(c.chunkId, 0);
  }

  // ── One global list per leg. `competitionRanks` requires descending score
  //    and is the SAME ranking rule the per-corpus fusion uses (modified
  //    competition, "1334"), imported rather than re-expressed so the two rungs
  //    cannot drift apart.
  for (const pick of [
    (c: MultiRetrievedChunk): number | undefined => c.denseScore,
    (c: MultiRetrievedChunk): number | undefined => c.lexicalScore,
  ]) {
    const rows = pool
      .filter((c) => pick(c) !== undefined)
      .map((c) => ({ chunkId: c.chunkId, score: pick(c)! }))
      .sort((a, b) => b.score - a.score);
    const ranks = competitionRanks(rows);
    rows.forEach((row, i) => {
      score.set(row.chunkId, score.get(row.chunkId)! + 1 / (k + ranks[i]!));
      legsFound.set(row.chunkId, legsFound.get(row.chunkId)! + 1);
    });
  }

  // ── Order. The tie-break ladder is deliberately CORPUS-ORDER-FREE.
  //    The old cross-corpus step was `sort((a, b) => b.score - a.score)` on a
  //    list built in request-corpus order. `Array.prototype.sort` is stable, so
  //    every exact tie went to whichever corpus the CALLER happened to list
  //    first — a silent, systematic thumb on the scale. None of the keys below can see the
  //    request order: the last of them is `chunkId`, which is arbitrary but
  //    FIXED, so the same tie resolves the same way whatever order the caller
  //    passes its corpora in.
  const ordered = pool.slice().sort((a, b) => {
    const sa = score.get(a.chunkId)!;
    const sb = score.get(b.chunkId)!;
    if (sa !== sb) return sb - sa;
    const la = legsFound.get(a.chunkId)!;
    const lb = legsFound.get(b.chunkId)!;
    if (la !== lb) return lb - la;
    const da = a.denseScore ?? -Infinity;
    const db = b.denseScore ?? -Infinity;
    if (da !== db) return db - da;
    const xa = a.lexicalScore ?? -Infinity;
    const xb = b.lexicalScore ?? -Infinity;
    if (xa !== xb) return xb - xa;
    return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0;
  });

  return {
    chunks: ordered.map((c) => ({ ...c, score: score.get(c.chunkId)! })),
    unscored: pool.filter(hasNoLegScore).length,
  };
}
