// `client.generate.stream` — frame parsing, error mapping, abort, heartbeat,
// and the no-retry rule.
//
// Every test drives an injected `fetch`, so the SSE bytes are exactly what
// ai-service's `/v1/generate/stream` writes: a `: ok` comment first, then
// `data:` frames separated by blank lines.

import { describe, expect, it, vi } from 'vitest';

import {
  AIClient,
  AIServiceError,
  BudgetExceededError,
  BudgetMisconfiguredError,
  BudgetNotConfiguredError,
  RateLimitError,
  RequestAbortedError,
  SpecResolutionError,
  GENERATE_STREAM_CONFORMANCE_CASES,
  type GenerateStreamDone,
} from './index.js';

function sse(chunks: string[], opts: { headers?: Record<string, string> } = {}): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      ...(opts.headers ?? {}),
    },
  });
}

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const DONE = {
  type: 'done',
  text: 'hello world',
  modelUsed: 'openai/gpt-4o-mini',
  provider: 'openrouter',
  costUsd: 0.0004,
  usage: { outputTokens: 12, inputTokens: 34, totalTokens: 46 },
  finishReason: 'stop',
  traceId: 'trace-1',
  systemPromptApplied: true,
  warnings: [{ code: 'BUDGET_SOFT_CAP', message: 'low' }],
} satisfies GenerateStreamDone;

function clientWith(fetchImpl: unknown): AIClient {
  return new AIClient({
    baseUrl: 'http://service.local',
    apiKey: 'tok',
    fetch: fetchImpl as typeof fetch,
  });
}

const REQ = { unit: { unitKey: 'u1', input: { q: 'hi' } } };

describe('generate.stream — frames', () => {
  it('yields deltas then the done frame, skipping heartbeat comments', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse([
        ': ok\n\n',
        frame({ type: 'delta', text: 'hello' }),
        ': ping\n\n',
        frame({ type: 'delta', text: ' world' }),
        frame(DONE),
      ]),
    );
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    const deltas: string[] = [];
    let done: GenerateStreamDone | undefined;
    for await (const f of s) {
      if (f.type === 'delta') deltas.push(f.text);
      else done = f;
    }
    expect(deltas).toEqual(['hello', ' world']);
    expect(done).toEqual(DONE);
    // The whole point of the `usage` object: a credits meter bills on it.
    expect(done?.usage?.outputTokens).toBe(12);
    expect(done?.finishReason).toBe('stop');
  });

  it('posts to /v1/generate/stream with the bearer and an SSE Accept', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sse([': ok\n\n', frame(DONE)]));
    await clientWith(fetchImpl).generate.stream(REQ);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://service.local/v1/generate/stream');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers.Accept).toBe('text/event-stream');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(REQ);
  });

  it('collect() drains, feeds onDelta, and returns the done frame', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse([': ok\n\n', frame({ type: 'delta', text: 'a' }), frame(DONE)]),
    );
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    const seen: string[] = [];
    const done = await s.collect((t) => seen.push(t));
    expect(seen).toEqual(['a']);
    expect(done.text).toBe('hello world');
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    const whole = frame({ type: 'delta', text: 'split' });
    const fetchImpl = vi.fn().mockResolvedValue(
      sse([': ok\n\n', whole.slice(0, 12), whole.slice(12), frame(DONE)]),
    );
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    const deltas: string[] = [];
    await s.collect((t) => deltas.push(t));
    expect(deltas).toEqual(['split']);
  });

  it('exposes the server x-request-id from the response headers', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sse([': ok\n\n', frame(DONE)], { headers: { 'x-request-id': 'req-77' } }));
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    expect(s.httpRequestId).toBe('req-77');
  });

  it('skips an unknown frame type instead of throwing (forward compatibility)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse([': ok\n\n', frame({ type: 'someFutureFrame', x: 1 }), frame(DONE)]),
    );
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    const done = await s.collect();
    expect(done.type).toBe('done');
  });

  it('throws when the stream ends with no terminal frame', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sse([': ok\n\n', frame({ type: 'delta', text: 'partial' })]));
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    await expect(s.collect()).rejects.toMatchObject({
      name: 'AIServiceError',
      body: { error: 'StreamTruncated' },
    });
  });
});

describe('generate.stream — error mapping', () => {
  it.each([
    ['BudgetExceeded', BudgetExceededError],
    ['BudgetNotConfigured', BudgetNotConfiguredError],
    ['BudgetMisconfigured', BudgetMisconfiguredError],
    ['SpecResolutionError', SpecResolutionError],
  ] as const)('maps a terminal %s frame to its typed class', async (code, cls) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse([': ok\n\n', frame({ type: 'delta', text: 'x' }), frame({ type: 'error', code, message: `${code} happened` })]),
    );
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    await expect(s.collect()).rejects.toBeInstanceOf(cls);
  });

  it('maps an unrecognised error code to a plain AIServiceError carrying the code', async () => {
    // `ProviderTimeout` used to stand in for "unrecognised" here; it has a
    // class of its own since 0.17.0, so the case needs a code that really is
    // unknown — a frame from a NEWER ai-service than this client.
    const fetchImpl = vi.fn().mockResolvedValue(
      sse([': ok\n\n', frame({ type: 'error', code: 'SomethingAddedLater', message: 'upstream said no' })]),
    );
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    await expect(s.collect()).rejects.toMatchObject({
      name: 'AIServiceError',
      message: 'upstream said no',
      body: { error: 'SomethingAddedLater' },
    });
  });

  it('a ProviderTimeout frame carries `truncated` (the unbilled cut) onto the error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse([
        ': ok\n\n',
        frame({
          type: 'error',
          code: 'ProviderTimeout',
          errorCode: 'ERR_PROVIDER_TIMEOUT',
          truncated: true,
          reason: 'provider_timeout',
          traceId: 'trace-1',
          message: 'The upstream LLM provider exceeded the request timeout.',
        }),
      ]),
    );
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    await expect(s.collect()).rejects.toMatchObject({
      name: 'ProviderTimeoutError',
      code: 'ERR_PROVIDER_TIMEOUT',
      truncated: true,
      body: { truncated: true, reason: 'provider_timeout', traceId: 'trace-1' },
    });
  });

  it('maps a ProviderTimeout frame to its own class', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse([': ok\n\n', frame({ type: 'error', code: 'ProviderTimeout', message: 'upstream timed out' })]),
    );
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    await expect(s.collect()).rejects.toMatchObject({
      name: 'ProviderTimeoutError',
      message: 'upstream timed out',
      status: 504,
    });
  });

  it('a ProviderUnavailable frame KEEPS its retryAfterMs and errorCode', async () => {
    // 🔴 The 0.16.0 bug this pins: `errorFromFrame` rebuilt `{ error, message }`
    // and nothing else, so the breaker's own cool-down — the whole reason the
    // frame carries it, there being no `Retry-After` header mid-stream — was
    // dropped, and the caller got an untyped error at status 0 with no hint.
    const fetchImpl = vi.fn().mockResolvedValue(
      sse([
        ': ok\n\n',
        frame({
          type: 'error',
          code: 'ProviderUnavailable',
          errorCode: 'ERR_PROVIDER_UNAVAILABLE',
          retryAfterMs: 30_000,
          message: 'breaker open',
        }),
      ]),
    );
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    await expect(s.collect()).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      message: 'breaker open',
      status: 503,
      code: 'ERR_PROVIDER_UNAVAILABLE',
      retryable: true,
      retryAfterMs: 30_000,
    });
  });

  it('a frame`s errorCode reaches `err.code` even for a class this client predates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse([
        ': ok\n\n',
        frame({ type: 'error', code: 'AddedLater', errorCode: 'ERR_ADDED_LATER', message: 'nope' }),
      ]),
    );
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    await expect(s.collect()).rejects.toMatchObject({
      name: 'AIServiceError',
      code: 'ERR_ADDED_LATER',
    });
  });

  it('maps a pre-stream 402 body to BudgetExceededError from the open() await', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'BudgetExceeded',
          message: 'budget exceeded',
          org: 'o',
          requested: 1,
          remaining: 0,
          shortfallUsd: 1,
        }),
        { status: 402, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(clientWith(fetchImpl).generate.stream(REQ)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it('maps a pre-stream 429 to RateLimitError with the server retryAfterMs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'RateLimitExceeded', message: 'slow down', retryAfterMs: 45_000 }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const err = await clientWith(fetchImpl)
      .generate.stream(REQ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(45_000);
  });
});

describe('generate.stream — abort', () => {
  it('a caller AbortSignal cancels the body and throws RequestAbortedError', async () => {
    const ctrl = new AbortController();
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': ok\n\n'));
        controller.enqueue(encoder.encode(frame({ type: 'delta', text: 'first' })));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));

    const s = await clientWith(fetchImpl).generate.stream(REQ, { signal: ctrl.signal });
    const err = await s
      .collect(() => {
        ctrl.abort();
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestAbortedError);
    expect((err as RequestAbortedError).reason).toBe('cancel');
    expect(cancelled).toBe(true);
  });

  it('handle.abort() does the same without a caller signal', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': ok\n\n'));
        controller.enqueue(encoder.encode(frame({ type: 'delta', text: 'first' })));
      },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    await expect(
      s.collect(() => {
        s.abort();
      }),
    ).rejects.toBeInstanceOf(RequestAbortedError);
  });
});

describe('generate.stream — retry', () => {
  it('does NOT retry a connection failure: /stream cannot dedupe a resend', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(clientWith(fetchImpl).generate.stream(REQ)).rejects.toThrow('fetch failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a transient 503 either', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('{"message":"upstream down"}', { status: 503 }));
    await expect(clientWith(fetchImpl).generate.stream(REQ)).rejects.toBeInstanceOf(AIServiceError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ignores a client-wide retry policy: no resend on a truncated stream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse([': ok\n\n', frame({ type: 'delta', text: 'a' })]),
    );
    const client = new AIClient({
      baseUrl: 'http://service.local',
      apiKey: 'tok',
      fetch: fetchImpl as unknown as typeof fetch,
      retry: { attempts: 5, baseDelayMs: 1 },
    });
    const s = await client.generate.stream(REQ);
    await expect(s.collect()).rejects.toMatchObject({ body: { error: 'StreamTruncated' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ignores a client-wide retry policy before the first byte too', async () => {
    // 🔴 The regression this pins: a client configured with `attempts: 3` for
    // its other calls must NOT resend a stream whose connection failed. The
    // request may already have been accepted and charged.
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = new AIClient({
      baseUrl: 'http://service.local',
      apiKey: 'tok',
      fetch: fetchImpl as unknown as typeof fetch,
      retry: { attempts: 3, baseDelayMs: 1 },
    });
    await expect(client.generate.stream(REQ)).rejects.toThrow('fetch failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('generate.streamRaw', () => {
  it('hands back the unread SSE body for a re-streaming proxy', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sse([': ok\n\n', frame(DONE)], { headers: { 'x-request-id': 'req-9' } }));
    const res = await clientWith(fetchImpl).generate.streamRaw(REQ);
    expect(res.headers.get('x-request-id')).toBe('req-9');
    const text = await res.text();
    // Heartbeat comments survive — a proxy forwards them verbatim.
    expect(text.startsWith(': ok\n\n')).toBe(true);
    expect(text).toContain('"type":"done"');
  });

  it('still throws the typed pre-stream error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'BudgetNotConfigured', message: 'none', org: 'o' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(clientWith(fetchImpl).generate.streamRaw(REQ)).rejects.toBeInstanceOf(
      BudgetNotConfiguredError,
    );
  });
});

// ---------------------------------------------------------------------------
// The conformance cases, driven against OUR parser. A consumer that keeps its
// own parser (chat's proxy does) runs the same array against theirs.
// ---------------------------------------------------------------------------
describe('generate.stream — conformance cases', () => {
  it.each(GENERATE_STREAM_CONFORMANCE_CASES)('$name', async (c) => {
    const fetchImpl = vi.fn().mockResolvedValue(sse([...c.wire]));
    const s = await clientWith(fetchImpl).generate.stream(REQ);
    const deltas: string[] = [];
    let done: Record<string, unknown> | null = null;
    let errorCode: string | null = null;
    let truncated = false;
    try {
      for await (const f of s) {
        if (f.type === 'delta') deltas.push(f.text);
        else done = f as unknown as Record<string, unknown>;
      }
    } catch (err) {
      const body = (err as AIServiceError).body;
      if (body.error === 'StreamTruncated') truncated = true;
      else errorCode = String(body.error ?? '');
    }
    expect({ deltas, done, errorCode, truncated }).toEqual(c.expect);
  });
});

// ---------------------------------------------------------------------------
// The 402-arrives-from-ITERATION contract.
//
// `/v1/generate/stream` calls `reply.hijack()` BEFORE `router.route`, and the
// budget reserve lives inside `router.route` — so by the time budget is
// enforced the headers are already on the wire and the open `await` has long
// resolved. A consumer that wraps only `await client.generate.stream(...)` in
// a `try` therefore lets every budget rejection escape.
//
// The `describe('error mapping')` block above already pins the frame→class
// mapping via `collect()`. These pin the shape a consumer actually writes:
// the open await RESOLVES, and the throw comes out of `for await`.
// ---------------------------------------------------------------------------
describe('generate.stream — a 402 error frame surfaces during iteration', () => {
  it.each([
    ['BudgetNotConfigured', BudgetNotConfiguredError],
    ['BudgetExceeded', BudgetExceededError],
    ['BudgetMisconfigured', BudgetMisconfiguredError],
  ] as const)('the open await resolves and `for await` throws %s', async (code, cls) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sse([
        ': ok\n\n',
        frame({ type: 'delta', text: 'partial ' }),
        frame({ type: 'error', code, message: `${code} after hijack` }),
      ]),
    );

    // 1. The open MUST NOT throw — this is the half consumers wrongly rely on.
    const s = await clientWith(fetchImpl).generate.stream(REQ);

    // 2. The throw comes out of the iteration, after real deltas were yielded.
    const deltas: string[] = [];
    let caught: unknown;
    try {
      for await (const f of s) {
        if (f.type === 'delta') deltas.push(f.text);
      }
    } catch (err) {
      caught = err;
    }

    expect(deltas).toEqual(['partial ']);
    expect(caught).toBeInstanceOf(cls);
    expect((caught as Error).message).toBe(`${code} after hijack`);
  });
});

// `maxElapsedMs` — a wall-clock cap over the WHOLE stream, connect through the
// terminal frame. Each test stalls forever, so only the cap can end it: the
// outcome does not depend on the cap's size, only on it firing at all.
describe('generate.stream — maxElapsedMs', () => {
  const stalledBody = (onCancel: () => void): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': ok\n\n'));
        controller.enqueue(encoder.encode(frame({ type: 'delta', text: 'first' })));
        // …and then nothing, ever: the stall a connect timeout cannot see.
      },
      cancel: onCancel,
    });
  };
  const sseResponse = (body: ReadableStream<Uint8Array>): Response =>
    new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  /** A fetch that never answers, rejecting only when its signal aborts. */
  const hangingFetch = () =>
    vi.fn((_url: unknown, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });

  it('cuts a stream that stalls mid-body with RequestAbortedError("timeout")', async () => {
    let cancelled = false;
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(stalledBody(() => (cancelled = true))));
    const s = await clientWith(fetchImpl).generate.stream(REQ, { maxElapsedMs: 20 });
    const deltas: string[] = [];
    const err = await s.collect((t) => deltas.push(t)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestAbortedError);
    expect((err as RequestAbortedError).reason).toBe('timeout');
    expect((err as Error).message).toContain('20ms');
    expect(deltas).toEqual(['first']);
    // The reader is cancelled, so the server sees the disconnect and refunds.
    expect(cancelled).toBe(true);
  });

  it('cuts a connect that never answers with RequestAbortedError("timeout")', async () => {
    const err = await clientWith(hangingFetch())
      .generate.stream(REQ, { maxElapsedMs: 20 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestAbortedError);
    expect((err as RequestAbortedError).reason).toBe('timeout');
  });

  it('applies to streamRaw up to the headers', async () => {
    const err = await clientWith(hangingFetch())
      .generate.streamRaw(REQ, { maxElapsedMs: 20 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestAbortedError);
    expect((err as RequestAbortedError).reason).toBe('timeout');
  });

  it('a caller abort still reads as "cancel" when a cap is also set', async () => {
    const ctrl = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(stalledBody(() => {})));
    const s = await clientWith(fetchImpl).generate.stream(REQ, {
      signal: ctrl.signal,
      maxElapsedMs: 60_000,
    });
    const err = await s.collect(() => ctrl.abort()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestAbortedError);
    expect((err as RequestAbortedError).reason).toBe('cancel');
  });

  it('a stream that finishes under the cap resolves normally', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sse([': ok\n\n', frame({ type: 'delta', text: 'hello ' }), frame(DONE)]));
    const s = await clientWith(fetchImpl).generate.stream(REQ, { maxElapsedMs: 60_000 });
    await expect(s.collect()).resolves.toEqual(DONE);
  });

  it('refuses a cap that is not a positive finite number, before any request', async () => {
    const fetchImpl = vi.fn();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        clientWith(fetchImpl).generate.stream(REQ, { maxElapsedMs: bad }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
