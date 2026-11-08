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

const { callOpenRouterEmbedding, OpenRouterEmbeddingHttpError, OpenRouterEmbeddingNoZdrEndpointError } = await import(
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

// `EMBEDDINGS_API_KEY` lets a non-OpenRouter `EMBEDDINGS_URL` (e.g. a
// self-hosted llama.cpp bge-m3) get its own token, so the OpenRouter key is
// never sent to a third-party host. Unset ⇒ behaviour is unchanged.
describe('callOpenRouterEmbedding — EMBEDDINGS_API_KEY resolution', () => {
  async function authHeaderWith(
    envKeys: { EMBEDDINGS_API_KEY?: string; OPENROUTER_API_KEY?: string },
    apiKey?: string,
  ): Promise<string> {
    vi.resetModules();
    vi.doMock('../router/task-profiles.js', () => ({ priceForEmbedding: () => 0 }));
    vi.doMock('../../../config/env.js', () => ({
      env: {
        OPENAI_API_KEY: undefined,
        EMBEDDINGS_URL: 'https://embeddings.example.test/v1/embeddings',
        EMBEDDING_MODEL: 'baai/bge-m3',
        EMBEDDING_DIM: 1024,
        ...envKeys,
      },
    }));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      makeResponse({ ok: true, status: 200, body: { data: [{ index: 0, embedding: [0.1] }] } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const mod = await import('./openrouter.js');
      await mod.callOpenRouterEmbedding({ model: 'baai/bge-m3', input: 'x', apiKey });
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      return (init.headers as Record<string, string>).Authorization!;
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock('../router/task-profiles.js');
      vi.doUnmock('../../../config/env.js');
    }
  }

  it('sends EMBEDDINGS_API_KEY instead of OPENROUTER_API_KEY when set', async () => {
    expect(
      await authHeaderWith({ EMBEDDINGS_API_KEY: 'embed-key', OPENROUTER_API_KEY: 'or-key' }),
    ).toBe('Bearer embed-key');
  });

  it('falls back to OPENROUTER_API_KEY when EMBEDDINGS_API_KEY is unset', async () => {
    expect(await authHeaderWith({ OPENROUTER_API_KEY: 'or-key' })).toBe('Bearer or-key');
  });

  it('treats an empty EMBEDDINGS_API_KEY as unset', async () => {
    expect(
      await authHeaderWith({ EMBEDDINGS_API_KEY: '', OPENROUTER_API_KEY: 'or-key' }),
    ).toBe('Bearer or-key');
  });

  it('an explicit opts.apiKey still wins over EMBEDDINGS_API_KEY', async () => {
    expect(
      await authHeaderWith({ EMBEDDINGS_API_KEY: 'embed-key', OPENROUTER_API_KEY: 'or-key' }, 'inline'),
    ).toBe('Bearer inline');
  });
});

// Hosted fallback: `EMBEDDINGS_FALLBACK_URL` takes over when the primary
// (e.g. a self-hosted bge-m3 over a VPN) is unreachable, slow, 5xx or 429.
describe('callOpenRouterEmbedding — EMBEDDINGS_FALLBACK_URL', () => {
  const PRIMARY = 'https://gpu-box.vpn.test/v1/embeddings';
  const FALLBACK = 'https://openrouter.ai/api/v1/embeddings';
  const okBody = { data: [{ index: 0, embedding: [0.5] }], usage: { prompt_tokens: 1 } };
  const warnMock = vi.fn();

  type Mod = typeof import('./openrouter.js');

  async function load(envOver: Record<string, unknown> = {}): Promise<Mod> {
    vi.resetModules();
    vi.doMock('../router/task-profiles.js', () => ({ priceForEmbedding: () => 0 }));
    vi.doMock('../../../logger.js', () => ({
      rootLogger: { warn: warnMock, info: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../../../config/env.js', () => ({
      env: {
        OPENAI_API_KEY: undefined,
        OPENROUTER_API_KEY: 'or-key',
        EMBEDDINGS_API_KEY: 'primary-key',
        EMBEDDINGS_URL: PRIMARY,
        EMBEDDINGS_FALLBACK_URL: FALLBACK,
        EMBEDDINGS_FALLBACK_COOLDOWN_S: 60,
        EMBEDDINGS_PRIMARY_TIMEOUT_MS: 50,
        EMBEDDING_MODEL: 'baai/bge-m3',
        EMBEDDING_DIM: 1024,
        ...envOver,
      },
    }));
    return import('./openrouter.js');
  }

  function call(mod: Mod, signal?: AbortSignal) {
    return mod.callOpenRouterEmbedding({
      model: 'baai/bge-m3',
      input: 'x',
      ...(signal ? { signal } : {}),
    });
  }

  function calls(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.map(([url, init]) => {
      const i = init as RequestInit;
      return {
        url: url as string,
        auth: (i.headers as Record<string, string>).Authorization,
        model: (JSON.parse(i.body as string) as { model: string }).model,
      };
    });
  }

  function connRefused(): Error {
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:8080'), {
      code: 'ECONNREFUSED',
    });
    return new TypeError('fetch failed', { cause });
  }

  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    warnMock.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.doUnmock('../router/task-profiles.js');
    vi.doUnmock('../../../logger.js');
    vi.doUnmock('../../../config/env.js');
  });

  it('falls back on ECONNREFUSED, same model, keys never cross', async () => {
    const mod = await load();
    fetchMock
      .mockRejectedValueOnce(connRefused())
      .mockResolvedValueOnce(makeResponse({ ok: true, status: 200, body: okBody }));

    const res = await call(mod);

    expect(res.servedBy).toBe('fallback');
    expect(mod.embeddingProviderLabel(res)).toBe('embeddings-fallback');
    expect(calls(fetchMock)).toEqual([
      { url: PRIMARY, auth: 'Bearer primary-key', model: 'baai/bge-m3' },
      { url: FALLBACK, auth: 'Bearer or-key', model: 'baai/bge-m3' },
    ]);
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [logObj] = warnMock.mock.calls[0]! as [Record<string, unknown>];
    expect(logObj.reason).toBe('network_ECONNREFUSED');
    expect(JSON.stringify(warnMock.mock.calls)).not.toMatch(/primary-key|or-key|"x"/);
  });

  it('uses EMBEDDINGS_FALLBACK_API_KEY for the fallback only', async () => {
    const mod = await load({ EMBEDDINGS_FALLBACK_API_KEY: 'fb-key' });
    fetchMock
      .mockResolvedValueOnce(makeResponse({ ok: false, status: 503, body: 'upstream down' }))
      .mockResolvedValueOnce(makeResponse({ ok: true, status: 200, body: okBody }));

    await call(mod);

    expect(calls(fetchMock).map((c) => c.auth)).toEqual(['Bearer primary-key', 'Bearer fb-key']);
  });

  it.each([503, 429])('falls back on HTTP %i', async (status) => {
    const mod = await load();
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ ok: false, status, body: { error: { message: 'busy' } } }),
      )
      .mockResolvedValueOnce(makeResponse({ ok: true, status: 200, body: okBody }));

    const res = await call(mod);

    expect(res.servedBy).toBe('fallback');
    expect(calls(fetchMock).map((c) => c.url)).toEqual([PRIMARY, FALLBACK]);
    expect((warnMock.mock.calls[0]![0] as { reason: string }).reason).toBe(`http_${status}`);
  });

  it('falls back when the primary exceeds EMBEDDINGS_PRIMARY_TIMEOUT_MS', async () => {
    const mod = await load();
    fetchMock
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
          }),
      )
      .mockResolvedValueOnce(makeResponse({ ok: true, status: 200, body: okBody }));

    const res = await call(mod);

    expect(res.servedBy).toBe('fallback');
    expect((warnMock.mock.calls[0]![0] as { reason: string }).reason).toBe('timeout');
  });

  it('does NOT fall back on 401 (config bugs surface)', async () => {
    const mod = await load();
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 401, body: { error: { message: 'bad key' } } }),
    );

    await expect(call(mod)).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('does NOT fall back when the caller aborted', async () => {
    const mod = await load();
    const ctrl = new AbortController();
    fetchMock.mockImplementationOnce(() => {
      ctrl.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });

    await expect(call(mod, ctrl.signal)).rejects.toThrow('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the primary during the cooldown, then probes it again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
    const mod = await load();
    fetchMock
      .mockRejectedValueOnce(connRefused())
      .mockResolvedValue(makeResponse({ ok: true, status: 200, body: okBody }));

    await call(mod); // primary fails → fallback; circuit opens
    vi.setSystemTime(new Date('2026-10-21T00:00:59Z'));
    const during = await call(mod); // inside the 60 s cooldown → straight to fallback
    vi.setSystemTime(new Date('2026-10-21T00:01:01Z'));
    const after = await call(mod); // cooldown over → primary probed, succeeds

    expect(calls(fetchMock).map((c) => c.url)).toEqual([PRIMARY, FALLBACK, FALLBACK, PRIMARY]);
    expect(during.servedBy).toBe('fallback');
    expect(after.servedBy).toBe('primary');
    expect(mod.embeddingProviderLabel(after)).toBe('openrouter');
    expect(calls(fetchMock)[2]!.auth).toBe('Bearer or-key');
    expect(calls(fetchMock)[3]!.auth).toBe('Bearer primary-key');
  });

  it('unset EMBEDDINGS_FALLBACK_URL → no fallback, no timeout, error surfaces', async () => {
    const mod = await load({ EMBEDDINGS_FALLBACK_URL: undefined });
    fetchMock.mockRejectedValueOnce(connRefused());

    await expect(call(mod)).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The caller's own signal (none here), not a timeout-wrapped one.
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBeUndefined();
    expect(warnMock).not.toHaveBeenCalled();
  });
});

// Zero Data Retention: always requested from OpenRouter, fail-closed when no
// ZDR endpoint serves the model.
describe('callOpenRouterEmbedding — Zero Data Retention', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const okBody = { data: [{ index: 0, embedding: [0.5] }], usage: { prompt_tokens: 1 } };
  const sentBody = (i = 0): Record<string, unknown> =>
    JSON.parse((fetchMock.mock.calls[i]![1] as RequestInit).body as string) as Record<string, unknown>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    priceForEmbeddingMock.mockReset();
    priceForEmbeddingMock.mockReturnValue(0);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends provider.zdr = true to OpenRouter', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ ok: true, status: 200, body: okBody }));
    await callOpenRouterEmbedding({ model: 'baai/bge-m3', input: 'x', apiKey: 'k' });
    expect(sentBody().provider).toEqual({ zdr: true });
  });

  it('no ZDR endpoint → typed error, exactly one request, never re-sent without zdr', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: false,
        status: 404,
        body: { error: { message: 'No endpoints found matching your data policy', code: 404 } },
      }),
    );
    const err = await callOpenRouterEmbedding({ model: 'baai/bge-m3', input: 'x', apiKey: 'k' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OpenRouterEmbeddingNoZdrEndpointError);
    expect(err).toBeInstanceOf(OpenRouterEmbeddingHttpError);
    expect((err as Error).message).toMatch(/No Zero Data Retention endpoint/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody().provider).toEqual({ zdr: true });
  });

  it('sends no provider block to a non-OpenRouter EMBEDDINGS_URL', async () => {
    vi.resetModules();
    vi.doMock('../router/task-profiles.js', () => ({ priceForEmbedding: () => 0 }));
    vi.doMock('../../../config/env.js', () => ({
      env: { EMBEDDINGS_URL: 'https://gpu-box.vpn.test/v1/embeddings', EMBEDDING_MODEL: 'baai/bge-m3' },
    }));
    try {
      const mod = await import('./openrouter.js');
      fetchMock.mockResolvedValueOnce(makeResponse({ ok: true, status: 200, body: okBody }));
      await mod.callOpenRouterEmbedding({ model: 'baai/bge-m3', input: 'x', apiKey: 'k' });
      expect(sentBody().provider).toBeUndefined();
    } finally {
      vi.doUnmock('../router/task-profiles.js');
      vi.doUnmock('../../../config/env.js');
    }
  });
});
