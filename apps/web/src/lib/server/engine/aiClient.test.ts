/**
 * The retrieval gates in `makeEngineAIClient`.
 *
 * Three properties, all of them safety properties, and all of them decided
 * BEFORE a network call:
 *
 *   1. only corpora the backend authorised are ever reached;
 *   2. the caller's draft corpus is narrowed to THIS conversation's documents,
 *      and refused outright when that list could not be read;
 *   3. no retrieve goes out without `asOf` (pre-existing, must not regress).
 *
 * `$env/dynamic/private` resolves once and cannot be mutated from a test, so
 * it is mocked at module scope — the same approach `promptSource.test.ts` and
 * `server/health.test.ts` use.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
  env: { AI_SERVICE_URL: 'http://ai.test', AI_SERVICE_API_KEY: 'k' },
}));

import { makeEngineAIClient } from './aiClient';
import type { AIServiceClient } from '$lib/server/aiService';
import type { RetrieveRequest } from '@edc/chat-engine/core';

const ECO = 'eco-7';
const DRAFT = 'eco-7-draft-42';
const ASOF = '2026-08-28T00:00:00Z';

/** `retrieve` never touches the BFF client — it raw-fetches. */
const noClient = {} as unknown as AIServiceClient;

interface Chunk {
  chunkId: string;
  documentId: string;
  text: string;
  score: number;
}

function chunk(documentId: string, n = 1): Chunk {
  return { chunkId: `${documentId}#${n}`, documentId, text: `t-${documentId}-${n}`, score: 1 / n };
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Every POST body this test's fetch stub saw, in order. */
function sentBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls.map(
    (c) => JSON.parse((c[1] as RequestInit).body as string) as Record<string, unknown>,
  );
}

function respondWith(chunks: Chunk[]): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ chunks }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function request(corpus: string, topK = 5): RetrieveRequest {
  return { orgId: 'org', scopeId: 's1', corpus, query: '¿qué dice el informe?', topK };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  respondWith([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the authorisation gate', () => {
  it('makes NO request for a corpus the backend did not authorise', async () => {
    const ai = makeEngineAIClient(noClient, {
      sessionId: '1',
      asOf: ASOF,
      allowedCorpora: [ECO],
      publishedCorpus: ECO,
      sessionDocumentIds: new Set(['10']),
    });

    const res = await ai.retrieve(request('eco-99'));

    expect(res.matches).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The engine appends `chat:thread:{sessionId}` to every turn
  // (`packages/chat-engine/src/core/retrieve.ts`). Nothing in this product ever
  // ingests there, so it was a per-turn round-trip to a guaranteed 404.
  it('drops the engine’s unconditional chat:thread leg without a round trip', async () => {
    const ai = makeEngineAIClient(noClient, {
      sessionId: '1',
      asOf: ASOF,
      allowedCorpora: [ECO, DRAFT],
      publishedCorpus: ECO,
      sessionDocumentIds: new Set(['10']),
    });

    const res = await ai.retrieve(request('chat:thread:1'));

    expect(res.matches).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('authorises nothing when no corpus list was given', async () => {
    const ai = makeEngineAIClient(noClient, { sessionId: '1', asOf: ASOF });
    expect((await ai.retrieve(request(ECO))).matches).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the draft leg', () => {
  const withDocs = (ids: ReadonlySet<string> | null) =>
    makeEngineAIClient(noClient, {
      sessionId: '1',
      asOf: ASOF,
      allowedCorpora: [ECO, DRAFT],
      publishedCorpus: ECO,
      sessionDocumentIds: ids,
    });

  // 🔴 The fail-closed case. Falling back to an unfiltered draft retrieve would
  // reintroduce the exact defect: a document answering in a conversation it was
  // never attached to.
  it('retrieves NOTHING when this conversation’s document list is unknown', async () => {
    const res = await withDocs(null).retrieve(request(DRAFT));

    expect(res.matches).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('treats an omitted document set as unknown, not as empty', async () => {
    const ai = makeEngineAIClient(noClient, {
      sessionId: '1',
      asOf: ASOF,
      allowedCorpora: [ECO, DRAFT],
      publishedCorpus: ECO,
    });
    expect((await ai.retrieve(request(DRAFT))).matches).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps chunks of documents attached here and drops the rest', async () => {
    respondWith([chunk('10'), chunk('999'), chunk('11'), chunk('998')]);

    const res = await withDocs(new Set(['10', '11'])).retrieve(request(DRAFT));

    expect(res.matches.map((m) => m.documentId)).toEqual(['10', '11']);
  });

  it('coerces a numeric documentId against the string id set', async () => {
    respondWith([{ ...chunk('10'), documentId: 10 as unknown as string }]);

    const res = await withDocs(new Set(['10'])).retrieve(request(DRAFT));

    expect(res.matches).toHaveLength(1);
  });

  // ⚠ Without the over-fetch the leg starves: ai-service ranks across the
  // caller's WHOLE draft corpus, so other conversations' drafts eat the topK
  // and this conversation's own documents never survive the filter.
  it('over-fetches upstream and truncates back to the requested topK', async () => {
    respondWith([
      chunk('999', 1),
      chunk('10', 2),
      chunk('998', 3),
      chunk('10', 4),
      chunk('10', 5),
      chunk('10', 6),
    ]);

    const res = await withDocs(new Set(['10'])).retrieve(request(DRAFT, 3));

    expect(sentBodies()[0]!.topK).toBe(12); // 3 × 4
    expect(res.matches).toHaveLength(3); // truncated back to topK
    expect(res.matches.every((m) => m.documentId === '10')).toBe(true);
  });

  it('caps the over-fetch so a large topK cannot ask for the world', async () => {
    await withDocs(new Set(['10'])).retrieve(request(DRAFT, 40));
    expect(sentBodies()[0]!.topK).toBe(50);
  });

  it('still sends asOf on the over-fetched call', async () => {
    await withDocs(new Set(['10'])).retrieve(request(DRAFT));
    expect(sentBodies()[0]!.asOf).toBe(ASOF);
  });
});

describe('the published corpus', () => {
  // 🔴 Published documents and testimonies are the ecosistema's shared brain:
  // retrievable in EVERY conversation, forever. The document filter must not
  // touch this leg.
  it('is never narrowed by this conversation’s document list', async () => {
    respondWith([chunk('999'), chunk('998')]);

    const ai = makeEngineAIClient(noClient, {
      sessionId: '1',
      asOf: ASOF,
      allowedCorpora: [ECO, DRAFT],
      publishedCorpus: ECO,
      sessionDocumentIds: new Set(['10']),
    });
    const res = await ai.retrieve(request(ECO));

    expect(res.matches.map((m) => m.documentId)).toEqual(['999', '998']);
  });

  it('asks upstream for exactly the topK it was given', async () => {
    const ai = makeEngineAIClient(noClient, {
      sessionId: '1',
      asOf: ASOF,
      allowedCorpora: [ECO],
      publishedCorpus: ECO,
      sessionDocumentIds: new Set(['10']),
    });
    await ai.retrieve(request(ECO, 5));

    expect(sentBodies()[0]!.topK).toBe(5);
  });

  it('is unfiltered even when the document list is unknown', async () => {
    respondWith([chunk('999')]);

    const ai = makeEngineAIClient(noClient, {
      sessionId: '1',
      asOf: ASOF,
      allowedCorpora: [ECO],
      publishedCorpus: ECO,
      sessionDocumentIds: null,
    });

    expect((await ai.retrieve(request(ECO))).matches).toHaveLength(1);
  });
});

describe('an unidentifiable shared corpus fails CLOSED', () => {
  // 🔴 The regression guard for the failure mode the exemption model exists to
  // prevent. Narrowing is stated as "everything EXCEPT the shared corpus", so a
  // corpora response that stops naming `published` costs the caller context —
  // loudly — instead of quietly reopening the cross-conversation draft leak.
  // The opposite spelling ("narrow the corpus I recognise as the draft one")
  // would make this same input retrieve every draft globally, with no error.
  it('narrows EVERY corpus when publishedCorpus is null', async () => {
    respondWith([chunk('10'), chunk('999')]);

    const ai = makeEngineAIClient(noClient, {
      sessionId: '1',
      asOf: ASOF,
      allowedCorpora: [ECO, DRAFT],
      publishedCorpus: null,
      sessionDocumentIds: new Set(['10']),
    });

    // Even the ecosistema's own corpus is filtered down to this conversation.
    expect((await ai.retrieve(request(ECO))).matches.map((m) => m.documentId)).toEqual(['10']);
  });

  it('refuses every corpus when the document list is ALSO unknown', async () => {
    respondWith([chunk('999')]);

    const ai = makeEngineAIClient(noClient, {
      sessionId: '1',
      asOf: ASOF,
      allowedCorpora: [ECO],
      publishedCorpus: null,
      sessionDocumentIds: null,
    });

    expect((await ai.retrieve(request(ECO))).matches).toHaveLength(0);
    expect(sentBodies()).toHaveLength(0);
  });
});

describe('the asOf guarantee (must not regress)', () => {
  // Unpublishing only end-dates a document's chunks; without `asOf` they keep
  // coming back. This blocks every corpus, authorised or not.
  it.each([
    ['the published corpus', ECO],
    ['the draft corpus', DRAFT],
  ])('refuses %s without asOf', async (_label, corpus) => {
    const ai = makeEngineAIClient(noClient, {
      sessionId: '1',
      asOf: null,
      allowedCorpora: [ECO, DRAFT],
      publishedCorpus: ECO,
      sessionDocumentIds: new Set(['10']),
    });

    expect((await ai.retrieve(request(corpus))).matches).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
