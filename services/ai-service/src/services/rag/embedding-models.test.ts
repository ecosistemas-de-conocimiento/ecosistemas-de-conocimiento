import { describe, expect, it } from 'vitest';

import {
  EmbeddingDimensionMismatchError,
  knownEmbeddingDim,
  resolveCorpusEmbeddingDim,
} from './embedding-models.js';

describe('knownEmbeddingDim', () => {
  it('knows the supported embedders', () => {
    expect(knownEmbeddingDim('baai/bge-m3')).toBe(1024);
    expect(knownEmbeddingDim('intfloat/multilingual-e5-large')).toBe(1024);
    expect(knownEmbeddingDim('openai/text-embedding-3-small')).toBe(1536);
    expect(knownEmbeddingDim('openai/text-embedding-3-large')).toBe(3072);
  });

  it('returns undefined for an unknown model', () => {
    expect(knownEmbeddingDim('some/unknown-embedder')).toBeUndefined();
  });
});

describe('resolveCorpusEmbeddingDim', () => {
  const COLUMN_DIM = 1024; // the live chunks.embedding vector(N) width

  it('accepts a known model whose dim matches the column', () => {
    expect(resolveCorpusEmbeddingDim('baai/bge-m3', COLUMN_DIM)).toBe(1024);
  });

  it('REJECTS a known model whose dim cannot fit the column', () => {
    // text-embedding-3-small emits 1536-dim vectors; the column is vector(1024).
    // Creating this corpus would make every embed fail the pgvector insert.
    expect(() => resolveCorpusEmbeddingDim('openai/text-embedding-3-small', COLUMN_DIM)).toThrow(
      EmbeddingDimensionMismatchError,
    );
    try {
      resolveCorpusEmbeddingDim('openai/text-embedding-3-large', COLUMN_DIM);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EmbeddingDimensionMismatchError);
      const e = err as EmbeddingDimensionMismatchError;
      expect(e.modelDim).toBe(3072);
      expect(e.columnDim).toBe(1024);
    }
  });

  it('falls back to the column width for an unknown model (worker guard covers a real mismatch)', () => {
    expect(resolveCorpusEmbeddingDim('some/unknown-embedder', COLUMN_DIM)).toBe(1024);
  });
});
