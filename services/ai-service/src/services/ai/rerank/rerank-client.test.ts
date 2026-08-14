// Unit tests for the rerank HTTP client. `env` and `fetch` are both mocked so
// the test controls RERANK_URL and the wire response without a real network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable env stand-in — callRerank reads `env.RERANK_URL` at call time.
// `vi.hoisted` so the object exists before the hoisted `vi.mock` factory runs.
const envMock = vi.hoisted(() => ({ RERANK_URL: 'http://rerank.test/rerank' as string | undefined }));
vi.mock('../../../config/env.js', () => ({ env: envMock }));

import { callRerank, RerankHttpError, RerankNotConfiguredError } from './rerank-client.js';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('callRerank', () => {
  beforeEach(() => {
    envMock.RERANK_URL = 'http://rerank.test/rerank';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('POSTs the Cohere-style body and parses {index, relevance_score}', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) =>
      jsonResponse({
        model: 'baai/bge-reranker-v2-m3',
        results: [
          { index: 2, relevance_score: 0.98 },
          { index: 0, relevance_score: 0.4 },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await callRerank({
      model: 'baai/bge-reranker-v2-m3',
      query: 'section 47 duties',
      documents: ['a', 'b', 'c'],
      topN: 2,
    });

    expect(out.results).toEqual([
      { index: 2, relevanceScore: 0.98 },
      { index: 0, relevanceScore: 0.4 },
    ]);
    expect(out.model).toBe('baai/bge-reranker-v2-m3');
    expect(out.usage.estimatedCostUsd).toBe(0);

    // The wire body is the industry-standard shape: query, documents, top_n.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://rerank.test/rerank');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: 'baai/bge-reranker-v2-m3',
      query: 'section 47 duties',
      documents: ['a', 'b', 'c'],
      top_n: 2,
    });
  });

  it('tolerates relevanceScore / score field aliases and drops malformed rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          results: [
            { index: 0, relevanceScore: 0.9 },
            { index: 1, score: 0.5 },
            { index: 2 }, // no score ⇒ dropped
          ],
        }),
      ),
    );
    const out = await callRerank({ model: 'm', query: 'q', documents: ['a', 'b', 'c'] });
    expect(out.results).toEqual([
      { index: 0, relevanceScore: 0.9 },
      { index: 1, relevanceScore: 0.5 },
    ]);
  });

  it('short-circuits with no fetch when documents is empty', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await callRerank({ model: 'm', query: 'q', documents: [] });
    expect(out.results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws RerankNotConfiguredError when RERANK_URL is unset', async () => {
    envMock.RERANK_URL = undefined;
    await expect(
      callRerank({ model: 'm', query: 'q', documents: ['a'] }),
    ).rejects.toBeInstanceOf(RerankNotConfiguredError);
  });

  it('throws RerankHttpError on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'boom', code: 503 } }, { ok: false, status: 503 })),
    );
    await expect(
      callRerank({ model: 'm', query: 'q', documents: ['a'] }),
    ).rejects.toBeInstanceOf(RerankHttpError);
  });

  it('throws RerankHttpError on non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>gateway</html>',
    }) as unknown as Response));
    await expect(
      callRerank({ model: 'm', query: 'q', documents: ['a'] }),
    ).rejects.toBeInstanceOf(RerankHttpError);
  });
});
