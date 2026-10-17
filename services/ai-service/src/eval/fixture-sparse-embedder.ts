// Deterministic, offline stand-in for bge-m3's LEARNED-SPARSE vector.
//
// WHY THIS EXISTS AT ALL
// ----------------------
// Until now `HarnessOptions` could inject a dense `embedder` and a `reranker`
// but NOT a `sparseEmbedder`, so the harness could never populate
// `chunks.sparse_embedding`. The sparse leg filters `WHERE sparse_embedding IS
// NOT NULL` and swallows every failure into an empty result set, so an eval
// that cannot populate sparse at ingest does not measure a weak sparse leg —
// it measures a SILENT one, and reports the dense ranking back as if fusion had
// happened. "hybrid" in this repo's eval therefore meant dense + `tsvector`,
// never dense + learned-sparse. This module plus the `sparseEmbedder` option on
// the harness is what makes the third leg measurable offline.
//
// WHY NOT CALL THE REAL bge-m3 SIBLING
// ------------------------------------
// Same two reasons as `fixture-embedder.ts` and `fixture-reranker.ts`: an eval
// that needs a running sibling does not run on every change, and a
// server-versioned model drifts so a "before" number stops being comparable.
// The real sibling stays reachable through the ordinary `SPARSE_EMBED_URL`
// seam; this is the CI-safe default.
//
// WHAT IT MODELS, AND WHAT IT DOES NOT
// ------------------------------------
// bge-m3's sparse vector is a learned LEXICAL weighting: one weight per token
// id the model actually saw, and — this is the load-bearing part — it keeps the
// numerals and short literal codes that a dense bi-encoder mean-pools into
// noise. That is the property the sparse leg is adopted for, and it is exactly
// the property `fixtureEmbedder` deliberately throws away (see its header).
//
// So this stub hashes every token INCLUDING numerals and identifier fragments
// into a token-id space and weights them `1 + log(tf)` — the same sub-linear
// damping the dense fixture uses, and the shape every serious lexical weighting
// scheme has. The result is a leg with a real exact-term advantage over the
// dense fixture, which is what makes a dense-vs-sparse A/B non-vacuous.
//
// It does NOT model what a learned sparse encoder actually learns: term
// expansion (a document gets weight on tokens it does not literally contain)
// and corpus-level term saturation. So a number from this stub is a valid A/B
// of the sparse WIRING and of exact-term sharpening. It is NOT a prediction of
// production bge-m3 sparse quality, and must not be reported as one — same
// honesty caveat as the other two fixtures.

import type {
  SparseEmbedResult,
  SparseEmbedder,
  SparseVector,
} from '../services/ai/embeddings/sparse-embed.js';
import { normalizeForMatch } from './metrics.js';

/**
 * Token-id space this stub hashes into.
 *
 * 🔴 MUST stay below `env.SPARSE_DIM` (250002, pinned to the
 * `chunks.sparse_embedding` column width by a boot guard). `toSparsevecLiteral`
 * DROPS any id outside `[0, dim)` silently, so a larger bucket count here would
 * quietly delete part of every vector and make the leg look weak rather than
 * misconfigured. 65536 is comfortably inside and collides rarely enough on a
 * fixture-sized corpus.
 */
const TOKEN_ID_SPACE = 65536;

/** FNV-1a, same hash as `fixture-embedder.ts` — small, fast, no dependencies. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Tokens the sparse leg weights.
 *
 * The contrast with `contentTokens()` in `fixture-embedder.ts` IS the point:
 * that one drops numerals, roman numerals, sub-3-character tokens and
 * stopwords; this one keeps every alphanumeric run of length ≥ 1. A query like
 * "section 12" leaves the dense fixture with the single useless token
 * "section"; here it keeps "12", which is the only token that separates section
 * 12 from section 44.
 */
export function sparseTokens(text: string): string[] {
  return normalizeForMatch(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * One deterministic learned-sparse vector for `text`: hashed token ids with
 * `1 + log(tf)` weights, ascending by id.
 *
 * Colliding tokens SUM rather than overwrite — a collision should behave like
 * an extra occurrence (a small ranking distortion), not like a lost term.
 * `toSparsevecLiteral` would otherwise keep only the last weight written.
 */
export function fixtureSparseEmbed(text: string): SparseVector {
  const tf = new Map<number, number>();
  for (const t of sparseTokens(text)) {
    const id = fnv1a(t) % TOKEN_ID_SPACE;
    tf.set(id, (tf.get(id) ?? 0) + 1);
  }
  const indices = [...tf.keys()].sort((a, b) => a - b);
  return {
    indices,
    values: indices.map((id) => 1 + Math.log(tf.get(id)!)),
  };
}

/**
 * A `SparseEmbedder` (the injectable seam on `RetrieveService` and the ingest
 * worker). Zero I/O, zero cost, byte-reproducible.
 *
 * `dense` comes back EMPTY on purpose. The sparse seam's dense half is unused
 * by both callers — ingest embeds dense through the separate `Embedder`
 * injectable and retrieve only reads `sparse[0]` — so returning fabricated
 * dense vectors here would invent a second, silently-diverging source of truth
 * for the dense index. The existing `retrieve-half-populated.integration.test.ts`
 * stub makes the same choice.
 */
export const fixtureSparseEmbedder: SparseEmbedder = async ({
  model,
  input,
}): Promise<SparseEmbedResult> => {
  const texts = Array.isArray(input) ? input : [input];
  return { model, dense: [], sparse: texts.map(fixtureSparseEmbed) };
};
