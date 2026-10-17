// The passage-length contract, in CHARACTERS — the client's copy of
// ai-service's `maxChunkChars` (`src/services/rag/chunk.ts`).
//
// ai-service cuts chunks on the way in and clamps passage text on the way out
// to `chunkSize × CHARS_PER_TOKEN`, where `chunkSize` is the CORPUS's own
// `chunk_size` (default 800 tokens). Consumers that bound or check retrieved
// passages re-derived the literal 3200, which goes wrong the day a corpus is configured
// with a larger `chunk_size`. Call this with the corpus's `chunkSize` instead
// (`client.corpora.get(name)` returns it).
//
// The package cannot import server code, so the two definitions are kept equal
// by `src/services/rag/chunk-bound-parity.test.ts` in the ai-service root suite.

/** ai-service's chunk size, in tokens, for a corpus that configures none. */
export const DEFAULT_CHUNK_SIZE = 800;

/** ai-service's token-estimation convention: `chars / 4`. */
export const CHARS_PER_TOKEN = 4;

/**
 * Longest passage, in characters, ai-service returns from a corpus with
 * `chunkSize` tokens. Nullish means the server default.
 */
export function maxChunkChars(chunkSize?: number | null): number {
  return (chunkSize ?? DEFAULT_CHUNK_SIZE) * CHARS_PER_TOKEN;
}
