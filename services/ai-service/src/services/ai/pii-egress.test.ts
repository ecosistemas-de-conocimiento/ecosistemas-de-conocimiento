// 🔴 THE WIRING GATE. `src/services/ai/pii/` shipped fully tested and NOTHING
// CALLED IT, which is worse than having no minimiser at all. What this file
// checks, per egress site: the URL, headers and body of EVERY request the
// adapter hands the stubbed `fetch` carry no raw synthetic identifier, and the
// adapter makes exactly ONE request per operation. For the `traces` table it
// checks the row handed to the stubbed insert. It does not check anything
// outside those stubs.
//
// §9.4 of `plan/tecnología/ai-infra/inference-hosting-grill.md` names
// three egress sites plus the traces decision; there is one describe block per
// site, and each one drives the REAL adapter with `fetch` stubbed rather than
// asserting on `minimiseEgress` in isolation. An isolated check on the minimiser
// is exactly the test that was already green while the wiring was absent.
//
// Seam 4, the rerank transport, is checked per provider in
// `pii-egress-rerank.test.ts`.
//
// Every fixture here is SYNTHETIC (`pii/fixtures.ts`) — ADR-0001's golden-set
// split keeps real Mexican identifiers out of this repo entirely.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../db/client.js';

import { PROBE_CURP, SYNTHETIC_EMAIL, SYNTHETIC_RFC_FISICA } from './pii/fixtures.js';
import { minimiseEgress, minimiseTracePayload } from './pii-egress.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface SentRequest {
  url: string;
  body: string;
  /** `[name, value]` pairs, serialised, so a raw value in any header shows up. */
  headers: string;
}

/**
 * Record EVERY request the adapter hands `fetch`, and answer plausibly.
 * `body()` returns the single request's body and FAILS unless exactly one
 * request went out: a raw call before the scrubbed one must not stay green.
 */
function stubFetch(responseText: string): {
  spy: ReturnType<typeof vi.fn>;
  calls: SentRequest[];
  body: () => string;
} {
  const calls: SentRequest[] = [];
  const spy = vi.fn(async (url: unknown, init: { body?: string; headers?: ConstructorParameters<typeof Headers>[0] } = {}) => {
    calls.push({
      url: String(url),
      body: init.body ?? '',
      headers: JSON.stringify([...new Headers(init.headers).entries()]),
    });
    return {
      ok: true,
      status: 200,
      text: async () => responseText,
      json: async () => JSON.parse(responseText) as unknown,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return {
    spy,
    calls,
    body: () => {
      expect(calls).toHaveLength(1);
      return calls[0]!.body;
    },
  };
}

/** No raw value in the URL (decoded) or any header of any recorded request. */
function expectNoRawOutsideBody(calls: readonly SentRequest[], raws: readonly string[]): void {
  for (const c of calls) {
    const url = decodeURIComponent(c.url);
    for (const raw of raws) {
      expect(url).not.toContain(raw);
      expect(c.headers).not.toContain(raw);
    }
  }
}

const CHAT_RESPONSE = JSON.stringify({
  choices: [{ message: { content: 'listo' }, finish_reason: 'stop' }],
  model: 'test/model',
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

// ---------------------------------------------------------------------------
// Egress site 1 of 3 — the OpenRouter chat adapter, non-streaming.
// ---------------------------------------------------------------------------

describe('egress site 1: callOpenRouter (sync)', () => {
  it('no messages array reaches fetch unminimised', async () => {
    const { callOpenRouter } = await import('./router/adapters/openrouter.js');
    const { body, calls } = stubFetch(CHAT_RESPONSE);

    await callOpenRouter({
      model: 'test/model',
      messages: [
        { role: 'system', content: 'Eres un asistente.' },
        {
          role: 'user',
          content: `Mi CURP ${PROBE_CURP}, mi RFC ${SYNTHETIC_RFC_FISICA} y mi correo ${SYNTHETIC_EMAIL}.`,
        },
      ],
      maxTokens: 16,
      temperature: 0,
      apiKey: 'k',
    });

    const sent = body();
    // Positive control first: if the prose that is NOT personal data also
    // vanished, the assertions below would pass on an empty body and prove
    // nothing. This is the same-shape known-present hit.
    expect(sent).toContain('Eres un asistente.');
    expect(sent).toContain('mi correo');

    expect(sent).not.toContain(PROBE_CURP);
    expect(sent).not.toContain(SYNTHETIC_RFC_FISICA);
    expect(sent).not.toContain(SYNTHETIC_EMAIL);
    expect(sent).toContain('[CURP]');
    expect(sent).toContain('[RFC]');
    expect(sent).toContain('[EMAIL]');
    expectNoRawOutsideBody(calls, [PROBE_CURP, SYNTHETIC_RFC_FISICA, SYNTHETIC_EMAIL]);
  });

  it('the `models` + `responseFormat` branch is scrubbed too', async () => {
    // Behavioural cover for every body-building branch: this, not a regex over
    // the source, is what fails if a branch assembles `messages` from the raw
    // field. `models` and `response_format` are asserted present so the test
    // cannot pass on a path that skipped the branch.
    const { callOpenRouter } = await import('./router/adapters/openrouter.js');
    const { body } = stubFetch(CHAT_RESPONSE);

    await callOpenRouter({
      model: 'test/model',
      models: ['test/model', 'test/fallback'],
      responseFormat: { type: 'json_object' },
      messages: [{ role: 'user', content: `Datos: CURP ${PROBE_CURP}, correo ${SYNTHETIC_EMAIL}.` }],
      maxTokens: 16,
      temperature: 0,
      apiKey: 'k',
    });

    const sent = JSON.parse(body()) as Record<string, unknown>;
    expect(sent.models).toEqual(['test/model', 'test/fallback']);
    expect(sent.response_format).toEqual({ type: 'json_object' });
    const messages = JSON.stringify(sent.messages);
    expect(messages).toContain('Datos:'); // positive control
    expect(messages).not.toContain(PROBE_CURP);
    expect(messages).not.toContain(SYNTHETIC_EMAIL);
    expect(messages).toContain('[CURP]');
    expect(messages).toContain('[EMAIL]');
  });

  it('does not mutate the caller-owned messages array', async () => {
    // `minimise` rebuilds rather than edits in place, and the adapter must not
    // undo that: the router reuses `opts.messages` across retry passes and
    // reads them back for the trace, so a scrub that mutated the input would
    // silently double-redact and corrupt the retry.
    const { callOpenRouter } = await import('./router/adapters/openrouter.js');
    stubFetch(CHAT_RESPONSE);
    const messages = [{ role: 'user' as const, content: `CURP ${PROBE_CURP}` }];

    await callOpenRouter({
      model: 'test/model',
      messages,
      maxTokens: 16,
      temperature: 0,
      apiKey: 'k',
    });

    expect(messages[0]!.content).toBe(`CURP ${PROBE_CURP}`);
  });

  it('🔴 REFUSES the call rather than sending a payload it could not scrub', async () => {
    // The one degradation this capability may not have. A `Date` is a value the
    // walker cannot enter, so `minimise` rejects — and the refusal must abort
    // the egress call, NOT be swallowed into a raw send.
    const { callOpenRouter } = await import('./router/adapters/openrouter.js');
    const { spy } = stubFetch(CHAT_RESPONSE);

    await expect(
      callOpenRouter({
        model: 'test/model',
        messages: [
          { role: 'user', content: 'hola' },
          // Deliberately ill-typed: this is what an untrusted upstream shape
          // looks like once it has been through a `as` cast somewhere.
          { role: 'user', content: new Date() as unknown as string },
        ],
        maxTokens: 16,
        temperature: 0,
        apiKey: 'k',
      }),
    ).rejects.toMatchObject({ code: 'ERR_PII_MINIMISATION_FAILED' });

    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Egress site 2 of 3 — the same adapter, streaming. The DEFAULT path.
// ---------------------------------------------------------------------------

describe('egress site 2: callOpenRouterStream', () => {
  /** An SSE body the adapter's reader loop can consume to completion. */
  function sseResponse(): Response {
    const frames = [
      'data: {"choices":[{"delta":{"content":"listo"}}],"model":"test/model"}\n\n',
      'data: [DONE]\n\n',
    ];
    const encoder = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            i < frames.length
              ? { done: false, value: encoder.encode(frames[i++]!) }
              : { done: true, value: undefined },
          releaseLock: () => {},
          cancel: async () => {},
        }),
      },
    } as unknown as Response;
  }

  it('no messages array reaches fetch unminimised', async () => {
    const { callOpenRouterStream } = await import('./router/adapters/openrouter.js');
    let sent = '';
    let headers = '';
    const spy = vi.fn(async (_url: unknown, init: { body?: string; headers?: ConstructorParameters<typeof Headers>[0] } = {}) => {
      sent = init.body ?? '';
      headers = JSON.stringify([...new Headers(init.headers).entries()]);
      return sseResponse();
    });
    vi.stubGlobal('fetch', spy);

    // The generator is lazy — the body is not built until it is pulled. Drain it.
    const stream = callOpenRouterStream({
      model: 'test/model',
      messages: [
        { role: 'user', content: `Escríbeme a ${SYNTHETIC_EMAIL} sobre el CURP ${PROBE_CURP}.` },
      ],
      maxTokens: 16,
      temperature: 0,
      apiKey: 'k',
    });
    for await (const _event of stream) {
      void _event;
    }

    expect(spy).toHaveBeenCalledTimes(1);
    // Positive control — the non-PII prose survived, so an empty body cannot pass.
    expect(sent).toContain('Escríbeme a');
    expect(headers).not.toContain(PROBE_CURP);
    expect(headers).not.toContain(SYNTHETIC_EMAIL);
    expect(sent).not.toContain(PROBE_CURP);
    expect(sent).not.toContain(SYNTHETIC_EMAIL);
    expect(sent).toContain('[CURP]');
    expect(sent).toContain('[EMAIL]');
  });

  it('the `models` + `responseFormat` branch is scrubbed too', async () => {
    const { callOpenRouterStream } = await import('./router/adapters/openrouter.js');
    let sent = '';
    let headers = '';
    const spy = vi.fn(async (_url: unknown, init: { body?: string; headers?: ConstructorParameters<typeof Headers>[0] } = {}) => {
      sent = init.body ?? '';
      headers = JSON.stringify([...new Headers(init.headers).entries()]);
      return sseResponse();
    });
    vi.stubGlobal('fetch', spy);

    const stream = callOpenRouterStream({
      model: 'test/model',
      models: ['test/model', 'test/fallback'],
      responseFormat: { type: 'json_object' },
      messages: [{ role: 'user', content: `Datos: CURP ${PROBE_CURP}, correo ${SYNTHETIC_EMAIL}.` }],
      maxTokens: 16,
      temperature: 0,
      apiKey: 'k',
    });
    for await (const _event of stream) void _event;

    expect(spy).toHaveBeenCalledTimes(1);
    expect(headers).not.toContain(PROBE_CURP);
    expect(headers).not.toContain(SYNTHETIC_EMAIL);
    const body = JSON.parse(sent) as Record<string, unknown>;
    expect(body.models).toEqual(['test/model', 'test/fallback']);
    expect(body.response_format).toEqual({ type: 'json_object' });
    const messages = JSON.stringify(body.messages);
    expect(messages).toContain('Datos:'); // positive control
    expect(messages).not.toContain(PROBE_CURP);
    expect(messages).not.toContain(SYNTHETIC_EMAIL);
    expect(messages).toContain('[CURP]');
    expect(messages).toContain('[EMAIL]');
  });

  it('🔴 REFUSES the stream rather than sending a payload it could not scrub', async () => {
    const { callOpenRouterStream } = await import('./router/adapters/openrouter.js');
    const spy = vi.fn(async () => sseResponse());
    vi.stubGlobal('fetch', spy);

    const stream = callOpenRouterStream({
      model: 'test/model',
      messages: [{ role: 'user', content: new Date() as unknown as string }],
      maxTokens: 16,
      temperature: 0,
      apiKey: 'k',
    });

    await expect(
      (async () => {
        for await (const _event of stream) void _event;
      })(),
    ).rejects.toMatchObject({ code: 'ERR_PII_MINIMISATION_FAILED' });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Egress site 3 of 3 — the embeddings adapter. §9.4's "ingest embeddings":
// ingest, /v1/embed and retrieve all embed through this one function.
// ---------------------------------------------------------------------------

describe('egress site 3: callOpenRouterEmbedding', () => {
  const EMBED_RESPONSE = JSON.stringify({
    data: [
      { index: 0, embedding: [0.1, 0.2] },
      { index: 1, embedding: [0.3, 0.4] },
    ],
    model: 'test/embed',
    usage: { prompt_tokens: 4 },
  });

  it('no chunk text reaches fetch unminimised', async () => {
    const { callOpenRouterEmbedding } = await import('./embeddings/openrouter.js');
    // The mock embedder short-circuits BEFORE the fetch, so it would hide this.
    vi.stubEnv('MOCK_LLM', '');
    vi.stubEnv('MOCK_EMBEDDINGS', '');
    const { body, calls } = stubFetch(EMBED_RESPONSE);

    await callOpenRouterEmbedding({
      model: 'test/embed',
      input: [`Acta con CURP ${PROBE_CURP}.`, `Contacto: ${SYNTHETIC_EMAIL}`],
      apiKey: 'k',
    });

    const sent = body();
    expect(sent).toContain('Acta con CURP'); // positive control
    expect(sent).toContain('Contacto:');
    expect(sent).not.toContain(PROBE_CURP);
    expect(sent).not.toContain(SYNTHETIC_EMAIL);
    expect(sent).toContain('[CURP]');
    expect(sent).toContain('[EMAIL]');
    expectNoRawOutsideBody(calls, [PROBE_CURP, SYNTHETIC_EMAIL]);
  });

  it('minimises a single-string input too, not only an array', async () => {
    // `EmbedOptions.input` is `string | string[]` and retrieve passes the SINGLE
    // string form for a query. A scrub that only walked arrays would leave the
    // query path — the one a user types into — completely unminimised.
    const { callOpenRouterEmbedding } = await import('./embeddings/openrouter.js');
    vi.stubEnv('MOCK_LLM', '');
    vi.stubEnv('MOCK_EMBEDDINGS', '');
    const { body } = stubFetch(
      JSON.stringify({ data: [{ index: 0, embedding: [0.1] }], model: 'test/embed' }),
    );

    await callOpenRouterEmbedding({
      model: 'test/embed',
      input: `¿De quién es el CURP ${PROBE_CURP}?`,
      apiKey: 'k',
    });

    expect(body()).toContain('De quién es el CURP'); // positive control
    expect(body()).not.toContain(PROBE_CURP);
    expect(body()).toContain('[CURP]');
  });
});

// ---------------------------------------------------------------------------
// §9.4 option A — what the `traces` table stores afterwards.
// ---------------------------------------------------------------------------

describe('traces: option A, scrubbed only', () => {
  it('scrubs input_payload and output_payload before the insert', async () => {
    const { TraceWriter } = await import('./router/trace-writer.js');
    const captured: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          captured.push(v);
          return { returning: async () => [{ id: 'trace-1' }] };
        },
      }),
    } as unknown as Db;

    await new TraceWriter(db).writeTrace({
      org: 'example.org',
      status: 'completed',
      inputPayload: { messages: [{ role: 'user', content: `CURP ${PROBE_CURP}` }] },
      outputPayload: { content: `Confirmado, escribo a ${SYNTHETIC_EMAIL}.` },
      metadata: { traceId: 'abc' },
    });

    const row = captured[0]!;
    const input = JSON.stringify(row.inputPayload);
    const output = JSON.stringify(row.outputPayload);
    expect(input).toContain('messages'); // positive control: shape survived
    expect(output).toContain('Confirmado');
    expect(input).not.toContain(PROBE_CURP);
    expect(output).not.toContain(SYNTHETIC_EMAIL);
    expect(input).toContain('[CURP]');
    expect(output).toContain('[EMAIL]');
    // Option B was rejected: nothing on the row may carry a way back.
    expect(JSON.stringify(row)).not.toContain(PROBE_CURP);
  });

  it('a refusal stores a MARKER, never the raw payload, and never fails the write', async () => {
    // The one deliberate difference from an egress seam, and why it is not a
    // loosening: `writeTrace` is awaited on the router's SUCCESS path, so a
    // refusal that threw would turn a completed generation into a failed
    // request. Fail-closed here means store nothing — visibly.
    const { TraceWriter } = await import('./router/trace-writer.js');
    const captured: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          captured.push(v);
          return { returning: async () => [{ id: 'trace-2' }] };
        },
      }),
    } as unknown as Db;

    const circular: Record<string, unknown> = { content: `CURP ${PROBE_CURP}` };
    circular.self = circular;

    const result = await new TraceWriter(db).writeTrace({
      org: 'example.org',
      status: 'completed',
      outputPayload: circular,
    });

    expect(result).toEqual({ id: 'trace-2' });
    expect(captured[0]!.outputPayload).toEqual({ piiMinimisationFailed: true });
    expect(JSON.stringify(captured[0]!.outputPayload)).not.toContain(PROBE_CURP);
  });

  it('leaves an absent payload absent rather than inventing an empty object', async () => {
    const { TraceWriter } = await import('./router/trace-writer.js');
    const captured: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          captured.push(v);
          return { returning: async () => [{ id: 'trace-3' }] };
        },
      }),
    } as unknown as Db;

    await new TraceWriter(db).writeTrace({ org: 'example.org', status: 'started' });
    expect(captured[0]!.inputPayload).toBeUndefined();
    expect(captured[0]!.outputPayload).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The function the capability probe names.
// ---------------------------------------------------------------------------

describe('minimiseEgress', () => {
  it('returns the same shape with strings scrubbed', async () => {
    const out = await minimiseEgress({
      messages: [{ role: 'user', content: `CURP ${PROBE_CURP}`, n: 1, ok: true }],
    });
    expect(out.messages[0]!.content).toBe('CURP [CURP]');
    expect(out.messages[0]!.n).toBe(1);
    expect(out.messages[0]!.ok).toBe(true);
  });

  it('is idempotent — a placeholder is not itself detectable', async () => {
    const once = await minimiseEgress([`CURP ${PROBE_CURP} correo ${SYNTHETIC_EMAIL}`]);
    expect(await minimiseEgress(once)).toEqual(once);
  });

  it('propagates the refusal instead of returning the payload', async () => {
    await expect(minimiseEgress({ when: new Date() })).rejects.toMatchObject({
      code: 'ERR_PII_MINIMISATION_FAILED',
    });
  });

  it('honours an abort signal', async () => {
    // Forced, not raced: the signal is ALREADY aborted before the call, so
    // there is no window to widen and no timing for the assertion to depend on.
    const controller = new AbortController();
    controller.abort(new Error('caller went away'));
    await expect(minimiseEgress(['hola'], controller.signal)).rejects.toMatchObject({
      code: 'ERR_PII_MINIMISATION_FAILED',
    });
  });
});

describe('minimiseTracePayload', () => {
  it('passes null and undefined through untouched', async () => {
    expect(await minimiseTracePayload(undefined)).toBeUndefined();
    expect(await minimiseTracePayload(null)).toBeNull();
  });
});
