// Unit tests for the OpenRouter embedding adapter.
//
// Mocks `fetch` globally (no network). Mocks `../router/task-profiles.js` so
// this suite is decoupled from the price-table contents.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const priceForEmbeddingMock = vi.fn<(model: string, inTok: number) => number>();

vi.mock('../router/task-profiles.js', () => ({
  priceForEmbedding: (...args: [string, number]) => priceForEmbeddingMock(...args),
}));

vi.mock('../../../config/env.js', () => ({
  env: {
    OPENROUTER_API_KEY: 'env-fallback-key',
    OPENAI_API_KEY: undefined,
    EMBEDDINGS_URL: 'https://openrouter.ai/api/v1/embeddings',
    EMBEDDING_MODEL: 'baai/bge-m3',
    EMBEDDING_DIM: 1024,
  },
}));

const { callOpenRouterEmbedding, OpenRouterEmbeddingHttpError } = await import(
  './openrouter.js'
);

function makeResponse(opts: { ok: boolean; status: number; body: unknown }): Response {
  const text = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  return {
    ok: opts.ok,
    status: opts.status,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

describe('callOpenRouterEmbedding', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    priceForEmbeddingMock.mockReset();
    priceForEmbeddingMock.mockReturnValue(0.00002);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends correctly-shaped request body and headers for a single string input', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'openai/text-embedding-3-small',
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
          usage: { prompt_tokens: 7, total_tokens: 7 },
        },
      }),
    );

    await callOpenRouterEmbedding({
      model: 'openai/text-embedding-3-small',
      input: 'hello world',
      apiKey: 'inline-key',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/embeddings');
    const initObj = init as RequestInit;
    expect(initObj.method).toBe('POST');
    const headers = initObj.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer inline-key');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(initObj.body as string) as Record<string, unknown>;
    expect(body.model).toBe('openai/text-embedding-3-small');
    expect(body.input).toBe('hello world');
  });

  it('passes through an array of inputs unchanged', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'openai/text-embedding-3-small',
          data: [
            { index: 0, embedding: [0.1] },
            { index: 1, embedding: [0.2] },
          ],
          usage: { prompt_tokens: 4 },
        },
      }),
    );

    const result = await callOpenRouterEmbedding({
      model: 'openai/text-embedding-3-small',
      input: ['a', 'b'],
    });

    const initObj = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(initObj.body as string) as Record<string, unknown>;
    expect(body.input).toEqual(['a', 'b']);
    expect(result.embeddings).toEqual([[0.1], [0.2]]);
  });

  it('parses data[].embedding into a row-ordered embeddings array', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'openai/text-embedding-3-small',
          // Deliberately out-of-order; adapter must sort by `index`.
          data: [
            { index: 1, embedding: [9, 9] },
            { index: 0, embedding: [1, 1] },
          ],
          usage: { prompt_tokens: 8 },
        },
      }),
    );

    const result = await callOpenRouterEmbedding({
      model: 'openai/text-embedding-3-small',
      input: ['first', 'second'],
    });

    expect(result.embeddings).toEqual([
      [1, 1],
      [9, 9],
    ]);
  });

  it('computes cost from priceForEmbedding(model, inputTokens)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'openai/text-embedding-3-small',
          data: [{ index: 0, embedding: [0.5] }],
          usage: { prompt_tokens: 1_000_000 },
        },
      }),
    );
    priceForEmbeddingMock.mockReturnValueOnce(0.02);

    const result = await callOpenRouterEmbedding({
      model: 'openai/text-embedding-3-small',
      input: 'big',
    });

    expect(priceForEmbeddingMock).toHaveBeenCalledWith(
      'openai/text-embedding-3-small',
      1_000_000,
    );
    expect(result.usage).toEqual({ inputTokens: 1_000_000, estimatedCostUsd: 0.02 });
  });

  it('falls back to chars/4 token estimate when usage field is missing', async () => {
    // Some OpenRouter-routed embedding providers ship responses without a
    // `usage` envelope. The adapter used to return inputTokens=0 in that
    // case, silently zeroing the cost line — now we estimate from the input.
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'voyage-3',
          data: [
            { index: 0, embedding: [0.1] },
            { index: 1, embedding: [0.2] },
          ],
          // usage intentionally omitted
        },
      }),
    );
    priceForEmbeddingMock.mockReturnValueOnce(0.000123);

    const inputs = ['abcd', 'abcdefgh']; // 4 + 8 = 12 chars → ceil(12/4) = 3
    const result = await callOpenRouterEmbedding({
      model: 'voyage-3',
      input: inputs,
    });

    expect(result.usage.inputTokens).toBe(3);
    expect(result.usage.inputTokens).not.toBe(0);
    expect(priceForEmbeddingMock).toHaveBeenCalledWith('voyage-3', 3);
    expect(result.usage.estimatedCostUsd).toBeCloseTo(0.000123);
  });

  it('falls back to chars/4 when usage is present but zero-valued', async () => {
    // A provider returning `usage: { prompt_tokens: 0 }` is just as broken
    // as omitting the field — treat both the same.
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'voyage-3',
          data: [{ index: 0, embedding: [0.5] }],
          usage: { prompt_tokens: 0 },
        },
      }),
    );

    const result = await callOpenRouterEmbedding({
      model: 'voyage-3',
      input: 'hello world!', // 12 chars → 3
    });

    expect(result.usage.inputTokens).toBe(3);
  });

  it('throws OpenRouterEmbeddingHttpError on non-OK HTTP', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: false,
        status: 401,
        body: { error: { code: 'invalid_api_key', message: 'bad key' } },
      }),
    );

    await expect(
      callOpenRouterEmbedding({
        model: 'openai/text-embedding-3-small',
        input: 'x',
      }),
    ).rejects.toBeInstanceOf(OpenRouterEmbeddingHttpError);
  });

  it('throws when API key is missing from opts AND env', async () => {
    // Re-import the module with no env keys.
    vi.resetModules();
    vi.doMock('../router/task-profiles.js', () => ({
      priceForEmbedding: () => 0,
    }));
    vi.doMock('../../../config/env.js', () => ({
      env: {
        OPENROUTER_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        EMBEDDINGS_URL: 'https://openrouter.ai/api/v1/embeddings',
        EMBEDDING_MODEL: 'baai/bge-m3',
        EMBEDDING_DIM: 1024,
      },
    }));
    const mod = await import('./openrouter.js');

    await expect(
      mod.callOpenRouterEmbedding({
        model: 'openai/text-embedding-3-small',
        input: 'x',
      }),
    ).rejects.toThrow(/API key missing/);

    vi.doUnmock('../router/task-profiles.js');
    vi.doUnmock('../../../config/env.js');
  });

  it('flag-off hits the real path (calls fetch)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'openai/text-embedding-3-small',
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
          usage: { prompt_tokens: 7 },
        },
      }),
    );

    await callOpenRouterEmbedding({
      model: 'openai/text-embedding-3-small',
      input: 'hello world',
      apiKey: 'inline-key',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
