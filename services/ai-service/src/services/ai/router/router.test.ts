// Router pipeline tests. Ported from a prototype `services/ai/router/router.test.ts`
// with fixture changes:
//   - `surface: 'story-enrichment-ixd'` → `label: 'unit:ixd'`
//   - `storyId: 1`                       → `unitKey: 'unit-1'`
//   - `orgId: 'acme'`                    → `org: 'acme'`
//   - `effort: 'standard'`               → `effortLevel: 'standard'` + explicit
//                                          `effortProfile` via `getTaskProfile`
//   - dropped: `surface → trace_type` / `dimensionFromSurface` tests
//
// Adapter is mocked via `vi.mock('./adapters/openrouter.js')`. BudgetEnforcer
// and TraceWriter are injected via `RouterOptions` so we don't touch real DB
// code; `runValidators` is mocked via `vi.mock` so tests control flag emission.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChatMessage,
  RouteRequest,
} from './types.js';
import type { Flag } from '../validators/types.js';
import { RouterCache } from './cache.js';
import { getTaskProfile } from './task-profiles.js';
import { BudgetExceeded } from '../../budget/errors.js';

// --- Mocks --------------------------------------------------------------- //

const adapterMock = vi.fn();
vi.mock('./adapters/openrouter.js', () => ({
  callOpenRouter: (...args: unknown[]) => adapterMock(...args),
  // The streaming adapter is the router's default; tests inject `adapter` via
  // RouterOptions so the default is unused, but the import must resolve. Make
  // it the same mock so any code path that picks up the default still works.
  streamingCallOpenRouter: (...args: unknown[]) => adapterMock(...args),
  OpenRouterHttpError: class OpenRouterHttpError extends Error {},
  OpenRouterAbortError: class OpenRouterAbortError extends Error {
    public readonly partial: unknown;
    constructor(partial: unknown) {
      super('aborted');
      this.name = 'AbortError';
      this.partial = partial;
    }
  },
}));

const runValidatorsMock = vi.fn<(...args: unknown[]) => Flag[]>();
vi.mock('../validators/index.js', () => ({
  runValidators: (...args: unknown[]) => runValidatorsMock(...args),
}));

vi.mock('../../../config/env.js', () => ({
  // Wall-clock backstop off by default here so the existing pipeline tests are
  // unaffected; the timeout-specific suite passes `requestTimeoutMs` explicitly.
  env: {
    OPENROUTER_API_KEY: 'env-key-for-tests',
    LLM_REQUEST_TIMEOUT_MS: 0,
    LLM_STREAM_STALL_TIMEOUT_MS: 0,
  },
}));

// Import after mocks are registered so the SUT binds to them.
const { Router } = await import('./router.js');

// --- Test helpers -------------------------------------------------------- //

interface FakeTraceWriter {
  writeTrace: ReturnType<typeof vi.fn>;
  writeUsage: ReturnType<typeof vi.fn>;
  assertParentTraceOrg: ReturnType<typeof vi.fn>;
}

function makeTraceWriter(opts: {
  parentOrg?: string;
  /** When set, `assertParentTraceOrg` rejects with this error. */
  parentRejects?: Error;
} = {}): FakeTraceWriter {
  const w = {
    writeTrace: vi.fn().mockResolvedValue({ id: 'trace-row-id' }),
    writeUsage: vi.fn().mockResolvedValue({ id: 'usage-row-id' }),
    assertParentTraceOrg: vi.fn().mockImplementation(async (a: {
      parentTraceId?: string;
      callerOrg: string;
    }) => {
      if (!a.parentTraceId) return;
      if (opts.parentRejects) throw opts.parentRejects;
      if (opts.parentOrg && opts.parentOrg !== a.callerOrg) {
        throw new Error('cross-org parent trace rejected');
      }
    }),
  };
  return w;
}

interface FakeBudget {
  reserve: ReturnType<typeof vi.fn>;
  refund: ReturnType<typeof vi.fn>;
  adjust: ReturnType<typeof vi.fn>;
}

function makeBudget(opts: { rejectReserve?: BudgetExceeded } = {}): FakeBudget {
  let calls = 0;
  return {
    reserve: vi.fn().mockImplementation(async () => {
      calls++;
      if (opts.rejectReserve && calls === 1) throw opts.rejectReserve;
      return { remainingUsd: 1000 };
    }),
    refund: vi.fn().mockResolvedValue(undefined),
    adjust: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCompletion(over: Partial<{
  contentText: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}> = {}) {
  return {
    contentText: over.contentText ?? 'hello world',
    finishReason: 'stop',
    model: over.model ?? 'deepseek/deepseek-chat-v3.1',
    rawId: 'gen-x',
    usage: {
      promptTokens: over.promptTokens ?? 100,
      completionTokens: over.completionTokens ?? 50,
      costUsd: over.costUsd ?? 0.001,
      costSource: 'openrouter' as const,
    },
  };
}

const baseMessages: ChatMessage[] = [
  { role: 'system', content: 'be concise' },
  { role: 'user', content: 'hello' },
];

function makeReq(over: Partial<RouteRequest> = {}): RouteRequest {
  const profile = getTaskProfile('standard');
  return {
    label: 'unit:ixd',
    unitKey: 'unit-1',
    unitType: 'ixd',
    org: 'acme',
    project: 'proj-a',
    messages: baseMessages,
    model: profile.model ?? 'deepseek/deepseek-chat-v3.1',
    effortLevel: 'standard',
    effortProfile: profile,
    ...over,
  };
}

beforeEach(() => {
  adapterMock.mockReset();
  runValidatorsMock.mockReset();
  runValidatorsMock.mockReturnValue([]); // default: no flags
});

// ------------------------------------------------------------------------ //

describe('Router — happy path', () => {
  it('completes the pipeline, writes trace + usage, returns RouteResult', async () => {
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();
    const cache = new RouterCache({ max: 10 });
    adapterMock.mockResolvedValueOnce(makeCompletion({ contentText: 'final answer' }));

    const router = new Router({
      cache,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
    });
    const out = await router.route(makeReq());

    expect(out.content).toBe('final answer');
    expect(out.cached).toBe(false);
    expect(out.flags).toEqual([]);
    expect(out.usage.totalTokens).toBe(150);
    expect(out.provider).toBe('openrouter');
    expect(adapterMock).toHaveBeenCalledTimes(1);

    // Reserve happened before the adapter call.
    expect(budget.reserve).toHaveBeenCalled();
    expect(budget.reserve.mock.invocationCallOrder[0])
      .toBeLessThan(adapterMock.mock.invocationCallOrder[0] ?? Infinity);

    // Trace + usage written exactly once each (no critique/refine on standard).
    expect(traceWriter.writeTrace).toHaveBeenCalledTimes(1);
    expect(traceWriter.writeUsage).toHaveBeenCalledTimes(1);
    const traceArg = traceWriter.writeTrace.mock.calls[0]?.[0];
    expect(traceArg.org).toBe('acme');
    expect(traceArg.status).toBe('completed');
    expect(traceArg.label).toBe('unit:ixd');
  });
});

describe('Router — budget reserve precedes adapter call', () => {
  it('does NOT call the adapter when reserve throws BudgetExceeded; writes failed trace', async () => {
    const traceWriter = makeTraceWriter();
    const budget = makeBudget({
      rejectReserve: new BudgetExceeded('acme', 0.01, 0.001),
    });
    adapterMock.mockResolvedValue(makeCompletion());

    const router = new Router({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
      cache: new RouterCache({ max: 10 }),
    });

    await expect(router.route(makeReq())).rejects.toBeInstanceOf(BudgetExceeded);
    expect(adapterMock).not.toHaveBeenCalled();
    // Failed trace written before the throw bubbles.
    expect(traceWriter.writeTrace).toHaveBeenCalled();
    expect(traceWriter.writeTrace.mock.calls[0]?.[0].status).toBe('failed');
  });
});

describe('Router — cache hit', () => {
  it('a second identical call returns cached: true and skips adapter + budget', async () => {
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();
    const cache = new RouterCache({ max: 10 });
    adapterMock.mockResolvedValueOnce(
      makeCompletion({ contentText: 'first', promptTokens: 10, completionTokens: 20 }),
    );

    const router = new Router({
      cache,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
    });
    const req = makeReq();

    const first = await router.route(req);
    expect(first.cached).toBe(false);

    // Second identical call.
    const second = await router.route(req);
    expect(second.cached).toBe(true);
    expect(second.content).toBe('first');
    // Adapter was only invoked the first time.
    expect(adapterMock).toHaveBeenCalledTimes(1);
    // Budget.reserve only ran for the first call.
    expect(budget.reserve).toHaveBeenCalledTimes(1);
  });
});

describe('Router — cross-org parent trace', () => {
  it('throws before calling the adapter when parent trace belongs to another org', async () => {
    const traceWriter = makeTraceWriter({ parentOrg: 'other-org' });
    const budget = makeBudget();
    adapterMock.mockResolvedValue(makeCompletion());

    const router = new Router({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
      cache: new RouterCache({ max: 10 }),
    });

    await expect(
      router.route(makeReq({ parentTraceId: 'parent-from-other-org' })),
    ).rejects.toThrow(/cross-org/);
    expect(adapterMock).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  });
});

describe('Router — self-critique on deep effort with blocker flag', () => {
  it('runs a refine pass when validators emit a blocker', async () => {
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();
    const deepProfile = getTaskProfile('deep');

    adapterMock
      .mockResolvedValueOnce(makeCompletion({ contentText: 'draft' }))
      .mockResolvedValueOnce(makeCompletion({ contentText: 'refined' }));

    runValidatorsMock
      .mockReturnValueOnce([{ severity: 'blocker', code: 'B1', message: 'bad' }])
      .mockReturnValueOnce([]); // refined output clean

    const router = new Router({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
      cache: new RouterCache({ max: 10 }),
    });
    const out = await router.route(
      makeReq({ effortLevel: 'deep', effortProfile: deepProfile }),
    );

    expect(adapterMock).toHaveBeenCalledTimes(1 + (deepProfile.multiSample - 1) + 1); // generate + refine + (multiSample-1) samples
    expect(out.content).toBe('refined');
    expect(out.breakdown).toBeDefined();
    expect(out.breakdown!.some((b) => b.purpose === 'refine')).toBe(true);
  });
});

describe('Router — refine path fires on blocker (validator-driven)', () => {
  it('uses the refined output when its validator flags improve', async () => {
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();
    const deepProfile = { ...getTaskProfile('deep'), multiSample: 1 };

    adapterMock
      .mockResolvedValueOnce(makeCompletion({ contentText: 'draft-with-blocker' }))
      .mockResolvedValueOnce(makeCompletion({ contentText: 'refined-clean' }));

    runValidatorsMock
      .mockReturnValueOnce([{ severity: 'blocker', code: 'B', message: 'fix it' }])
      .mockReturnValueOnce([]);

    const router = new Router({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
      cache: new RouterCache({ max: 10 }),
    });
    const out = await router.route(
      makeReq({ effortLevel: 'deep', effortProfile: deepProfile }),
    );

    expect(out.content).toBe('refined-clean');
    expect(out.flags).toEqual([]);
    // Two adapter calls: generate + refine.
    expect(adapterMock).toHaveBeenCalledTimes(2);
  });
});

describe('Router — budget true-up', () => {
  it('calls budget.adjust with reserved − actual when actual differs', async () => {
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();
    const profile = getTaskProfile('standard'); // reserve = estimatedCostUsdPerCall
    // Adapter reports a smaller actual cost than reserve ⇒ delta refund > 0.
    adapterMock.mockResolvedValueOnce(makeCompletion({ costUsd: 0.0002 }));

    const router = new Router({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
      cache: new RouterCache({ max: 10 }),
    });
    await router.route(makeReq({ effortLevel: 'standard', effortProfile: profile }));

    expect(budget.adjust).toHaveBeenCalled();
    const arg = budget.adjust.mock.calls[0]?.[0];
    expect(arg.org).toBe('acme');
    // Delta = reserved (profile.estimatedCostUsdPerCall) − actual 0.0002.
    // Pulling the reserve from the profile keeps the assertion stable across
    // MODEL_PRICING refreshes.
    expect(arg.deltaUsd).toBeCloseTo(profile.estimatedCostUsdPerCall - 0.0002, 6);
  });

  it('calls budget.adjust with negative delta when actual exceeds reserve', async () => {
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();
    const profile = getTaskProfile('standard');
    adapterMock.mockResolvedValueOnce(makeCompletion({ costUsd: 0.005 }));

    const router = new Router({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
      cache: new RouterCache({ max: 10 }),
    });
    await router.route(makeReq({ effortLevel: 'standard', effortProfile: profile }));

    const arg = budget.adjust.mock.calls[0]?.[0];
    expect(arg.deltaUsd).toBeLessThan(0); // further-reserve
  });
});

describe('Router — adapter exception', () => {
  it('refunds the reserve, writes a failed trace, and rethrows the original error', async () => {
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();
    const oops = new Error('connection refused');
    adapterMock.mockRejectedValueOnce(oops);

    const router = new Router({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
      cache: new RouterCache({ max: 10 }),
    });
    await expect(router.route(makeReq())).rejects.toBe(oops);

    expect(budget.reserve).toHaveBeenCalledTimes(1);
    expect(budget.refund).toHaveBeenCalledTimes(1);
    const refundArg = budget.refund.mock.calls[0]?.[0];
    expect(refundArg.org).toBe('acme');
    // Full per-call reserve refunded.
    expect(refundArg.amountUsd).toBeCloseTo(getTaskProfile('standard').estimatedCostUsdPerCall, 6);

    expect(traceWriter.writeTrace).toHaveBeenCalledTimes(1);
    expect(traceWriter.writeTrace.mock.calls[0]?.[0].status).toBe('failed');
  });
});

describe('Router — cancelled with partial usage', () => {
  it('records partial spend, refunds only the unspent reserve, writes status=aborted', async () => {
    // Pull the mocked OpenRouterAbortError out of the module so we throw the
    // same constructor the router checks for via `instanceof`.
    const { OpenRouterAbortError } = await import('./adapters/openrouter.js');
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();

    const partial = {
      contentText: 'Hello, partial …',
      finishReason: 'aborted',
      model: 'mock/model',
      usage: {
        promptTokens: 25,
        completionTokens: 12,
        costUsd: 0.000123,
        costSource: 'pricing-table' as const,
      },
    };
    adapterMock.mockRejectedValueOnce(new OpenRouterAbortError(partial));

    const router = new Router({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
      cache: new RouterCache({ max: 10 }),
    });
    await expect(router.route(makeReq())).rejects.toBeInstanceOf(OpenRouterAbortError);

    // Refund = reserve − actual spend (clamped to ≥ 0).
    expect(budget.refund).toHaveBeenCalledTimes(1);
    const refundArg = budget.refund.mock.calls[0]?.[0];
    const reserve = getTaskProfile('standard').estimatedCostUsdPerCall;
    expect(refundArg.amountUsd).toBeCloseTo(reserve - partial.usage.costUsd, 6);

    expect(traceWriter.writeTrace).toHaveBeenCalledTimes(1);
    const traceArg = traceWriter.writeTrace.mock.calls[0]?.[0];
    expect(traceArg.status).toBe('aborted');
    expect(traceArg.actualCostUsd).toBeCloseTo(partial.usage.costUsd, 6);
    expect(traceArg.outputPayload).toEqual({ content: partial.contentText, partial: true });
    expect(traceArg.tokenUsage.inputTokens).toBe(partial.usage.promptTokens);
    expect(traceArg.tokenUsage.outputTokens).toBe(partial.usage.completionTokens);

    expect(traceWriter.writeUsage).toHaveBeenCalledTimes(1);
    const usageArg = traceWriter.writeUsage.mock.calls[0]?.[0];
    expect(usageArg.status).toBe('aborted');
    expect(usageArg.inputTokens).toBe(partial.usage.promptTokens);
    expect(usageArg.outputTokens).toBe(partial.usage.completionTokens);
    expect(usageArg.actualCostUsd).toBeCloseTo(partial.usage.costUsd, 6);
  });
});

describe('Router — wall-clock timeout backstop', () => {
  it('aborts the adapter when requestTimeoutMs elapses and records abortCause=timeout', async () => {
    const { OpenRouterAbortError } = await import('./adapters/openrouter.js');
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();

    const partial = {
      contentText: 'partial before timeout',
      finishReason: 'aborted',
      model: 'mock/model',
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        costUsd: 0.0001,
        costSource: 'pricing-table' as const,
      },
    };

    // Adapter that honours the combined signal: resolves only if the signal
    // never fires (it won't, given the tiny timeout), otherwise rejects with
    // OpenRouterAbortError — exactly like streamingCallOpenRouter on abort.
    let sawSignal: AbortSignal | undefined;
    adapterMock.mockImplementationOnce((opts: { signal?: AbortSignal }) => {
      sawSignal = opts.signal;
      return new Promise((_resolve, reject) => {
        const s = opts.signal;
        if (!s) return; // would hang; not expected in this test
        const onAbort = (): void => reject(new OpenRouterAbortError(partial));
        if (s.aborted) onAbort();
        else s.addEventListener('abort', onAbort, { once: true });
      });
    });

    const router = new Router({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
      cache: new RouterCache({ max: 10 }),
      requestTimeoutMs: 20, // tiny wall-clock cap drives the abort
    });

    await expect(router.route(makeReq())).rejects.toBeInstanceOf(OpenRouterAbortError);

    // The adapter received a *combined* signal (not undefined) that fired.
    expect(sawSignal).toBeDefined();
    expect(sawSignal?.aborted).toBe(true);

    // Partial-billing path reused unchanged: status aborted, partial recorded.
    const traceArg = traceWriter.writeTrace.mock.calls[0]?.[0];
    expect(traceArg.status).toBe('aborted');
    expect(traceArg.actualCostUsd).toBeCloseTo(partial.usage.costUsd, 6);
    // The new bit: the cause is distinguished as a timeout, not a disconnect.
    expect(traceArg.metadata.abortCause).toBe('timeout');
  });

  it('does NOT abort a fast call; timer is disposed and cause stays unknown', async () => {
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();
    adapterMock.mockResolvedValueOnce(makeCompletion({ contentText: 'fast answer' }));

    const router = new Router({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
      cache: new RouterCache({ max: 10 }),
      requestTimeoutMs: 5000,
    });

    const out = await router.route(makeReq());
    expect(out.content).toBe('fast answer');
    const traceArg = traceWriter.writeTrace.mock.calls[0]?.[0];
    expect(traceArg.status).toBe('completed');
  });
});

// ------------------------------------------------------------------------ //
// Structured output (json_object mode): parse-first validation. Regression
// guard for the bug where the raw completion STRING was validated against an
// object responseSchema, failing every structured unit with `/ must be object`.

describe('Router — structured output (parse-first validation)', () => {
  function makeRouter() {
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();
    return new Router({
      cache: new RouterCache({ max: 10 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
    });
  }

  it('parses the JSON completion and validates the PARSED object, surfacing it as `parsed`', async () => {
    const obj = { summary: 'ok', items: [1, 2, 3] };
    adapterMock.mockResolvedValueOnce(makeCompletion({ contentText: JSON.stringify(obj) }));
    const router = makeRouter();

    const out = await router.route(
      makeReq({ responseSchema: { type: 'object' }, validators: ['json-schema'] }),
    );

    // runValidators received the PARSED object, not the raw string.
    expect(runValidatorsMock).toHaveBeenCalledTimes(1);
    const passedOutput = runValidatorsMock.mock.calls[0]?.[1];
    expect(passedOutput).toEqual(obj);
    expect(typeof passedOutput).toBe('object');

    // The parsed object is surfaced on the result.
    expect(out.parsed).toEqual(obj);
    expect(out.flags).toEqual([]);
    // Raw content is preserved.
    expect(out.content).toBe(JSON.stringify(obj));
  });

  it('emits a clean `json-parse-error` blocker (no crash) when output is malformed JSON', async () => {
    adapterMock.mockResolvedValueOnce(
      makeCompletion({ contentText: 'not json at all { [1] [2024]' }),
    );
    const router = makeRouter();

    const out = await router.route(
      makeReq({ responseSchema: { type: 'object' }, validators: ['json-schema'] }),
    );

    // Schema validators are NOT run on un-parseable output.
    expect(runValidatorsMock).not.toHaveBeenCalled();
    expect(out.parsed).toBeUndefined();
    expect(out.flags).toHaveLength(1);
    expect(out.flags[0]?.severity).toBe('blocker');
    expect(out.flags[0]?.code).toBe('json-parse-error');
  });

  // Regression guard for the fail-open bug: OpenRouter's structured-output
  // enforcement does NOT strictly enforce `required` fields nested under
  // `$ref`/`definitions`, so a weak model can return JSON that parses cleanly
  // yet violates the schema. `parsed` must be withheld in that case, and a
  // `json-schema-mismatch` blocker surfaced — ai-service must not report
  // `parsed` for output it can't vouch for. Note: `runValidators` is mocked to
  // [] here, so the ONLY source of flags is the router's authoritative Ajv gate.
  const refSchema = {
    type: 'object',
    properties: { item: { $ref: '#/definitions/Item' } },
    required: ['item'],
    definitions: {
      Item: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' } },
        required: ['id', 'name'],
      },
    },
  } as const;

  it('withholds `parsed` (and flags a blocker) when a required field nested in $ref/definitions is missing', async () => {
    // `item.name` (required, under `#/definitions/Item`) is omitted.
    const bad = { item: { id: 'x' } };
    adapterMock.mockResolvedValueOnce(makeCompletion({ contentText: JSON.stringify(bad) }));
    const router = makeRouter();

    const out = await router.route(makeReq({ responseSchema: refSchema }));

    // Schema-invalid ⇒ `parsed` must NOT be surfaced.
    expect(out.parsed).toBeUndefined();
    // A schema-mismatch blocker is surfaced (source of truth = Ajv gate).
    const mismatch = out.flags.find((f) => f.code === 'json-schema-mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch?.severity).toBe('blocker');
    // Raw content is still preserved for consumers/debugging.
    expect(out.content).toBe(JSON.stringify(bad));
  });

  it('surfaces `parsed` when all $ref/definitions required fields are present', async () => {
    const good = { item: { id: 'x', name: 'ok' } };
    adapterMock.mockResolvedValueOnce(makeCompletion({ contentText: JSON.stringify(good) }));
    const router = makeRouter();

    const out = await router.route(makeReq({ responseSchema: refSchema }));

    expect(out.parsed).toEqual(good);
    expect(out.flags.every((f) => f.code !== 'json-schema-mismatch')).toBe(true);
  });

  it('validates the raw STRING (no parse) when there is no responseSchema — backward compatible', async () => {
    adapterMock.mockResolvedValueOnce(makeCompletion({ contentText: 'plain text answer' }));
    const router = makeRouter();

    const out = await router.route(
      makeReq({ validators: [{ type: 'regex', pattern: 'answer' }] }),
    );

    expect(runValidatorsMock).toHaveBeenCalledTimes(1);
    expect(runValidatorsMock.mock.calls[0]?.[1]).toBe('plain text answer');
    // No parsing attempted ⇒ no parsed field.
    expect(out.parsed).toBeUndefined();
    expect(out.content).toBe('plain text answer');
  });
});

// ------------------------------------------------------------------------ //
// Structured-output self-heal: a `json-schema-mismatch` OR `json-parse-error`
// blocker earns exactly ONE cross-effort refine pass, even at `quick` effort
// (where refine is otherwise bypassed). This is the path structured extraction
// relies on to recover from an occasional unusable draft (schema-invalid JSON,
// or output that isn't JSON at all). The pass is hard-capped at one — a
// persistently-invalid model stops after a single retry, never loops.

describe('Router — structured-output self-heal on quick effort', () => {
  function makeRouter() {
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();
    return new Router({
      cache: new RouterCache({ max: 10 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
    });
  }

  // A schema that requires `name`; the Ajv gate flags a missing `name` as a
  // `json-schema-mismatch` blocker (runValidators is mocked to [], so this is
  // the sole source of flags).
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  } as const;

  function quickReq(over: Partial<RouteRequest> = {}): RouteRequest {
    const profile = { ...getTaskProfile('quick'), multiSample: 1 };
    return makeReq({
      effortLevel: 'quick',
      effortProfile: profile,
      responseSchema: schema,
      ...over,
    });
  }

  it('fires exactly one refine pass and surfaces `parsed` when the retry is valid', async () => {
    const bad = { wrong: 'field' }; // parses, but missing required `name`
    const good = { name: 'recovered' }; // valid on the retry
    adapterMock
      .mockResolvedValueOnce(makeCompletion({ contentText: JSON.stringify(bad) }))
      .mockResolvedValueOnce(makeCompletion({ contentText: JSON.stringify(good) }));
    const router = makeRouter();

    const out = await router.route(quickReq());

    // generate + exactly one refine — no more (multiSample is 1 for quick).
    expect(adapterMock).toHaveBeenCalledTimes(2);
    expect(out.breakdown?.some((b) => b.purpose === 'refine')).toBe(true);
    // The refined, schema-valid draft is surfaced as `parsed`, mismatch cleared.
    expect(out.parsed).toEqual(good);
    expect(out.content).toBe(JSON.stringify(good));
    expect(out.flags.every((f) => f.code !== 'json-schema-mismatch')).toBe(true);
  });

  it('stops after ONE retry (no loop) when the model stays schema-invalid', async () => {
    const bad1 = { wrong: 'a' };
    const bad2 = { still: 'wrong' };
    adapterMock
      .mockResolvedValueOnce(makeCompletion({ contentText: JSON.stringify(bad1) }))
      .mockResolvedValueOnce(makeCompletion({ contentText: JSON.stringify(bad2) }));
    const router = makeRouter();

    const out = await router.route(quickReq());

    // Hard cap: generate + one refine, then stop — never re-evaluate/loop.
    expect(adapterMock).toHaveBeenCalledTimes(2);
    // Still invalid ⇒ no `parsed`, mismatch blocker preserved.
    expect(out.parsed).toBeUndefined();
    expect(out.flags.some((f) => f.code === 'json-schema-mismatch')).toBe(true);
  });

  it('does NOT refine on quick effort when the first draft is schema-valid', async () => {
    const good = { name: 'ok' };
    adapterMock.mockResolvedValueOnce(makeCompletion({ contentText: JSON.stringify(good) }));
    const router = makeRouter();

    const out = await router.route(quickReq());

    // No mismatch ⇒ no refine ⇒ a single adapter call (baseline quick behaviour).
    expect(adapterMock).toHaveBeenCalledTimes(1);
    expect(out.parsed).toEqual(good);
  });

  // A `json-parse-error` (output that isn't valid JSON at all) is the same class
  // of structured-extraction failure as a schema mismatch and gets the same
  // single cross-effort refine pass.
  it('fires exactly one refine pass and surfaces `parsed` when unparseable output is fixed on retry', async () => {
    const good = { name: 'recovered' };
    adapterMock
      .mockResolvedValueOnce(makeCompletion({ contentText: 'not json at all { [1]' }))
      .mockResolvedValueOnce(makeCompletion({ contentText: JSON.stringify(good) }));
    const router = makeRouter();

    const out = await router.route(quickReq());

    expect(adapterMock).toHaveBeenCalledTimes(2);
    expect(out.breakdown?.some((b) => b.purpose === 'refine')).toBe(true);
    expect(out.parsed).toEqual(good);
    expect(out.flags.every((f) => f.code !== 'json-parse-error')).toBe(true);
  });

  it('stops after ONE retry (no loop) when the model stays unparseable', async () => {
    adapterMock
      .mockResolvedValueOnce(makeCompletion({ contentText: 'nope {' }))
      .mockResolvedValueOnce(makeCompletion({ contentText: 'still nope ]' }));
    const router = makeRouter();

    const out = await router.route(quickReq());

    expect(adapterMock).toHaveBeenCalledTimes(2);
    expect(out.parsed).toBeUndefined();
    expect(out.flags.some((f) => f.code === 'json-parse-error')).toBe(true);
  });
});
