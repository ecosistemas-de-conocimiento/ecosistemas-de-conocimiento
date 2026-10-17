// `client.admin.deleteDocument` — DELETE /v1/corpus/:name/documents/:externalId.

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
