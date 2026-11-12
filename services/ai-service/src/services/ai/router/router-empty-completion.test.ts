// An empty provider answer is an ERROR: retried within the bounded ladder,
// filed as a failure, never cached.
//
// Measured on dev (2026-11-10, ai-service request logs plus `edc_ai.traces`):
// 3 of 6 chat answers came back as a 200 with no content, model `unknown`,
// 0 tokens. The router filed them `completed` and cached one, which a later
// identical request was served in 0 ms. See `empty-completion.ts`.

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
  env: {
    OPENROUTER_API_KEY: 'env-key-for-tests',
    LLM_REQUEST_TIMEOUT_MS: 0,
    LLM_STREAM_STALL_TIMEOUT_MS: 0,
  },
}));

const { Router } = await import('./router.js');
const { createProviderResilience, DEFAULT_MAX_RETRY_ATTEMPTS } = await import('./resilience.js');
const { CompletionTruncated, EmptyCompletion } = await import('./empty-completion.js');

const baseMessages: ChatMessage[] = [{ role: 'user', content: 'hola' }];

function completion(
  text: string,
  over: { costUsd?: number; finishReason?: string; promptTokens?: number; completionTokens?: number } = {},
) {
  return {
    contentText: text,
    finishReason: over.finishReason ?? 'stop',
    model: text.trim() === '' ? 'unknown' : 'mock/model',
    rawId: 'gen-1',
    usage: {
      promptTokens: over.promptTokens ?? 0,
      completionTokens: over.completionTokens ?? 0,
      costUsd: over.costUsd ?? 0,
      costSource: 'openrouter' as const,
    },
  };
}

function makeDeps() {
  return {
    traceWriter: {
      writeTrace: vi.fn().mockResolvedValue({ id: 't' }),
      writeUsage: vi.fn().mockResolvedValue({ id: 'u' }),
      assertParentTraceOrg: vi.fn().mockResolvedValue(undefined),
    },
    budget: {
      reserve: vi.fn().mockResolvedValue({ remainingUsd: 1000, softCap: false }),
      refund: vi.fn().mockResolvedValue(undefined),
      adjust: vi.fn().mockResolvedValue(undefined),
      settleReservations: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function makeRouter(deps: ReturnType<typeof makeDeps>, cache = new RouterCache({ max: 10 })) {
  return new Router({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    budget: deps.budget as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    traceWriter: deps.traceWriter as any,
    cache,
    requestTimeoutMs: 0,
    // The production ladder, minus the waits.
    resilience: createProviderResilience({ baseDelayMs: 0, random: () => 0 }),
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

beforeEach(() => {
  adapterMock.mockReset();
  runValidatorsMock.mockReset();
  runValidatorsMock.mockReturnValue([]);
});

describe('Router — an empty answer is a provider error', () => {
  it('retries an empty 200 and returns the next real answer', async () => {
    const deps = makeDeps();
    adapterMock
      .mockResolvedValueOnce(completion(''))
      .mockResolvedValueOnce(completion('respuesta'));

    const out = await makeRouter(deps).route(makeReq());

    expect(out.content).toBe('respuesta');
    expect(adapterMock).toHaveBeenCalledTimes(2);
    // ONE reserve for the whole ladder, as for any retried pass.
    expect(deps.budget.reserve).toHaveBeenCalledTimes(1);
  });

  it('gives up after the bounded ladder: EmptyCompletion with the trace id, failed trace and usage', async () => {
    const deps = makeDeps();
    adapterMock.mockResolvedValue(completion('  \n'));

    const err = await makeRouter(deps).route(makeReq({ traceId: 'trace-e' })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EmptyCompletion);
    expect((err as InstanceType<typeof EmptyCompletion>).traceId).toBe('trace-e');
    // 1 + DEFAULT_MAX_RETRY_ATTEMPTS, never more.
    expect(adapterMock).toHaveBeenCalledTimes(1 + DEFAULT_MAX_RETRY_ATTEMPTS);

    const trace = deps.traceWriter.writeTrace.mock.calls.at(-1)?.[0];
    expect(trace.status).toBe('failed');
    expect(trace.actualCostUsd).toBe(0);
    expect(trace.model).toBe('unknown');
    expect(trace.metadata.errorCode).toBe('EmptyCompletion');
    expect(trace.metadata.providerGenerationId).toBe('gen-1');
    const usage = deps.traceWriter.writeUsage.mock.calls.at(-1)?.[0];
    expect(usage.status).toBe('failed');
    expect(
      deps.traceWriter.writeTrace.mock.calls.filter((c) => c[0].status === 'completed'),
    ).toHaveLength(0);
  });

  it('never caches an empty answer: the identical request asks the provider again', async () => {
    const deps = makeDeps();
    const cache = new RouterCache({ max: 10 });
    const router = makeRouter(deps, cache);
    adapterMock.mockResolvedValue(completion(''));

    await expect(router.route(makeReq())).rejects.toBeInstanceOf(EmptyCompletion);
    expect(cache.size).toBe(0);

    adapterMock.mockReset();
    adapterMock.mockResolvedValueOnce(completion('ahora sí'));
    const out = await router.route(makeReq());
    expect(out.cached).toBe(false);
    expect(out.content).toBe('ahora sí');
    expect(adapterMock).toHaveBeenCalledTimes(1);
  });

  it('is not retried once text reached the client (no duplicated stream)', async () => {
    const deps = makeDeps();
    adapterMock.mockImplementation(async (opts: { onDelta?: (t: string) => void }) => {
      opts.onDelta?.(' ');
      return completion(' ');
    });

    const deltas: string[] = [];
    const err = await makeRouter(deps)
      .route(makeReq({ onDelta: (t) => deltas.push(t) }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EmptyCompletion);
    expect(adapterMock).toHaveBeenCalledTimes(1);
    expect(deltas).toEqual([' ']);
  });

  it('an empty refine pass never replaces the draft', async () => {
    const deps = makeDeps();
    adapterMock
      .mockResolvedValueOnce(completion('borrador'))
      .mockResolvedValue(completion(''));

    const out = await makeRouter(deps).route(
      makeReq({ effortLevel: 'deep', effortProfile: { ...getTaskProfile('deep'), estimatedCostUsdPerCall: 0.01, multiSample: 1 } }),
    );

    expect(out.content).toBe('borrador');
  });
});

// The provider can bill an empty answer (`providerCostUsd` exists for that).
// Costs below are synthetic test values, chosen to be exact in binary-ish sums.
describe('Router — every attempt of the ladder is paid for', () => {
  it('two billed empty attempts then a success: trace, usage and budget carry all three', async () => {
    const deps = makeDeps();
    adapterMock
      .mockResolvedValueOnce(completion('', { costUsd: 0.001, promptTokens: 10, completionTokens: 5 }))
      .mockResolvedValueOnce(completion('', { costUsd: 0.002, promptTokens: 10, completionTokens: 7 }))
      .mockResolvedValueOnce(completion('respuesta', { costUsd: 0.004, promptTokens: 10, completionTokens: 9 }));

    const out = await makeRouter(deps).route(makeReq({ traceId: 'trace-c' }));

    expect(out.content).toBe('respuesta');
    expect(adapterMock).toHaveBeenCalledTimes(3);
    const total = 0.001 + 0.002 + 0.004;
    expect(out.usage.estimatedCostUsd).toBeCloseTo(total, 12);

    const trace = deps.traceWriter.writeTrace.mock.calls.at(-1)?.[0];
    expect(trace.status).toBe('completed');
    expect(trace.actualCostUsd).toBeCloseTo(total, 12);
    expect(trace.costBreakdown).toHaveLength(3);
    expect(trace.costBreakdown.filter((b: { empty?: true }) => b.empty)).toHaveLength(2);
    expect(
      trace.costBreakdown.reduce((n: number, b: { outputTokens: number }) => n + b.outputTokens, 0),
    ).toBe(5 + 7 + 9);
    const usage = deps.traceWriter.writeUsage.mock.calls.at(-1)?.[0];
    expect(usage.actualCostUsd).toBeCloseTo(total, 12);
    // ONE reserve (0.01), and the true-up charges the real spend against it.
    expect(deps.budget.reserve).toHaveBeenCalledTimes(1);
    expect(deps.budget.adjust).toHaveBeenCalledTimes(1);
    expect(deps.budget.adjust.mock.calls[0]?.[0].deltaUsd).toBeCloseTo(0.01 - total, 12);
  });

  it('every attempt empty: unbilled, and providerCostUsd is the sum of all of them', async () => {
    const deps = makeDeps();
    adapterMock.mockResolvedValue(completion('', { costUsd: 0.001 }));

    await expect(makeRouter(deps).route(makeReq())).rejects.toBeInstanceOf(EmptyCompletion);

    const trace = deps.traceWriter.writeTrace.mock.calls.at(-1)?.[0];
    expect(trace.actualCostUsd).toBe(0);
    expect(trace.metadata.providerCostUsd).toBeCloseTo(0.001 * (1 + DEFAULT_MAX_RETRY_ATTEMPTS), 12);
    expect(trace.costBreakdown).toHaveLength(1 + DEFAULT_MAX_RETRY_ATTEMPTS);
  });
});

describe('Router — empty at the token cap is CompletionTruncated, not retried', () => {
  it('length + empty: exactly one provider call, ERR_COMPLETION_TRUNCATED with the trace id', async () => {
    const deps = makeDeps();
    adapterMock.mockResolvedValue(completion('', { finishReason: 'length', costUsd: 0.003 }));

    const err = await makeRouter(deps).route(makeReq({ traceId: 'trace-t' })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CompletionTruncated);
    expect((err as InstanceType<typeof CompletionTruncated>).code).toBe('ERR_COMPLETION_TRUNCATED');
    expect((err as InstanceType<typeof CompletionTruncated>).traceId).toBe('trace-t');
    expect(adapterMock).toHaveBeenCalledTimes(1);

    const trace = deps.traceWriter.writeTrace.mock.calls.at(-1)?.[0];
    expect(trace.status).toBe('failed');
    expect(trace.actualCostUsd).toBe(0);
    expect(trace.metadata.errorCode).toBe('CompletionTruncated');
    expect(trace.metadata.providerCostUsd).toBeCloseTo(0.003, 12);
  });

  it('a provider spelling of the cap (`max_tokens`) counts too, on the stream path', async () => {
    const deps = makeDeps();
    adapterMock.mockResolvedValue(completion('', { finishReason: 'max_tokens' }));

    const err = await makeRouter(deps)
      .route(makeReq({ onDelta: () => undefined }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CompletionTruncated);
    expect(adapterMock).toHaveBeenCalledTimes(1);
  });

  it('length WITH content is still a success, finishReason length, one call', async () => {
    const deps = makeDeps();
    adapterMock.mockResolvedValue(completion('texto cortado', { finishReason: 'length' }));

    const out = await makeRouter(deps).route(makeReq());

    expect(out.content).toBe('texto cortado');
    expect(out.finishReason).toBe('length');
    expect(adapterMock).toHaveBeenCalledTimes(1);
  });

  it('a plain empty answer (finish stop) is still retried', async () => {
    const deps = makeDeps();
    adapterMock
      .mockResolvedValueOnce(completion('', { finishReason: 'stop' }))
      .mockResolvedValueOnce(completion('', { finishReason: 'stop' }))
      .mockResolvedValueOnce(completion('al fin'));

    const out = await makeRouter(deps).route(makeReq());

    expect(out.content).toBe('al fin');
    expect(adapterMock).toHaveBeenCalledTimes(3);
  });
});
