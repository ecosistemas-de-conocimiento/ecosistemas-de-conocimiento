// Route-level tests for `usage` + `finishReason` on the generation responses.
//
// These exist because the numbers were already in hand and still never reached
// the wire. The router computed token counts, used them for cost, and wrote
// them to `traces` + `usage`; both response builders in `src/routes/generate.ts`
// then forwarded only `usage.estimatedCostUsd` and dropped the rest, and
// `finishReason` never left the adapter at all. A consumer metering credits by
// output tokens had to settle from a chars/4 guess.
//
// So the assertions here are deliberately about the ROUTE BOUNDARY: given a
// router result, what appears on the HTTP response. Three properties:
//   1. present when upstream provides them,
//   2. absent (not zeroed, not defaulted) when upstream does not,
//   3. every pre-existing field unchanged — these routes have
//      consumers, and this change must be purely additive.

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

const APP_TOKEN = 'usage-wire-app';

process.env['API_KEYS'] = JSON.stringify({
  [APP_TOKEN]: { org: 'acme', project: 'acme', role: 'app' },
});

const PROFILE = {
  model: 'mock/model',
  maxOutputTokens: 800,
  validationPasses: 1,
  multiSample: 1,
  temperature: 0.4,
  estimatedCostUsdPerCall: 0.001,
} as const;

async function makeApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

/**
 * A router result with the given overrides layered on a realistic base.
 * `usage` here is the ROUTER-internal shape (it carries cost); the wire shape
 * is what we assert on.
 */
function routerResult(over: Record<string, unknown> = {}) {
  return {
    content: 'Hello Alice!',
    parsed: undefined,
    flags: [],
    usage: {
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
      estimatedCostUsd: 0.0012,
    },
    model: 'mock/model',
    provider: 'openrouter' as const,
    traceId: 'trace-usage-1',
    cached: false,
    durationMs: 12,
    effort: 'standard' as const,
    effortProfileUsed: PROFILE,
    ...over,
  };
}

function primeRoute(result: Record<string, unknown>) {
  resolveSpecMock.mockResolvedValueOnce({
    promptTemplate: 'Hello {{name}}!',
    model: 'mock/model',
    effortLevel: 'standard',
    effortProfile: PROFILE,
    validators: [],
  });
  createOpenRouterMock.mockReturnValue({ route: vi.fn(async () => result) });
}

async function postSync(app: Awaited<ReturnType<typeof makeApp>>) {
  return app.inject({
    method: 'POST',
    url: '/v1/generate/sync',
    headers: { authorization: `Bearer ${APP_TOKEN}` },
    payload: { unit: { unitKey: 'u-1', input: { name: 'Alice' } } },
  });
}

/** POST /v1/generate/stream and return the parsed terminal `done` frame. */
async function postStreamDone(app: Awaited<ReturnType<typeof makeApp>>) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/generate/stream',
    headers: { authorization: `Bearer ${APP_TOKEN}` },
    payload: { unit: { unitKey: 'u-1', input: { name: 'Alice' } } },
  });
  const frames = res.payload
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice('data: '.length)) as Record<string, unknown>);
  return frames.find((f) => f['type'] === 'done');
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
// Present when upstream provides them
// ---------------------------------------------------------------------------

describe('usage + finishReason are projected onto the wire', () => {
  it('POST /v1/generate/sync carries both when the router reports them', async () => {
    const app = await makeApp();
    primeRoute(routerResult({ finishReason: 'stop' }));

    const res = await postSync(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.usage).toEqual({ outputTokens: 45, inputTokens: 120, totalTokens: 165 });
    expect(body.finishReason).toBe('stop');
  });

  it('the stream `done` frame carries both, identically to /sync', async () => {
    const app = await makeApp();
    primeRoute(routerResult({ finishReason: 'stop' }));

    const done = await postStreamDone(app);
    expect(done).toBeDefined();
    expect(done?.['usage']).toEqual({ outputTokens: 45, inputTokens: 120, totalTokens: 165 });
    expect(done?.['finishReason']).toBe('stop');
  });

  // The reason the whole feature exists: a consumer capping generation via
  // `specOverride.effortProfile.maxOutputTokens` must be able to see that the
  // cap actually bit, so it settles credits against a truncated response.
  it("surfaces finishReason 'length' so a caller can detect truncation", async () => {
    const app = await makeApp();
    primeRoute(routerResult({ finishReason: 'length' }));

    const body = (await postSync(app)).json();
    expect(body.finishReason).toBe('length');
    expect(body.usage.outputTokens).toBe(45);
  });

  it('projects token counts without recomputing them', async () => {
    // The route must forward what the provider reported, NOT re-derive from
    // the response text. `content` here is 12 chars (~3 tokens by chars/4) but
    // the provider said 45 — 45 is what a consumer gets billed on.
    const app = await makeApp();
    primeRoute(
      routerResult({
        content: 'Hello Alice!',
        usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165, estimatedCostUsd: 0.0012 },
        finishReason: 'stop',
      }),
    );

    const body = (await postSync(app)).json();
    expect(body.usage.outputTokens).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// Absent when upstream does not provide them
// ---------------------------------------------------------------------------

describe('usage + finishReason are omitted, never faked', () => {
  it('omits finishReason when the router reports none', async () => {
    const app = await makeApp();
    primeRoute(routerResult()); // no finishReason key at all

    const body = (await postSync(app)).json();
    expect(body).not.toHaveProperty('finishReason');
    // Crucially NOT defaulted to 'stop' — nobody told us the model finished.
    expect(body.finishReason).toBeUndefined();
  });

  it('omits usage entirely when the provider reported no token counts', async () => {
    const app = await makeApp();
    primeRoute(
      routerResult({
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0.004 },
      }),
    );

    const body = (await postSync(app)).json();
    expect(body).not.toHaveProperty('usage');
    // Cost is still reported — it came from OpenRouter's `usage.cost`, which
    // can arrive when token counts do not.
    expect(body.costUsd).toBe(0.004);
  });

  it('omits both on the stream `done` frame under the same conditions', async () => {
    const app = await makeApp();
    primeRoute(
      routerResult({
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      }),
    );

    const done = await postStreamDone(app);
    expect(done).toBeDefined();
    expect(done).not.toHaveProperty('usage');
    expect(done).not.toHaveProperty('finishReason');
  });

  it('omits finishReason on a cache hit, where it is unknown', async () => {
    // Cache entries do not store the original finish reason, and re-serving a
    // cached body says nothing about how the first call ended. Absent is the
    // only honest answer; the router never fabricates one.
    const app = await makeApp();
    primeRoute(
      routerResult({
        cached: true,
        usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165, estimatedCostUsd: 0 },
      }),
    );

    const body = (await postSync(app)).json();
    expect(body).not.toHaveProperty('finishReason');
    // Token counts ARE cached, so they still surface.
    expect(body.usage).toEqual({ outputTokens: 45, inputTokens: 120, totalTokens: 165 });
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — the change must be purely additive
// ---------------------------------------------------------------------------

describe('existing consumer contract is unchanged', () => {
  // Consumers read these routes. If any pre-existing
  // field changed name, type, or value, this fails.
  const REQUIRED_SYNC_FIELDS = [
    'text',
    'modelUsed',
    'provider',
    'costUsd',
    'traceId',
    'systemPromptApplied',
  ] as const;

  it('POST /v1/generate/sync still returns every pre-existing field', async () => {
    const app = await makeApp();
    primeRoute(routerResult({ finishReason: 'stop' }));

    const body = (await postSync(app)).json();
    for (const f of REQUIRED_SYNC_FIELDS) {
      expect(body, `missing pre-existing field ${f}`).toHaveProperty(f);
    }
    expect(body.text).toBe('Hello Alice!');
    expect(body.modelUsed).toBe('mock/model');
    expect(body.provider).toBe('openrouter');
    expect(body.costUsd).toBe(0.0012);
    expect(body.traceId).toBe('trace-usage-1');
  });

  it('the stream `done` frame still returns every pre-existing field', async () => {
    const app = await makeApp();
    primeRoute(routerResult({ finishReason: 'stop' }));

    const done = await postStreamDone(app);
    for (const f of [...REQUIRED_SYNC_FIELDS, 'type']) {
      expect(done, `missing pre-existing field ${f}`).toHaveProperty(f);
    }
    expect(done?.['type']).toBe('done');
    expect(done?.['text']).toBe('Hello Alice!');
    expect(done?.['costUsd']).toBe(0.0012);
  });

  it('costUsd keeps its own top-level home and its exact value', async () => {
    // Regression guard: the obvious "tidy-up" is to move cost inside `usage`.
    // That would break every existing consumer, so it is explicitly forbidden.
    const app = await makeApp();
    primeRoute(routerResult({ finishReason: 'stop' }));

    const body = (await postSync(app)).json();
    expect(body.costUsd).toBe(0.0012);
    expect(body.usage).not.toHaveProperty('costUsd');
    expect(body.usage).not.toHaveProperty('estimatedCostUsd');
  });

  it('a consumer that ignores the new fields sees an unchanged response', async () => {
    // Strip the additions; what remains must be byte-identical to the old
    // response shape.
    const app = await makeApp();
    primeRoute(routerResult({ finishReason: 'length' }));

    const body = (await postSync(app)).json();
    delete body.usage;
    delete body.finishReason;

    expect(body).toEqual({
      text: 'Hello Alice!',
      modelUsed: 'mock/model',
      provider: 'openrouter',
      costUsd: 0.0012,
      traceId: 'trace-usage-1',
      systemPromptApplied: false,
    });
  });
});
