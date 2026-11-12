// Router pipeline tests.
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
  OpenRouterNoZdrEndpointError: class OpenRouterNoZdrEndpointError extends Error {},
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
const { Router, MAX_MULTI_SAMPLE, MAX_OUTPUT_TOKENS } = await import('./router.js');

/** The `max_tokens` the adapter was handed on call `n` (0-based). */
function adapterMaxTokens(n = 0): number {
  return (adapterMock.mock.calls[n]![0] as { maxTokens: number }).maxTokens;
}

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

  it('🔴 does NOT serve one project the answer cached for another in the same org', async () => {
    // FG-18. The key carried the org (as `namespace`) but never the project, so
    // an identical prompt from proj-b returned proj-a's completion for the
    // 5-minute TTL. Same organisation, different caller, different context.
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();
    const cache = new RouterCache({ max: 10 });
    adapterMock
      .mockResolvedValueOnce(
        makeCompletion({ contentText: 'for proj-a', promptTokens: 10, completionTokens: 20 }),
      )
      .mockResolvedValueOnce(
        makeCompletion({ contentText: 'for proj-b', promptTokens: 10, completionTokens: 20 }),
      );

    const router = new Router({
      cache,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
    });

    const a = await router.route(makeReq({ org: 'acme', project: 'proj-a' }));
    expect(a.cached).toBe(false);
    expect(a.content).toBe('for proj-a');

    // Identical in every way except the project.
    const b = await router.route(makeReq({ org: 'acme', project: 'proj-b' }));
    expect(b.cached).toBe(false);
    expect(b.content).toBe('for proj-b');
    expect(adapterMock).toHaveBeenCalledTimes(2);
  });

  it('still caches within one project, so the fix did not disable the cache', async () => {
    // The obvious way to "pass" the test above is to stop caching. This is the
    // other half: a repeat from the SAME project must still hit.
    const traceWriter = makeTraceWriter();
    const budget = makeBudget();
    const cache = new RouterCache({ max: 10 });
    adapterMock.mockResolvedValueOnce(
      makeCompletion({ contentText: 'once', promptTokens: 10, completionTokens: 20 }),
    );

    const router = new Router({
      cache,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
    });
    const req = makeReq({ org: 'acme', project: 'proj-a' });

    expect((await router.route(req)).cached).toBe(false);
    expect((await router.route(req)).cached).toBe(true);
    expect(adapterMock).toHaveBeenCalledTimes(1);
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

describe('Router — provider generation id on the trace', () => {
  const mk = (traceWriter: ReturnType<typeof makeTraceWriter>) =>
    new Router({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: makeBudget() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
      cache: new RouterCache({ max: 10 }),
    });

  it('stores the winning completion\'s rawId as metadata.providerGenerationId', async () => {
    const traceWriter = makeTraceWriter();
    adapterMock.mockResolvedValueOnce(makeCompletion());
    await mk(traceWriter).route(makeReq());
    expect(traceWriter.writeTrace.mock.calls[0]?.[0].metadata.providerGenerationId).toBe('gen-x');
  });

  it('omits the key when the provider sent no id', async () => {
    const traceWriter = makeTraceWriter();
    const { rawId: _drop, ...noId } = makeCompletion();
    adapterMock.mockResolvedValueOnce(noId);
    await mk(traceWriter).route(makeReq());
    expect(traceWriter.writeTrace.mock.calls[0]![0].metadata).not.toHaveProperty('providerGenerationId');
  });

  it('🔴 a database error lands on the trace as its code, never the row it quotes', async () => {
    const { default: postgres } = await import('postgres');
    const traceWriter = makeTraceWriter();
    adapterMock.mockRejectedValueOnce(
      new postgres.PostgresError({
        severity: 'ERROR',
        code: '22P02',
        message: 'invalid input syntax for type uuid: "Juana Pérez declaró en la audiencia"',
      } as unknown as string),
    );
    await expect(mk(traceWriter).route(makeReq())).rejects.toThrow();
    const trace = traceWriter.writeTrace.mock.calls[0]?.[0];
    expect(trace.metadata.errorMessage).toBe('PostgresError(22P02)');
    expect(JSON.stringify(trace)).not.toContain('Juana');
  });

  it('stores the partial\'s id on an aborted (client-disconnect) trace', async () => {
    const { OpenRouterAbortError } = await import('./adapters/openrouter.js');
    const traceWriter = makeTraceWriter();
    adapterMock.mockRejectedValueOnce(
      new OpenRouterAbortError({
        contentText: 'par',
        finishReason: 'aborted',
        model: 'mock/model',
        rawId: 'gen-cut',
        usage: { promptTokens: 5, completionTokens: 1, costUsd: 0.0001, costSource: 'pricing-table' },
      }),
    );
    await expect(mk(traceWriter).route(makeReq())).rejects.toBeInstanceOf(OpenRouterAbortError);
    const trace = traceWriter.writeTrace.mock.calls[0]?.[0];
    expect(trace.status).toBe('aborted');
    expect(trace.metadata.providerGenerationId).toBe('gen-cut');
  });

  it('stores the partial\'s id on a provider-timeout trace', async () => {
    // The timeout trace is written by its own code path (the unbilled 504
    // `ProviderTimeout`), separate from the disconnect one above, so it needs
    // its own pin: OpenRouter still bills that partial to US, and its id is
    // what reconciles it against the provider invoice.
    const { OpenRouterAbortError } = await import('./adapters/openrouter.js');
    const traceWriter = makeTraceWriter();
    adapterMock.mockImplementationOnce(
      (opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const onAbort = (): void =>
            reject(
              new OpenRouterAbortError({
                contentText: 'par',
                finishReason: 'aborted',
                model: 'mock/model',
                rawId: 'gen-timeout',
                usage: { promptTokens: 5, completionTokens: 1, costUsd: 0.0001, costSource: 'pricing-table' },
              }),
            );
          if (opts.signal?.aborted) onAbort();
          else opts.signal?.addEventListener('abort', onAbort, { once: true });
        }),
    );
    const router = new Router({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: makeBudget() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
      cache: new RouterCache({ max: 10 }),
      requestTimeoutMs: 20,
    });
    await expect(router.route(makeReq())).rejects.toMatchObject({ name: 'ProviderTimeout' });
    const trace = traceWriter.writeTrace.mock.calls[0]?.[0];
    expect(trace.metadata.reason).toBe('provider_timeout');
    expect(trace.metadata.providerGenerationId).toBe('gen-timeout');
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

    // Decision (audit §3 item 5, option A): OUR timeout is a 504
    // `ProviderTimeout`, UNBILLED — no longer the partial-billing abort path.
    // Full contract in `router-provider-timeout.test.ts`.
    await expect(router.route(makeReq())).rejects.toMatchObject({
      name: 'ProviderTimeout',
      code: 'ERR_PROVIDER_TIMEOUT',
    });

    // The adapter received a *combined* signal (not undefined) that fired.
    expect(sawSignal).toBeDefined();
    expect(sawSignal?.aborted).toBe(true);

    const traceArg = traceWriter.writeTrace.mock.calls[0]?.[0];
    expect(traceArg.status).toBe('aborted');
    expect(traceArg.actualCostUsd).toBe(0);
    expect(traceArg.metadata.providerCostUsd).toBeCloseTo(partial.usage.costUsd, 6);
    // The cause is distinguished as a timeout, not a disconnect.
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

// -------------------------------------------------------------------------- //
// Security clamp at the PROVIDER boundary — audit finding C4.
//
// `resolveSpec` already bounds these (see `registry/caller-limits.test.ts`),
// but the router is reachable with a hand-built profile that never went
// through the resolver — `/v1/route`, RAG condense, any direct `Router` user.
// These tests pin the second line of defence: whatever the profile says, the
// adapter never sees an out-of-bounds `max_tokens`, and never more billed
// passes than `MAX_MULTI_SAMPLE`.
// -------------------------------------------------------------------------- //

describe('Router — C4 cost clamps at the adapter boundary', () => {
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

  it('caps max_tokens at MAX_OUTPUT_TOKENS however large the profile asks', async () => {
    adapterMock.mockResolvedValue(makeCompletion());
    const profile = { ...getTaskProfile('standard'), maxOutputTokens: 200_000 };
    await makeRouter().route(makeReq({ effortProfile: profile }));

    expect(adapterMaxTokens()).toBe(MAX_OUTPUT_TOKENS);
  });

  it('🔴 passes a BELOW-ceiling max_tokens through untouched', async () => {
    // The chat product's per-user credit cap rides on this exact behaviour.
    // A clamp that also lowered legitimate caps, or dropped them, would break
    // metering silently — see `plan/open-maxoutputtokens-clamp-not-delete.md`.
    adapterMock.mockResolvedValue(makeCompletion());
    const profile = { ...getTaskProfile('standard'), maxOutputTokens: 120 };
    await makeRouter().route(makeReq({ effortProfile: profile }));

    expect(adapterMaxTokens()).toBe(120);
  });

  it('caps the multiSample fan-out at MAX_MULTI_SAMPLE billed passes', async () => {
    adapterMock.mockResolvedValue(makeCompletion());
    const profile = { ...getTaskProfile('standard'), multiSample: 50 };
    await makeRouter().route(makeReq({ effortProfile: profile }));

    // One pass per sample, and `standard` triggers no self-critique refine.
    expect(adapterMock).toHaveBeenCalledTimes(MAX_MULTI_SAMPLE);
  });

  it('falls back to the default cap rather than sending NaN when the profile is junk', async () => {
    adapterMock.mockResolvedValue(makeCompletion());
    // `effortProfile` crosses the wire as `z.record(z.string(), z.unknown())`, so a
    // non-numeric value can reach a hand-built profile. `Math.min(NaN, ceiling)`
    // is NaN, which is a worse failure than the one being fixed.
    const profile = { ...getTaskProfile('standard'), maxOutputTokens: NaN };
    await makeRouter().route(makeReq({ effortProfile: profile }));

    expect(adapterMaxTokens()).toBe(800);
  });
});

// ------------------------------------------------------------------------ //
// Strict schema-constrained output (`responseSchemaStrict`).

describe('Router — strict schema-constrained output', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['answer'],
    properties: { answer: { type: 'string' } },
  };

  function makeRouter(cache = new RouterCache({ max: 10 })) {
    const budget = makeBudget();
    const router = new Router({
      cache,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: makeTraceWriter() as any,
    });
    return { router, budget };
  }

  function sentFormat(n = 0): unknown {
    return (adapterMock.mock.calls[n]![0] as { responseFormat?: unknown }).responseFormat;
  }

  it('asks the adapter for json_schema with strict: true and the caller schema', async () => {
    adapterMock.mockResolvedValueOnce(makeCompletion({ contentText: '{"answer":"x"}' }));
    const { router } = makeRouter();
    const out = await router.route(
      makeReq({ model: 'openai/gpt-4o-mini', responseSchema: schema, responseSchemaStrict: true }),
    );
    expect(sentFormat()).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema, strict: true },
    });
    expect(out.parsed).toEqual({ answer: 'x' });
  });

  it('keeps JSON mode when the flag is absent', async () => {
    adapterMock.mockResolvedValueOnce(makeCompletion({ contentText: '{"answer":"x"}' }));
    const { router } = makeRouter();
    await router.route(makeReq({ model: 'openai/gpt-4o-mini', responseSchema: schema }));
    expect(sentFormat()).toEqual({ type: 'json_object' });
  });

  it('still holds the output to the full schema (the strictParsed gate stays on)', async () => {
    adapterMock.mockResolvedValueOnce(makeCompletion({ contentText: '{"other":1}' }));
    const { router } = makeRouter();
    const out = await router.route(
      makeReq({ model: 'openai/gpt-4o-mini', responseSchema: schema, responseSchemaStrict: true }),
    );
    expect(out.parsed).toBeUndefined();
    expect(out.flags.some((f) => f.code === 'json-schema-mismatch')).toBe(true);
  });

  it('🔴 refuses an unsupported model BEFORE reserving budget or dialling the provider', async () => {
    const { router, budget } = makeRouter();
    await expect(
      router.route(
        makeReq({ model: 'deepseek/deepseek-r1', responseSchema: schema, responseSchemaStrict: true }),
      ),
    ).rejects.toMatchObject({ name: 'SpecResolutionError', cause: 'strict schema unsupported model' });
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(adapterMock).not.toHaveBeenCalled();
  });

  it('refuses a schema outside the strict subset before reserving budget', async () => {
    const { router, budget } = makeRouter();
    await expect(
      router.route(
        makeReq({
          model: 'openai/gpt-4o-mini',
          responseSchema: { type: 'object' },
          responseSchemaStrict: true,
        }),
      ),
    ).rejects.toMatchObject({ name: 'SpecResolutionError', cause: 'strict schema invalid' });
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it('cache: strict, JSON-mode and plain calls with the same messages never share an entry', async () => {
    const cache = new RouterCache({ max: 10 });
    const { router } = makeRouter(cache);
    adapterMock
      .mockResolvedValueOnce(makeCompletion({ contentText: 'plain text' }))
      .mockResolvedValueOnce(makeCompletion({ contentText: '{"answer":"json"}' }))
      .mockResolvedValueOnce(makeCompletion({ contentText: '{"answer":"strict"}' }));
    const base = { model: 'openai/gpt-4o-mini' };

    const plain = await router.route(makeReq(base));
    const json = await router.route(makeReq({ ...base, responseSchema: schema }));
    const strict = await router.route(
      makeReq({ ...base, responseSchema: schema, responseSchemaStrict: true }),
    );
    expect([plain.cached, json.cached, strict.cached]).toEqual([false, false, false]);
    expect(adapterMock).toHaveBeenCalledTimes(3);

    // …and a repeat of the strict call IS a hit, re-gated against the schema.
    const again = await router.route(
      makeReq({ ...base, responseSchema: schema, responseSchemaStrict: true }),
    );
    expect(again.cached).toBe(true);
    expect(again.parsed).toEqual({ answer: 'strict' });
  });

  it('cache: two strict calls with different schemas do not share an entry', async () => {
    const { router } = makeRouter();
    adapterMock
      .mockResolvedValueOnce(makeCompletion({ contentText: '{"answer":"a"}' }))
      .mockResolvedValueOnce(makeCompletion({ contentText: '{"answer":"b","n":1}' }));
    const other = {
      ...schema,
      required: ['answer', 'n'],
      properties: { ...schema.properties, n: { type: 'integer' } },
    };
    await router.route(makeReq({ model: 'openai/gpt-4o-mini', responseSchema: schema, responseSchemaStrict: true }));
    const second = await router.route(
      makeReq({ model: 'openai/gpt-4o-mini', responseSchema: other, responseSchemaStrict: true }),
    );
    expect(second.cached).toBe(false);
    expect(adapterMock).toHaveBeenCalledTimes(2);
  });
});
