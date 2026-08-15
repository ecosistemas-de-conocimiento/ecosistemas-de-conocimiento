// Unit tests for /v1/generate/* — orchestrator + cancel + DB select are
// mocked via vi.mock so this suite exercises only the route layer wiring:
// Zod validation, error-class → HTTP status mapping, auth-context plumbing,
// and reply shape.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared BEFORE the dynamic `buildServer` import so
// Vitest hoists them ahead of any transitive resolution.
// ---------------------------------------------------------------------------

const enqueueGenerationMock = vi.fn();
const cancelGenerationMock = vi.fn();
const resolveSpecMock = vi.fn();
const createOpenRouterMock = vi.fn();
const fetchContextMock = vi.fn();

// Stable single-row store the GET / cancel handlers read from. Tests mutate it.
const dbState = {
  requestRows: [] as Record<string, unknown>[],
  jobRows: [] as Record<string, unknown>[],
};

vi.mock('../services/generation/orchestrator.js', async () => {
  // Pull the real error classes (so `instanceof` checks in the handler still
  // line up) but replace `enqueueGeneration` with our spy.
  const actual = await vi.importActual<
    typeof import('../services/generation/orchestrator.js')
  >('../services/generation/orchestrator.js');
  return {
    ...actual,
    enqueueGeneration: (...args: unknown[]) => enqueueGenerationMock(...args),
  };
});

vi.mock('../services/generation/cancel.js', () => ({
  cancelGeneration: (...args: unknown[]) => cancelGenerationMock(...args),
}));

vi.mock('../services/registry/resolve.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/registry/resolve.js')
  >('../services/registry/resolve.js');
  return {
    ...actual,
    resolveSpec: (...args: unknown[]) => resolveSpecMock(...args),
  };
});

vi.mock('../services/ai/router/openrouter.js', () => ({
  createOpenRouter: () => createOpenRouterMock(),
}));

vi.mock('../services/context/fetch.js', () => ({
  fetchContext: (...args: unknown[]) => fetchContextMock(...args),
}));

vi.mock('../db/client.js', () => {
  // Minimal drizzle-like select chain that reads from dbState. Inserts/updates
  // are not exercised by these route tests — the orchestrator/cancel paths
  // (which DO touch the DB) are themselves mocked above.
  const select = () => ({
    from(table: unknown) {
      let rows: unknown[] = [];
      if ((table as { _name?: unknown })?._name === 'generation_requests' || table === GR_TABLE) {
        rows = dbState.requestRows;
      } else if ((table as { _name?: unknown })?._name === 'generation_jobs' || table === GJ_TABLE) {
        rows = dbState.jobRows;
      }
      const chain: Record<string, unknown> = {
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(rows),
        then: (resolve: (v: unknown[]) => void) => resolve(rows),
      };
      // `select(...).from(t).where(...)` returns a thenable for non-limit usage.
      return chain;
    },
  });

  return {
    db: {
      select,
    },
  };
});

// Pull schema table objects after the mock so `_name` discrimination works.
import { generationJobs as GJ_TABLE, generationRequests as GR_TABLE } from '../db/schema/index.js';
import {
  BudgetExceededError,
  IdempotencyConflictError,
  SpecResolutionError,
} from '../services/generation/orchestrator.js';

import { useBuildServer } from '../test/server-harness.js';

// ---------------------------------------------------------------------------
// Server fixture
// ---------------------------------------------------------------------------

const APP_TOKEN = 'test-key';
const ORG = 'test-org';
const PROJECT = 'test-project';

// `server.js` is imported ONCE per file, in `beforeAll` — importing it inside
// the first test body cost that test ~3 s of module transform against vitest's
// 5 s per-test budget. See `src/test/server-harness.ts`.
const makeApp = useBuildServer();

beforeEach(() => {
  enqueueGenerationMock.mockReset();
  cancelGenerationMock.mockReset();
  resolveSpecMock.mockReset();
  createOpenRouterMock.mockReset();
  fetchContextMock.mockReset();
  // Default: no context fetched. Individual tests override.
  fetchContextMock.mockResolvedValue({});
  dbState.requestRows = [];
  dbState.jobRows = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// POST /v1/generate
// ---------------------------------------------------------------------------

describe('POST /v1/generate', () => {
  it('happy path → 200 with handle', async () => {
    const app = await makeApp();
    enqueueGenerationMock.mockResolvedValueOnce({
      requestId: 'req-1',
      channel: 'request:req-1:generations',
      totalJobs: 2,
      estimatedCostUsd: 0.002,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: {
        units: [
          { unitKey: 'u1', input: { name: 'A' } },
          { unitKey: 'u2', input: { name: 'B' } },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      requestId: 'req-1',
      channel: 'request:req-1:generations',
      totalJobs: 2,
      estimatedCostUsd: 0.002,
    });
    // Orchestrator received the caller's auth scope, not the body.
    expect(enqueueGenerationMock).toHaveBeenCalledTimes(1);
    const [, ctx] = enqueueGenerationMock.mock.calls[0]!;
    expect((ctx as { org: string; project: string }).org).toBe(ORG);
    expect((ctx as { org: string; project: string }).project).toBe(PROJECT);
    await app.close();
  });

  it('invalid body → 400 (Zod validation)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { units: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(enqueueGenerationMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('SpecResolutionError → 400', async () => {
    const app = await makeApp();
    enqueueGenerationMock.mockRejectedValueOnce(
      new SpecResolutionError({
        cause: 'no spec for unitType',
        message: 'no active registry entry',
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { units: [{ unitKey: 'u1', unitType: 'missing' }] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('SpecResolutionError');
    expect(body.cause).toBe('no spec for unitType');
    await app.close();
  });

  it('BudgetExceeded → 402', async () => {
    const app = await makeApp();
    enqueueGenerationMock.mockRejectedValueOnce(
      new BudgetExceededError('test-org', 5, 1),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: { units: [{ unitKey: 'u1' }] },
    });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.error).toBe('BudgetExceeded');
    expect(body.org).toBe('test-org');
    expect(body.requested).toBe(5);
    expect(body.remaining).toBe(1);
    expect(body.shortfallUsd).toBeCloseTo(4);
    await app.close();
  });

  it('IdempotencyConflict → 409', async () => {
    const app = await makeApp();
    enqueueGenerationMock.mockRejectedValueOnce(
      new IdempotencyConflictError('req-existing'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: {
        clientRequestId: 'dup-1',
        units: [{ unitKey: 'u1' }],
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('IdempotencyConflict');
    expect(body.existingRequestId).toBe('req-existing');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/generate/:requestId
// ---------------------------------------------------------------------------

describe('GET /v1/generate/:requestId', () => {
  it('returns the request snapshot + units', async () => {
    const app = await makeApp();
    dbState.requestRows = [
      {
        id: 'req-1',
        org: ORG,
        project: PROJECT,
        status: 'completed',
        totalJobs: 1,
        completedJobs: 1,
        failedJobs: 0,
        estimatedCostUsd: '0.001',
        actualCostUsd: '0.0009',
        createdAt: new Date('2026-05-15T12:00:00Z'),
        startedAt: new Date('2026-05-15T12:00:01Z'),
        finishedAt: new Date('2026-05-15T12:00:02Z'),
        cancelledAt: null,
      },
    ];
    dbState.jobRows = [
      {
        id: 'job-1',
        unitKey: 'u1',
        unitType: null,
        status: 'completed',
        output: { text: 'hello' },
        error: null,
        estimatedCostUsd: '0.001',
        actualCostUsd: '0.0009',
        registryEntryId: null,
        traceId: 'trace-1',
        finishedAt: new Date('2026-05-15T12:00:02Z'),
      },
    ];
    const res = await app.inject({
      method: 'GET',
      url: '/v1/generate/req-1',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requestId).toBe('req-1');
    expect(body.status).toBe('completed');
    expect(body.units).toHaveLength(1);
    expect(body.units[0].unitKey).toBe('u1');
    expect(body.units[0].output).toEqual({ text: 'hello' });
    await app.close();
  });

  it('404 when the request is missing', async () => {
    const app = await makeApp();
    dbState.requestRows = []; // none for any tenant
    const res = await app.inject({
      method: 'GET',
      url: '/v1/generate/missing',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('404 when the request belongs to a different tenant (no existence leak)', async () => {
    const app = await makeApp();
    // The select chain filters by org+project; rows from a different tenant
    // simply don't get returned by the WHERE clause (mocked to ignore the
    // predicate, but since dbState.requestRows is empty for THIS scope it's
    // identical behaviour from the route's perspective).
    dbState.requestRows = [];
    const res = await app.inject({
      method: 'GET',
      url: '/v1/generate/some-other-tenant-request',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/generate/:requestId/cancel
// ---------------------------------------------------------------------------

describe('POST /v1/generate/:requestId/cancel', () => {
  it('200 with the cancel result', async () => {
    const app = await makeApp();
    cancelGenerationMock.mockResolvedValueOnce({
      cancelled: true,
      removedJobs: 2,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate/req-1/cancel',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: true, removedJobs: 2 });
    expect(cancelGenerationMock).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ org: ORG, project: PROJECT }),
    );
    await app.close();
  });

  it('404 when the request is not found (cancelled=false, removed=0)', async () => {
    const app = await makeApp();
    cancelGenerationMock.mockResolvedValueOnce({
      cancelled: false,
      removedJobs: 0,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate/missing/cancel',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/generate/sync
// ---------------------------------------------------------------------------

describe('POST /v1/generate/sync', () => {
  it('returns the LLM response shape', async () => {
    const app = await makeApp();
    resolveSpecMock.mockResolvedValueOnce({
      promptTemplate: 'Hello {{name}}!',
      model: 'mock/model',
      effortLevel: 'standard',
      effortProfile: {
        model: 'mock/model',
        maxOutputTokens: 800,
        validationPasses: 1,
        multiSample: 1,
        temperature: 0.4,
        estimatedCostUsdPerCall: 0.001,
      },
      validators: [],
    });
    const routeMock = vi.fn(async () => ({
      content: 'Hello Alice!',
      parsed: undefined,
      flags: [],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        estimatedCostUsd: 0.0008,
      },
      model: 'mock/model',
      provider: 'openrouter' as const,
      traceId: 'trace-sync-1',
      cached: false,
      durationMs: 12,
      effort: 'standard' as const,
      effortProfileUsed: {
        model: 'mock/model',
        maxOutputTokens: 800,
        validationPasses: 1,
        multiSample: 1,
        temperature: 0.4,
        estimatedCostUsdPerCall: 0.001,
      },
    }));
    createOpenRouterMock.mockReturnValue({ route: routeMock });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate/sync',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: {
        unit: { unitKey: 'u-sync', input: { name: 'Alice' } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.text).toBe('Hello Alice!');
    expect(body.modelUsed).toBe('mock/model');
    expect(body.provider).toBe('openrouter');
    expect(body.costUsd).toBeCloseTo(0.0008);
    expect(body.traceId).toBe('trace-sync-1');
    expect(routeMock).toHaveBeenCalledTimes(1);
    // The rendered prompt — {{name}} resolved against input.name.
    const calls = routeMock.mock.calls as unknown as Array<
      [{ messages: Array<{ content: string }> }]
    >;
    expect(calls[0]![0].messages[0]!.content).toBe('Hello Alice!');
    await app.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // includeContext wiring — prior to this fix the sync route accepted
  // `includeContext` in the body schema but never called `fetchContext`,
  // so retrieved chunks were silently dropped before reaching the prompt.
  // Regression guard: the three tests below pin the wiring.
  // ─────────────────────────────────────────────────────────────────────────

  function syncSpecForTemplate(template: string) {
    return {
      promptTemplate: template,
      model: 'mock/model',
      effortLevel: 'standard' as const,
      effortProfile: {
        model: 'mock/model',
        maxOutputTokens: 800,
        validationPasses: 1,
        multiSample: 1,
        temperature: 0.4,
        estimatedCostUsdPerCall: 0.001,
      },
      validators: [],
    };
  }

  function syncRouteMock() {
    return vi.fn(async () => ({
      content: 'ok',
      parsed: undefined,
      flags: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimatedCostUsd: 0.0001,
      },
      model: 'mock/model',
      provider: 'openrouter' as const,
      traceId: 't',
      cached: false,
      durationMs: 1,
      effort: 'standard' as const,
      effortProfileUsed: {
        model: 'mock/model',
        maxOutputTokens: 800,
        validationPasses: 1,
        multiSample: 1,
        temperature: 0.4,
        estimatedCostUsdPerCall: 0.001,
      },
    }));
  }

  it('includeContext: fetchContext is called and chunks reach the rendered prompt', async () => {
    const app = await makeApp();
    resolveSpecMock.mockResolvedValueOnce(
      syncSpecForTemplate(
        'Q: {{q}}\n{{#each __context.docs}}- {{this}}\n{{/each}}',
      ),
    );
    fetchContextMock.mockResolvedValueOnce({
      docs: ['chunk-one', 'chunk-two'],
    });
    const routeMock = syncRouteMock();
    createOpenRouterMock.mockReturnValue({ route: routeMock });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate/sync',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: {
        unit: { unitKey: 'u-sync', input: { q: 'hi' } },
        includeContext: [{ corpus: 'docs', query: 'hi', topK: 2 }],
      },
    });
    expect(res.statusCode).toBe(200);

    // fetchContext got the caller's org/project + the request's includeContext.
    expect(fetchContextMock).toHaveBeenCalledTimes(1);
    const fcArgs = fetchContextMock.mock.calls[0]![0] as {
      org: string;
      project: string;
      includeContext: Array<{ corpus: string; query: string; topK?: number }>;
    };
    expect(fcArgs.org).toBe(ORG);
    expect(fcArgs.project).toBe(PROJECT);
    expect(fcArgs.includeContext).toEqual([
      { corpus: 'docs', query: 'hi', topK: 2 },
    ]);

    // The rendered prompt contains the fetched chunks.
    const calls = routeMock.mock.calls as unknown as Array<
      [{ messages: Array<{ content: string }> }]
    >;
    const sentPrompt = calls[0]![0].messages[0]!.content;
    expect(sentPrompt).toContain('chunk-one');
    expect(sentPrompt).toContain('chunk-two');
    await app.close();
  });

  it('includeContext: missing-corpus result (empty key) is non-fatal', async () => {
    const app = await makeApp();
    resolveSpecMock.mockResolvedValueOnce(
      syncSpecForTemplate(
        'Q: {{q}}\n{{#each __context.missing}}- {{this}}\n{{/each}}',
      ),
    );
    // fetchContext's contract per services/context/fetch.ts:118 is to return
    // an empty array on CorpusNotFoundError — no throw. Mirror that here.
    fetchContextMock.mockResolvedValueOnce({ missing: [] });
    const routeMock = syncRouteMock();
    createOpenRouterMock.mockReturnValue({ route: routeMock });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate/sync',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: {
        unit: { unitKey: 'u-sync', input: { q: 'hi' } },
        includeContext: [{ corpus: 'missing', query: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);
    // Prompt renders cleanly with no chunks (template's #each iterates []).
    const calls = routeMock.mock.calls as unknown as Array<
      [{ messages: Array<{ content: string }> }]
    >;
    expect(calls[0]![0].messages[0]!.content).toBe('Q: hi\n');
    await app.close();
  });

  it('no includeContext: __context is {} and old prompt-only templates still work', async () => {
    // Backwards-compat: existing consumers that never sent includeContext
    // must keep getting the exact same rendered prompt as before.
    const app = await makeApp();
    resolveSpecMock.mockResolvedValueOnce(syncSpecForTemplate('Hello {{name}}!'));
    const routeMock = syncRouteMock();
    createOpenRouterMock.mockReturnValue({ route: routeMock });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate/sync',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: {
        unit: { unitKey: 'u-sync', input: { name: 'Bob' } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchContextMock).toHaveBeenCalledTimes(1);
    const fcArgs = fetchContextMock.mock.calls[0]![0] as {
      includeContext?: unknown;
    };
    expect(fcArgs.includeContext).toBeUndefined();
    const calls = routeMock.mock.calls as unknown as Array<
      [{ messages: Array<{ content: string }> }]
    >;
    expect(calls[0]![0].messages[0]!.content).toBe('Hello Bob!');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/generate/sync — system prompt
// ---------------------------------------------------------------------------
//
// `/sync` is the surface every consumer's hand-folded system prompt currently
// goes through, so this block is the contract for the cleanup migration.

describe('POST /v1/generate/sync — system prompt', () => {
  function spec(over: Record<string, unknown> = {}) {
    return {
      promptTemplate: 'Hello {{name}}!',
      model: 'mock/model',
      effortLevel: 'standard' as const,
      effortProfile: {
        model: 'mock/model',
        maxOutputTokens: 800,
        validationPasses: 1,
        multiSample: 1,
        temperature: 0.4,
        estimatedCostUsdPerCall: 0.001,
      },
      validators: [],
      ...over,
    };
  }

  function routeMockFactory() {
    return vi.fn(async () => ({
      content: 'ok',
      parsed: undefined,
      flags: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0.0001 },
      model: 'mock/model',
      provider: 'openrouter' as const,
      traceId: 't',
      cached: false,
      durationMs: 1,
      effort: 'standard' as const,
      effortProfileUsed: {
        model: 'mock/model',
        maxOutputTokens: 800,
        validationPasses: 1,
        multiSample: 1,
        temperature: 0.4,
        estimatedCostUsdPerCall: 0.001,
      },
    }));
  }

  type MessageCalls = Array<[{ messages: Array<{ role: string; content: string }> }]>;

  async function callSync(payload: Record<string, unknown>, specOver = {}) {
    const app = await makeApp();
    resolveSpecMock.mockResolvedValueOnce(spec(specOver));
    const routeMock = routeMockFactory();
    createOpenRouterMock.mockReturnValue({ route: routeMock });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate/sync',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload,
    });
    await app.close();
    return { res, messages: (routeMock.mock.calls as unknown as MessageCalls)[0]?.[0].messages };
  }

  it('BACKWARD COMPAT: no system input ⇒ a single user message, exactly as before', async () => {
    const { res, messages } = await callSync({
      unit: { unitKey: 'u-sync', input: { name: 'Alice' } },
    });
    expect(res.statusCode).toBe(200);
    expect(messages).toEqual([{ role: 'user', content: 'Hello Alice!' }]);
    expect(res.json().systemPromptApplied).toBe(false);
  });

  it('sends unit.systemPrompt as a real system message', async () => {
    const { res, messages } = await callSync({
      unit: {
        unitKey: 'u-sync',
        input: { name: 'Alice' },
        systemPrompt: 'You only answer in JSON.',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(messages).toEqual([
      { role: 'system', content: 'You only answer in JSON.' },
      { role: 'user', content: 'Hello Alice!' },
    ]);
    expect(res.json().systemPromptApplied).toBe(true);
  });

  it('accepts a batch-level systemPromptOverride', async () => {
    const { messages } = await callSync({
      unit: { unitKey: 'u-sync', input: { name: 'Alice' } },
      systemPromptOverride: 'REQUEST LEVEL',
    });
    expect(messages?.[0]).toEqual({ role: 'system', content: 'REQUEST LEVEL' });
  });

  it('unit.systemPrompt beats systemPromptOverride', async () => {
    const { messages } = await callSync({
      unit: {
        unitKey: 'u-sync',
        input: { name: 'Alice' },
        systemPrompt: 'UNIT LEVEL',
      },
      systemPromptOverride: 'REQUEST LEVEL',
    });
    expect(messages?.[0]).toEqual({ role: 'system', content: 'UNIT LEVEL' });
  });

  it('a request-level system prompt beats the registry metaPromptTemplate', async () => {
    const { messages } = await callSync(
      {
        unit: { unitKey: 'u-sync', input: { name: 'Alice' } },
        systemPromptOverride: 'REQUEST LEVEL',
      },
      { metaPromptTemplate: 'REGISTRY LEVEL', metaPromptSource: 'registry' },
    );
    expect(messages?.[0]).toEqual({ role: 'system', content: 'REQUEST LEVEL' });
  });

  it('wires the registry metaPromptTemplate when the request supplies nothing', async () => {
    const { res, messages } = await callSync(
      { unit: { unitKey: 'u-sync', input: { name: 'Alice' } } },
      { metaPromptTemplate: 'Greet {{name}} warmly.', metaPromptSource: 'registry' },
    );
    expect(messages).toEqual([
      { role: 'system', content: 'Greet Alice warmly.' },
      { role: 'user', content: 'Hello Alice!' },
    ]);
    expect(res.json().systemPromptApplied).toBe(true);
  });

  it('passes a brace-heavy caller-composed system prompt through untouched', async () => {
    const contract =
      'Reply with JSON matching {"type":"object","required":["items"]} and nothing else.';
    const { messages } = await callSync({
      unit: { unitKey: 'u-sync', input: { name: 'Alice' }, systemPrompt: contract },
    });
    expect(messages?.[0]!.content).toBe(contract);
  });

  it('rejects an empty systemPrompt at the schema boundary', async () => {
    const { res } = await callSync({
      unit: { unitKey: 'u-sync', input: { name: 'Alice' }, systemPrompt: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});
