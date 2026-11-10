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
  env: {
    OPENROUTER_API_KEY: 'env-fallback-key',
    LLM_STREAM_STALL_TIMEOUT_MS: 0,
    CHAT_COMPLETIONS_URL: 'https://openrouter.ai/api/v1/chat/completions',
  },
}));

// Import after mocks are set so the adapter binds to them.
const {
  callOpenRouter,
  OpenRouterAbortError,
  OpenRouterHttpError,
  OpenRouterNoZdrEndpointError,
  streamingCallOpenRouter,
} = await import('./openrouter.js');

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

  it('a stall rejected with the REAL fetch reason (TimeoutError) still carries the partial', async () => {
    // Real undici rejects `reader.read()` with `signal.reason` — the stall
    // controller's `TimeoutError` DOMException — not with an `AbortError`.
    // The sibling test above mocks an `AbortError`, which hid that a real
    // stall left the adapter as a bare TimeoutError: no partial, a 500 upstream.
    const { env } = (await import('../../../../config/env.js')) as unknown as {
      env: { LLM_STREAM_STALL_TIMEOUT_MS?: number };
    };
    const prev = env.LLM_STREAM_STALL_TIMEOUT_MS;
    env.LLM_STREAM_STALL_TIMEOUT_MS = 25;
    try {
      fetchMock.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => {
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
            return new Promise<void>((_resolve, reject) => {
              const onAbort = (): void => {
                controller.error(init.signal.reason);
                reject(init.signal.reason as Error);
              };
              if (init.signal.aborted) onAbort();
              else init.signal.addEventListener('abort', onAbort, { once: true });
            });
          },
        });
        return Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
      });

      const err = await streamingCallOpenRouter({
        model: 'm',
        messages: baseMessages,
        maxTokens: 10,
        temperature: 0,
        apiKey: 'k',
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(OpenRouterAbortError);
      expect((err as InstanceType<typeof OpenRouterAbortError>).partial.contentText).toBe('hi');
      expect(((err as { cause?: Error }).cause as Error)?.name).toBe('TimeoutError');
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

// OpenRouter's generation id (`gen-…`) — the body's top-level `id`, on every
// stream chunk. The router stores it on the trace (`metadata.providerGenerationId`)
// so a charge can be reconciled against OpenRouter's own record of the call.
describe('streamingCallOpenRouter — provider generation id', () => {
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

  it('returns the stream chunk id as rawId', async () => {
    fetchMock.mockResolvedValueOnce(
      makeStreamResponse([
        'data: {"id":"gen-abc","model":"m","choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"id":"gen-abc","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const completion = await streamingCallOpenRouter({
      model: 'm', messages: baseMessages, maxTokens: 10, temperature: 0, apiKey: 'k',
    });
    expect(completion.rawId).toBe('gen-abc');
  });

  it('omits rawId when no chunk carries an id', async () => {
    fetchMock.mockResolvedValueOnce(
      makeStreamResponse([
        'data: {"model":"m","choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const completion = await streamingCallOpenRouter({
      model: 'm', messages: baseMessages, maxTokens: 10, temperature: 0, apiKey: 'k',
    });
    expect('rawId' in completion).toBe(false);
  });

  it('carries the id on an aborted call\'s partial', async () => {
    const ctrl = new AbortController();
    const encoder = new TextEncoder();
    fetchMock.mockImplementationOnce(async (_url: unknown, init: { signal?: AbortSignal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"id":"gen-cut","model":"m","choices":[{"delta":{"content":"par"}}]}\n\n'),
          );
          init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
        },
      });
      return { ok: true, status: 200, body } as unknown as Response;
    });
    const p = streamingCallOpenRouter({
      model: 'm', messages: baseMessages, maxTokens: 10, temperature: 0, apiKey: 'k',
      signal: ctrl.signal,
      onDelta: () => ctrl.abort(),
    });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenRouterAbortError);
    expect((err as InstanceType<typeof OpenRouterAbortError>).partial.rawId).toBe('gen-cut');
  });
});

// OpenAI's json_object mode answers HTTP 400 ("'messages' must contain the word
// 'json' in some form") when no message says "json". Measured:
// /v1/route with modelOverride openai/gpt-4o-mini → 14/14 OpenRouterHttpError 400,
// each silently degraded to the fallback route .
// Neither the built-in
// router prompt nor a consumer-registered one has to say "json", so the adapter does.
describe('JSON mode always names JSON in the messages', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const okBody = {
    model: 'm',
    choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 },
  };
  const okStream = [
    'data: {"model":"m","choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.001}}\n\n',
    'data: [DONE]\n\n',
  ];
  const sentMessages = (): ChatMessage[] =>
    JSON.parse(fetchMock.mock.calls[0]![1].body as string).messages as ChatMessage[];

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    priceForUsageMock.mockReset();
    priceForUsageMock.mockReturnValue(0.001);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds a leading system line naming JSON when no message mentions it', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ ok: true, status: 200, body: okBody }));
    await callOpenRouter({
      model: 'openai/gpt-4o-mini',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
      responseFormat: { type: 'json_object' },
    });
    const sent = sentMessages();
    expect(sent).toHaveLength(baseMessages.length + 1);
    expect(sent[0]!.role).toBe('system');
    expect(sent[0]!.content).toMatch(/json/i);
    expect(sent.slice(1)).toEqual(baseMessages);
  });

  it('does the same on the streaming path', async () => {
    fetchMock.mockResolvedValueOnce(makeStreamResponse(okStream));
    await streamingCallOpenRouter({
      model: 'openai/gpt-4o-mini',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
      responseFormat: { type: 'json_object' },
    });
    const sent = sentMessages();
    expect(sent[0]!.role).toBe('system');
    expect(sent[0]!.content).toMatch(/json/i);
    expect(sent.slice(1)).toEqual(baseMessages);
  });

  it('leaves the messages untouched when one already says JSON (any case)', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ ok: true, status: 200, body: okBody }));
    const said: ChatMessage[] = [
      { role: 'system', content: 'Devuelve SOLO el objeto Json.' },
      { role: 'user', content: 'hola' },
    ];
    await callOpenRouter({
      model: 'm',
      messages: said,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
      responseFormat: { type: 'json_object' },
    });
    expect(sentMessages()).toEqual(said);
  });

  it('leaves the messages untouched without JSON mode', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ ok: true, status: 200, body: okBody }));
    await callOpenRouter({ model: 'm', messages: baseMessages, maxTokens: 10, temperature: 0, apiKey: 'k' });
    expect(sentMessages()).toEqual(baseMessages);
  });
});

// Strict schema-constrained output. OpenRouter IGNORES a parameter the routed
// endpoint does not support unless `provider.require_parameters` is true, which
// would silently turn strict mode back into free text. So strict mode always
// sends it, and OpenRouter errors instead of degrading.
describe('strict json_schema mode', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['a'],
    properties: { a: { type: 'string' } },
  };
  const strictFormat = {
    type: 'json_schema' as const,
    json_schema: { name: 'response', schema, strict: true as const },
  };
  const okBody = {
    model: 'm',
    choices: [{ message: { content: '{"a":"x"}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 },
  };
  const okStream = [
    'data: {"model":"m","choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.001}}\n\n',
    'data: [DONE]\n\n',
  ];
  const sentBody = (): Record<string, unknown> =>
    JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, unknown>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    priceForUsageMock.mockReset();
    priceForUsageMock.mockReturnValue(0.001);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends response_format json_schema + provider.require_parameters (non-streaming)', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ ok: true, status: 200, body: okBody }));
    await callOpenRouter({
      model: 'openai/gpt-4o-mini',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
      responseFormat: strictFormat,
    });
    const body = sentBody();
    expect(body.response_format).toEqual(strictFormat);
    expect(body.provider).toEqual({ zdr: true, require_parameters: true });
  });

  it('does the same on the streaming path', async () => {
    fetchMock.mockResolvedValueOnce(makeStreamResponse(okStream));
    await streamingCallOpenRouter({
      model: 'openai/gpt-4o-mini',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
      responseFormat: strictFormat,
    });
    const body = sentBody();
    expect(body.response_format).toEqual(strictFormat);
    expect(body.provider).toEqual({ zdr: true, require_parameters: true });
  });

  it('adds no JSON hint line: the schema constrains decoding, and the word rule is json_object-only', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ ok: true, status: 200, body: okBody }));
    await callOpenRouter({
      model: 'openai/gpt-4o-mini',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
      responseFormat: strictFormat,
    });
    expect(sentBody().messages).toEqual(baseMessages);
  });

  it('JSON mode sends only provider.zdr (no require_parameters)', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ ok: true, status: 200, body: okBody }));
    await callOpenRouter({
      model: 'm',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
      responseFormat: { type: 'json_object' },
    });
    expect(sentBody().provider).toEqual({ zdr: true });
  });
});

// Zero Data Retention: both request bodies always carry `provider.zdr`, and a
// model with no ZDR endpoint fails closed — one request, a typed error, never
// a second request without the flag.
describe('Zero Data Retention', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const okBody = {
    model: 'm',
    choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 },
  };
  const okStream = [
    'data: {"model":"m","choices":[{"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.001}}\n\n',
    'data: [DONE]\n\n',
  ];
  const noZdrBody = {
    error: { message: 'No endpoints found matching your data policy (Zero data retention)', code: 404 },
  };
  const opts = { model: 'm', messages: baseMessages, maxTokens: 10, temperature: 0, apiKey: 'k' };
  const sentBodies = (): Array<Record<string, unknown>> =>
    fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string) as Record<string, unknown>);

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    priceForUsageMock.mockReset();
    priceForUsageMock.mockReturnValue(0.001);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('non-streaming body carries provider.zdr without a response format', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ ok: true, status: 200, body: okBody }));
    await callOpenRouter(opts);
    expect(sentBodies()[0]!.provider).toEqual({ zdr: true });
  });

  it('streaming body carries provider.zdr without a response format', async () => {
    fetchMock.mockResolvedValueOnce(makeStreamResponse(okStream));
    await streamingCallOpenRouter(opts);
    expect(sentBodies()[0]!.provider).toEqual({ zdr: true });
  });

  it('non-streaming: no ZDR endpoint → OpenRouterNoZdrEndpointError, one request only', async () => {
    fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 404, body: noZdrBody }));
    const err = await callOpenRouter(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenRouterNoZdrEndpointError);
    expect(err).toBeInstanceOf(OpenRouterHttpError);
    expect((err as InstanceType<typeof OpenRouterHttpError>).status).toBe(404);
    expect((err as Error).message).toMatch(/No Zero Data Retention endpoint available for model "m"/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBodies().every((b) => (b.provider as { zdr?: unknown }).zdr === true)).toBe(true);
  });

  it('streaming: no ZDR endpoint → OpenRouterNoZdrEndpointError, one request only', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      body: {},
      text: () => Promise.resolve(JSON.stringify(noZdrBody)),
      headers: { get: () => null },
    } as unknown as Response);
    const err = await streamingCallOpenRouter(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenRouterNoZdrEndpointError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is never transient, so the retry ladder does not ask again', async () => {
    const { isTransientProviderError } = await import('../resilience.js');
    const err = new OpenRouterNoZdrEndpointError({ status: 503, model: 'm', upstreamMessage: 'data policy' });
    expect(isTransientProviderError(err)).toBe(false);
  });

  it('a plain 404 (unknown model) stays a plain OpenRouterHttpError', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 404, body: { error: { message: 'Model not found', code: 404 } } }),
    );
    const err = await callOpenRouter(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenRouterHttpError);
    expect(err).not.toBeInstanceOf(OpenRouterNoZdrEndpointError);
  });
});

describe('streamingCallOpenRouter — errors inside a 200 stream', () => {
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

  const call = (onDelta?: (t: string) => void) =>
    streamingCallOpenRouter({
      model: 'm',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
      ...(onDelta ? { onDelta } : {}),
    }).catch((e: unknown) => e);

  it('an `error` frame after some text raises OpenRouterHttpError (502), not a short answer', async () => {
    fetchMock.mockResolvedValueOnce(
      makeStreamResponse([
        'data: {"choices":[{"delta":{"content":"Hola"}}]}\n\n',
        'data: {"error":{"code":"server_error","message":"upstream died"}}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const deltas: string[] = [];
    const err = await call((t) => deltas.push(t));
    expect(err).toBeInstanceOf(OpenRouterHttpError);
    expect((err as InstanceType<typeof OpenRouterHttpError>).status).toBe(502);
    expect((err as Error).message).toContain('upstream died');
    expect(deltas).toEqual(['Hola']);
  });

  it('a numeric HTTP code in the frame is kept as the status (429 stays retryable as a 429)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeStreamResponse(['data: {"error":{"code":429,"message":"rate limited"}}\n\n']),
    );
    const err = await call();
    expect((err as InstanceType<typeof OpenRouterHttpError>).status).toBe(429);
  });

  it('finish_reason "error" raises OpenRouterHttpError', async () => {
    fetchMock.mockResolvedValueOnce(
      makeStreamResponse([
        'data: {"choices":[{"delta":{"content":"Ho"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"error"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const err = await call();
    expect(err).toBeInstanceOf(OpenRouterHttpError);
    expect((err as InstanceType<typeof OpenRouterHttpError>).status).toBe(502);
  });

  it('non-streaming: finish_reason "error" in a 200 raises OpenRouterHttpError', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        status: 200,
        body: { model: 'm', choices: [{ message: { content: '' }, finish_reason: 'error' }] },
      }),
    );
    const err = await callOpenRouter({
      model: 'm',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenRouterHttpError);
    expect((err as InstanceType<typeof OpenRouterHttpError>).status).toBe(502);
  });
});

describe('streamingCallOpenRouter — only model output resets the stall window', () => {
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

  /**
   * A body that sends `frame` every `everyMs` for `count` ticks, then a real
   * answer and `[DONE]`. Aborting the fetch signal errors the body with the
   * signal's reason, as undici does.
   */
  function tickingResponse(signal: AbortSignal, frame: string, everyMs: number, count: number): Response {
    const encoder = new TextEncoder();
    let ticks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            if (ticks++ < count) {
              controller.enqueue(encoder.encode(frame));
            } else {
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"content":"fin"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                ),
              );
              controller.close();
            }
            resolve();
          }, everyMs);
          const onAbort = (): void => {
            clearTimeout(t);
            controller.error(signal.reason);
            resolve();
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    });
    return { ok: true, status: 200, body } as unknown as Response;
  }

  async function withStall<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    const { env } = (await import('../../../../config/env.js')) as unknown as {
      env: { LLM_STREAM_STALL_TIMEOUT_MS?: number };
    };
    const prev = env.LLM_STREAM_STALL_TIMEOUT_MS;
    env.LLM_STREAM_STALL_TIMEOUT_MS = ms;
    try {
      return await fn();
    } finally {
      env.LLM_STREAM_STALL_TIMEOUT_MS = prev;
    }
  }

  const call = () =>
    streamingCallOpenRouter({
      model: 'm',
      messages: baseMessages,
      maxTokens: 10,
      temperature: 0,
      apiKey: 'k',
    }).catch((e: unknown) => e);

  // Measured on dev 2026-11-10: streams that sent only keepalives waited 58 s.
  it.each([
    ['SSE comment keepalives', ': OPENROUTER PROCESSING\n\n'],
    ['empty-delta chunks', 'data: {"choices":[{"delta":{"content":""}}]}\n\n'],
  ])('%s alone end the call as a stall', async (_label, frame) => {
    fetchMock.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) =>
      // 5 ms ticks for 60 ticks (≈300 ms) against a 40 ms window.
      Promise.resolve(tickingResponse(init.signal, frame, 5, 60)),
    );
    const err = await withStall(40, call);
    expect(err).toBeInstanceOf(OpenRouterAbortError);
    expect(((err as { cause?: Error }).cause as Error)?.name).toBe('TimeoutError');
  });

  it('text chunks keep resetting it', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) =>
      Promise.resolve(
        tickingResponse(init.signal, 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 5, 30),
      ),
    );
    const out = await withStall(40, call);
    expect((out as { contentText: string }).contentText).toBe(`${'a'.repeat(30)}fin`);
  });

  async function withWindows<T>(stall: number, first: number, fn: () => Promise<T>): Promise<T> {
    const { env } = (await import('../../../../config/env.js')) as unknown as {
      env: { LLM_STREAM_FIRST_OUTPUT_TIMEOUT_MS?: number };
    };
    const prev = env.LLM_STREAM_FIRST_OUTPUT_TIMEOUT_MS;
    env.LLM_STREAM_FIRST_OUTPUT_TIMEOUT_MS = first;
    try {
      return await withStall(stall, fn);
    } finally {
      env.LLM_STREAM_FIRST_OUTPUT_TIMEOUT_MS = prev;
    }
  }

  // Measured on dev 2026-11-10: one answer's first token came at 58.3 s and it finished.
  it('keepalives before the first output get the longer first-output window', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) =>
      // ≈100 ms of keepalives against a 40 ms stall window and a 300 ms first-output window.
      Promise.resolve(tickingResponse(init.signal, ': OPENROUTER PROCESSING\n\n', 5, 20)),
    );
    const out = await withWindows(40, 300, call);
    expect((out as { contentText: string }).contentText).toBe('fin');
  });

  it('keepalives past the first-output window still end as a stall', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) =>
      Promise.resolve(tickingResponse(init.signal, ': OPENROUTER PROCESSING\n\n', 5, 60)),
    );
    const err = await withWindows(40, 100, call);
    expect(err).toBeInstanceOf(OpenRouterAbortError);
    expect(((err as { cause?: Error }).cause as Error)?.name).toBe('TimeoutError');
  });

  it('reasoning chunks keep resetting it too: they are model output', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) =>
      Promise.resolve(
        tickingResponse(init.signal, 'data: {"choices":[{"delta":{"reasoning":"r"}}]}\n\n', 5, 30),
      ),
    );
    const out = await withStall(40, call);
    expect((out as { contentText: string }).contentText).toBe('fin');
  });
});
