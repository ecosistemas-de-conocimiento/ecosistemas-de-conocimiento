// Unit tests for processGenerationJob.
//
// Pattern (same as services/generation/cancel.test.ts + orchestrator.test.ts):
//   - drizzle `db` is replaced with a tiny stub that exposes the chainable
//     surface processGenerationJob touches (`select`, `update`, `transaction`,
//     `execute`). `transaction(fn)` calls `fn(stub)` so the recorder catches
//     in-tx writes too.
//   - The router is a `vi.fn()` returning a canned `RouteResult`.
//   - The event bus is a fresh `createEventBus()` per test.
//   - We mock `resolveSpec` via `vi.mock` so we don't have to populate
//     project_configs / registry rows in the stub.
//   - `setImmediate` is overridden per test (assigned to `global.setImmediate`)
//     to run callbacks synchronously when we want to assert callback POSTs.
//
// We do NOT exercise `startGenerationWorker` — that touches Redis. The
// processGenerationJob function is the unit under test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client.js';
import {
  generationJobs,
  generationRequests,
  projectConfigs,
} from '../db/schema/index.js';
import { createEventBus, type EventBus } from '../services/events/bus.js';
import type { AppEvent } from '../services/events/types.js';
import type { LLMRouter, RouteResult } from '../services/ai/router/types.js';
import type { ResolvedSpec } from '../services/registry/resolve.js';
import type { GenerationJobData } from '../types/generation.js';

// Mock resolveSpec at the module boundary so the worker's call doesn't hit
// the real DB code path. The test injects a `vi.fn()` per case via the
// mocked module's named export.
vi.mock('../services/registry/resolve.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/registry/resolve.js')
  >('../services/registry/resolve.js');
  return {
    ...actual,
    resolveSpec: vi.fn(),
  };
});

import { resolveSpec } from '../services/registry/resolve.js';

import { processGenerationJob } from './generation.worker.js';

// ---------------------------------------------------------------------------
// Stub DB
// ---------------------------------------------------------------------------

type JobRow = typeof generationJobs.$inferSelect;
type RequestRow = typeof generationRequests.$inferSelect;

interface StubState {
  jobs: Map<string, Partial<JobRow> & { id: string }>;
  requests: Map<string, Partial<RequestRow> & { id: string }>;
  projectConfigs: Array<{
    org: string;
    project: string;
    callbackUrl?: string | null;
  }>;
  updates: Array<{
    table: 'jobs' | 'requests';
    set: Record<string, unknown>;
    whereId?: string;
  }>;
  executes: Array<{ sql: string }>;
  /** Callback-deliveries rows the worker inserted via `enqueueCallback`. */
  callbackDeliveries: Array<Record<string, unknown>>;
}

function makeState(): StubState {
  return {
    jobs: new Map(),
    requests: new Map(),
    projectConfigs: [],
    updates: [],
    executes: [],
    callbackDeliveries: [],
  };
}

/**
 * Build a chainable select-result handle. The worker uses two access shapes:
 *   - `.where(...).limit(1)` → Promise<rows>
 *   - `.where(...)` (no `.limit`) → Promise<rows> (jobs sibling fetch)
 * The chain returns the SAME rows for both shapes; callers pass already-filtered
 * data via the state-resolver function.
 */
function selectChain(rowsFn: () => unknown[]) {
  const chain: {
    where: (...args: unknown[]) => typeof chain;
    limit: (n: number) => Promise<unknown[]>;
    then: (resolve: (v: unknown[]) => void) => void;
  } = {
    where: () => chain,
    limit: async () => rowsFn(),
    then: (resolve) => {
      Promise.resolve(rowsFn()).then(resolve);
    },
  };
  return chain;
}

/** Flatten a drizzle `sql\`...\`` template into a plain string for test asserts. */
function stringifySql(q: unknown): string {
  if (q == null) return '';
  if (typeof q === 'string') return q;
  if (typeof q === 'object' && 'queryChunks' in q) {
    const chunks = (q as { queryChunks: unknown[] }).queryChunks;
    return chunks
      .map((c) => {
        if (c && typeof c === 'object' && 'value' in c) {
          const v = (c as { value: unknown }).value;
          if (Array.isArray(v)) return v.join('');
          return String(v ?? '');
        }
        return String(c ?? '');
      })
      .join('');
  }
  return String(q);
}

function makeDb(state: StubState): Db {
  const stub: Record<string, unknown> = {
    select(_cols?: unknown) {
      // Track the table queried so the chain returns the right rows.
      let table: unknown = null;
      return {
        from(t: unknown) {
          table = t;
          return selectChain(() => {
            if (table === generationJobs) {
              return Array.from(state.jobs.values());
            }
            if (table === generationRequests) {
              return Array.from(state.requests.values());
            }
            if (table === projectConfigs) {
              return state.projectConfigs;
            }
            return [];
          });
        },
      };
    },
    update(table: unknown) {
      const which: 'jobs' | 'requests' =
        table === generationJobs ? 'jobs' : 'requests';
      return {
        set(values: Record<string, unknown>) {
          const captured: Record<string, unknown> = { ...values };
          const upd: StubState['updates'][number] = {
            table: which,
            set: captured,
          };
          state.updates.push(upd);
          return {
            where() {
              // Apply the SET to the first matching row we know about. The
              // worker scopes by `id`, so we apply to the entire map and let
              // the tests inspect the recorded `updates` array for ordering.
              if (which === 'jobs') {
                for (const [id, row] of state.jobs) {
                  state.jobs.set(id, { ...row, ...resolveSqlExprs(captured, row) });
                }
              } else {
                for (const [id, row] of state.requests) {
                  state.requests.set(id, {
                    ...row,
                    ...resolveSqlExprs(captured, row),
                  });
                }
              }
              return Promise.resolve();
            },
          };
        },
      };
    },
    async transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(stub);
    },
    async execute(q: unknown) {
      // jsonb_set UPDATE for __renderedPrompt — accept and record it.
      state.executes.push({ sql: stringifySql(q) });
      return { rows: [] };
    },
    /**
     * `insert(callbackDeliveries).values(...).returning(...)` from
     * `enqueueCallback`. We don't care about other inserts — there are none
     * in the worker path.
     */
    insert(_table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          const row = { id: `mock-delivery-${state.callbackDeliveries.length + 1}`, ...v };
          state.callbackDeliveries.push(row);
          const out = Promise.resolve();
          return Object.assign(out, {
            returning() {
              return Promise.resolve([{ id: row.id }]);
            },
          });
        },
      };
    },
  };
  return stub as unknown as Db;
}

/**
 * SQL template tags emitted by drizzle's `sql\`\`` carry a `.queryChunks`
 * shape we don't want to evaluate. We swap them out with a flat increment
 * applied against the current row so counter logic stays observable in tests.
 */
function resolveSqlExprs(
  values: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v && typeof v === 'object' && ('queryChunks' in v || 'sql' in v)) {
      // Counter bumps — apply the known shapes manually.
      if (k === 'completedJobs') {
        out[k] = (Number(current[k] ?? 0) || 0) + 1;
      } else if (k === 'failedJobs') {
        out[k] = (Number(current[k] ?? 0) || 0) + 1;
      } else if (k === 'actualCostUsd') {
        // Best-effort: add a numeric cost the test passed in via the route
        // result. The SQL chunk shape carries the literal we want — but it's
        // not stable across drizzle versions; we extract the numeric literal
        // from String(v) as a fallback.
        const text = String(v);
        const match = text.match(/[\d.]+/g);
        const delta = match ? Number(match[match.length - 1]) : 0;
        out[k] = (Number(current[k] ?? 0) || 0) + (isFinite(delta) ? delta : 0);
      } else {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG = 'test-org';
const PROJECT = 'test-project';
const REQ_ID = '11111111-2222-3333-4444-555555555555';
const JOB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeJobRow(over: Partial<JobRow> = {}): Partial<JobRow> & { id: string } {
  return {
    id: JOB_ID,
    generationRequestId: REQ_ID,
    org: ORG,
    project: PROJECT,
    unitKey: 'u1',
    unitType: null,
    dependsOn: null,
    input: { __renderedPrompt: 'leaf prompt' },
    output: null,
    registryEntryId: null,
    specOverride: null,
    status: 'queued',
    attempts: 0,
    error: null,
    effort: 'standard',
    priority: 5,
    traceId: '99999999-1111-2222-3333-444444444444',
    queueJobId: null,
    estimatedCostUsd: '0.001',
    actualCostUsd: null,
    metadata: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    ...over,
  };
}

function makeRequestRow(over: Partial<RequestRow> = {}): Partial<RequestRow> & {
  id: string;
} {
  return {
    id: REQ_ID,
    org: ORG,
    project: PROJECT,
    requestedBy: null,
    clientRequestId: null,
    status: 'queued',
    totalJobs: 1,
    completedJobs: 0,
    failedJobs: 0,
    effort: 'standard',
    effortOverrides: null,
    promptOverride: null,
    metaPromptOverride: null,
    modelOverride: null,
    includeContext: null,
    callbackUrl: null,
    estimatedCostUsd: '0.001',
    actualCostUsd: '0',
    metadata: null,
    startedAt: new Date(),
    finishedAt: null,
    cancelledAt: null,
    createdAt: new Date(),
    ...over,
  };
}

function makeSpec(over: Partial<ResolvedSpec> = {}): ResolvedSpec {
  return {
    promptTemplate: 'unused at worker time',
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
    registryEntryId: 'reg-1',
    registryEntryVersion: '1',
    ...over,
  };
}

function makeRouteResult(over: Partial<RouteResult> = {}): RouteResult {
  return {
    content: 'router output content',
    flags: [],
    usage: {
      inputTokens: 5,
      outputTokens: 10,
      totalTokens: 15,
      estimatedCostUsd: 0.0005,
    },
    model: 'mock/model',
    provider: 'openrouter',
    traceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    cached: false,
    durationMs: 12,
    effort: 'standard',
    effortProfileUsed: {
      model: 'mock/model',
      maxOutputTokens: 800,
      validationPasses: 1,
      multiSample: 1,
      temperature: 0.4,
      estimatedCostUsdPerCall: 0.001,
    },
    ...over,
  };
}

function jobData(over: Partial<GenerationJobData> = {}): GenerationJobData {
  return {
    jobId: JOB_ID,
    generationRequestId: REQ_ID,
    org: ORG,
    project: PROJECT,
    unitKey: 'u1',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Common fixtures
// ---------------------------------------------------------------------------

let state: StubState;
let db: Db;
let bus: EventBus;
let events: AppEvent[];
let router: LLMRouter & { route: ReturnType<typeof vi.fn> };
let originalSetImmediate: typeof setImmediate;

beforeEach(() => {
  state = makeState();
  db = makeDb(state);
  bus = createEventBus();
  events = [];
  bus.onAny((e) => events.push(e));
  router = {
    route: vi.fn(async () => makeRouteResult()),
  };
  vi.mocked(resolveSpec).mockReset();
  vi.mocked(resolveSpec).mockResolvedValue(makeSpec());
  originalSetImmediate = global.setImmediate;
});

afterEach(() => {
  global.setImmediate = originalSetImmediate;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processGenerationJob', () => {
  it('happy path leaf unit — uses __renderedPrompt, writes output, bumps counter', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 2 }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).toHaveBeenCalledTimes(1);
    const routeArg = router.route.mock.calls[0]![0];
    expect(routeArg.messages).toEqual([
      { role: 'user', content: 'leaf prompt' },
    ]);
    expect(routeArg.org).toBe(ORG);
    expect(routeArg.label).toBe('unit:u1');

    // The first job row update is the 'running' marker; later updates write
    // status/output/cost.
    const jobUpdates = state.updates.filter((u) => u.table === 'jobs');
    const runMark = jobUpdates.find((u) => u.set.status === 'running');
    expect(runMark).toBeDefined();
    const finalWrite = jobUpdates.find((u) => u.set.status === 'completed');
    expect(finalWrite).toBeDefined();
    expect(finalWrite!.set.output).toEqual({
      text: 'router output content',
      flags: [],
    });

    // generation.job.started + generation.job.completed
    const types = events.map((e) => e.type);
    expect(types).toContain('generation.job.started');
    expect(types).toContain('generation.job.completed');
    // Parent not terminal yet (totalJobs=2, only one completed).
    expect(types).not.toContain('generation.request.completed');
  });

  it('dependent unit — renders prompt with predecessor output, writes back to row', async () => {
    const predUnitKey = 'pred-1';
    const predId = 'pred-id-1';
    state.jobs.set(JOB_ID, makeJobRow({
      dependsOn: { context: predUnitKey },
      input: {
        __promptTemplate: 'Q: {{question}} CTX: {{context}}',
        __promptVars: { question: 'why?' },
      },
    }));
    state.jobs.set(predId, {
      id: predId,
      generationRequestId: REQ_ID,
      org: ORG,
      project: PROJECT,
      unitKey: predUnitKey,
      status: 'completed',
      output: 'because',
    });
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 2 }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).toHaveBeenCalledTimes(1);
    const routeArg = router.route.mock.calls[0]![0];
    expect(routeArg.messages[0].content).toBe('Q: why? CTX: because');

    // jsonb_set UPDATE was issued to persist __renderedPrompt.
    expect(state.executes.length).toBeGreaterThanOrEqual(1);
    const renderedExecute = state.executes.find((e) =>
      e.sql.includes('__renderedPrompt'),
    );
    expect(renderedExecute).toBeDefined();
  });

  it('predecessor failed — marks job failed without calling router', async () => {
    const predUnitKey = 'pred-1';
    const predId = 'pred-id-1';
    state.jobs.set(JOB_ID, makeJobRow({
      dependsOn: { slot: predUnitKey },
      input: { __promptTemplate: 'X {{slot}}' },
    }));
    state.jobs.set(predId, {
      id: predId,
      generationRequestId: REQ_ID,
      org: ORG,
      project: PROJECT,
      unitKey: predUnitKey,
      status: 'failed',
      output: null,
    });
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 2 }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).not.toHaveBeenCalled();
    const failed = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'failed',
    );
    expect(failed).toBeDefined();
    expect(String(failed!.set.error)).toContain("predecessor unitKey 'pred-1'");
    const types = events.map((e) => e.type);
    expect(types).toContain('generation.job.failed');
  });

  it('validator blocker — retry once with refine-style messages, use retry if clean', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ totalJobs: 1 }));

    router.route
      .mockResolvedValueOnce(
        makeRouteResult({
          content: 'first draft',
          flags: [
            { severity: 'blocker', code: 'json-schema', message: 'missing field' },
          ],
        }),
      )
      .mockResolvedValueOnce(makeRouteResult({ content: 'clean retry' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).toHaveBeenCalledTimes(2);
    const retryArg = router.route.mock.calls[1]![0];
    expect(retryArg.messages).toHaveLength(3);
    expect(retryArg.messages[0].role).toBe('user');
    expect(retryArg.messages[1].role).toBe('assistant');
    expect(retryArg.messages[1].content).toBe('first draft');
    expect(retryArg.messages[2].role).toBe('user');
    expect(String(retryArg.messages[2].content)).toContain('failed validation');

    const completed = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'completed',
    );
    expect(completed).toBeDefined();
    expect(completed!.set.output).toEqual({
      text: 'clean retry',
      flags: [],
    });
    // ADR-0003 S2: the job's actual cost must be the SUM of BOTH router calls
    // (the discarded first draft + the winning retry), not just the final
    // result — each call wrote a trace and spent real budget. Both fixtures
    // carry usage.estimatedCostUsd = 0.0005, so the rollup is 0.001, not 0.0005.
    expect(completed!.set.actualCostUsd).toBe((0.0005 + 0.0005).toFixed(6));
  });

  it('cancel before pickup — parent cancelled, no router call, job marked cancelled', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow({ status: 'cancelled' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).not.toHaveBeenCalled();
    const cancelled = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'cancelled',
    );
    expect(cancelled).toBeDefined();
    expect(events).toHaveLength(0);
  });

  it('cancel via abort signal — router throws OpenRouterAbortError, job cancelled with partial cost', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow());

    // Import lazily so the mock-aware setup at the top of the file applies.
    const { OpenRouterAbortError } = await import(
      '../services/ai/router/adapters/openrouter.js'
    );

    const partial = {
      contentText: 'partial reply…',
      finishReason: 'aborted' as const,
      model: 'mock/model',
      usage: {
        promptTokens: 25,
        completionTokens: 18,
        costUsd: 0.000234,
        costSource: 'pricing-table' as const,
      },
    };

    // Simulate the pub/sub fast path: the cancel-bus subscriber would normally
    // call ctrl.abort() on the in-flight controller, and the router's
    // streaming adapter would then throw OpenRouterAbortError carrying partial
    // usage. We assert the worker records the partial cost on the job row.
    router.route.mockImplementationOnce(async () => {
      throw new OpenRouterAbortError(partial);
    });

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).toHaveBeenCalledTimes(1);
    const cancelled = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'cancelled',
    );
    expect(cancelled).toBeDefined();
    // The job row carries the partial cost (priced from the deltas the
    // router accumulated before the abort).
    expect(cancelled?.set.actualCostUsd).toBe(partial.usage.costUsd.toFixed(6));
  });

  it('cancel mid-flight — parent flips during router call, output discarded, job cancelled', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow());

    router.route.mockImplementationOnce(async () => {
      // Simulate the parent flipping to cancelled while the router was busy.
      state.requests.set(
        REQ_ID,
        makeRequestRow({ status: 'cancelled' }),
      );
      return makeRouteResult();
    });

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    expect(router.route).toHaveBeenCalledTimes(1);
    // After the post-LLM cancel-check the job is set to cancelled, not completed.
    const completed = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'completed',
    );
    expect(completed).toBeUndefined();
    const cancelled = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'cancelled',
    );
    expect(cancelled).toBeDefined();
  });

  it('terminal parent transition — last sibling completes, callback contract envelope enqueued', async () => {
    // totalJobs=1 ⇒ this single completion drives the parent to terminal.
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(
      REQ_ID,
      makeRequestRow({
        totalJobs: 1,
        callbackUrl: 'https://callback.example/ai-service',
      }),
    );

    await processGenerationJob({ id: 'q-1', data: jobData() }, {
      db,
      router,
      bus,
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('generation.request.completed');
    const finalEvent = events.find(
      (e) => e.type === 'generation.request.completed',
    );
    expect(finalEvent).toBeDefined();
    if (finalEvent && finalEvent.type === 'generation.request.completed') {
      expect(finalEvent.status).toBe('completed');
    }

    // The worker enqueues callback envelopes through `enqueueCallback`, which
    // INSERTs into `callback_deliveries`. We verify the unit + request
    // terminal envelopes landed at the right URL with the right event types.
    const events_enqueued = state.callbackDeliveries.map((row) => ({
      event: row.event,
      url: row.url,
      source: row.source,
    }));
    expect(events_enqueued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'unit.completed',
          url: 'https://callback.example/ai-service',
          source: 'generate',
        }),
        expect.objectContaining({
          event: 'request.completed',
          url: 'https://callback.example/ai-service',
          source: 'generate',
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// System prompt (precedence + both router calls)
// ---------------------------------------------------------------------------
//
// The backward-compatibility assertion lives in the happy-path test above,
// which pins `messages` to exactly `[{ role: 'user', … }]` when nothing supplies
// a system prompt. These cases cover the wiring on top of it.

// The spec FLOOR survives the queue only because the orchestrator stashed it on
// `input.__specDefault`. If the worker stopped reading it, an async unit whose
// project has registered nothing would resolve with no prompt at all — a
// failure that looks like a registry problem and is not.

describe('processGenerationJob — spec floor', () => {
  it('passes `input.__specDefault` to resolveSpec', async () => {
    state.jobs.set(
      JOB_ID,
      makeJobRow({
        input: {
          __renderedPrompt: 'leaf prompt',
          __specDefault: { promptTemplate: 'FLOOR', effortLevel: 'quick' },
        },
      }),
    );
    state.requests.set(REQ_ID, makeRequestRow());

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(vi.mocked(resolveSpec).mock.calls[0]![1]).toMatchObject({
      specDefault: { promptTemplate: 'FLOOR', effortLevel: 'quick' },
    });
  });

  it('BACKWARD COMPAT: no floor on the row ⇒ specDefault is undefined', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow());

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(vi.mocked(resolveSpec).mock.calls[0]![1].specDefault).toBeUndefined();
  });
});

describe('processGenerationJob — system prompt', () => {
  it('sends `input.__systemPrompt` as a real system message', async () => {
    state.jobs.set(
      JOB_ID,
      makeJobRow({
        input: { __renderedPrompt: 'leaf prompt', __systemPrompt: 'YOU ARE TERSE' },
      }),
    );
    state.requests.set(REQ_ID, makeRequestRow());

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(router.route.mock.calls[0]![0].messages).toEqual([
      { role: 'system', content: 'YOU ARE TERSE' },
      { role: 'user', content: 'leaf prompt' },
    ]);
  });

  it('falls back to generation_requests.meta_prompt_override (batch-level)', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(
      REQ_ID,
      makeRequestRow({ metaPromptOverride: 'BATCH CONTRACT' }),
    );

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(router.route.mock.calls[0]![0].messages).toEqual([
      { role: 'system', content: 'BATCH CONTRACT' },
      { role: 'user', content: 'leaf prompt' },
    ]);
  });

  it('per-unit __systemPrompt beats the batch-level meta_prompt_override', async () => {
    state.jobs.set(
      JOB_ID,
      makeJobRow({
        input: { __renderedPrompt: 'leaf prompt', __systemPrompt: 'UNIT WINS' },
      }),
    );
    state.requests.set(REQ_ID, makeRequestRow({ metaPromptOverride: 'BATCH' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(router.route.mock.calls[0]![0].messages[0]).toEqual({
      role: 'system',
      content: 'UNIT WINS',
    });
  });

  it('wires the registry metaPromptTemplate and renders it with the prompt vars', async () => {
    vi.mocked(resolveSpec).mockResolvedValue(
      makeSpec({
        metaPromptTemplate: 'You write for {{audience}}.',
        metaPromptSource: 'registry',
      }),
    );
    state.jobs.set(
      JOB_ID,
      makeJobRow({
        input: { __renderedPrompt: 'leaf prompt', audience: 'vecinos' },
      }),
    );
    state.requests.set(REQ_ID, makeRequestRow());

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(router.route.mock.calls[0]![0].messages[0]).toEqual({
      role: 'system',
      content: 'You write for vecinos.',
    });
  });

  it('carries the system message into the validator-retry call too', async () => {
    state.jobs.set(
      JOB_ID,
      makeJobRow({
        input: { __renderedPrompt: 'leaf prompt', __systemPrompt: 'JSON ONLY' },
      }),
    );
    state.requests.set(REQ_ID, makeRequestRow());

    // First pass carries a blocker ⇒ one refine retry; second pass is clean.
    router.route
      .mockResolvedValueOnce(
        makeRouteResult({
          flags: [{ severity: 'blocker', code: 'json-parse-error', message: 'nope' }],
        }),
      )
      .mockResolvedValueOnce(makeRouteResult({ content: 'fixed' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(router.route).toHaveBeenCalledTimes(2);
    const retryMessages = router.route.mock.calls[1]![0].messages;
    expect(retryMessages[0]).toEqual({ role: 'system', content: 'JSON ONLY' });
    expect(retryMessages.map((m: { role: string }) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('retry stays system-less when no system prompt was supplied', async () => {
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow());
    router.route
      .mockResolvedValueOnce(
        makeRouteResult({
          flags: [{ severity: 'blocker', code: 'json-parse-error', message: 'nope' }],
        }),
      )
      .mockResolvedValueOnce(makeRouteResult({ content: 'fixed' }));

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    const retryMessages = router.route.mock.calls[1]![0].messages;
    expect(retryMessages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('fails the job cleanly when the system template cannot render', async () => {
    vi.mocked(resolveSpec).mockResolvedValue(
      makeSpec({
        metaPromptTemplate: 'Hello {{whoIsMissing}}',
        metaPromptSource: 'registry',
      }),
    );
    state.jobs.set(JOB_ID, makeJobRow());
    state.requests.set(REQ_ID, makeRequestRow());

    await processGenerationJob({ id: 'q-1', data: jobData() }, { db, router, bus });

    expect(router.route).not.toHaveBeenCalled();
    const failed = state.updates.find(
      (u) => u.table === 'jobs' && u.set.status === 'failed',
    );
    expect(failed).toBeDefined();
    expect(String(failed!.set.error)).toContain('system prompt render error');
  });
});
