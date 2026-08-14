import { describe, it, expect } from 'vitest';
import {
  provenanceToCitations,
  splitContentByCitations,
} from './citation.js';
import type { Provenance } from './types.js';

describe('provenanceToCitations', () => {
  it('returns [] for null/empty provenance', () => {
    expect(provenanceToCitations(null)).toEqual([]);
    expect(provenanceToCitations(undefined)).toEqual([]);
    expect(provenanceToCitations({ chunks: [] })).toEqual([]);
  });

  it('maps chunks to 1-based ordinals in order', () => {
    const prov: Provenance = {
      chunks: [
        { chunkId: 'a', documentId: 'd1', score: 0.91, corpus: 'c1', metadata: { title: 'Doc One' }, text: 'passage A' },
        { chunkId: 'b', documentId: 'd2', score: 0.4, corpus: 'c2', metadata: null },
      ],
    };
    const out = provenanceToCitations(prov);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      ordinal: 1,
      title: 'Doc One',
      passageText: 'passage A',
      score: 0.91,
      documentId: 'd1',
      chunkId: 'a',
    });
    // No metadata title → falls back to corpus; no chunk.text → null passage.
    expect(out[1]).toMatchObject({ ordinal: 2, title: 'c2', passageText: null, score: 0.4 });
  });

  it('probes custom title keys and falls back to corpus', () => {
    const prov: Provenance = {
      chunks: [{ chunkId: 'a', documentId: 'd', score: 0.5, corpus: 'fallbackCorpus', metadata: { docName: 'Custom' } }],
    };
    expect(provenanceToCitations(prov, { titleKeys: ['docName'] })[0]?.title).toBe('Custom');
    expect(provenanceToCitations(prov)[0]?.title).toBe('fallbackCorpus');
  });

  it('applies an injected hrefFor resolver', () => {
    const prov: Provenance = {
      chunks: [{ chunkId: 'a', documentId: 'd7', score: 0.5, corpus: 'c', metadata: null }],
    };
    const out = provenanceToCitations(prov, { hrefFor: (c) => `/docs/${c.documentId}` });
    expect(out[0]?.href).toBe('/docs/d7');
  });
});

describe('splitContentByCitations', () => {
  it('returns the whole content as text when no valid ordinals', () => {
    expect(splitContentByCitations('hello [1] world', [])).toEqual([
      { type: 'text', text: 'hello [1] world' },
    ]);
  });

  it('splits a single marker', () => {
    expect(splitContentByCitations('see [1] here', [1])).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'cite', ordinal: 1 },
      { type: 'text', text: ' here' },
    ]);
  });

  it('leaves unknown ordinals as literal text', () => {
    // 7 has no citation → the bracket stays literal text.
    expect(splitContentByCitations('a [7] b', [1])).toEqual([
      { type: 'text', text: 'a [7] b' },
    ]);
  });

  it('expands grouped markers [1, 2] into separate segments', () => {
    expect(splitContentByCitations('x [1, 2] y', [1, 2])).toEqual([
      { type: 'text', text: 'x ' },
      { type: 'cite', ordinal: 1 },
      { type: 'cite', ordinal: 2 },
      { type: 'text', text: ' y' },
    ]);
  });

  it('keeps only valid ordinals within a group', () => {
    expect(splitContentByCitations('[1, 9]', [1])).toEqual([{ type: 'cite', ordinal: 1 }]);
  });

  it('handles adjacent markers [1][2]', () => {
    expect(splitContentByCitations('[1][2]', [1, 2])).toEqual([
      { type: 'cite', ordinal: 1 },
      { type: 'cite', ordinal: 2 },
    ]);
  });

  it('accepts a Set of valid ordinals', () => {
    expect(splitContentByCitations('q [3] r', new Set([3]))).toEqual([
      { type: 'text', text: 'q ' },
      { type: 'cite', ordinal: 3 },
      { type: 'text', text: ' r' },
    ]);
  });
});
