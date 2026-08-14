// Deterministic, offline stand-in for a real embedding model.
//
// WHY NOT JUST CALL OPENROUTER
// ----------------------------
// Two reasons, in order of importance.
//
// 1. An eval that costs money per run does not get run. The whole value of a
//    regression gate is that it runs on every change, in CI, without anyone
//    deciding whether today's question is worth the spend. A harness gated
//    behind an API key and a budget is a harness that goes stale.
// 2. Reproducibility. Embedding endpoints are versioned server-side and drift
//    without notice; a "before" number taken last month against a silently
//    updated model is not comparable to today's "after".
//
// WHAT THIS MODELS, AND WHAT IT DOES NOT
// --------------------------------------
// This is a bag-of-words vector: text is normalised, tokenised, and each token
// is hashed into a fixed 1024-dim space with L2 normalisation, so cosine
// similarity ≈ normalised lexical overlap on CONTENT WORDS.
//
// The load-bearing detail is what it DROPS: numerals, roman numerals, and
// standalone identifier fragments contribute NOTHING to the vector. This is
// not a shortcut — it is the specific property of real dense retrievers that
// rung 1 exists to fix. A sentence-transformer sub-word-tokenises "12" and
// "SPEC-035" into pieces with almost no distributional signal, then mean-pools
// them into a vector dominated by the surrounding topical words. The practical
// consequence is that "section 12" and "section 44" embed to nearly the same
// point, and dense retrieval cannot tell them apart. That is exactly the
// failure this fixture reproduces.
//
// What it does NOT model: synonymy and paraphrase. A real encoder puts
// "personal records" near "privacy"; this does not. So a fixture item whose
// query paraphrases its target will look harder here than in production. The
// golden set therefore keeps query wording close to document wording for the
// topical items, and reserves the hard cases for the identifier queries —
// where this fixture is faithful.
//
// The honest summary: numbers from this harness are a valid A/B between
// retrieval CONFIGURATIONS on this repo's own machinery. They are not a
// prediction of production retrieval quality, and are not reported as one.

import type { Embedder } from '../services/rag/retrieve.js';
import { normalizeForMatch } from './metrics.js';

// Matches the live `chunks.embedding` SQL type `vector(1024)` (migration 0013).
const DIM = 1024;

/** FNV-1a — small, fast, no dependencies, well-distributed enough for hashing into buckets. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Pure digits, or digits with a short alphabetic suffix (`12`, `035`, `2018`, `12a`). */
const NUMERIC_RE = /^\d+[a-z]?$/;
/** Roman numerals — dropped for the same reason as arabic ones: no topical signal. */
const ROMAN_RE = /^[ivxlcdm]{1,7}$/;

/**
 * Function words, matching the language of the fixture corpus. Removed so
 * cosine similarity reflects topic rather than grammar — without this every
 * long sentence looks similar to every other long sentence, which would make
 * the dense leg noise and flatter hybrid unfairly.
 *
 * This is the ONE language-dependent knob in this module. It is a plain list
 * rather than a parameter because the list is only ever read by the fixture
 * corpus that ships beside it; a caller evaluating other content edits the set
 * or drops it (the effect is a slightly noisier dense leg, not a wrong result).
 */
const STOPWORDS = new Set([
  'all', 'and', 'any', 'are', 'arising', 'the', 'their', 'them', 'then', 'there', 'these',
  'this', 'those', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'whom', 'why',
  'will', 'with', 'within', 'without', 'would', 'shall', 'should', 'may', 'must', 'can',
  'from', 'for', 'into', 'onto', 'out', 'over', 'under', 'upon', 'each', 'every', 'other',
  'such', 'than', 'that', 'they', 'has', 'have', 'had', 'been', 'being', 'its', 'not',
  'but', 'per', 'set', 'sets', 'out', 'own', 'also', 'more', 'most', 'some', 'both',
]);

/**
 * Tokens that carry topical signal for the dense leg. Drops stopwords, very
 * short tokens, and — critically — every purely numeric or roman-numeral
 * token. See the header for why that omission is the point rather than a bug.
 */
export function contentTokens(text: string): string[] {
  return normalizeForMatch(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
    .filter((t) => !NUMERIC_RE.test(t))
    .filter((t) => !ROMAN_RE.test(t))
    .filter((t) => t.length >= 3)
    .filter((t) => !STOPWORDS.has(t));
}

/**
 * Hash tokens into a normalised DIM-dim vector. Sub-linear term-frequency
 * damping (1 + log tf) mirrors what every serious lexical weighting scheme
 * does and stops one repeated word from dominating a long chunk.
 */
export function fixtureEmbed(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  const tf = new Map<string, number>();
  for (const t of contentTokens(text)) tf.set(t, (tf.get(t) ?? 0) + 1);

  for (const [token, count] of tf) {
    const h = fnv1a(token);
    const idx = h % DIM;
    // Sign from a second hash bit so unrelated tokens colliding on `idx` tend
    // to cancel rather than reinforce.
    const sign = (h >>> 16) % 2 === 0 ? 1 : -1;
    vec[idx] = (vec[idx] ?? 0) + sign * (1 + Math.log(count));
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) {
    // A text with no content tokens at all (e.g. the query "section 12" once
    // stopwords and numerals are gone leaves only "section"). Return a fixed
    // unit vector rather than zeros: pgvector's cosine distance against a zero
    // vector is undefined/NaN, which would crash the query rather than simply
    // ranking badly. Ranking badly is the honest outcome, and it is precisely
    // the outcome that the lexical leg is there to rescue.
    const out = new Array<number>(DIM).fill(0);
    out[0] = 1;
    return out;
  }
  return vec.map((v) => v / norm);
}

/** An `Embedder` (the injectable seam on `RetrieveService` / the ingest worker). */
export const fixtureEmbedder: Embedder = (async ({
  model,
  input,
}: {
  model: string;
  input: string | string[];
}) => {
  const texts = Array.isArray(input) ? input : [input];
  return {
    embeddings: texts.map(fixtureEmbed),
    model,
    usage: { inputTokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0), estimatedCostUsd: 0 },
  };
}) as unknown as Embedder;
