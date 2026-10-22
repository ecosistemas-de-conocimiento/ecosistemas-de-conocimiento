// `ProviderUnavailable` (breaker open) on both inline generation transports.
//
// ── Why this file exists ───────────────────────────────────────────────────
// The resilience stack can refuse a call outright: after five consecutive
// transient provider failures the circuit opens and `router.route()` throws
// `ProviderUnavailable` WITHOUT dialling OpenRouter. Neither route mapper had
// an arm for it, which failed differently — and much worse — per transport:
//
//   · /sync fell through to Fastify's DEFAULT error handler. That reads
//     `err.statusCode` / `err.headers`, so the status and `Retry-After` were
//     already right; only the BODY was Fastify's generic shape, so a consumer
//     could not discriminate it from any other 503.
//   · /stream was the real bug. The reply is hijacked before the router is
//     called, so there is no status line left to carry the 503 and no header
//     left to carry the retry hint — and `classifyStreamError` collapsed the
//     error to `code: 'INTERNAL', message: 'generation failed'`. A streaming
//     consumer got NO signal that the provider was down and no retry hint,
//     which is precisely the case where back-pressure matters.
//
// So the assertions below are about the ROUTE BOUNDARY: given a router that
// throws `ProviderUnavailable`, what reaches the wire on each transport.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const resolveSpecMock = vi.fn();
const createOpenRouterMock = vi.fn();
const fetchContextMock = vi.fn();

vi.mock('../services/registry/resolve.js', async () => {
  const actual =
    await vi.importActual<typeof import('../services/registry/resolve.js')>(
      '../services/registry/resolve.js',
    );
  return { ...actual, resolveSpec: (...a: unknown[]) => resolveSpecMock(...a) };
});

vi.mock('../services/ai/router/openrouter.js', () => ({
  createOpenRouter: () => createOpenRouterMock(),
}));

vi.mock('../services/context/fetch.js', () => ({
  fetchContext: (...a: unknown[]) => fetchContextMock(...a),
  // The routes call the trace variant; it wraps the same mock.
  fetchContextWithTrace: async (...a: unknown[]) => ({
    context: await fetchContextMock(...a),
    retrievalTrace: [],
  }),
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => {
        const chain: Record<string, unknown> = {
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve([]),
          then: (r: (v: unknown[]) => void) => r([]),
        };
        return chain;
      },
    }),
  },
}));

const APP_TOKEN = 'provider-unavailable-app';

process.env['API_KEYS'] = JSON.stringify({
  [APP_TOKEN]: { org: 'acme', project: 'acme', role: 'app' },
});

// ⚠ DYNAMIC, and it must stay that way. A static `import` is hoisted above the
// `process.env.API_KEYS` assignment above, and this module transitively pulls
// in `env.ts`, which SNAPSHOTS the key table at load — every request then 401s.
// The leaf module, not the `router.ts` re-export: it keeps this file off the
// router's (heavy) module graph. Class IDENTITY no longer matters to the
// routes — the wire mapping reads the `isAiServiceError` brand and the
// instance's own `status`/`midStream`, not an `instanceof` arm — so a second
// resolution of this file would still be classified correctly.
const { ProviderUnavailable } = await import('../services/ai/router/resilience.js');

const PROFILE = {
  model: 'mock/model',
  maxOutputTokens: 800,
  validationPasses: 1,
  multiSample: 1,
  temperature: 0.4,
  estimatedCostUsdPerCall: 0.001,
} as const;

/** ~7 s — deliberately not a whole number of seconds, so the header rounds UP. */
const RETRY_AFTER_MS = 6_400;

async function makeApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

/** Prime the pre-hijack pipeline to succeed, then have the router refuse. */
function primeBreakerOpen() {
  resolveSpecMock.mockResolvedValue({
    promptTemplate: 'Hello {{name}}!',
    model: 'mock/model',
    effortLevel: 'standard',
    effortProfile: PROFILE,
    validators: [],
  });
  createOpenRouterMock.mockReturnValue({
    route: vi.fn(async () => {
      throw new ProviderUnavailable(RETRY_AFTER_MS);
    }),
  });
}

async function post(app: Awaited<ReturnType<typeof makeApp>>, url: string) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${APP_TOKEN}` },
    payload: { unit: { unitKey: 'u-1', input: { name: 'Alice' } } },
  });
}

/** Parse the SSE body into frames, in order. */
function frames(payload: string): Record<string, unknown>[] {
  return payload
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice('data: '.length)) as Record<string, unknown>);
}

beforeEach(() => {
  resolveSpecMock.mockReset();
  createOpenRouterMock.mockReset();
  fetchContextMock.mockReset();
  fetchContextMock.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// /v1/generate/sync — a typed 503
// ---------------------------------------------------------------------------

describe('POST /v1/generate/sync — breaker open', () => {
  it('answers 503 with a typed ProviderUnavailable body', async () => {
    const app = await makeApp();
    primeBreakerOpen();

    const res = await post(app, '/v1/generate/sync');

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe('ProviderUnavailable');
    expect(body.code).toBe('ERR_PROVIDER_UNAVAILABLE');
    expect(body.retryAfterMs).toBe(RETRY_AFTER_MS);
    expect(typeof body.message).toBe('string');
  });

  it('the 503 body parses through the schema the OpenAPI document publishes', async () => {
    // The parse gate for this status, and it has to live HERE rather than in
    // `openapi/response-parse.integration.test.ts`: the only way to open the
    // breaker is the file-scope `vi.mock` of `db/client.js` above, and that
    // shared-server file has 58 DB-backed cases which the mock would kill.
    //
    // It reads through `responsesFor`, the same fold the document builder
    // uses, so this asserts against the PUBLISHED schema and not a restated
    // copy of it. A 503 declared as the plain flat envelope (it carries
    // `retryAfterMs`, which the flat envelope does not name) goes red here.
    const { ROUTES, responsesFor } = await import('../openapi/route-table.js');
    const row = ROUTES.find((r) => r.method === 'post' && r.path === '/v1/generate/sync');
    if (!row) throw new Error('no row in route-table.ts for POST /v1/generate/sync');
    const schema = responsesFor(row)[503]?.schema;
    if (!schema) throw new Error('POST /v1/generate/sync declares no 503');

    const app = await makeApp();
    primeBreakerOpen();
    const res = await post(app, '/v1/generate/sync');
    expect(res.statusCode).toBe(503);

    const parsed = schema.safeParse(res.json());
    expect(
      parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      'the 503 body does not match its declared schema',
    ).toEqual([]);
  });

  it('still sends Retry-After once the route intercepts the error', async () => {
    // 🔴 REGRESSION GUARD. Before the arm existed, Fastify's default handler
    // supplied this header from `err.headers`. Intercepting the error takes
    // that handler out of the path, so the header has to be set explicitly —
    // and losing it would be invisible in the body assertions above.
    const app = await makeApp();
    primeBreakerOpen();

    const res = await post(app, '/v1/generate/sync');

    // 6400 ms ⇒ 7 s, rounded UP: never tell a caller to come back early.
    expect(res.headers['retry-after']).toBe('7');
  });
});

// ---------------------------------------------------------------------------
// /v1/generate/stream — the frame is the only signal there is
// ---------------------------------------------------------------------------

describe('POST /v1/generate/stream — breaker open', () => {
  it('emits a terminal ProviderUnavailable frame carrying retryAfterMs', async () => {
    const app = await makeApp();
    primeBreakerOpen();

    const res = await post(app, '/v1/generate/stream');

    // The status line was already 200 when the reply was hijacked — that is
    // exactly why the frame has to carry everything.
    expect(res.statusCode).toBe(200);
    const errorFrame = frames(res.payload).find((f) => f['type'] === 'error');
    expect(errorFrame).toBeDefined();
    expect(errorFrame?.['code']).toBe('ProviderUnavailable');
    expect(errorFrame?.['errorCode']).toBe('ERR_PROVIDER_UNAVAILABLE');
    expect(errorFrame?.['retryAfterMs']).toBe(RETRY_AFTER_MS);
  });

  it('does NOT collapse the breaker-open to INTERNAL', async () => {
    // The original defect verbatim: `{"type":"error","code":"INTERNAL",
    // "message":"generation failed"}` told a streaming consumer nothing.
    const app = await makeApp();
    primeBreakerOpen();

    const res = await post(app, '/v1/generate/stream');

    const errorFrame = frames(res.payload).find((f) => f['type'] === 'error');
    expect(errorFrame?.['code']).not.toBe('INTERNAL');
    expect(errorFrame?.['message']).not.toBe('generation failed');
  });

  it('omits retryAfterMs on error frames that have no retry hint', async () => {
    // Guards the spread at the call site: optional fields must be ABSENT, not
    // serialised as null, on every other classification.
    const app = await makeApp();
    resolveSpecMock.mockResolvedValue({
      promptTemplate: 'Hello {{name}}!',
      model: 'mock/model',
      effortLevel: 'standard',
      effortProfile: PROFILE,
      validators: [],
    });
    createOpenRouterMock.mockReturnValue({
      route: vi.fn(async () => {
        throw new Error('something else went wrong');
      }),
    });

    const res = await post(app, '/v1/generate/stream');

    const errorFrame = frames(res.payload).find((f) => f['type'] === 'error');
    expect(errorFrame?.['code']).toBe('INTERNAL');
    expect(errorFrame).not.toHaveProperty('retryAfterMs');
    expect(errorFrame).not.toHaveProperty('errorCode');
  });
});
