import { describe, it, expect } from 'vitest';
import {
  thresholdScore,
  maxDenseScore,
  relevanceScore,
  parseCitedOrdinals,
  citedProvenance,
} from './relevance.js';
import type { Provenance } from './types.js';

// The engine counts a chunk with no cosine as 0.

describe('thresholdScore (consumer port)', () => {
  it('prefers denseScore (cosine) over the fused score', () => {
    expect(thresholdScore({ score: 0.03, denseScore: 0.71 })).toBe(0.71);
  });
  it('falls back to score when denseScore is absent or null', () => {
    expect(thresholdScore({ score: 0.42 })).toBe(0.42);
    expect(thresholdScore({ score: 0.42, denseScore: null })).toBe(0.42);
  });
  it('a denseScore of 0 is a real cosine and wins', () => {
    expect(thresholdScore({ score: 0.42, denseScore: 0 })).toBe(0);
  });
  it('a lexical-only or reranked chunk with no denseScore → 0, never its fused/rerank score', () => {
    expect(thresholdScore({ score: 0.03, lexicalScore: 0.4 })).toBe(0);
    expect(thresholdScore({ score: 0.91, rerankScore: 0.91 })).toBe(0);
  });
});

describe('maxDenseScore (port of a consumer maxCosineScore)', () => {
  it('a lexical-only TOP chunk does not hide a dense match lower down', () => {
    const chunks = [
      { score: 0.017, lexicalScore: 0.3 },
      { score: 0.016, denseScore: 0.62 },
    ];
    expect(maxDenseScore(chunks)).toBe(0.62);
  });
  it('all lexical-only stays at the tiny RRF fallback, below any cosine cutoff', () => {
    expect(maxDenseScore([{ score: 0.017 }, { score: 0.021 }])).toBe(0.021);
  });
  it('empty → 0', () => {
    expect(maxDenseScore([])).toBe(0);
  });
  it('under rerank, a chunk with no cosine counts as 0, never the rerank score', () => {
    expect(maxDenseScore([{ score: 0.91, rerankScore: 0.91, lexicalScore: 0.2 }])).toBe(0);
  });
  it('pure dense (only score) keeps score as the cosine', () => {
    expect(maxDenseScore([{ score: 0.44 }, { score: 0.61 }])).toBe(0.61);
  });
  it('lexical-only RRF 0.03 next to dense 0.5 → 0.5', () => {
    expect(maxDenseScore([{ score: 0.03, lexicalScore: 0.4 }, { score: 0.016, denseScore: 0.5 }])).toBe(0.5);
  });
});

describe('relevanceScore (port of a consumer citationCosine, mode instead of corpus tag)', () => {
  it('hybrid dense-leg chunk → its denseScore', () => {
    expect(relevanceScore({ score: 0.016, denseScore: 0.62 }, 'hybrid')).toBe(0.62);
  });
  it('hybrid lexical-only chunk → null, never the RRF score', () => {
    expect(relevanceScore({ score: 0.017 }, 'hybrid')).toBeNull();
    expect(relevanceScore({ score: 0.03, lexicalScore: 0.4 })).toBeNull();
  });
  it('a reranked chunk the dense leg missed → null, never the cross-encoder score', () => {
    expect(relevanceScore({ score: 0.91, rerankScore: 0.91 })).toBeNull();
  });
  it('a dense chunk from a server without denseScore → its score (the cosine)', () => {
    expect(relevanceScore({ score: 0.44 })).toBe(0.44);
    expect(relevanceScore({ score: 0.44 }, 'dense')).toBe(0.44);
  });
  it('a denseScore of 0 is a real cosine and wins', () => {
    expect(relevanceScore({ score: 0.4, denseScore: 0 }, 'hybrid')).toBe(0);
  });
});

describe('parseCitedOrdinals (consumer port)', () => {
  it('distinct ordinals in first-seen order', () => {
    expect(parseCitedOrdinals('foo [1] bar [3] baz [1]')).toEqual([1, 3]);
  });
  it('ignores [0]', () => {
    expect(parseCitedOrdinals('[0] [2]')).toEqual([2]);
  });
  it('reads grouped markers like splitContentByCitations: [1, 2], [1,2], [ 3 ]', () => {
    expect(parseCitedOrdinals('Según el reglamento [1, 2].')).toEqual([1, 2]);
    expect(parseCitedOrdinals('[1,2]')).toEqual([1, 2]);
    expect(parseCitedOrdinals('[ 3 ]')).toEqual([3]);
  });
  it('dedupes across bare and grouped markers, in first-appearance order', () => {
    expect(parseCitedOrdinals('[2] luego [1, 2] y [3,1]')).toEqual([2, 1, 3]);
  });
  it('no marker → []', () => {
    expect(parseCitedOrdinals('sin citas')).toEqual([]);
  });
});

describe('citedProvenance (port of a consumer cited-only citationsFromAnswer)', () => {
  const provenance: Provenance = {
    chunks: [
      { chunkId: 'a', documentId: 'd1', score: 0.03, lexicalScore: 0.4, corpus: 'k', metadata: null },
      { chunkId: 'b', documentId: 'd2', score: 0.016, denseScore: 0.5, corpus: 'k', metadata: null },
      { chunkId: 'c', documentId: 'd3', score: 0.02, denseScore: 0.3, corpus: 'k', metadata: null },
    ],
  };

  it('keeps only cited chunks, in citation order, with their prompt ordinal', () => {
    const out = citedProvenance(provenance, 'Ver [3] y [1]. Otra vez [3].');
    expect(out.map((c) => [c.ordinal, c.chunkId])).toEqual([[3, 'c'], [1, 'a']]);
  });

  it('a grouped marker cites both chunks', () => {
    const out = citedProvenance(provenance, 'Así lo dicen [1, 2].');
    expect(out.map((c) => [c.ordinal, c.chunkId])).toEqual([[1, 'a'], [2, 'b']]);
  });

  it('relevance is the cosine, or null for the lexical-only chunk', () => {
    const out = citedProvenance(provenance, '[1] [2]');
    expect(out.map((c) => c.relevance)).toEqual([null, 0.5]);
  });

  it('drops a marker past the end; no marker or no provenance → []', () => {
    expect(citedProvenance(provenance, '[9]')).toEqual([]);
    expect(citedProvenance(provenance, 'sin citas')).toEqual([]);
    expect(citedProvenance(null, '[1]')).toEqual([]);
  });

  it('mode hybrid nulls a chunk with no leg scores', () => {
    const p: Provenance = { chunks: [{ chunkId: 'x', documentId: 'd', score: 0.02, corpus: 'k', metadata: null }] };
    expect(citedProvenance(p, '[1]', { mode: 'hybrid' })[0]!.relevance).toBeNull();
    expect(citedProvenance(p, '[1]')[0]!.relevance).toBe(0.02);
  });
});
