// Unit tests for the OpenRouter HTTP adapter.
//
// Mocks `fetch` globally (no network). Mocks `../task-profiles.js` so this
// suite is independent of the pricing-table module (which lands in parallel).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../types.js';

const priceForUsageMock = vi.fn<(model: string, inTok: number, outTok: number) => number>();

vi.mock('../task-profiles.js', () => ({
  priceForUsage: (...args: [string, number, number]) => priceForUsageMock(...args),
}));

vi.mock('../../../../config/env.js', () => ({
  // Stall backstop off by default so the existing streaming tests are
  // unaffected; the stall-specific test overrides it on the mocked env object.
  env: { OPENROUTER_API_KEY: 'env-fallback-key', LLM_STREAM_STALL_TIMEOUT_MS: 0 },
}));

// Import after mocks are set so the adapter binds to them.
const { callOpenRouter, OpenRouterHttpError, streamingCallOpenRouter } = await import('./openrouter.js');

function makeResponse(opts: { ok: boolean; status: number; body: unknown }): Response {
  const text = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  return {
    ok: opts.ok,
    status: opts.status,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

/**
 * Build a streaming Response whose body replays OpenRouter-style SSE `data:`
 * chunks (`choices[0].delta.content` per token, a usage frame, then `[DONE]`).
 */
function makeStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const baseMessages: ChatMessage[] = [
  { role: 'system', content: 'be concise' },
  { role: 'user', content: 'hello' },
];

describe('callOpenRouter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    priceForUsageMock.mockReset();
    priceForUsageMock.mockReturnValue(0.0042);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends correctly-shaped request body and headers', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          id: 'gen-1',
          model: 'anthropic/claude-3.7-sonnet',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi back' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0013 },
        },
      }),
    );

    await callOpenRouter({
      model: 'anthropic/claude-3.7-sonnet',
      messages: baseMessages,
      maxTokens: 1024,
      temperature: 0.4,
      apiKey: 'inline-key',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer inline-key');
    expect(headers['X-Title']).toMatch(/ai-service/);

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'anthropic/claude-3.7-sonnet',
      messages: baseMessages,
      max_tokens: 1024,
      temperature: 0.4,
      usage: { include: true },
    });
  });

  it('falls back to env.OPENROUTER_API_KEY when apiKey omitted', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'm',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 },
        },
      }),
    );

    await callOpenRouter({
      model: 'm',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer env-fallback-key');
  });

  it('parses content, finishReason, and usage from response', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          id: 'gen-2',
          model: 'openai/gpt-4o',
          choices: [
            { message: { content: 'final answer' }, finish_reason: 'length' },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0099 },
        },
      }),
    );

    const out = await callOpenRouter({
      model: 'openai/gpt-4o',
      messages: baseMessages,
      maxTokens: 256,
      temperature: 0.7,
      apiKey: 'k',
    });

    expect(out.contentText).toBe('final answer');
    expect(out.finishReason).toBe('length');
    expect(out.model).toBe('openai/gpt-4o');
    expect(out.usage.promptTokens).toBe(100);
    expect(out.usage.completionTokens).toBe(50);
    expect(out.rawId).toBe('gen-2');
  });

  it('uses usage.cost when present and tags costSource = openrouter', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'm',
          choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 7, cost: 0.0021 },
        },
      }),
    );

    const out = await callOpenRouter({
      model: 'm',
      messages: baseMessages,
      maxTokens: 50,
      temperature: 0,
      apiKey: 'k',
    });

    expect(out.usage.costUsd).toBe(0.0021);
    expect(out.usage.costSource).toBe('openrouter');
    expect(priceForUsageMock).not.toHaveBeenCalled();
  });

  it('falls back to priceForUsage when usage.cost is missing', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'm-no-cost',
          choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        },
      }),
    );

    const out = await callOpenRouter({
      model: 'm-no-cost',
      messages: baseMessages,
      maxTokens: 50,
      temperature: 0,
      apiKey: 'k',
    });

    expect(priceForUsageMock).toHaveBeenCalledWith('m-no-cost', 12, 7);
    expect(out.usage.costUsd).toBe(0.0042);
    expect(out.usage.costSource).toBe('pricing-table');
  });

  it('falls back to priceForUsage when usage.cost is not a finite number', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'm',
          choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5, cost: 'oops' },
        },
      }),
    );

    const out = await callOpenRouter({
      model: 'm',
      messages: baseMessages,
      maxTokens: 50,
      temperature: 0,
      apiKey: 'k',
    });

    expect(out.usage.costSource).toBe('pricing-table');
    expect(priceForUsageMock).toHaveBeenCalled();
  });

  it('throws OpenRouterHttpError with status on HTTP 4xx with error envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: false,
        status: 429,
        body: { error: { code: 'rate_limited', message: 'slow down' } },
      }),
    );

    await expect(
      callOpenRouter({
        model: 'm',
        messages: baseMessages,
        maxTokens: 50,
        temperature: 0,
        apiKey: 'k',
      }),
    ).rejects.toMatchObject({
      name: 'OpenRouterHttpError',
      status: 429,
      code: 'rate_limited',
    });
  });

  it('throws OpenRouterHttpError with status on HTTP 5xx', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 502, body: '' }),
    );

    const err = await callOpenRouter({
      model: 'm',
      messages: baseMessages,
      maxTokens: 50,
      temperature: 0,
      apiKey: 'k',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenRouterHttpError);
    expect((err as InstanceType<typeof OpenRouterHttpError>).status).toBe(502);
  });

  it('throws OpenRouterHttpError on non-JSON body', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: true, status: 200, body: '<html>nope</html>' }),
    );

    await expect(
      callOpenRouter({
        model: 'm',
        messages: baseMessages,
        maxTokens: 50,
        temperature: 0,
        apiKey: 'k',
      }),
    ).rejects.toBeInstanceOf(OpenRouterHttpError);
  });

  it('forwards AbortSignal to fetch', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'm',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 },
        },
      }),
    );

    const ctrl = new AbortController();
    await callOpenRouter({
      model: 'm',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
      signal: ctrl.signal,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.signal).toBe(ctrl.signal);
  });

  it('includes models[] and response_format when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'm',
          choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 },
        },
      }),
    );

    await callOpenRouter({
      model: 'm',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
      models: ['fallback-a', 'fallback-b'],
      responseFormat: { type: 'json_object' },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.models).toEqual(['fallback-a', 'fallback-b']);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('omits usage.include when includeUsage is false', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: {
          model: 'm',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      }),
    );

    await callOpenRouter({
      model: 'm',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
      includeUsage: false,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.usage).toBeUndefined();
  });
});

describe('streamingCallOpenRouter onDelta', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    priceForUsageMock.mockReset();
    priceForUsageMock.mockReturnValue(0.001);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('invokes onDelta for each token chunk in order and returns the joined text', async () => {
    fetchMock.mockResolvedValueOnce(
      makeStreamResponse([
        'data: {"model":"m","choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":3,"cost":0.005}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const deltas: string[] = [];
    const completion = await streamingCallOpenRouter({
      model: 'm',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
      onDelta: (t) => deltas.push(t),
    });

    expect(deltas).toEqual(['Hel', 'lo ', 'world']);
    expect(completion.contentText).toBe('Hello world');
    expect(completion.finishReason).toBe('stop');
    expect(completion.usage.completionTokens).toBe(3);
    // Cost came from the stream's usage frame, not the pricing table.
    expect(completion.usage.costSource).toBe('openrouter');
    expect(completion.usage.costUsd).toBe(0.005);
  });

  it('aborts a stalled stream after LLM_STREAM_STALL_TIMEOUT_MS and throws AbortError', async () => {
    // Re-import env (the mocked object) and arm a tiny stall window.
    const { env } = (await import('../../../../config/env.js')) as unknown as {
      env: { LLM_STREAM_STALL_TIMEOUT_MS?: number };
    };
    const prev = env.LLM_STREAM_STALL_TIMEOUT_MS;
    env.LLM_STREAM_STALL_TIMEOUT_MS = 25;

    try {
      // A body that emits ONE frame then stalls forever — until the fetch
      // signal (the adapter's internal stall controller) fires, at which point
      // the reader rejects with an AbortError, mirroring undici's behaviour.
      const makeStallingResponse = (signal: AbortSignal): Response => {
        const encoder = new TextEncoder();
        let emitted = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!emitted) {
              emitted = true;
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
              );
              return;
            }
            // Stall: resolve nothing until the signal aborts the request.
            return new Promise<void>((_resolve, reject) => {
              const onAbort = (): void => {
                const err = new Error('aborted') as Error & { name: string };
                err.name = 'AbortError';
                controller.error(err);
                reject(err);
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener('abort', onAbort, { once: true });
            });
          },
        });
        return { ok: true, status: 200, body } as unknown as Response;
      };

      fetchMock.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) =>
        Promise.resolve(makeStallingResponse(init.signal)),
      );

      const deltas: string[] = [];
      const err = await streamingCallOpenRouter({
        model: 'm',
        messages: baseMessages,
        maxTokens: 10,
        temperature: 0,
        apiKey: 'k',
        onDelta: (t) => deltas.push(t),
      }).catch((e: unknown) => e);

      // One delta arrived before the stall; then the inactivity backstop fired.
      expect(deltas).toEqual(['hi']);
      expect((err as Error)?.name).toBe('AbortError');
    } finally {
      env.LLM_STREAM_STALL_TIMEOUT_MS = prev;
    }
  });

  it('omitting onDelta still returns the full completion (no-op callback)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeStreamResponse([
        'data: {"model":"m","choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const completion = await streamingCallOpenRouter({
      model: 'm',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
    });

    expect(completion.contentText).toBe('hi');
  });
});
