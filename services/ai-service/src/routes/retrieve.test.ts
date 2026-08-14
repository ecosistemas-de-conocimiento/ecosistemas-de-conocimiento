// Unit tests for /v1/retrieve.
//
// `RetrieveService.retrieve` is mocked at the class level so the route layer
// is exercised in isolation: Zod validation, error-class → 404 mapping, and
// the auth-context plumbing (cross-tenant access yields a 404 because the
// service's lookup filters by `{org, project}`).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const retrieveMock = vi.fn();
const retrieveMultiMock = vi.fn();

vi.mock('../services/rag/retrieve.js', async () => {
  const actual = await vi.importActual<typeof import('../services/rag/retrieve.js')>(
    '../services/rag/retrieve.js',
  );
  return {
    ...actual,
    RetrieveService: class {
      retrieve = (...args: unknown[]) => retrieveMock(...args);
    },
  };
});

vi.mock('../services/rag/retrieve-multi.js', () => ({
  RetrieveMultiService: class {
    retrieveMulti = (...args: unknown[]) => retrieveMultiMock(...args);
  },
}));

vi.mock('../db/client.js', () => ({ db: {} }));

import { CorpusNotFoundError } from '../services/rag/retrieve.js';

const APP_TOKEN = 'test-key';
const ORG = 'test-org';
const PROJECT = 'test-project';

async function makeApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

beforeEach(() => {
  retrieveMock.mockReset();
  retrieveMultiMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /v1/retrieve', () => {
  it('returns retrieved chunks on the happy path', async () => {
    retrieveMock.mockResolvedValueOnce({
      chunks: [
        {
          chunkId: 'c1',
          documentId: 'd1',
          ordinal: 0,
          text: 'hello',
          score: 0.91,
          metadata: { tag: 'h' },
        },
      ],
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/retrieve',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { corpus: 'docs', query: 'hello', topK: 3, mmr: 0.5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chunks).toHaveLength(1);
    expect(body.chunks[0]).toMatchObject({ chunkId: 'c1', score: 0.91 });
    expect(retrieveMock).toHaveBeenCalledWith(
      { corpus: 'docs', query: 'hello', topK: 3, mmr: 0.5 },
      { org: ORG, project: PROJECT },
    );
    await app.close();
  });

  it('maps CorpusNotFoundError to 404', async () => {
    retrieveMock.mockRejectedValueOnce(
      new CorpusNotFoundError({ corpus: 'missing', org: ORG, project: PROJECT }),
    );
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/retrieve',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { corpus: 'missing', query: 'q' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 for cross-tenant corpus access (different org owns the name)', async () => {
    // The service-level lookup is `{org, project, name}` — a foreign-owned
    // corpus is indistinguishable from a missing one, by design (no info leak).
    retrieveMock.mockRejectedValueOnce(
      new CorpusNotFoundError({ corpus: 'foreign', org: ORG, project: PROJECT }),
    );
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/retrieve',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { corpus: 'foreign', query: 'q' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /v1/retrieve/multi', () => {
  it('validates the body and delegates to RetrieveMultiService with auth ctx', async () => {
    retrieveMultiMock.mockResolvedValueOnce({
      query: 'hi',
      rewritten: false,
      chunks: [
        { chunkId: 'c1', documentId: 'd1', ordinal: 0, text: 'hello', score: 0.91, corpus: 'a' },
      ],
      corpora: [
        { corpus: 'a', matched: 1 },
        { corpus: 'b', matched: 0, error: 'not_found' },
      ],
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/retrieve/multi',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { corpora: ['a', 'b'], query: 'hi', topK: 5, limit: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chunks[0]).toMatchObject({ chunkId: 'c1', corpus: 'a' });
    expect(body.corpora).toHaveLength(2);
    expect(retrieveMultiMock).toHaveBeenCalledWith(
      { corpora: ['a', 'b'], query: 'hi', topK: 5, limit: 3 },
      { org: ORG, project: PROJECT },
    );
    await app.close();
  });

  it('rejects an empty corpora array with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/retrieve/multi',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { corpora: [], query: 'hi' },
    });
    expect(res.statusCode).toBe(400);
    expect(retrieveMultiMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an unknown field (strict schema) with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/retrieve/multi',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { corpora: ['a'], query: 'hi', corpus: 'a' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
