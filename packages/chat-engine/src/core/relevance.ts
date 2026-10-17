/**
 * Which score means "how relevant is this chunk", across retrieve modes.
 * ADDITIVE (0.6.0). Pure, no I/O.
 *
 * ai-service's `score` changes scale with the mode: cosine in `dense` mode, a
 * Reciprocal Rank Fusion value (~0.01–0.05) in `hybrid` mode, a cross-encoder
 * score when rerank ran. `denseScore` is the cosine in both modes, present on
 * every chunk the dense leg found. These helpers read the right one.
 *
 * Three choices worth knowing:
 *   - `thresholdScore` / `maxDenseScore` count a chunk with a `lexicalScore`
 *     or `rerankScore` but no `denseScore` as 0. Falling back to `score`,
 *     which under rerank is the cross-encoder value (0–1), would pass a
 *     cosine cutoff with no cosine at all.
 *   - `relevanceScore` detects a hybrid chunk by `mode` (or its leg scores),
 *     not by a `corpus` tag — every engine chunk carries `corpus`.
 *   - `parseCitedOrdinals` also reads grouped markers (`[1, 2]`), with the
 *     same pattern as `splitContentByCitations`.
 */

import type { Provenance, RetrieveMode } from './types.js';

/** The score fields a chunk may carry. Every engine chunk shape satisfies it. */
export interface ScoredChunk {
  score: number;
  denseScore?: number | null;
  lexicalScore?: number | null;
  rerankScore?: number | null;
}

/**
 * Cosine basis for a no-information GATE.
 *   - `denseScore` present → it (a real cosine of 0 included).
 *   - a `lexicalScore` or `rerankScore` but no `denseScore` → 0: the dense
 *     leg missed this chunk, so it has no cosine. Never the RRF or the
 *     cross-encoder score, which are on other scales.
 *   - only `score` → `score`: a pure dense chunk from a server that omits
 *     `denseScore`, where `score` IS the cosine.
 * ⚠ A `retrieveMulti` shim that drops `denseScore` while keeping the other
 * leg scores makes every chunk 0, and the gate refuses every turn.
 */
export function thresholdScore(c: ScoredChunk): number {
  if (typeof c.denseScore === 'number') return c.denseScore;
  if (typeof c.lexicalScore === 'number' || typeof c.rerankScore === 'number') return 0;
  return c.score;
}

/**
 * Highest `thresholdScore` across the chunks; `0` when empty. Independent of
 * ORDER on purpose: under RRF the top chunk can be lexical-only while a
 * confident dense match sits lower. The gate asks "is there ANY confident
 * dense match?".
 */
export function maxDenseScore(chunks: readonly ScoredChunk[]): number {
  return chunks.reduce((max, c) => Math.max(max, thresholdScore(c)), 0);
}

/**
 * The cosine to show or persist as a chunk's relevance, or `null` when the
 * chunk has none. Never the RRF value.
 *
 *   - `denseScore` present → it (0 included).
 *   - `mode: 'hybrid'` and no `denseScore` → `null`: a lexical-only hit.
 *   - a `lexicalScore` or `rerankScore` but no `denseScore` → `null`: the
 *     chunk came from a hybrid or reranked retrieve the dense leg missed.
 *   - none of the three → `score`: a dense chunk from a server that predates
 *     `denseScore`, where `score` IS the cosine.
 *
 * A `corpus` tag cannot tell a hybrid chunk apart here — every engine chunk
 * carries `corpus` — so pass the
 * `mode` when you know it.
 */
export function relevanceScore(c: ScoredChunk, mode?: RetrieveMode): number | null {
  if (typeof c.denseScore === 'number') return c.denseScore;
  if (mode === 'hybrid') return null;
  if (typeof c.lexicalScore === 'number' || typeof c.rerankScore === 'number') return null;
  return c.score;
}

/**
 * Distinct cited ordinals in the answer, in first-appearance order. Positive
 * integers only. Reads bare (`[1]`) and grouped (`[1, 2]`, `[1,2]`, `[ 3 ]`)
 * markers with the SAME pattern as `splitContentByCitations`, so every marker
 * the card renders as a citation is also a saved source.
 */
export function parseCitedOrdinals(text: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const re = /\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (const digits of m[0].match(/\d+/g) ?? []) {
      const n = Number(digits);
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  return out;
}

/** A provenance chunk the answer cited, with its prompt ordinal and relevance. */
export type CitedChunk = Provenance['chunks'][number] & {
  /** The `[N]` the model wrote: 1-based position in the prompt's chunk list. */
  ordinal: number;
  /** `relevanceScore` of the chunk: a cosine, or `null` when none exists. */
  relevance: number | null;
};

/**
 * The chunks the answer actually cited with `[N]`, in citation order. `N` is
 * 1-based over `provenance.chunks` exactly as numbered in the prompt. A
 * marker past the end is dropped. No marker → `[]`: there is no "attach every
 * retrieved chunk" fallback. Run it on the COMPLETE answer, never a partial
 * stream.
 */
export function citedProvenance(
  provenance: Provenance | null | undefined,
  answer: string,
  options: { mode?: RetrieveMode } = {},
): CitedChunk[] {
  const chunks = provenance?.chunks ?? [];
  const cited: CitedChunk[] = [];
  for (const n of parseCitedOrdinals(answer)) {
    const c = chunks[n - 1];
    if (!c) continue;
    cited.push({ ...c, ordinal: n, relevance: relevanceScore(c, options.mode) });
  }
  return cited;
}
