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
const { EmptyCompletion } = await import('./empty-completion.js');

const baseMessages: ChatMessage[] = [{ role: 'user', content: 'hola' }];

function completion(text: string) {
  return {
    contentText: text,
    finishReason: 'stop',
    model: text.trim() === '' ? 'unknown' : 'mock/model',
    rawId: 'gen-1',
    usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, costSource: 'openrouter' as const },
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
