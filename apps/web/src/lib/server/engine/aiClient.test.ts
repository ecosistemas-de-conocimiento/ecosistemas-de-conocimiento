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
  metadata?: Record<string, unknown>;
}

/**
 * A chunk in the shape ai-service REALLY returns. `documentId` is ai-service's
 * own UUID for its copy of the document; the BACKEND's id — the one the
 * session's document list holds — travels in `metadata.docId`, set by the
 * backend's ingest call. ✅ measured 2026-10-14 against a fresh stack:
 * `{"documentId":"5190327d-…","metadata":{"docId":"3",…}}`.
 *
 * 🔴 These fixtures used to put the backend id in `documentId`, which made the
 * draft-leg filter look correct while it dropped every real chunk — the same
 * wrong shape `fdb5bd5` fixed in the backend's conversation ingest.
 */
function chunk(backendDocId: string, n = 1): Chunk {
  return {
    chunkId: `${backendDocId}#${n}`,
    documentId: `00000000-0000-4000-8000-${backendDocId.padStart(12, '0')}`,
    text: `t-${backendDocId}-${n}`,
    score: 1 / n,
    metadata: { docId: backendDocId },
  };
}

/** The backend document ids of the kept matches. */
function backendIds(matches: { metadata?: Record<string, unknown> }[]): unknown[] {
  return matches.map((m) => m.metadata?.docId);
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

    expect(backendIds(res.matches)).toEqual(['10', '11']);
  });

  it('coerces a numeric metadata.docId against the string id set', async () => {
    respondWith([{ ...chunk('10'), metadata: { docId: 10 } }]);

    const res = await withDocs(new Set(['10'])).retrieve(request(DRAFT));

    expect(res.matches).toHaveLength(1);
  });

  // 🔴 ai-service's own UUID is never a backend id. Matching on it dropped every
  // draft chunk on a real stack, so attached documents were never cited.
  it('matches on metadata.docId, never on ai-service’s documentId', async () => {
    respondWith([
      { chunkId: 'a', documentId: '10', text: 'uuid collides', score: 1, metadata: { docId: '999' } },
      { chunkId: 'b', documentId: 'f00d-uuid', text: 'kept', score: 0.5, metadata: { docId: '10' } },
      { chunkId: 'c', documentId: '10', text: 'no metadata', score: 0.4 },
    ]);

    const res = await withDocs(new Set(['10'])).retrieve(request(DRAFT));

    expect(res.matches.map((m) => m.chunkId)).toEqual(['b']);
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
    expect(backendIds(res.matches).every((id) => id === '10')).toBe(true);
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

    expect(backendIds(res.matches)).toEqual(['999', '998']);
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
    expect(backendIds((await ai.retrieve(request(ECO))).matches)).toEqual(['10']);
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

describe('the lengua filter on the wire', () => {
  const opts = {
    sessionId: '1',
    asOf: ASOF,
    allowedCorpora: [ECO],
    publishedCorpus: ECO,
    sessionDocumentIds: new Set<string>(),
  };

  it('forwards `filter: { lengua }` to ai-service', async () => {
    const ai = makeEngineAIClient(noClient, opts);
    await ai.retrieve({ ...request(ECO), filter: { lengua: 'mixe' } });
    expect(sentBodies()[0]!.filter).toEqual({ lengua: 'mixe' });
  });

  // 🔴 The 400 fallback drops `filter` and retries. For a lengua filter that
  // answers with every language under a "solo mixe" summary line — wrong, and
  // silently. Empty is the honest degradation.
  it('does NOT retry unfiltered when ai-service rejects a lengua filter', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 400 }));
    const ai = makeEngineAIClient(noClient, opts);
    const res = await ai.retrieve({ ...request(ECO), filter: { lengua: 'mixe' } });
    expect(res.matches).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
