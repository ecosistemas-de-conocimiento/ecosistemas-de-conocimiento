// Unit tests for /v1/generate/* — orchestrator + cancel + DB select are
// mocked via vi.mock so this suite exercises only the route layer wiring:
// Zod validation, error-class → HTTP status mapping, auth-context plumbing,
// and reply shape.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { WhereRecorder } from '../test/where-recorder.js';

// ---------------------------------------------------------------------------
// Module mocks — must be declared BEFORE the dynamic `buildServer` import so
// Vitest hoists them ahead of any transitive resolution.
// ---------------------------------------------------------------------------

const enqueueGenerationMock = vi.fn();
const cancelGenerationMock = vi.fn();
const resolveSpecMock = vi.fn();
const createOpenRouterMock = vi.fn();
const fetchContextMock = vi.fn();
/** The `retrievalTrace` the mocked `fetchContextWithTrace` returns. */
const retrievalTraceMock = vi.fn((): unknown[] => []);

// ⚠ `snapshotWhere` and `RecordedWhere` used to be defined here. They now come
// from `src/test/where-recorder.ts`: eighteen further test files carried the
// same parameterless-`where()` defect, and fixing each with its own private
// copy is how three subtly different `<NO PREDICATE>` conventions get born.
// The shared helper has its own mutation tests in
// `src/test/where-recorder.test.ts`, so the tripwire itself is proven to fail.

// Stable single-row store the GET / cancel handlers read from. Tests mutate it.
//
// 🔴 `wheres` EXISTS BECAUSE A STUB THAT DISCARDS ITS FILTER PROVES NOTHING.
// The chain below used to declare `where: () => chain` — no parameter — so the
// tenant predicate the route builds was thrown away and this file agreed with
// any WHERE clause at all, including none. It is now recorded and asserted on.
// (The full-strength proof, against a real Postgres with real foreign rows,
// lives in `src/routes/tenant-isolation.integration.test.ts`.)
//
// 🔴 AND `wheres` IS A `WhereRecorder`, NOT A BARE ARRAY, FOR ONE REASON:
// `guard()`. Recording the argument catches the mutation that EMPTIES a
// `.where()`; it is blind to the one that DELETES it. That was not theoretical
// here. `GET /v1/generate/:requestId` ends with
//
//     const jobRows = await db.select().from(generationJobs)
//                       .where(eq(generationJobs.generationRequestId, row.id));
//
// and the chain below is thenable, so deleting that `.where(...)` left
// `await …from(generationJobs)` resolving the full `jobRows` array — a
// cross-tenant read of every job in the table — with this file GREEN at 24/24
// (measured). Nothing reached `record()`, because `record()` only runs from
// inside `where`. A guard built per `from()` and settled on every terminal
// puts that chain in `calls` as `<NO PREDICATE>`, which is what the
// `expectNoUnfilteredQuery()` assertions below now catch.
const dbState = {
  requestRows: [] as Record<string, unknown>[],
  jobRows: [] as Record<string, unknown>[],
  wheres: new WhereRecorder(),
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
  // The routes call the trace variant; it wraps the same mock.
  fetchContextWithTrace: async (...args: unknown[]) => ({
    context: await fetchContextMock(...args),
    retrievalTrace: retrievalTraceMock(),
  }),
}));

vi.mock('../db/client.js', () => {
  // Minimal drizzle-like select chain that reads from dbState. Inserts/updates
  // are not exercised by these route tests — the orchestrator/cancel paths
  // (which DO touch the DB) are themselves mocked above.
  const select = () => ({
    from(table: unknown) {
      let rows: unknown[] = [];
      let tableName = 'unknown';
      if ((table as { _name?: unknown })?._name === 'generation_requests' || table === GR_TABLE) {
        rows = dbState.requestRows;
        tableName = 'generation_requests';
      } else if ((table as { _name?: unknown })?._name === 'generation_jobs' || table === GJ_TABLE) {
        rows = dbState.jobRows;
        tableName = 'generation_jobs';
      }
      // ONE guard per chain instance — per `from()`. Anything else and two
      // queries in the same handler share a `filtered` flag, so the first
      // one's predicate would excuse the second one's absence.
      const guard = dbState.wheres.guard(tableName);
      const chain: Record<string, unknown> = {
        // 🔴 TAKES its argument — see the `wheres` comment above.
        where: (predicate: unknown) => {
          guard.where(predicate);
          return chain;
        },
        // NOT a terminal: `.orderBy()` hands the builder back, so settling here
        // would record a chain that has not run yet.
        orderBy: () => chain,
        // EVERY terminal settles through the guard. `then` is the load-bearing
        // one: `await db.select().from(t)` with the `.where()` deleted lands
        // here and nowhere else.
        limit: () => guard.settle(Promise.resolve(rows)),
        then: (resolve: (v: unknown[]) => void) => resolve(guard.settle(rows)),
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
import { CorpusNotFoundError } from '../services/rag/errors.js';

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
  retrievalTraceMock.mockReset();
  retrievalTraceMock.mockReturnValue([]);
  // Default: no context fetched. Individual tests override.
  fetchContextMock.mockResolvedValue({});
  dbState.requestRows = [];
  dbState.jobRows = [];
  dbState.wheres.reset();
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
    // …and a logger in deps. The orchestrator forwards it to `fetchContext`,
    // which hands it to the RetrieveService that clamps over-bound stored
    // chunks — without it the async generate path clamps silently.
    const [, , deps] = enqueueGenerationMock.mock.calls[0]!;
    expect((deps as { logger?: { warn: unknown } }).logger).toBeDefined();
    expect(typeof (deps as { logger: { warn: unknown } }).logger.warn).toBe('function');
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

    // 🔴 THE ASSERTION THAT CATCHES A DELETED `.where()` RATHER THAN AN
    // EMPTIED ONE — and the only test in this file that reaches the handler's
    // SECOND query, because the scoping tests below all 404 before it.
    //
    // This handler runs two queries: the request lookup (id + org + project,
    // asserted column-by-column further down) and then a jobs lookup scoped to
    // the PARENT request id. The second is deliberately NOT tenant-scoped —
    // `row.id` was itself fetched under the tenant predicate, so re-filtering
    // on (org, project) would be redundant. That is why `expectScopedTo` is
    // the wrong tool for it. What it must never be is UNFILTERED: delete
    // `.where(eq(generationJobs.generationRequestId, row.id))` and the reply
    // carries every tenant's jobs. Measured before the guard was wired: that
    // deletion left this file GREEN at 24/24.
    dbState.wheres.expectNoUnfilteredQuery();
    // Both queries reached the stub, in order. A count, so a chain that
    // silently stopped running could not satisfy the line above vacuously.
    expect(dbState.wheres.calls.map((c) => c.table)).toEqual([
      'generation_requests',
      'generation_jobs',
    ]);
    // The jobs lookup is the one whose scope is the parent row, not the tenant.
    expect(dbState.wheres.for('generation_jobs')[0]!.sql).toContain(
      '"generation_jobs"."generation_request_id" =',
    );
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

  it('404 — not 403 — when the lookup returns nothing, so the status code alone leaks no existence', async () => {
    const app = await makeApp();
    // ⚠ THIS IS NOT A TENANT-ISOLATION TEST, and it used to claim to be one.
    // The db here is a stub whose `where()` ignores the predicate, so emptying
    // `requestRows` proves only what the ROUTE does with an empty result set:
    // it answers 404 rather than 403, which is the no-existence-leak half of
    // the contract. Whether a foreign tenant's row is actually excluded is a
    // property of the WHERE clause, and a mock cannot demonstrate it.
    //
    // 🔴 The real proof runs against a real Postgres, with a REAL foreign
    // request id, in `src/routes/tenant-isolation.integration.test.ts`
    // ("cross-ORG: GET /v1/generate/:requestId with a REAL foreign id is 404").
    dbState.requestRows = [];
    const res = await app.inject({
      method: 'GET',
      url: '/v1/generate/some-other-tenant-request',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('🔴 scopes the request lookup by id AND org AND project — a dropped tenant filter fails here', async () => {
    // The stub now RECORDS the predicate it is handed (see `dbState.wheres`),
    // so this asserts on the SQL the route actually built rather than on a
    // row array the test itself emptied. Column by column, so dropping any one
    // of the three is its own distinct failure.
    const app = await makeApp();
    dbState.requestRows = [];
    await app.inject({
      method: 'GET',
      url: '/v1/generate/req-42',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });

    // Reported BEFORE the column checks: with the guard wired, a deleted
    // `.where()` arrives here as `<NO PREDICATE>`, and this says so by name
    // instead of failing on a `toContain` that just prints a missing substring.
    dbState.wheres.expectNoUnfilteredQuery();
    const lookup = dbState.wheres.for('generation_requests')[0];
    expect(lookup).toBeDefined();
    expect(lookup!.sql).toContain('"generation_requests"."id" =');
    expect(lookup!.sql).toContain('"generation_requests"."org" =');
    expect(lookup!.sql).toContain('"generation_requests"."project" =');
    // Bound to the CALLER's scope — a predicate naming the right columns but
    // binding the wrong values would pass the checks above.
    expect(lookup!.params).toEqual(['req-42', ORG, PROJECT]);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/generate/units/:unitKey/latest
// ---------------------------------------------------------------------------

describe('GET /v1/generate/units/:unitKey/latest', () => {
  it('🔴 scopes the job lookup by org AND project AND unitKey — a dropped tenant filter fails here', async () => {
    // A shared `unitKey` across tenants is the dangerous shape here: the route
    // orders by `createdAt desc` and takes ONE row, so without the tenant
    // predicate the caller receives whichever tenant wrote most recently. The
    // real-database version of this case is in
    // `src/routes/tenant-isolation.integration.test.ts`.
    const app = await makeApp();
    dbState.jobRows = [];
    await app.inject({
      method: 'GET',
      url: '/v1/generate/units/u-shared/latest',
      headers: { authorization: `Bearer ${APP_TOKEN}` },
    });

    // As above: names a deleted `.where()` as `<NO PREDICATE>` rather than
    // leaving it to a substring check.
    dbState.wheres.expectNoUnfilteredQuery();
    const lookup = dbState.wheres.for('generation_jobs')[0];
    expect(lookup).toBeDefined();
    expect(lookup!.sql).toContain('"generation_jobs"."org" =');
    expect(lookup!.sql).toContain('"generation_jobs"."project" =');
    expect(lookup!.sql).toContain('"generation_jobs"."unit_key" =');
    expect(lookup!.params).toEqual([ORG, PROJECT, 'u-shared']);
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
      // Third argument added by phase 2: the route now passes the generation
      // queue explicitly (`app.runtime.queues.generation`) instead of letting
      // `cancelGeneration` reach for a module-scope singleton. The first two
      // arguments — the assertion this case exists for — are unchanged.
      expect.objectContaining({ queue: expect.anything() }),
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

  it('includeContext: a missing corpus is a 404 and the model is never called', async () => {
    // AIS-3: this used to render an empty `__context` and answer 200 —
    // ungrounded, and indistinguishable from a grounded answer.
    const app = await makeApp();
    resolveSpecMock.mockResolvedValueOnce(syncSpecForTemplate('Q: {{q}}'));
    fetchContextMock.mockRejectedValueOnce(
      new CorpusNotFoundError({ corpus: 'missing', org: ORG, project: PROJECT }),
    );
    const routeMock = syncRouteMock();
    createOpenRouterMock.mockReturnValue({ route: routeMock });

    for (const url of ['/v1/generate/sync', '/v1/generate/stream']) {
      if (url.endsWith('stream')) {
        resolveSpecMock.mockResolvedValueOnce(syncSpecForTemplate('Q: {{q}}'));
        fetchContextMock.mockRejectedValueOnce(
          new CorpusNotFoundError({ corpus: 'missing', org: ORG, project: PROJECT }),
        );
      }
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${APP_TOKEN}` },
        payload: {
          unit: { unitKey: 'u-sync', input: { q: 'hi' } },
          includeContext: [{ corpus: 'missing', query: 'hi' }],
        },
      });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({
        error: { code: 'CORPUS_NOT_FOUND', message: expect.stringContaining('missing') },
      });
    }
    expect(routeMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('includeContext: the response carries the retrievalTrace (sync body and stream done frame)', async () => {
    const app = await makeApp();
    const trace = [{ key: 'docs', corpus: 'docs', chunkIds: ['c1'], legs: ['dense'] }];
    for (const url of ['/v1/generate/sync', '/v1/generate/stream']) {
      resolveSpecMock.mockResolvedValueOnce(syncSpecForTemplate('Q: {{q}}'));
      fetchContextMock.mockResolvedValueOnce({ docs: ['chunk-one'] });
      retrievalTraceMock.mockReturnValueOnce(trace);
      createOpenRouterMock.mockReturnValue({ route: syncRouteMock() });
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${APP_TOKEN}` },
        payload: {
          unit: { unitKey: 'u-sync', input: { q: 'hi' } },
          includeContext: [{ corpus: 'docs', query: 'hi' }],
        },
      });
      expect(res.statusCode, url).toBe(200);
      const body = url.endsWith('sync')
        ? res.json()
        : (JSON.parse(
            res.body
              .split('\n\n')
              .filter((f) => f.startsWith('data: '))
              .map((f) => f.slice('data: '.length))
              .find((f) => f.includes('"done"'))!,
          ) as Record<string, unknown>);
      expect(body.retrievalTrace, url).toEqual(trace);
    }
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
