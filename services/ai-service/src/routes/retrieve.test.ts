// Unit tests for /v1/retrieve.
//
// `RetrieveService.retrieve` is mocked at the class level so the route layer
// is exercised in isolation: Zod validation, error-class → 404 mapping, and
// that the caller's `{org, project}` (never the body) is what reaches the
// service.
//
// ⚠ SCOPE LIMIT, stated because this file previously overclaimed. With the
// service mocked, NOTHING here executes the tenant-scoping WHERE clause. These
// cases prove the route hands the auth context down and maps the resulting
// error to 404-not-403; they cannot prove another tenant's rows are
// unreachable. That is asserted against a real Postgres in
// `src/routes/tenant-isolation.integration.test.ts`.

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

import { env } from '../config/env.js';
import { CorpusNotFoundError } from '../services/rag/retrieve.js';

import { useBuildServer } from '../test/server-harness.js';

const APP_TOKEN = 'test-key';
const ORG = 'test-org';
const PROJECT = 'test-project';

// `server.js` is imported ONCE per file, in `beforeAll` — importing it inside
// the first test body cost that test ~3 s of module transform against vitest's
// 5 s per-test budget. See `src/test/server-harness.ts`.
const makeApp = useBuildServer();

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

  it('a CorpusNotFoundError raised for a foreign-owned name is answered 404, not 403', async () => {
    // ⚠ THIS IS NOT A TENANT-ISOLATION TEST, and it used to claim to be one.
    // `RetrieveService` is mocked here, so the only thing under test is the
    // route's error mapping: told to reject, it must answer 404 and not 403, so
    // a foreign corpus is indistinguishable from a missing one at the wire.
    // Nothing here executes the `{org, project, name}` WHERE clause that
    // actually makes the row unreachable — a mock told to throw would agree
    // with a service that had no predicate at all.
    //
    // 🔴 The real proof runs against a real Postgres, with a positive control
    // showing the owner still retrieves the same chunk, in
    // `src/routes/tenant-isolation.integration.test.ts` ("POST /v1/retrieve →
    // cross-ORG / cross-PROJECT").
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

// Item 10.3 — the rerank model allowlist (`DEEPINFRA_RERANK_MODELS`). A refused
// per-request `rerankModel` is the route's existing flat 400, before the service
// runs; the service mocks above prove it never reached retrieval.
describe('rerankModel allowlist (RERANK_PROVIDER=deepinfra)', () => {
  const previous = env.RERANK_PROVIDER;
  beforeEach(() => {
    env.RERANK_PROVIDER = 'deepinfra';
  });
  afterEach(() => {
    env.RERANK_PROVIDER = previous;
  });

  const cases = [
    { url: '/v1/retrieve', payload: { corpus: 'docs', query: 'q', rerank: true }, mock: retrieveMock },
    { url: '/v1/retrieve/multi', payload: { corpora: ['a'], query: 'q', rerank: true }, mock: retrieveMultiMock },
  ] as const;

  for (const c of cases) {
    it(`🔴 ${c.url}: a Google model is a 400 and never reaches the service`, async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST',
        url: c.url,
        headers: { authorization: `Bearer ${APP_TOKEN}` },
        payload: { ...c.payload, rerankModel: 'google/gemini-2.5-flash' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/allowlist/);
      expect(c.mock).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${c.url}: a refused model is a 400 even with \`rerank\` absent (checked, not ignored)`, async () => {
      // Documented in the contract and the OpenAPI description: `rerankModel`
      // is only USED under `rerank`, but always CHECKED. Fail-closed on purpose.
      const { rerank: _dropped, ...withoutRerank } = c.payload;
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST',
        url: c.url,
        headers: { authorization: `Bearer ${APP_TOKEN}` },
        payload: { ...withoutRerank, rerankModel: 'google/gemini-2.5-flash' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/allowlist/);
      expect(c.mock).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${c.url}: the allowlisted Qwen model passes through`, async () => {
      c.mock.mockResolvedValueOnce({ chunks: [], query: 'q', rewritten: false, corpora: [] });
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST',
        url: c.url,
        headers: { authorization: `Bearer ${APP_TOKEN}` },
        payload: { ...c.payload, rerankModel: 'Qwen/Qwen3-Reranker-0.6B' },
      });
      expect(res.statusCode).toBe(200);
      expect(c.mock).toHaveBeenCalledTimes(1);
      await app.close();
    });
  }
});
