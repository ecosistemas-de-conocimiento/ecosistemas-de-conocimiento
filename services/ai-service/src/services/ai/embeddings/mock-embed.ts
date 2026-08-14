// Deterministic mock embedding generator for fully-offline RAG.
//
// Companion to `src/services/ai/router/adapters/mock-stream.ts`: when
// `MOCK_LLM=1` (or the dedicated `MOCK_EMBEDDINGS=1` override) is set, the
// embedding adapter short-circuits to this module instead of calling
// OpenRouter, so RAG ingest + query run with ZERO network and ZERO spend.
//
// Requirements this satisfies:
//   - CORRECT dimension: 1024, the dimension hard-bound to the
//     `chunks.embedding` SQL type (`vector(1024)`) in src/db/schema/index.ts
//     (migration 0013 re-cut it from 1536 for the open multilingual model).
//   - DETERMINISTIC per input text: the vector is seeded from a hash of the
//     text, so cosine top-K / MMR results are stable across runs (same
//     input → byte-identical vector).
//   - Unit-normalized: avoids degenerate zero vectors and keeps cosine
//     similarity well-defined.
//
// This file performs NO I/O. It is the embedding counterpart to mock-stream's
// fake adapter, and like that adapter it reports a `usage` object in the same
// shape the real path returns so the budget ledger and usage-readers don't
// break.

export const MOCK_EMBEDDING_DIM = 1024;

/**
 * FNV-1a 32-bit hash of a string. Cheap, deterministic, and well-distributed
 * enough to seed a PRNG. Not cryptographic — we only need reproducible noise.
 */
function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // h *= 16777619, kept in 32-bit space via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  // Force to unsigned 32-bit.
  return h >>> 0;
}

/** mulberry32 PRNG — small, fast, deterministic from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Produce a deterministic, unit-normalized {@link MOCK_EMBEDDING_DIM}-dim
 * vector for a single input string. Same text in → byte-identical vector out.
 */
export function mockEmbedOne(text: string): number[] {
  const rand = mulberry32(hashString(text));
  const vec = new Array<number>(MOCK_EMBEDDING_DIM);
  let sumSq = 0;
  for (let i = 0; i < MOCK_EMBEDDING_DIM; i++) {
    // Map [0,1) → (-1,1) so components span both signs like a real embedding.
    const v = rand() * 2 - 1;
    vec[i] = v;
    sumSq += v * v;
  }
  // Normalize to unit length. sumSq is effectively never 0 for 1024 random
  // components, but guard anyway so we never emit a NaN vector.
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < MOCK_EMBEDDING_DIM; i++) {
    vec[i] = vec[i]! / norm;
  }
  return vec;
}

/**
 * Whether the embedding adapter should use the offline mock path.
 *
 * `MOCK_LLM=1` is the project's single local-mock switch (it already gates the
 * chat-completion adapter); it is sufficient on its own. `MOCK_EMBEDDINGS=1`
 * is an optional dedicated override for mocking embeddings without mocking
 * completions.
 */
export function isMockEmbeddingsEnabled(): boolean {
  return process.env['MOCK_LLM'] === '1' || process.env['MOCK_EMBEDDINGS'] === '1';
}
