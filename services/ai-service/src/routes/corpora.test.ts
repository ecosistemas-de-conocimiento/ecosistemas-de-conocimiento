// Unit tests for the /v1/corpora control plane (create/list/get/patch/delete).
//
// `CorpusService` and `CorpusDeleteService` are mocked at the class level so the
// route layer is exercised in isolation: app-role auth, org/project pulled from
// req.auth (never the body), status codes, and the typed-error → HTTP mapping.
// The real DB behaviour is covered in corpus-crud.integration.test.ts.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { useBuildServer } from '../test/server-harness.js';

const createMock = vi.fn();
const listMock = vi.fn();
const getMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../services/rag/corpus-crud.js', async () => {
  const actual = await vi.importActual<typeof import('../services/rag/corpus-crud.js')>(
    '../services/rag/corpus-crud.js',
  );
  return {
    ...actual,
    CorpusService: class {
      createCorpus = (...a: unknown[]) => createMock(...a);
      listCorpora = (...a: unknown[]) => listMock(...a);
      getCorpus = (...a: unknown[]) => getMock(...a);
      updateCorpus = (...a: unknown[]) => updateMock(...a);
    },
  };
});

vi.mock('../services/rag/corpus-delete.js', async () => {
  const actual = await vi.importActual<typeof import('../services/rag/corpus-delete.js')>(
    '../services/rag/corpus-delete.js',
  );
  return {
    ...actual,
    CorpusDeleteService: class {
      deleteCorpus = (...a: unknown[]) => deleteMock(...a);
    },
  };
});

vi.mock('../db/client.js', () => ({ db: {} }));

vi.hoisted(() => {
  process.env.API_KEYS = JSON.stringify({
    'app-key': { org: 'acme', project: 'chat', role: 'app' },
  });
});

// `server.js` is imported ONCE per file, in `beforeAll` — importing it inside
// the first test body cost that test ~3 s of module transform against vitest's
// 5 s per-test budget. See `src/test/server-harness.ts`.
const makeApp = useBuildServer();

const SAMPLE = {
  name: 'policies',
  embeddingModel: 'baai/bge-m3',
  embeddingDim: 1024,
  language: 'spanish',
  chunkStrategy: 'recursive-char',
  chunkSize: 800,
  chunkOverlap: 100,
  chunkConfig: null,
  metadata: null,
  documentCount: 0,
  chunkCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: null,
};

beforeEach(() => {
  createMock.mockReset();
  listMock.mockReset();
  getMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /v1/corpora', () => {
  it('creates a corpus, scoping to the caller (org, project), never the body', async () => {
    createMock.mockResolvedValueOnce(SAMPLE);
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpora',
      headers: { authorization: 'Bearer app-key' },
      payload: { name: 'policies', language: 'spanish', org: 'evil', project: 'evil' },
    });
    // The body's org/project are ignored by `.strict()` — extra keys are rejected.
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 201 with the introspection view on success', async () => {
    createMock.mockResolvedValueOnce(SAMPLE);
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpora',
      headers: { authorization: 'Bearer app-key' },
      payload: { name: 'policies', language: 'spanish' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(SAMPLE);
    const [spec, ctx] = createMock.mock.calls[0]!;
    expect(spec).toMatchObject({ name: 'policies', language: 'spanish' });
    expect(ctx).toEqual({ org: 'acme', project: 'chat' });
    await app.close();
  });

  it('rejects an unknown language (Postgres regconfig whitelist) at validation', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpora',
      headers: { authorization: 'Bearer app-key' },
      payload: { name: 'policies', language: 'es' },
    });
    expect(res.statusCode).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('maps CORPUS_ALREADY_EXISTS to 409', async () => {
    const { CorpusAlreadyExistsError } = await import('../services/rag/corpus-crud.js');
    createMock.mockRejectedValueOnce(new CorpusAlreadyExistsError('policies'));
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpora',
      headers: { authorization: 'Bearer app-key' },
      payload: { name: 'policies' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CORPUS_ALREADY_EXISTS');
    await app.close();
  });

  it('maps a model↔dimension mismatch to 400', async () => {
    const { EmbeddingDimensionMismatchError } = await import(
      '../services/rag/embedding-models.js'
    );
    createMock.mockRejectedValueOnce(
      new EmbeddingDimensionMismatchError('openai/text-embedding-3-small', 1536, 1024),
    );
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/corpora',
      headers: { authorization: 'Bearer app-key' },
      payload: { name: 'policies', embeddingModel: 'openai/text-embedding-3-small' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 401 with no bearer token', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/v1/corpora', payload: { name: 'x' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /v1/corpora', () => {
  it('lists the caller-scoped corpora', async () => {
    listMock.mockResolvedValueOnce([SAMPLE]);
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/corpora',
      headers: { authorization: 'Bearer app-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ corpora: [SAMPLE] });
    expect(listMock).toHaveBeenCalledWith({ org: 'acme', project: 'chat' });
    await app.close();
  });
});

describe('GET /v1/corpora/:name', () => {
  it('returns the introspection view', async () => {
    getMock.mockResolvedValueOnce(SAMPLE);
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/corpora/policies',
      headers: { authorization: 'Bearer app-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SAMPLE);
    expect(getMock).toHaveBeenCalledWith('policies', { org: 'acme', project: 'chat' });
    await app.close();
  });

  it('returns 404 CORPUS_NOT_FOUND when absent', async () => {
    getMock.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/corpora/missing',
      headers: { authorization: 'Bearer app-key' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CORPUS_NOT_FOUND');
    await app.close();
  });
});

describe('PATCH /v1/corpora/:name', () => {
  it('reconfigures and returns the updated view', async () => {
    updateMock.mockResolvedValueOnce({ ...SAMPLE, chunkSize: 1200, updatedAt: '2026-02-02T00:00:00.000Z' });
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/corpora/policies',
      headers: { authorization: 'Bearer app-key' },
      payload: { chunkSize: 1200 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().chunkSize).toBe(1200);
    const [name, patch, ctx] = updateMock.mock.calls[0]!;
    expect(name).toBe('policies');
    expect(patch).toEqual({ chunkSize: 1200 });
    expect(ctx).toEqual({ org: 'acme', project: 'chat' });
    await app.close();
  });

  it('rejects an empty patch body with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/corpora/policies',
      headers: { authorization: 'Bearer app-key' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('maps EMBEDDING_MODEL_LOCKED to 409', async () => {
    const { EmbeddingModelChangeNotAllowedError } = await import(
      '../services/rag/corpus-crud.js'
    );
    updateMock.mockRejectedValueOnce(new EmbeddingModelChangeNotAllowedError('policies'));
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/corpora/policies',
      headers: { authorization: 'Bearer app-key' },
      payload: { embeddingModel: 'openai/text-embedding-3-large' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMBEDDING_MODEL_LOCKED');
    await app.close();
  });

  it('maps CHUNK_SIZE_LOCKED to 409', async () => {
    const { ChunkSizeShrinkNotAllowedError } = await import('../services/rag/corpus-crud.js');
    updateMock.mockRejectedValueOnce(new ChunkSizeShrinkNotAllowedError('policies', 800, 200));
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/corpora/policies',
      headers: { authorization: 'Bearer app-key' },
      payload: { chunkSize: 200 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHUNK_SIZE_LOCKED');
    await app.close();
  });

  it('maps CORPUS_NOT_FOUND to 404', async () => {
    const { CorpusNotFoundError } = await import('../services/rag/corpus-crud.js');
    updateMock.mockRejectedValueOnce(new CorpusNotFoundError({ corpus: 'missing' }));
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/corpora/missing',
      headers: { authorization: 'Bearer app-key' },
      payload: { chunkSize: 900 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CORPUS_NOT_FOUND');
    await app.close();
  });
});

describe('DELETE /v1/corpora/:name', () => {
  it('returns 200 with counts on the happy path', async () => {
    deleteMock.mockResolvedValueOnce({
      matched: true,
      deleted: { chunks: 5, documents: 2, corpora: 1 },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpora/policies',
      headers: { authorization: 'Bearer app-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: { chunks: 5, documents: 2, corpora: 1 } });
    expect(deleteMock).toHaveBeenCalledWith('policies', { org: 'acme', project: 'chat' });
    await app.close();
  });

  it('returns 404 CORPUS_NOT_FOUND when nothing matched', async () => {
    deleteMock.mockResolvedValueOnce({
      matched: false,
      deleted: { chunks: 0, documents: 0, corpora: 0 },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpora/missing',
      headers: { authorization: 'Bearer app-key' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CORPUS_NOT_FOUND');
    await app.close();
  });
});
