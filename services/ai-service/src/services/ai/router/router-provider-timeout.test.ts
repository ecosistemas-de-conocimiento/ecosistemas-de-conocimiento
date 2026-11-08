// Provider timeout ⇒ 504-class failure, UNBILLED, marked `truncated`.
//
// Decision (Rodrigo, option A of
// `plan/tecnología/prod-readiness/ai-reality-audit.md` §3 item 5):
// when the wall-clock deadline (`LLM_REQUEST_TIMEOUT_MS`) or the stream stall
// backstop cuts a generation, the router must NOT return a result and must NOT
// charge the org. It throws `ProviderTimeout`, refunds every hold it took, and
// writes an `aborted` trace + usage row at $0 that says `truncated: true`,
// `reason: 'provider_timeout'`. The provider's own charge is kept on the trace
// as `providerCostUsd` so the ledger can still be reconciled with the invoice.
//
// Measured reproducer (audit §2 P7): req-1gk ran 120038 ms against a
// 120 s deadline and came back 200 + charged $0.0009979 — the deadline fired in
// the REFINE pass, `runExtraPass` swallowed it as "best effort", and the
// primary draft went out as a success.
//
// ⚠ A provider timeout is NOT a shutdown and NOT a client disconnect. Those two
// keep billing the partial; the last tests
// here pin that the two paths stay distinct.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, RouteRequest } from './types.js';
import type { Flag } from '../validators/types.js';
import { RouterCache } from './cache.js';
import { getTaskProfile } from './task-profiles.js';

const adapterMock = vi.fn();
vi.mock('./adapters/openrouter.js', () => ({
  callOpenRouter: (...args: unknown[]) => adapterMock(...args),
  streamingCallOpenRouter: (...args: unknown[]) => adapterMock(...args),
  OpenRouterHttpError: class OpenRouterHttpError extends Error {},
  OpenRouterNoZdrEndpointError: class OpenRouterNoZdrEndpointError extends Error {},
  OpenRouterAbortError: class OpenRouterAbortError extends Error {
    public readonly partial: unknown;
    constructor(partial: unknown, cause?: unknown) {
      super('aborted');
      this.name = 'AbortError';
      this.partial = partial;
      if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
    }
  },
}));

const runValidatorsMock = vi.fn<(...args: unknown[]) => Flag[]>();
vi.mock('../validators/index.js', () => ({
  runValidators: (...args: unknown[]) => runValidatorsMock(...args),
}));

vi.mock('../../../config/env.js', () => ({
  env: {
    OPENROUTER_API_KEY: 'env-key-for-tests',
    LLM_REQUEST_TIMEOUT_MS: 0,
    LLM_STREAM_STALL_TIMEOUT_MS: 0,
  },
}));

const { Router } = await import('./router.js');
const { createProviderResilience } = await import('./resilience.js');
const { OpenRouterAbortError } = await import('./adapters/openrouter.js');

const baseMessages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

const PARTIAL = {
  contentText: 'partial before the cut',
  finishReason: 'aborted',
  model: 'mock/model',
  usage: { promptTokens: 10, completionTokens: 4, costUsd: 0.0004, costSource: 'pricing-table' as const },
};

function completion(text = 'draft answer', costUsd = 0.001) {
  return {
    contentText: text,
    finishReason: 'stop',
    model: 'mock/model',
    usage: { promptTokens: 100, completionTokens: 50, costUsd, costSource: 'openrouter' as const },
  };
}

/** An adapter call that never finishes on its own: it ends only when its
 *  signal fires, and then rejects exactly like `streamingCallOpenRouter`. */
function hangUntilAborted(opts: { signal?: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    const s = opts.signal;
    if (!s) return;
    const onAbort = (): void => reject(new OpenRouterAbortError(PARTIAL, s.reason));
    if (s.aborted) onAbort();
    else s.addEventListener('abort', onAbort, { once: true });
  });
}

function makeDeps() {
  const traceWriter = {
    writeTrace: vi.fn().mockResolvedValue({ id: 't' }),
    writeUsage: vi.fn().mockResolvedValue({ id: 'u' }),
    assertParentTraceOrg: vi.fn().mockResolvedValue(undefined),
  };
  const budget = {
    reserve: vi.fn().mockResolvedValue({ remainingUsd: 1000, softCap: false }),
    refund: vi.fn().mockResolvedValue(undefined),
    adjust: vi.fn().mockResolvedValue(undefined),
    settleReservations: vi.fn().mockResolvedValue(undefined),
  };
  return { traceWriter, budget };
}

function makeRouter(deps: ReturnType<typeof makeDeps>, requestTimeoutMs: number) {
  return new Router({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    budget: deps.budget as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    traceWriter: deps.traceWriter as any,
    cache: new RouterCache({ max: 10 }),
    requestTimeoutMs,
    resilience: createProviderResilience({ maxAttempts: 1 }),
  });
}

function makeReq(over: Partial<RouteRequest> = {}): RouteRequest {
  const profile = getTaskProfile('standard');
  return {
    label: 'unit:x',
    unitKey: 'unit-1',
    org: 'acme',
    project: 'proj-a',
    messages: baseMessages,
    model: 'mock/model',
    effortLevel: 'standard',
    effortProfile: { ...profile, estimatedCostUsdPerCall: 0.01 },
    ...over,
  };
}

/** Sum of every hold the router took vs. every dollar it gave back. */
function netHeld(budget: ReturnType<typeof makeDeps>['budget']): number {
  const reserved = budget.reserve.mock.calls.reduce(
    (s, c) => s + (c[0] as { amountUsd: number }).amountUsd,
    0,
  );
  const refunded = budget.refund.mock.calls.reduce(
    (s, c) => s + (c[0] as { amountUsd: number }).amountUsd,
    0,
  );
  const adjusted = budget.adjust.mock.calls.reduce(
    (s, c) => s + (c[0] as { deltaUsd: number }).deltaUsd,
    0,
  );
  return reserved - refunded - adjusted;
}

/** The unbilled-timeout contract, asserted on whatever the router wrote last. */
function expectUnbilledTimeoutTrace(deps: ReturnType<typeof makeDeps>, providerCostUsd: number) {
  const trace = deps.traceWriter.writeTrace.mock.calls.at(-1)?.[0];
  expect(trace.status).toBe('aborted');
  expect(trace.actualCostUsd).toBe(0);
  expect(trace.metadata.truncated).toBe(true);
  expect(trace.metadata.reason).toBe('provider_timeout');
  expect(trace.metadata.abortCause).toBe('timeout');
  // What the provider charged US is kept for reconciliation, not billed.
  expect(trace.metadata.providerCostUsd).toBeCloseTo(providerCostUsd, 9);

  const usage = deps.traceWriter.writeUsage.mock.calls.at(-1)?.[0];
  expect(usage.status).toBe('aborted');
  expect(usage.actualCostUsd).toBe(0);
  // Exactly one usage row per call, and no `completed` one.
  expect(
    deps.traceWriter.writeUsage.mock.calls.filter((c) => c[0].status === 'completed'),
  ).toHaveLength(0);
}

beforeEach(() => {
  adapterMock.mockReset();
  runValidatorsMock.mockReset();
  runValidatorsMock.mockReturnValue([]);
});

describe('Router — provider timeout is a failure, unbilled', () => {
  it('primary pass cut by the deadline: throws ProviderTimeout, bills $0, releases the hold', async () => {
    const deps = makeDeps();
    adapterMock.mockImplementationOnce(hangUntilAborted);

    const err = await makeRouter(deps, 30).route(makeReq()).catch((e: unknown) => e);

    expect((err as Error).name).toBe('ProviderTimeout');
    expect((err as { code?: string }).code).toBe('ERR_PROVIDER_TIMEOUT');
    expect((err as { status?: number }).status).toBe(504);
    expectUnbilledTimeoutTrace(deps, PARTIAL.usage.costUsd);
    expect(netHeld(deps.budget)).toBeCloseTo(0, 9);
  });

  it('REFINE pass cut by the deadline (the req-1gk shape): no 200 with the draft', async () => {
    const deps = makeDeps();
    adapterMock
      .mockResolvedValueOnce(completion('draft answer', 0.001))
      .mockImplementationOnce(hangUntilAborted);

    const deep = getTaskProfile('deep');
    const out = await makeRouter(deps, 60)
      .route(
        makeReq({
          effortLevel: 'deep',
          effortProfile: { ...deep, multiSample: 1, estimatedCostUsdPerCall: 0.01 },
        }),
      )
      .catch((e: unknown) => e);

    expect(adapterMock).toHaveBeenCalledTimes(2);
    expect((out as Error).name).toBe('ProviderTimeout');
    // Provider spent the draft's cost AND the refine partial; the org pays none.
    expectUnbilledTimeoutTrace(deps, 0.001 + PARTIAL.usage.costUsd);
    expect(netHeld(deps.budget)).toBeCloseTo(0, 9);
  });

  it('structured self-heal refine cut by the deadline: the broken JSON draft is not returned', async () => {
    const deps = makeDeps();
    // An unparseable draft earns a refine pass even at `standard`.
    adapterMock
      .mockResolvedValueOnce(completion('{"cut', 0.001))
      .mockImplementationOnce(hangUntilAborted);

    const out = await makeRouter(deps, 60)
      .route(makeReq({ responseSchema: { type: 'object' }, validators: ['json-schema'] }))
      .catch((e: unknown) => e);

    expect(adapterMock).toHaveBeenCalledTimes(2);
    expect((out as Error).name).toBe('ProviderTimeout');
    expectUnbilledTimeoutTrace(deps, 0.001 + PARTIAL.usage.costUsd);
    expect(netHeld(deps.budget)).toBeCloseTo(0, 9);
  });

  it('extra SAMPLE pass cut by the deadline: throws, and no further samples are dialled', async () => {
    const deps = makeDeps();
    adapterMock
      .mockResolvedValueOnce(completion('sample 1', 0.001))
      .mockImplementationOnce(hangUntilAborted);

    const std = getTaskProfile('standard');
    const out = await makeRouter(deps, 60)
      .route(makeReq({ effortProfile: { ...std, multiSample: 3, estimatedCostUsdPerCall: 0.01 } }))
      .catch((e: unknown) => e);

    expect((out as Error).name).toBe('ProviderTimeout');
    expect(adapterMock).toHaveBeenCalledTimes(2);
    expectUnbilledTimeoutTrace(deps, 0.001 + PARTIAL.usage.costUsd);
    expect(netHeld(deps.budget)).toBeCloseTo(0, 9);
  });

  it('stream STALL backstop (adapter-internal TimeoutError) is a provider timeout too', async () => {
    const deps = makeDeps();
    adapterMock.mockImplementationOnce(() =>
      Promise.reject(
        new OpenRouterAbortError(
          PARTIAL,
          new DOMException('OpenRouter stream stalled: no frame for 10ms', 'TimeoutError'),
        ),
      ),
    );

    const err = await makeRouter(deps, 0).route(makeReq()).catch((e: unknown) => e);

    expect((err as Error).name).toBe('ProviderTimeout');
    expectUnbilledTimeoutTrace(deps, PARTIAL.usage.costUsd);
    expect(netHeld(deps.budget)).toBeCloseTo(0, 9);
  });
});

describe('Router — shutdown and disconnect aborts stay BILLED (not provider timeouts)', () => {
  it('a shutdown abort bills the partial and rethrows the abort', async () => {
    const deps = makeDeps();
    const shutdown = new AbortController();
    adapterMock.mockImplementationOnce((opts: { signal?: AbortSignal }) => {
      queueMicrotask(() => shutdown.abort('ai-service:shutdown'));
      return hangUntilAborted(opts);
    });

    const err = await makeRouter(deps, 10_000)
      .route(makeReq({ signal: shutdown.signal }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenRouterAbortError);
    const trace = deps.traceWriter.writeTrace.mock.calls.at(-1)?.[0];
    expect(trace.status).toBe('aborted');
    expect(trace.actualCostUsd).toBeCloseTo(PARTIAL.usage.costUsd, 9);
    expect(trace.metadata.truncated).toBeUndefined();
    const usage = deps.traceWriter.writeUsage.mock.calls.at(-1)?.[0];
    expect(usage.actualCostUsd).toBeCloseTo(PARTIAL.usage.costUsd, 9);
  });

  it('a client disconnect bills the partial with abortCause=disconnect', async () => {
    const deps = makeDeps();
    const client = new AbortController();
    adapterMock.mockImplementationOnce((opts: { signal?: AbortSignal }) => {
      queueMicrotask(() => client.abort());
      return hangUntilAborted(opts);
    });

    const err = await makeRouter(deps, 10_000)
      .route(makeReq({ signal: client.signal }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenRouterAbortError);
    const trace = deps.traceWriter.writeTrace.mock.calls.at(-1)?.[0];
    expect(trace.actualCostUsd).toBeCloseTo(PARTIAL.usage.costUsd, 9);
    expect(trace.metadata.abortCause).toBe('disconnect');
    expect(trace.metadata.truncated).toBeUndefined();
  });
});
