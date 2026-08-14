// Unit tests for /v1/corpus/:name (DELETE).
//
// `CorpusDeleteService.deleteCorpus` is mocked at the class level so the route
// layer is exercised in isolation: app-role auth, params plumbing (org/project
// pulled from req.auth, never the body), 404 vs. 200 shape, idempotent re-run.
// The DELETE routes are app-role (not admin) — an app-role key deleting its OWN
// tenant's corpus succeeds; isolation is enforced by the service's (org,
// project) scoping, covered in the integration tests against a real DB.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const deleteCorpusMock = vi.fn();
const deleteDocumentMock = vi.fn();

vi.mock('../services/rag/corpus-delete.js', async () => {
  const actual = await vi.importActual<typeof import('../services/rag/corpus-delete.js')>(
    '../services/rag/corpus-delete.js',
  );
  return {
    ...actual,
    CorpusDeleteService: class {
      deleteCorpus = (...args: unknown[]) => deleteCorpusMock(...args);
    },
  };
});

vi.mock('../services/rag/document-delete.js', async () => {
  const actual = await vi.importActual<typeof import('../services/rag/document-delete.js')>(
    '../services/rag/document-delete.js',
  );
  return {
    ...actual,
    DocumentDeleteService: class {
      deleteDocument = (...args: unknown[]) => deleteDocumentMock(...args);
    },
  };
});

vi.mock('../db/client.js', () => ({ db: {} }));

vi.hoisted(() => {
  process.env.API_KEYS = JSON.stringify({
    'app-key': { org: 'acme', project: 'chat', role: 'app' },
    'admin-key': { org: 'acme', project: 'chat', role: 'admin' },
  });
});

async function makeApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

beforeEach(() => {
  deleteCorpusMock.mockReset();
  deleteDocumentMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('DELETE /v1/corpus/:name', () => {
  it('allows an app-role token, scoping the delete to its (org, project)', async () => {
    deleteCorpusMock.mockResolvedValueOnce({
      matched: true,
      deleted: { chunks: 1, documents: 1, corpora: 1 },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/my-corpus',
      headers: { authorization: 'Bearer app-key' },
    });
    expect(res.statusCode).toBe(200);
    // The org/project come from the app key's req.auth, never the request body.
    expect(deleteCorpusMock).toHaveBeenCalledWith('my-corpus', {
      org: 'acme',
      project: 'chat',
    });
    await app.close();
  });

  it('returns 401 with no bearer token', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/my-corpus',
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 200 with deletion counts on the happy path', async () => {
    deleteCorpusMock.mockResolvedValueOnce({
      matched: true,
      deleted: { chunks: 12, documents: 4, corpora: 1 },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/my-corpus',
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ deleted: { chunks: 12, documents: 4, corpora: 1 } });
    expect(deleteCorpusMock).toHaveBeenCalledWith('my-corpus', {
      org: 'acme',
      project: 'chat',
    });
    await app.close();
  });

  it('returns 404 with CORPUS_NOT_FOUND when no corpus matched', async () => {
    deleteCorpusMock.mockResolvedValueOnce({
      matched: false,
      deleted: { chunks: 0, documents: 0, corpora: 0 },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/missing',
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('CORPUS_NOT_FOUND');
    await app.close();
  });

  it('returns 404 on idempotent re-issue (per route contract)', async () => {
    // The route's contract is: 200 on the first successful delete, 404 on a
    // second delete since the row is already gone. Tested by sequencing the
    // mock returns — the second call sees `matched: false`.
    deleteCorpusMock.mockResolvedValueOnce({
      matched: true,
      deleted: { chunks: 3, documents: 1, corpora: 1 },
    });
    deleteCorpusMock.mockResolvedValueOnce({
      matched: false,
      deleted: { chunks: 0, documents: 0, corpora: 0 },
    });
    const app = await makeApp();
    const first = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/twice',
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/twice',
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(second.statusCode).toBe(404);
    expect(deleteCorpusMock).toHaveBeenCalledTimes(2);
    await app.close();
  });
});

describe('DELETE /v1/corpus/:name/documents/:externalId', () => {
  it('allows an app-role token, scoping the delete to its (org, project)', async () => {
    deleteDocumentMock.mockResolvedValueOnce({
      notFound: null,
      deleted: { chunks: 2, documents: 1 },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/my-corpus/documents/doc-42',
      headers: { authorization: 'Bearer app-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(deleteDocumentMock).toHaveBeenCalledWith('my-corpus', 'doc-42', {
      org: 'acme',
      project: 'chat',
    });
    await app.close();
  });

  it('returns 401 with no bearer token', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/my-corpus/documents/doc-42',
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 200 with deletion counts on the happy path', async () => {
    deleteDocumentMock.mockResolvedValueOnce({
      notFound: null,
      deleted: { chunks: 7, documents: 1 },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/my-corpus/documents/doc-42',
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: { chunks: 7, documents: 1 } });
    expect(deleteDocumentMock).toHaveBeenCalledWith('my-corpus', 'doc-42', {
      org: 'acme',
      project: 'chat',
    });
    await app.close();
  });

  it('returns 404 CORPUS_NOT_FOUND when the corpus is missing', async () => {
    deleteDocumentMock.mockResolvedValueOnce({
      notFound: 'corpus',
      deleted: { chunks: 0, documents: 0 },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/missing/documents/doc-42',
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CORPUS_NOT_FOUND');
    await app.close();
  });

  it('returns 404 DOCUMENT_NOT_FOUND when the document is missing', async () => {
    deleteDocumentMock.mockResolvedValueOnce({
      notFound: 'document',
      deleted: { chunks: 0, documents: 0 },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/corpus/my-corpus/documents/doc-does-not-exist',
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('DOCUMENT_NOT_FOUND');
    await app.close();
  });
});
