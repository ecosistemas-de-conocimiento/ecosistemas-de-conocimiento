import { describe, expect, it } from 'vitest';
import { provenanceToCitations } from '@edc/chat-engine/core';
import { citedBrowserProvenance, toBrowserProvenance, toBrowserMessage } from './citationProvenance';
import { DRAFT_PROVENANCE_FLAG } from '$lib/publication';
import { citationsWithOrdinals } from '$lib/citationOrdinals';
import { chatCitationHref } from '$lib/engine/client';

/**
 * Fable audit #8: chunk metadata `sessionId` and `authoredBy` (written by
 * `chunkMetadata`, apps/backend/src/lib/contentKind.ts) rode into citations
 * that every member's browser receives. The browser now gets an ALLOWLIST.
 */

/** A conversation turn ingested before the 2026-10-21 ruling: never a source. */
const assistantChunk = {
  chunkId: 'c1',
  documentId: 'uuid-1',
  score: 0.9,
  denseScore: 0.7,
  lexicalScore: 0.1,
  rerankScore: 0.9,
  corpus: 'eco-7',
  text: 'Antes dije que el faro existe.',
  metadata: {
    docId: 'msg-41',
    organizationId: '7',
    kind: 'conversacion',
    format: 'chat',
    publication: 'published',
    title: 'Conversación',
    authoredBy: 'assistant',
    sessionId: '77',
    path: 'graph',
  },
  someFutureField: 'x',
};

const userTurnChunk = {
  ...assistantChunk,
  chunkId: 'c0',
  text: '¿Qué dice el informe de riego?',
  metadata: { ...assistantChunk.metadata, docId: 'msg-40', authoredBy: 'user' },
};

const docChunk = {
  chunkId: 'c2',
  documentId: 'uuid-11',
  score: 0.5,
  corpus: 'eco-7-draft-1',
  text: 'Dato.',
  metadata: { docId: '11', publication: 'draft', title: 'informe.pdf', [DRAFT_PROVENANCE_FLAG]: true, lengua: 'mixe' },
};

const hasKeyDeep = (value: unknown, key: string): boolean =>
  JSON.stringify(value).includes(`"${key}"`);

describe('toBrowserProvenance', () => {
  const out = toBrowserProvenance({ chunks: [assistantChunk, docChunk] })!;

  it('🔴 drops every conversation turn (owner ruling 2026-10-21), question or answer', () => {
    const both = toBrowserProvenance({ chunks: [userTurnChunk, assistantChunk, docChunk] })!;
    expect(both.chunks.map((c) => c.chunkId)).toEqual(['c2']);
    expect(provenanceToCitations(both).map((c) => c.title)).not.toContain('Conversación');
  });

  it('🔴 never carries sessionId or authoredBy', () => {
    expect(hasKeyDeep(out, 'sessionId')).toBe(false);
    expect(hasKeyDeep(out, 'authoredBy')).toBe(false);
  });

  it('stamps each chunk with its PROMPT ordinal before dropping, so [N] keeps its source', () => {
    // The turn was [1]; the document stays [2].
    expect(out.chunks.map((c) => [(c as { ordinal?: number }).ordinal, c.chunkId])).toEqual([[2, 'c2']]);
    expect(citationsWithOrdinals(out).map((c) => [c.ordinal, c.title])).toEqual([[2, 'informe.pdf']]);
  });

  it('is an allowlist: unknown chunk and metadata keys are dropped', () => {
    const doc = toBrowserProvenance({ chunks: [{ ...docChunk, denseScore: 0.7, someFutureField: 'x' }] })!;
    expect(Object.keys(doc.chunks[0]!).sort()).toEqual(
      ['chunkId', 'corpus', 'denseScore', 'documentId', 'metadata', 'ordinal', 'score', 'text'],
    );
    expect(Object.keys(doc.chunks[0]!.metadata!).sort()).toEqual(
      ['docId', DRAFT_PROVENANCE_FLAG, 'publication', 'title'].sort(),
    );
  });

  it('keeps everything the citation card reads: title, passage, link and draft label', () => {
    const citations = citationsWithOrdinals(out);
    expect(citations.map((c) => [c.title, c.passageText])).toEqual([['informe.pdf', 'Dato.']]);
    expect(citations[0]!.metadata?.[DRAFT_PROVENANCE_FLAG]).toBe(true);
    const published = toBrowserProvenance({ chunks: [{ ...docChunk, metadata: { docId: '12', publication: 'published' } }] })!;
    expect(chatCitationHref(provenanceToCitations(published)[0]!)).not.toBeNull();
  });

  it('keeps docId only when it is a documents row id; a msg- id is a turn and is dropped', () => {
    const ids = toBrowserProvenance({
      chunks: [
        { ...docChunk, metadata: { docId: 'msg-41' } },
        { ...docChunk, metadata: { docId: 12 } },
        { ...docChunk, metadata: { docId: ' 13 ' } },
        { ...docChunk, metadata: { docId: 'abc' } },
      ],
    })!;
    expect(ids.chunks.map((c) => c.metadata?.docId)).toEqual(['12', '13', undefined]);
  });

  it('passes null through, and reads anything else as no provenance', () => {
    expect(toBrowserProvenance(null)).toBeNull();
    expect(toBrowserProvenance(undefined)).toBeNull();
    expect(toBrowserProvenance('x')).toBeNull();
    expect(toBrowserProvenance({ chunks: 'nope' })).toBeNull();
    expect(toBrowserProvenance({ chunks: [null, 3, { ...docChunk, metadata: null }] })).toEqual({
      chunks: [expect.objectContaining({ chunkId: 'c2', metadata: null, ordinal: 3 })],
    });
  });

  it('reads a bare array of chunks too (an older persisted shape)', () => {
    const arr = toBrowserProvenance([assistantChunk, docChunk]);
    expect(arr?.chunks.map((c) => c.chunkId)).toEqual(['c2']);
    expect(hasKeyDeep(arr, 'sessionId')).toBe(false);
  });
});

describe('citedBrowserProvenance — only the sources the answer cites (#35)', () => {
  const doc = (i: number) => ({ ...docChunk, chunkId: `d${i}`, metadata: { docId: String(i), title: `Doc ${i}` } });
  const five = { chunks: [doc(1), doc(2), doc(3), doc(4), doc(5)] };

  it('keeps the cited chunks only, each with the ordinal the answer used', () => {
    const out = citedBrowserProvenance(five as never, 'El riego empezó en 2020 [3], según el acta [1, 3].')!;
    expect(out.chunks.map((c) => [(c as { ordinal?: number }).ordinal, c.chunkId])).toEqual([
      [3, 'd3'],
      [1, 'd1'],
    ]);
    expect(citationsWithOrdinals(out).map((c) => [c.ordinal, c.title])).toEqual([
      [3, 'Doc 3'],
      [1, 'Doc 1'],
    ]);
  });

  it('an answer that cites nothing shows no sources', () => {
    expect(citedBrowserProvenance(five as never, 'Los documentos no hablan de esto.')).toBeNull();
  });

  it('a marker past the end is ignored', () => {
    expect(citedBrowserProvenance(five as never, 'Dato [9].')).toBeNull();
  });

  it('🔴 a cited conversation turn is still dropped, and leaves no "Conversación" source', () => {
    const out = citedBrowserProvenance({ chunks: [userTurnChunk, docChunk] } as never, 'Según [1] y [2].')!;
    expect(out.chunks.map((c) => c.chunkId)).toEqual(['c2']);
    expect(citationsWithOrdinals(out).map((c) => [c.ordinal, c.title])).toEqual([[2, 'informe.pdf']]);
  });

  it('carries no `relevance` field to the browser', () => {
    expect(hasKeyDeep(citedBrowserProvenance(five as never, '[2]'), 'relevance')).toBe(false);
  });
});

describe('toBrowserMessage', () => {
  it('sanitises the provenance of a persisted message and leaves the rest alone', () => {
    const msg = { id: 3, role: 'assistant', content: 'hola', provenance: { chunks: [assistantChunk, docChunk] } };
    const out = toBrowserMessage(msg);
    expect(out).toMatchObject({ id: 3, role: 'assistant', content: 'hola' });
    expect(hasKeyDeep(out, 'sessionId')).toBe(false);
    expect(hasKeyDeep(out, 'authoredBy')).toBe(false);
    expect(JSON.stringify(out)).not.toContain('Conversación');
  });

  it('leaves a message without provenance unchanged', () => {
    expect(toBrowserMessage({ id: 1, role: 'user', content: 'q' })).toEqual({ id: 1, role: 'user', content: 'q' });
  });
});
