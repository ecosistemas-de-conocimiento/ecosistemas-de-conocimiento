// One span per synchronous generation, carrying the attributes an operator
// actually searches by.
//
// WHY THIS TEST EXISTS: instrumentation fails silently in both directions. A
// span that is never created looks identical to a quiet service, and a span
// created with no attributes looks identical to a busy one — you find out
// months later, during an incident, that the traces cannot be filtered by
// tenant. So this boots a REAL in-memory span exporter, drives one real HTTP
// request through `POST /v1/generate/sync`, and reads the span back.
//
// 🔴 `ai.api_key_id` IS THE SHA-256 FINGERPRINT MINTED BY `deriveApiKeyId`,
// NEVER THE BEARER TOKEN. The last assertion in this file pins that: a span is
// exported to a collector, and a raw key on it is a credential leak with a
// long tail. It fails if anyone ever "helpfully" swaps in the real key.
//
// 🔴 THE ATTRIBUTE KEYS ARE WRITTEN OUT AS LITERALS, NOT IMPORTED FROM `ATTR`.
// Importing the constant makes the test agree with the code by construction:
// rename `ai.org` to `ai.tenant` and this file stays green while every saved
// query, alert and dashboard in the collector breaks. An attribute key is a
// PUBLISHED NAME — the one thing an operator types — so the test has to state
// it independently. If you rename one deliberately, this file is the checklist
// of what you are breaking.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { node, tracing } from '@opentelemetry/sdk-node';


// ---------------------------------------------------------------------------
// Mocks — same shape as `generate.test.ts`; hoisted above the dynamic import.
// ---------------------------------------------------------------------------

const enqueueGenerationMock = vi.fn();
const resolveSpecMock = vi.fn();
const createOpenRouterMock = vi.fn();
const fetchContextMock = vi.fn();

vi.mock('../services/generation/orchestrator.js', async () => {
  const actual =
    await vi.importActual<typeof import('../services/generation/orchestrator.js')>(
      '../services/generation/orchestrator.js',
    );
  return { ...actual, enqueueGeneration: (...args: unknown[]) => enqueueGenerationMock(...args) };
});

vi.mock('../services/registry/resolve.js', async () => {
  const actual =
    await vi.importActual<typeof import('../services/registry/resolve.js')>(
      '../services/registry/resolve.js',
    );
  return { ...actual, resolveSpec: (...args: unknown[]) => resolveSpecMock(...args) };
});

vi.mock('../services/ai/router/openrouter.js', () => ({
  createOpenRouter: () => createOpenRouterMock(),
}));

vi.mock('../services/context/fetch.js', () => ({
  fetchContext: (...args: unknown[]) => fetchContextMock(...args),
  // The routes call the trace variant; it wraps the same mock.
  fetchContextWithTrace: async (...args: unknown[]) => ({
    context: await fetchContextMock(...args),
    retrievalTrace: [],
  }),
}));

vi.mock('../db/client.js', () => ({ db: { select: () => ({ from: () => ({}) }) } }));

// ---------------------------------------------------------------------------
// In-memory tracing pipeline. `SimpleSpanProcessor` exports on `span.end()`,
// so no flush timing to get wrong.
// ---------------------------------------------------------------------------

const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});

const APP_TOKEN = 'test-key';
// `deriveApiKeyId` = first 16 hex chars of SHA-256(token). Recomputed here
// rather than imported so the test states the expected shape independently.
const EXPECTED_KEY_ID = (
  await import('node:crypto')
).createHash('sha256').update(APP_TOKEN).digest('hex').slice(0, 16);

beforeAll(() => {
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
  enqueueGenerationMock.mockReset();
  resolveSpecMock.mockReset();
  createOpenRouterMock.mockReset();
  fetchContextMock.mockReset();
  fetchContextMock.mockResolvedValue({});
});

const SPEC = {
  promptTemplate: 'Hola {{name}}!',
  model: 'mock/model-xl',
  effortLevel: 'standard' as const,
  effortProfile: {
    model: 'mock/model-xl',
    maxOutputTokens: 800,
    validationPasses: 1,
    multiSample: 1,
    temperature: 0.4,
    estimatedCostUsdPerCall: 0.001,
  },
  validators: [],
};

function routeResult() {
  return {
    content: 'Hola Alice!',
    parsed: undefined,
    flags: [],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCostUsd: 0.0008 },
    model: 'mock/model-xl',
    provider: 'openrouter' as const,
    traceId: 'trace-span-1',
    cached: false,
    durationMs: 12,
    effort: 'standard' as const,
    effortProfileUsed: SPEC.effortProfile,
  };
}

async function injectStream() {
  const { buildServer } = await import('../server.js');
  const app = await buildServer();
  try {
    return await app.inject({
      method: 'POST',
      url: '/v1/generate/stream',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: {
        unit: { unitKey: 'u-stream', unitType: 'summary', input: { name: 'Alice' } },
      },
    });
  } finally {
    await app.close();
  }
}

async function injectSync() {
  const { buildServer } = await import('../server.js');
  const app = await buildServer();
  try {
    return await app.inject({
      method: 'POST',
      url: '/v1/generate/sync',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: {
        unit: { unitKey: 'u-span', unitType: 'summary', input: { name: 'Alice' } },
      },
    });
  } finally {
    await app.close();
  }
}

describe('POST /v1/generate/sync — trace span', () => {
  it('exports one span carrying tenancy, unit and model attributes', async () => {
    resolveSpecMock.mockResolvedValueOnce(SPEC);
    createOpenRouterMock.mockReturnValue({ route: vi.fn(async () => routeResult()) });

    const res = await injectSync();
    expect(res.statusCode).toBe(200);

    const spans = exporter.getFinishedSpans();
    const span = spans.find((s) => s.name === 'POST /v1/generate/sync');
    // SABOTAGE (measured, twice): (a) make `withRouteSpan` call its body
    // without starting a span — all 3 tests RED, this one on `undefined`;
    // (b) drop the single `ATTR.project` setter — only this test RED, on
    // `expected undefined to be 'test-project'`. So the file catches both a
    // missing span and a silently narrowed one.
    expect(span, `no generate/sync span; got: ${spans.map((s) => s.name).join(', ')}`)
      .toBeDefined();

    expect(span!.attributes['ai.org']).toBe('test-org');
    expect(span!.attributes['ai.project']).toBe('test-project');
    expect(span!.attributes['ai.unit_type']).toBe('summary');
    expect(span!.attributes['ai.unit_key']).toBe('u-span');
    // Set from `spec.model` — only knowable AFTER `resolveSpec`, so this also
    // pins that `otel.setModel()` is called on the resolved spec and not on
    // the request's (absent) model override.
    expect(span!.attributes['ai.model']).toBe('mock/model-xl');
    // Fastify's own per-HTTP-request id, the same value on the log lines and
    // on the `x-request-id` response header. NOT `ai.request_id`: in this
    // codebase "requestId" already means `generation_requests.id`.
    expect(span!.attributes['ai.http_request_id']).toBe(res.headers['x-request-id']);
    expect(span!.attributes['ai.http_request_id']).toBeTruthy();
  });

  it('carries the hashed api key id and never the bearer token', async () => {
    resolveSpecMock.mockResolvedValueOnce(SPEC);
    createOpenRouterMock.mockReturnValue({ route: vi.fn(async () => routeResult()) });

    await injectSync();
    const span = exporter.getFinishedSpans().find((s) => s.name === 'POST /v1/generate/sync');
    expect(span!.attributes['ai.api_key_id']).toBe(EXPECTED_KEY_ID);
    const serialised = JSON.stringify(span!.attributes);
    expect(serialised).not.toContain(APP_TOKEN);
  });

  it('marks the span as an error when generation fails', async () => {
    resolveSpecMock.mockRejectedValueOnce(new Error('boom'));

    const res = await injectSync();
    expect(res.statusCode).toBe(500);
    const span = exporter.getFinishedSpans().find((s) => s.name === 'POST /v1/generate/sync');
    expect(span).toBeDefined();
    // 2 === SpanStatusCode.ERROR
    expect(span!.status.code).toBe(2);
    expect(span!.events.some((e) => e.name === 'exception')).toBe(true);
  });
});

describe('POST /v1/generate — trace span on the ASYNC route', () => {
  // The batch route had NO span at all: it was the one generation entry point
  // an operator could not see, and it is the one most consumers actually use.
  // It gets tenancy attributes only — there is no single unit and no resolved
  // model at enqueue time, so anything finer would be a guess.
  it('exports a span carrying tenancy and the http request id', async () => {
    enqueueGenerationMock.mockResolvedValueOnce({ requestId: 'req-1', jobIds: ['j-1'] });

    const { buildServer } = await import('../server.js');
    const app = await buildServer();
    let res;
    try {
      res = await app.inject({
        method: 'POST',
        url: '/v1/generate',
        headers: { authorization: `Bearer ${APP_TOKEN}` },
        payload: { units: [{ unitKey: 'u-async', unitType: 'summary', input: {} }] },
      });
    } finally {
      await app.close();
    }
    expect(res.statusCode, res.body).toBe(200);

    const spans = exporter.getFinishedSpans();
    const span = spans.find((sp) => sp.name === 'POST /v1/generate');
    expect(span, `no generate span; got: ${spans.map((sp) => sp.name).join(', ')}`).toBeDefined();
    expect(span!.attributes['ai.org']).toBe('test-org');
    expect(span!.attributes['ai.project']).toBe('test-project');
    expect(span!.attributes['ai.api_key_id']).toBe(EXPECTED_KEY_ID);
    expect(span!.attributes['ai.http_request_id']).toBe(res.headers['x-request-id']);
  });

  it('carries the http request id into the orchestrator context', async () => {
    enqueueGenerationMock.mockResolvedValueOnce({ requestId: 'req-2', jobIds: [] });

    const { buildServer } = await import('../server.js');
    const app = await buildServer();
    let res;
    try {
      res = await app.inject({
        method: 'POST',
        url: '/v1/generate',
        headers: { authorization: `Bearer ${APP_TOKEN}` },
        payload: { units: [{ unitKey: 'u-async', unitType: 'summary', input: {} }] },
      });
    } finally {
      await app.close();
    }
    expect(res.statusCode).toBe(200);
    const [, ctx] = enqueueGenerationMock.mock.calls[0]!;
    // 🔴 `httpRequestId`, NOT `requestId`. The orchestrator's own `requestId`
    // is `generation_requests.id` — the value it MINTS — so reusing the name
    // here would have produced a context object with two different meanings for
    // one key depending on who filled it in.
    expect((ctx as { httpRequestId?: string }).httpRequestId).toBe(res.headers['x-request-id']);
  });
});

describe('POST /v1/generate/stream — a hijacked response still carries x-request-id', () => {
  // 🔴 THE HOOK IN `server.ts` DOES NOT REACH THIS ROUTE. `reply.header(...)`
  // is only written by Fastify's serializer, and `reply.hijack()` bypasses it,
  // so both streaming routes answered with no correlation id — on exactly the
  // transport where a consumer most needs one, because a stream that dies
  // mid-flight leaves nothing else to quote.
  //
  // SABOTAGE (measured): delete the `reply.raw.setHeader('x-request-id', …)`
  // line from `routes/generate.ts` and this test goes RED on `undefined`.
  it('sets the header on the raw socket, matching the span attribute', async () => {
    resolveSpecMock.mockResolvedValueOnce(SPEC);
    createOpenRouterMock.mockReturnValue({ route: vi.fn(async () => routeResult()) });

    const res = await injectStream();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    const requestId = res.headers['x-request-id'];
    expect(requestId, 'hijacked SSE response carried no x-request-id').toBeTruthy();

    const span = exporter.getFinishedSpans().find((sp) => sp.name === 'POST /v1/generate/stream');
    expect(span, 'no generate/stream span').toBeDefined();
    // The header and the span attribute are the SAME id — that identity is the
    // whole point: the value a consumer quotes is the value an operator filters
    // traces by.
    expect(span!.attributes['ai.http_request_id']).toBe(requestId);
    expect(span!.attributes['ai.unit_key']).toBe('u-stream');
    expect(span!.attributes['ai.model']).toBe('mock/model-xl');
  });
});
