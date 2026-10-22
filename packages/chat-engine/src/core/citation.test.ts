import { describe, it, expect } from 'vitest';
import {
  provenanceToCitations,
  splitContentByCitations,
  toBrowserProvenance,
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

// ── the browser allowlist (U3) ───────────────────────────────────────────────
//
// Raw ingest metadata (who wrote a chunk, which thread it came from, any key an
// ingest pipeline stamps) must stay on the server. Only what the citation card
// and `provenanceToCitations` read survives. An ALLOWLIST: a key nobody listed
// is dropped, so a new metadata field cannot leak by default.

describe('toBrowserProvenance — allowlist, not denylist', () => {
  const raw = {
    routed: false,
    retrievalQuery: 'consulta condensada',
    internalNote: 'server only',
    chunks: [
      {
        chunkId: 'k1',
        documentId: 'd1',
        score: 0.03,
        corpus: 'chat:thread:7',
        text: 'pasaje citado',
        ordinal: 3,
        relevance: 0.82,
        denseScore: 0.82,
        lexicalScore: 0.4,
        rerankScore: 0.9,
        embedding: [0.1, 0.2],
        metadata: {
          title: 'Informe.pdf',
          docId: 12,
          sessionId: '99',
          authoredBy: 'someone@else.test',
          kind: 'pdf',
          nested: { secret: 'x' },
        },
      },
    ],
  };

  it('keeps only the chunk fields the card reads, and only title keys in metadata', () => {
    expect(toBrowserProvenance(raw)).toEqual({
      chunks: [
        {
          chunkId: 'k1',
          documentId: 'd1',
          score: 0.03,
          corpus: 'chat:thread:7',
          text: 'pasaje citado',
          ordinal: 3,
          metadata: { title: 'Informe.pdf' },
        },
      ],
    });
  });

  it('never lets an unlisted key through, at any level', () => {
    const json = JSON.stringify(toBrowserProvenance(raw));
    for (const leak of ['sessionId', 'authoredBy', 'someone@else.test', 'internalNote', 'embedding', 'secret', 'relevance', 'kind']) {
      expect(json).not.toContain(leak);
    }
  });

  it('metadataKeys adds named keys, primitives only (an object value is dropped)', () => {
    const out = toBrowserProvenance(raw, { metadataKeys: ['docId', 'nested'] });
    expect(out!.chunks[0]!.metadata).toEqual({ title: 'Informe.pdf', docId: 12 });
  });

  it('topLevelKeys adds named top-level primitives; chunks are always rebuilt', () => {
    const out = toBrowserProvenance(raw, { topLevelKeys: ['routed', 'retrievalQuery', 'chunks'] });
    expect(out).toMatchObject({ routed: false, retrievalQuery: 'consulta condensada' });
    expect(out).not.toHaveProperty('internalNote');
    expect(out!.chunks[0]).not.toHaveProperty('denseScore');
  });

  it('titleKeys replaces the probed title keys, as provenanceToCitations does', () => {
    const out = toBrowserProvenance(
      { chunks: [{ chunkId: 'a', documentId: 'd', score: 1, corpus: 'c', metadata: { title: 'T', label: 'L' } }] },
      { titleKeys: ['label'] },
    );
    expect(out!.chunks[0]!.metadata).toEqual({ label: 'L' });
  });

  it('the card renders the same citation from the stripped copy', () => {
    const before = provenanceToCitations(raw as unknown as Provenance)[0]!;
    const after = provenanceToCitations(toBrowserProvenance(raw))[0]!;
    expect(after).toMatchObject({
      title: before.title,
      passageText: before.passageText,
      score: before.score,
      documentId: before.documentId,
      chunkId: before.chunkId,
      corpus: before.corpus,
    });
  });

  it('drops a non-integer or non-positive ordinal and wrongly typed fields', () => {
    const out = toBrowserProvenance({
      chunks: [{ chunkId: 'a', documentId: 'd', score: 'high', corpus: 'c', text: 42, ordinal: 1.5, metadata: null }],
    });
    expect(out).toEqual({ chunks: [{ chunkId: 'a', documentId: 'd', corpus: 'c', metadata: null }] });
  });

  it('reads old persisted shapes: a bare chunk array, junk entries, junk rows', () => {
    expect(toBrowserProvenance([{ chunkId: 'a', documentId: 'd', score: 1, corpus: 'c', metadata: { sessionId: 's' } }, null, 'x'])).toEqual({
      chunks: [{ chunkId: 'a', documentId: 'd', score: 1, corpus: 'c', metadata: {} }],
    });
    expect(toBrowserProvenance(null)).toBeNull();
    expect(toBrowserProvenance(undefined)).toBeNull();
    expect(toBrowserProvenance('nope')).toBeNull();
    expect(toBrowserProvenance({ chunks: 'nope' })).toBeNull();
    expect(toBrowserProvenance({ chunks: [] })).toEqual({ chunks: [] });
  });

  it('does not mutate its input', () => {
    const copy = JSON.parse(JSON.stringify(raw));
    toBrowserProvenance(raw, { metadataKeys: ['docId'] });
    expect(raw).toEqual(copy);
  });
});
