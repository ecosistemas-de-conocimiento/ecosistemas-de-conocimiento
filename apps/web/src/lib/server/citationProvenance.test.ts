import { describe, expect, it } from 'vitest';
import { provenanceToCitations } from '@edc/chat-engine/core';
import { citedBrowserProvenance, toBrowserProvenance, toBrowserMessage } from './citationProvenance';
import { DRAFT_PROVENANCE_FLAG } from '$lib/publication';
import { NO_ANSWER_REPLY } from '$lib/server/engine/prompt';
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

  it('a marker past the end is ignored, and still counts as citing: no fallback', () => {
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

// 🔴 Measured on dev: "dengue" (3 runs) answered with no [N] and showed 0
// sources. An answer with no marker at all lists the top retrieved ones.
describe('citedBrowserProvenance — an answer with no [N] lists the top sources', () => {
  const scored = (i: number, score: number, rerankScore?: number) => ({
    chunkId: `s${i}`,
    documentId: `uuid-${i}`,
    score,
    ...(rerankScore === undefined ? {} : { rerankScore }),
    corpus: 'eco-7',
    text: `Pasaje ${i}.`,
    metadata: { docId: String(i), title: `Doc ${i}`, publication: 'published' },
  });
  const ids = (p: ReturnType<typeof citedBrowserProvenance>) => (p?.chunks ?? []).map((c) => c.chunkId);
  const ords = (p: ReturnType<typeof citedBrowserProvenance>) =>
    (p?.chunks ?? []).map((c) => (c as { ordinal?: number }).ordinal);

  it('no [N]: the top 3 by rerank score, best first, each with its prompt ordinal', () => {
    const p = { chunks: [scored(1, 0.9, 0.1), scored(2, 0.1, 0.8), scored(3, 0.5, 0.5), scored(4, 0.3, 0.9), scored(5, 0.2, 0.2)] };
    const out = citedBrowserProvenance(p as never, 'El dengue se transmite por mosquitos.');
    expect(ids(out)).toEqual(['s4', 's2', 's3']);
    expect(ords(out)).toEqual([4, 2, 3]);
  });

  it('no rerank score: ranks by the retrieval score', () => {
    const p = { chunks: [scored(1, 0.2), scored(2, 0.9), scored(3, 0.5), scored(4, 0.7)] };
    expect(ids(citedBrowserProvenance(p as never, 'Sin marcas.'))).toEqual(['s2', 's4', 's3']);
  });

  it('fewer than 3 retrieved: lists them all; none retrieved: no sources', () => {
    expect(ids(citedBrowserProvenance({ chunks: [scored(1, 0.2)] } as never, 'Sin marcas.'))).toEqual(['s1']);
    expect(citedBrowserProvenance({ chunks: [] } as never, 'Sin marcas.')).toBeNull();
    expect(citedBrowserProvenance(null, 'Sin marcas.')).toBeNull();
  });

  it('🔴 the no-answer reply (the prompt constant) lists no sources', () => {
    const p = { chunks: [scored(1, 0.9), scored(2, 0.8)] };
    expect(citedBrowserProvenance(p as never, NO_ANSWER_REPLY)).toBeNull();
    expect(citedBrowserProvenance(p as never, `Lo siento. ${NO_ANSWER_REPLY}`)).toBeNull();
  });

  it('the no-answer reply with a title match: only the matched document, as before', () => {
    const p = { chunks: [scored(1, 0.9), scored(2, 0.8)] };
    const out = citedBrowserProvenance(p as never, NO_ANSWER_REPLY, { id: '2', name: 'Doc 2' });
    expect(ids(out)).toEqual(['s2']);
  });

  it('a near-miss wording is not the reply: the fallback applies', () => {
    const p = { chunks: [scored(1, 0.9)] };
    expect(ids(citedBrowserProvenance(p as never, 'Los documentos no hablan de dengue.'))).toEqual(['s1']);
  });

  it('with [N]: cited only, the fallback never adds a top chunk', () => {
    const p = { chunks: [scored(1, 0.9), scored(2, 0.1), scored(3, 0.5)] };
    expect(ids(citedBrowserProvenance(p as never, 'Dato [2].'))).toEqual(['s2']);
  });

  it('🔴 a conversation turn never takes a slot', () => {
    const p = { chunks: [{ ...userTurnChunk, score: 0.99 }, scored(2, 0.5), scored(3, 0.4), scored(4, 0.3), scored(5, 0.2)] };
    expect(ids(citedBrowserProvenance(p as never, 'Sin marcas.'))).toEqual(['s2', 's3', 's4']);
  });

  it('🔴 a testimonio: published chunks only, titled "Testimonio"', () => {
    const t = (id: string, publication: string, score: number) => ({
      ...scored(9, score),
      chunkId: id,
      text: publication === 'published' ? 'REDACTADO [Persona A]' : 'ORIGINAL Juana',
      metadata: { docId: '9', title: 'Carta de Juana', kind: 'testimonio', publication },
    });
    const p = { chunks: [t('t-draft', 'draft', 0.99), t('t-pub', 'published', 0.6), scored(2, 0.5)] };
    const out = citedBrowserProvenance(p as never, 'Sin marcas.')!;
    expect(ids(out)).toEqual(['t-pub', 's2']);
    expect(out.chunks[0]!.metadata).toMatchObject({ title: 'Testimonio' });
    expect(JSON.stringify(out)).not.toMatch(/Juana/);
  });

  describe('with a title match', () => {
    const p = { chunks: [scored(1, 0.9), scored(2, 0.8), scored(3, 0.7), scored(4, 0.6), scored(5, 0.1)] };

    it('matched doc outside the top 3: the top 3 plus it, 4 at most', () => {
      const out = citedBrowserProvenance(p as never, 'Sin marcas.', { id: '5', name: 'Doc 5', contentKind: 'documento' } as never);
      expect(ids(out)).toEqual(['s1', 's2', 's3', 's5']);
      expect(ords(out)).toEqual([1, 2, 3, 5]);
    });

    it('matched doc inside the top 3: listed once, no duplicate', () => {
      const out = citedBrowserProvenance(p as never, 'Sin marcas.', { id: '2', name: 'Doc 2', contentKind: 'documento' } as never);
      expect(ids(out)).toEqual(['s1', 's2', 's3']);
    });

    it('matched doc not retrieved: the top 3 plus a document-level entry', () => {
      const out = citedBrowserProvenance(p as never, 'Sin marcas.', { id: '77', name: 'Doc 77', contentKind: 'documento' } as never)!;
      expect(ids(out)).toEqual(['s1', 's2', 's3', 'document:77']);
      expect(new Set(ords(out)).size).toBe(4);
    });
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
