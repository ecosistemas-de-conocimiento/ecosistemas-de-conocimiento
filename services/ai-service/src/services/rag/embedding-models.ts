// Embedding-model → vector-dimension map + corpus-creation validation.
//
// WHY THIS EXISTS (Fable review, MUST-FIX 1). A consumer may pass
// `embeddingModel` on `POST /v1/ingest`. Before this module the corpus was
// created with that model but its `embeddingDim` was stamped
// UNCONDITIONALLY from `env.EMBEDDING_DIM` (1024). The `chunks.embedding`
// column is a fixed-width `vector(env.EMBEDDING_DIM)` — pgvector fixes the
// dimension at DDL time. So a model whose real dimension ≠ the column width
// (e.g. `openai/text-embedding-3-small` at 1536) could NEVER have a single
// vector inserted: every real embed threw on the pgvector insert forever, and
// because the null-externalId ingest path inserts the document row BEFORE the
// chunk insert throws, BullMQ retries accumulated duplicate document rows.
//
// Fix: refuse such a corpus at CREATION time with a legible error, so the
// failure surfaces once, up front, instead of as an unbounded poison-pill
// retry loop. The worker keeps a defence-in-depth length guard for UNKNOWN
// models (see src/workers/ingest.worker.ts).
//
// This map is exported so the corpus-CRUD session (a separate route surface)
// can reuse the same validation rather than re-deriving it.

import { CodedEnvelopeError } from '../../errors/base.js';

/**
 * Known open + hosted embedding models → the vector dimension they emit.
 * Keep additive; an unknown model is not an error here (see
 * `resolveCorpusEmbeddingDim`) — it just can't be dimension-checked up front.
 *
 *   baai/bge-m3                     → 1024  (default; open, multilingual)
 *   intfloat/multilingual-e5-large  → 1024  (drop-in alt, same dim)
 *   openai/text-embedding-3-small   → 1536
 *   openai/text-embedding-3-large   → 3072
 */
export const KNOWN_EMBEDDING_DIMS: Readonly<Record<string, number>> = {
  'baai/bge-m3': 1024,
  'intfloat/multilingual-e5-large': 1024,
  'openai/text-embedding-3-small': 1536,
  'openai/text-embedding-3-large': 3072,
};

/** The dimension a model is KNOWN to emit, or `undefined` if unknown. */
export function knownEmbeddingDim(model: string): number | undefined {
  return KNOWN_EMBEDDING_DIMS[model];
}

/**
 * Thrown when a corpus is asked to use an embedding model whose known
 * dimension cannot fit the live `chunks.embedding` column. A 400 (consumer
 * error) rather than a 500 — declared by the class, not re-decided per route.
 */
export class EmbeddingDimensionMismatchError extends CodedEnvelopeError {
  readonly code = 'ERR_EMBEDDING_DIMENSION_MISMATCH';
  readonly status = 400;
  readonly model: string;
  readonly modelDim: number;
  readonly columnDim: number;
  constructor(model: string, modelDim: number, columnDim: number) {
    super(
      `embedding model '${model}' emits ${modelDim}-dim vectors, but this deployment stores ` +
        `${columnDim}-dim vectors (chunks.embedding is vector(${columnDim}), fixed at DDL time). ` +
        `Every embed for this corpus would fail the pgvector insert. Re-cut the column via a ` +
        `migration to use this model, or pick a ${columnDim}-dim model.`,
    );
    this.name = 'EmbeddingDimensionMismatchError';
    this.model = model;
    this.modelDim = modelDim;
    this.columnDim = columnDim;
  }
}

/**
 * Decide the `embeddingDim` to stamp on a NEW corpus for `model`, given the
 * live pgvector column width `columnDim` (`env.EMBEDDING_DIM` — the width
 * `chunks.embedding vector(N)` was cut to).
 *
 *   - KNOWN model whose dim ≠ columnDim → throw `EmbeddingDimensionMismatchError`.
 *   - KNOWN model whose dim = columnDim → return that dim (honest, and correct).
 *   - UNKNOWN model → return `columnDim` (best available assumption); a real
 *     mismatch is then caught legibly by the worker's per-vector length guard.
 */
export function resolveCorpusEmbeddingDim(model: string, columnDim: number): number {
  const known = knownEmbeddingDim(model);
  if (known !== undefined && known !== columnDim) {
    throw new EmbeddingDimensionMismatchError(model, known, columnDim);
  }
  return known ?? columnDim;
}
