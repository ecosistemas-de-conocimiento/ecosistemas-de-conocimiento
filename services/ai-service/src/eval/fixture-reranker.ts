// Deterministic, offline stand-in for a real cross-encoder reranker.
//
// WHY NOT JUST CALL THE SIBLING RERANKER
// --------------------------------------
// Same two reasons the embedder has a fixture (see `fixture-embedder.ts`): an
// eval that needs a running rerank sibling + a budget does not run on every
// change, and a server-versioned cross-encoder drifts, so a "before" number
// stops being comparable. This stub lets the rerank PIPELINE WIRING be tested
// and A/B'd offline and byte-reproducibly.
//
// WHAT IT MODELS, AND WHAT IT DOES NOT
// ------------------------------------
// A real cross-encoder scores a (query, document) pair JOINTLY and its edge
// over the bi-encoder embedder is precisely on the tokens the embedder throws
// away — exact identifiers, numerals, short literal codes. So this stub scores
// by literal token overlap INCLUDING numerals (unlike `fixtureEmbedder`, which
// drops them): the fraction of the query's distinct tokens that appear verbatim
// in the document, nudged by a small identifier bonus. That gives the eval a
// deterministic rerank signal that meaningfully re-orders the fused pool toward
// exact-term matches — the property a real reranker is being adopted for.
//
// It does NOT model semantic similarity or paraphrase (a real cross-encoder
// does). So a fixture rerank number is a valid A/B of the WIRING and of
// exact-term sharpening, not a prediction of production rerank quality — same
// honesty caveat as the fixture embedder.

import type { Reranker } from '../services/ai/rerank/rerank-client.js';
import { normalizeForMatch } from './metrics.js';

/** Distinct normalized tokens (alphanumeric runs), numerals INCLUDED. */
function tokens(text: string): Set<string> {
  return new Set(
    normalizeForMatch(text)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

/** Looks like an identifier token: a numeral, or a short alphanumeric code. */
function isIdentifier(t: string): boolean {
  return /\d/.test(t) || (t.length <= 4 && /[a-z]/.test(t) && /\d/.test(t));
}

/**
 * Deterministic relevance in [0, 1] for one (query, document) pair. Overlap of
 * distinct query tokens present in the document, plus a small bonus for each
 * identifier-shaped query token the document contains (capped so it stays in
 * range). A query with no tokens scores every document 0.
 */
export function fixtureRerankScore(query: string, document: string): number {
  const q = [...tokens(query)];
  if (q.length === 0) return 0;
  const d = tokens(document);
  let hits = 0;
  let idBonus = 0;
  for (const t of q) {
    if (d.has(t)) {
      hits++;
      if (isIdentifier(t)) idBonus += 0.15;
    }
  }
  const base = hits / q.length;
  return Math.min(1, base + Math.min(idBonus, 1 - base));
}

/**
 * A `Reranker` (the injectable seam on `RetrieveService`). Zero I/O, zero cost.
 * Returns every document scored, sorted desc, honoring `topN`.
 */
export const fixtureReranker: Reranker = async ({ query, documents, topN, model }) => {
  const scored = documents
    .map((doc, index) => ({ index, relevanceScore: fixtureRerankScore(query, doc) }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
  const results = typeof topN === 'number' ? scored.slice(0, topN) : scored;
  return { results, model, usage: { estimatedCostUsd: 0 } };
};
