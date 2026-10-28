import { describe, expect, it } from 'vitest';

import type { CitationLike } from '@edc/chat-engine/core';

import { CHAT_CITATION_LABELS, chatCitationHref } from './client';

/**
 * `chatCitationHref` decides whether a source card gets its "Abrir documento"
 * link. It is the whole reason these tests exist: the two ways it can be wrong
 * are a MISSING link on a document the reader could have opened, and — far
 * worse — a DEAD link on one they cannot. The cases below pin both edges.
 *
 * The metadata shape mirrors the backend's single `chunkMetadata` builder
 * (`apps/backend/src/lib/contentKind.ts`), which is what every corpus chunk is
 * tagged with on the way in.
 */
function citation(metadata: Record<string, unknown> | null): CitationLike {
  return { ordinal: 1, title: 'Acta de la asamblea', metadata };
}

describe('chatCitationHref', () => {
  it('links a published document to its biblioteca reader', () => {
    expect(chatCitationHref(citation({ docId: '42', publication: 'published' }))).toBe(
      '/biblioteca/42',
    );
  });

  it('accepts a numeric docId, since metadata is untyped on the wire', () => {
    expect(chatCitationHref(citation({ docId: 42, publication: 'published' }))).toBe(
      '/biblioteca/42',
    );
  });

  it('trims a padded docId rather than building a broken path', () => {
    expect(chatCitationHref(citation({ docId: ' 42 ', publication: 'published' }))).toBe(
      '/biblioteca/42',
    );
  });

  it('omits the link when the citation carries no docId', () => {
    expect(chatCitationHref(citation({ publication: 'published' }))).toBeNull();
  });

  it('omits the link when docId is present but empty', () => {
    expect(chatCitationHref(citation({ docId: '', publication: 'published' }))).toBeNull();
  });

  // 🔴 The conversation case, and the reason a plain truthiness check on
  // `docId` is not enough. A `conversacion` chunk's `docId` is a synthetic turn
  // id (`turnExternalId` → `msg-<messages row id>`). It names a `messages` row,
  // not a `documents` row, so `/biblioteca/msg-7` is a guaranteed 404.
  it('omits the link for a non-numeric docId, such as a conversation turn', () => {
    expect(chatCitationHref(citation({ docId: 'msg-7', publication: 'published' }))).toBeNull();
  });

  it.each(['42a', 'doc-42', '4.2', '-42', 'abc'])(
    'omits the link for the non-numeric docId %s',
    (docId) => {
      expect(chatCitationHref(citation({ docId, publication: 'published' }))).toBeNull();
    },
  );

  // 🔴 The draft corpus is retrieved on EVERY turn, so this is the ordinary
  // case, not an edge one. `/biblioteca/[id]` answers 404 for an unpublished
  // row by design (`isLibraryVisible`), so a link here would be dead.
  it('omits the link for a draft chunk, which the library will not serve', () => {
    expect(chatCitationHref(citation({ docId: '42', publication: 'draft' }))).toBeNull();
  });

  it('omits the link when the publication tag is missing or unknown', () => {
    expect(chatCitationHref(citation({ docId: '42' }))).toBeNull();
    expect(chatCitationHref(citation({ docId: '42', publication: 'publishing' }))).toBeNull();
  });

  it('omits the link when there is no metadata at all', () => {
    expect(chatCitationHref(citation(null))).toBeNull();
    expect(chatCitationHref({ ordinal: 1 })).toBeNull();
  });

  // The top-level `documentId` is NOT the source of truth here: the resolver
  // reads the chunk metadata, which is the only place the publication tag
  // lives. A citation with an id but no metadata still gets no link.
  it('does not fall back to the top-level documentId', () => {
    expect(chatCitationHref({ ordinal: 1, documentId: '42', metadata: null })).toBeNull();
  });
});

describe('CHAT_CITATION_LABELS', () => {
  it('names the open-source action in Spanish, since the link now renders', () => {
    expect(CHAT_CITATION_LABELS.openSource).toBe('Abrir documento');
  });
});

describe('chatCitationHref — summary sources (`$lib/server/engine/sources`)', () => {
  it('the graph map opens /grafo, the published list opens /biblioteca', () => {
    expect(chatCitationHref(citation({ edcSource: 'mapa' }))).toBe('/grafo');
    expect(chatCitationHref(citation({ edcSource: 'lista' }))).toBe('/biblioteca');
    expect(chatCitationHref(citation({ edcSource: 'otro' }))).toBeNull();
  });
});
