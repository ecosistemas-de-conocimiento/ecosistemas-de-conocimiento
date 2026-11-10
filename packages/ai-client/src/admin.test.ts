// `client.admin.deleteDocument` — DELETE /v1/corpus/:name/documents/:externalId.
// `client.admin.setDocumentTitles` — PATCH /v1/corpus/:name/titles.

import { describe, expect, it, vi } from 'vitest';

import { AIClient, NotFoundError } from './index.js';

function clientWith(fetchImpl: unknown): AIClient {
  return new AIClient({ baseUrl: 'http://service.local', apiKey: 'tok', fetch: fetchImpl as typeof fetch });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('admin.deleteDocument', () => {
  it('DELETEs the encoded document path and returns the two counters', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { deleted: { chunks: 3, documents: 1 } }));
    const res = await clientWith(fetchImpl).admin.deleteDocument('org-1/thread 2', 'doc-42');
    expect(res).toEqual({ deleted: { chunks: 3, documents: 1 } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://service.local/v1/corpus/org-1%2Fthread%202/documents/doc-42');
    expect((init as RequestInit).method).toBe('DELETE');
    expect(new Headers((init as RequestInit).headers).get('authorization')).toBe('Bearer tok');
  });

  it('surfaces a 404 DOCUMENT_NOT_FOUND as NotFoundError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json(404, { error: { code: 'DOCUMENT_NOT_FOUND', message: "document 'x' not found" } }),
    );
    await expect(clientWith(fetchImpl).admin.deleteDocument('c', 'x')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('admin.setDocumentTitles', () => {
  it('PATCHes the encoded corpus path with the batch and dryRun', async () => {
    const body = { dryRun: true, documents: [], notFound: ['x'] };
    const fetchImpl = vi.fn().mockResolvedValue(json(200, body));
    const docs = [{ externalId: 'x', title: 'T' }];
    const res = await clientWith(fetchImpl).admin.setDocumentTitles('eco 1', docs, { dryRun: true });
    expect(res).toEqual(body);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://service.local/v1/corpus/eco%201/titles');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ documents: docs, dryRun: true });
  });

  it('surfaces a 404 CORPUS_NOT_FOUND as NotFoundError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json(404, { error: { code: 'CORPUS_NOT_FOUND', message: "corpus 'c' not found" } }),
    );
    await expect(
      clientWith(fetchImpl).admin.setDocumentTitles('c', [{ externalId: 'x', title: 'T' }]),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
