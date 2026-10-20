import { describe, expect, it } from 'vitest';
import { provenanceToCitations } from '@edc/chat-engine/core';
import { toBrowserProvenance, toBrowserMessage } from './citationProvenance';
import { DRAFT_PROVENANCE_FLAG } from '$lib/publication';
import { markAssistantCitations, ASSISTANT_CITATION_SUFFIX } from '$lib/assistantChunks';
import { chatCitationHref } from '$lib/engine/client';

/**
 * Fable audit #8: chunk metadata `sessionId` and `authoredBy` (written by
 * `chunkMetadata`, apps/backend/src/lib/contentKind.ts) rode into citations
 * that every member's browser receives. The browser now gets an ALLOWLIST.
 */

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

  it('🔴 never carries sessionId or authoredBy', () => {
    expect(hasKeyDeep(out, 'sessionId')).toBe(false);
    expect(hasKeyDeep(out, 'authoredBy')).toBe(false);
  });

  it('turns authoredBy: assistant into the server-derived boolean', () => {
    expect(out.chunks[0]!.metadata).toMatchObject({ isAssistantAnswer: true });
    expect(out.chunks[1]!.metadata).not.toHaveProperty('isAssistantAnswer');
  });

  it('is an allowlist: unknown chunk and metadata keys are dropped', () => {
    expect(Object.keys(out.chunks[0]!).sort()).toEqual(
      ['chunkId', 'corpus', 'denseScore', 'documentId', 'lexicalScore', 'metadata', 'rerankScore', 'score', 'text'],
    );
    expect(Object.keys(out.chunks[0]!.metadata!).sort()).toEqual(
      ['isAssistantAnswer', 'publication', 'title'],
    );
    expect(Object.keys(out.chunks[1]!.metadata!).sort()).toEqual(
      ['docId', DRAFT_PROVENANCE_FLAG, 'publication', 'title'].sort(),
    );
  });

  it('keeps everything the citation card reads: title, passage, link, draft and assistant labels', () => {
    const citations = provenanceToCitations(out);
    expect(citations.map((c) => [c.ordinal, c.title, c.passageText])).toEqual([
      [1, 'Conversación', 'Antes dije que el faro existe.'],
      [2, 'informe.pdf', 'Dato.'],
    ]);
    expect(markAssistantCitations(citations)[0]!.title).toBe(`Conversación${ASSISTANT_CITATION_SUFFIX}`);
    expect(citations[1]!.metadata?.[DRAFT_PROVENANCE_FLAG]).toBe(true);
    const published = toBrowserProvenance({ chunks: [{ ...docChunk, metadata: { docId: '12', publication: 'published' } }] })!;
    expect(chatCitationHref(provenanceToCitations(published)[0]!)).not.toBeNull();
  });

  it('keeps docId only when it is a documents row id, never a conversation turn id', () => {
    const ids = toBrowserProvenance({
      chunks: [
        { ...docChunk, metadata: { docId: 'msg-41' } },
        { ...docChunk, metadata: { docId: 12 } },
        { ...docChunk, metadata: { docId: ' 13 ' } },
      ],
    })!;
    expect(ids.chunks.map((c) => c.metadata?.docId)).toEqual([undefined, '12', '13']);
  });

  it('a forged isAssistantAnswer of the wrong type is not trusted', () => {
    const forged = toBrowserProvenance({ chunks: [{ ...docChunk, metadata: { isAssistantAnswer: 'yes' } }] })!;
    expect(forged.chunks[0]!.metadata).toEqual({});
  });

  it('passes null through, and reads anything else as no provenance', () => {
    expect(toBrowserProvenance(null)).toBeNull();
    expect(toBrowserProvenance(undefined)).toBeNull();
    expect(toBrowserProvenance('x')).toBeNull();
    expect(toBrowserProvenance({ chunks: 'nope' })).toBeNull();
    expect(toBrowserProvenance({ chunks: [null, 3, { ...docChunk, metadata: null }] })).toEqual({
      chunks: [expect.objectContaining({ chunkId: 'c2', metadata: null })],
    });
  });

  it('reads a bare array of chunks too (an older persisted shape)', () => {
    const arr = toBrowserProvenance([assistantChunk]);
    expect(arr?.chunks).toHaveLength(1);
    expect(hasKeyDeep(arr, 'sessionId')).toBe(false);
  });
});

describe('toBrowserMessage', () => {
  it('sanitises the provenance of a persisted message and leaves the rest alone', () => {
    const msg = { id: 3, role: 'assistant', content: 'hola', provenance: { chunks: [assistantChunk] } };
    const out = toBrowserMessage(msg);
    expect(out).toMatchObject({ id: 3, role: 'assistant', content: 'hola' });
    expect(hasKeyDeep(out, 'sessionId')).toBe(false);
    expect(hasKeyDeep(out, 'authoredBy')).toBe(false);
  });

  it('leaves a message without provenance unchanged', () => {
    expect(toBrowserMessage({ id: 1, role: 'user', content: 'q' })).toEqual({ id: 1, role: 'user', content: 'q' });
  });
});
