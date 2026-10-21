import { describe, expect, it } from 'vitest';
import { retrieveResponseSchema } from './schemas';

const base = { chunkId: 'c1', documentId: 'd1', ordinal: 0, text: 'pasaje', score: 0.9 };

describe('retrieveResponseSchema', () => {
  it('keeps the per-leg scores ai-service sends on a rerank or hybrid retrieve', () => {
    const out = retrieveResponseSchema.parse({
      chunks: [{ ...base, denseScore: 0.7, lexicalScore: 0.2, rerankScore: 0.95, metadata: { docId: '1' } }],
    });
    expect(out.chunks[0]).toEqual({
      ...base,
      denseScore: 0.7,
      lexicalScore: 0.2,
      rerankScore: 0.95,
      metadata: { docId: '1' },
    });
  });

  it('a plain dense chunk with none of them still parses, and gains no keys', () => {
    expect(Object.keys(retrieveResponseSchema.parse({ chunks: [base] }).chunks[0]!).sort()).toEqual(
      Object.keys(base).sort(),
    );
  });

  it('a non-numeric leg score is refused', () => {
    expect(() => retrieveResponseSchema.parse({ chunks: [{ ...base, rerankScore: 'x' }] })).toThrow();
  });
});
