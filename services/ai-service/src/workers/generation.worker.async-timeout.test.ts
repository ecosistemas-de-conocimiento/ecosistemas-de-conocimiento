// The async worker's router gets ITS OWN request deadline.
//
// 🔴 Why this file exists. `runGenerationJob` built its router with
// `createOpenRouter({ budget, traceWriter })` and nothing else, so the router
// fell back to `env.LLM_REQUEST_TIMEOUT_MS` (120 s in every env, quoted from
// the Coolify env at the time of writing). A `deep` unit on the async path —
// where no HTTP client is waiting — therefore died at the same 120 s wall as a
// sync call. Worst cut seen: 120 038 ms (measured,
// req-1gk; the true duration of that unit is unknown because it was cut).
//
// `LLM_ASYNC_REQUEST_TIMEOUT_MS` is the async-only deadline. This file pins
// that the worker hands it to the router it builds.
//
// Sabotage: drop `requestTimeoutMs: env.LLM_ASYNC_REQUEST_TIMEOUT_MS` from the
// `createOpenRouter` call in `generation.worker.ts` and the first case goes red
// (the router then gets `undefined` and falls back to the sync deadline).

import { afterEach, describe, expect, it, vi } from 'vitest';

const ROUTER_BUILT = new Error('router built — stop here');
const createOpenRouterSpy = vi.fn((_opts: Record<string, unknown>) => {
  throw ROUTER_BUILT;
});

vi.mock('../services/ai/router/openrouter.js', async () => {
  const actual = await vi.importActual<typeof import('../services/ai/router/openrouter.js')>(
    '../services/ai/router/openrouter.js',
  );
  return { ...actual, createOpenRouter: (opts: Record<string, unknown>) => createOpenRouterSpy(opts) };
});

async function routerOptsFor(asyncTimeout: string | undefined): Promise<Record<string, unknown>> {
  vi.resetModules();
  createOpenRouterSpy.mockClear();
  if (asyncTimeout !== undefined) vi.stubEnv('LLM_ASYNC_REQUEST_TIMEOUT_MS', asyncTimeout);
  const { processGenerationJob } = await import('./generation.worker.js');
  // The router is built before the first DB read, so an empty db stub is
  // enough: the spy throws before anything touches it.
  await expect(
    processGenerationJob(
      { id: 'q-1', data: { jobId: 'job-1', generationRequestId: 'req-1' } as never },
      { db: {} as never, bus: { publish: () => undefined } as never },
    ),
  ).rejects.toBe(ROUTER_BUILT);
  expect(createOpenRouterSpy).toHaveBeenCalledTimes(1);
  return createOpenRouterSpy.mock.calls[0]![0];
}

describe('generation worker — async request deadline', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('passes LLM_ASYNC_REQUEST_TIMEOUT_MS to the router it builds', async () => {
    const opts = await routerOptsFor('600000');
    expect(opts.requestTimeoutMs).toBe(600_000);
    // Budget + trace wiring is untouched by the change.
    expect(opts.budget).toBeDefined();
    expect(opts.traceWriter).toBeDefined();
  });

  it('unset ⇒ the router gets the sync deadline (no behaviour change by default)', async () => {
    const opts = await routerOptsFor(undefined);
    expect(opts.requestTimeoutMs).toBe(120_000);
  });
});
