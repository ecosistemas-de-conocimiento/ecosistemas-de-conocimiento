// The emit side of the LLM / budget metrics.
//
// These assert on the DEFAULT registry of `@prometheus-io/client`, which is
// the contract with the lane that owns `/metrics` — if a counter is not on
// THAT registry it is not scraped, and asserting on the module's exported
// counter objects instead would pass while the endpoint served nothing. It is
// also what catches an import of the deprecated `prom-client`, whose separate
// default registry would leave every assertion here reading 0.

import { describe, expect, it, vi } from 'vitest';
import { register } from '@prometheus-io/client';

import { recordBreakerState, recordBudgetRefusal, recordPass } from './llm.js';
import { OpenRouterHttpError, type OpenRouterCompletion } from '../services/ai/router/adapters/openrouter.js';
import { createProviderResilience } from '../services/ai/router/resilience.js';
import { RouterCache } from '../services/ai/router/cache.js';
import { getTaskProfile } from '../services/ai/router/task-profiles.js';
import type { RouteRequest } from '../services/ai/router/types.js';

vi.mock('../services/ai/validators/index.js', () => ({ runValidators: () => [] }));
vi.mock('../config/env.js', () => ({
  env: {
    OPENROUTER_API_KEY: 'env-key-for-tests',
    LLM_REQUEST_TIMEOUT_MS: 0,
    LLM_STREAM_STALL_TIMEOUT_MS: 0,
  },
}));

const { Router } = await import('../services/ai/router/router.js');

/**
 * Read one counter/gauge sample off the DEFAULT registry.
 *
 * ⚠ Reads a DELTA, never an absolute. Counters are process-wide and other
 * tests in the same file (and the same worker) increment them, so asserting
 * `toBe(1)` would make each test depend on the order of every test before it.
 */
async function sample(name: string, labels: Record<string, string>): Promise<number> {
  const metrics = await register.getMetricsAsJSON();
  const m = metrics.find((x) => x.name === name);
  if (!m) return 0;
  const hit = (m.values as Array<{ value: number; labels: Record<string, unknown> }>).find((v) =>
    Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val),
  );
  return hit?.value ?? 0;
}

function completion(): OpenRouterCompletion {
  return {
    contentText: 'ok',
    finishReason: 'stop',
    model: 'deepseek/deepseek-chat-v3.1',
    usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.002, costSource: 'openrouter' },
  };
}

function makeReq(over: Partial<RouteRequest> = {}): RouteRequest {
  const profile = getTaskProfile('standard');
  return {
    label: 'unit:m',
    unitKey: 'unit-m',
    unitType: 'm',
    org: 'metrics-org',
    project: 'proj-m',
    messages: [{ role: 'user', content: 'metrics please' }],
    model: profile.model ?? 'deepseek/deepseek-chat-v3.1',
    effortLevel: 'standard',
    effortProfile: profile,
    ...over,
  };
}

describe('metrics registration', () => {
  it('registers all four instruments on the default registry', async () => {
    const names = (await register.getMetricsAsJSON()).map((m) => m.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'ai_llm_pass_total',
        'ai_llm_cost_usd_total',
        'ai_budget_refusals_total',
        'ai_breaker_state',
      ]),
    );
  });

  it('re-importing does not throw on a duplicate metric name', async () => {
    // The client THROWS on a duplicate registration; `getOrCreate` is why this
    // module can be imported from the router, the enforcer and their tests.
    //
    // ⚠ `vi.resetModules()` + a DYNAMIC import is the whole test. A plain
    // `import('./llm.js')` hands back the already-initialised module out of
    // vitest's cache, so the top-level registrations never re-run and this
    // assertion cannot fail — it stayed green even with `getOrCreate` gutted.
    // Resetting the module graph forces a genuinely fresh instantiation, while
    // `@prometheus-io/client` (externalised, not reset) keeps the SAME default
    // registry — which is exactly what makes the second registration a duplicate.
    vi.resetModules();
    await expect(import('./llm.js')).resolves.toBeDefined();
  });
});

describe('recordPass / recordBudgetRefusal / recordBreakerState', () => {
  it('increments the pass counter under the right labels', async () => {
    const before = await sample('ai_llm_pass_total', { purpose: 'refine', status: 'failure' });
    recordPass({ purpose: 'refine', status: 'failure' });
    expect(await sample('ai_llm_pass_total', { purpose: 'refine', status: 'failure' })).toBe(
      before + 1,
    );
  });

  it('adds the pass cost to the org counter, and ignores a zero cost', async () => {
    const before = await sample('ai_llm_cost_usd_total', { org: 'cost-org' });
    recordPass({ purpose: 'generate', status: 'success', org: 'cost-org', costUsd: 0.25 });
    recordPass({ purpose: 'generate', status: 'success', org: 'cost-org', costUsd: 0 });
    expect(await sample('ai_llm_cost_usd_total', { org: 'cost-org' })).toBeCloseTo(before + 0.25, 9);
  });

  it('counts a budget refusal by remedy', async () => {
    const before = await sample('ai_budget_refusals_total', { reason: 'misconfigured' });
    recordBudgetRefusal('misconfigured');
    expect(await sample('ai_budget_refusals_total', { reason: 'misconfigured' })).toBe(before + 1);
  });

  it('publishes breaker state as a level, not an accumulation', async () => {
    recordBreakerState('probe-provider', 1);
    expect(await sample('ai_breaker_state', { provider: 'probe-provider' })).toBe(1);
    recordBreakerState('probe-provider', 0);
    expect(await sample('ai_breaker_state', { provider: 'probe-provider' })).toBe(0);
  });
});

describe('the router emits them', () => {
  it('a successful pass increments the counter and the org cost', async () => {
    const passBefore = await sample('ai_llm_pass_total', { purpose: 'generate', status: 'success' });
    const costBefore = await sample('ai_llm_cost_usd_total', { org: 'metrics-org' });

    const router = new Router({
      cache: new RouterCache({ max: 10 }),
      adapter: vi.fn().mockResolvedValue(completion()),
      resilience: createProviderResilience({ baseDelayMs: 1, maxDelayMs: 10 }),
    } as never);
    await router.route(makeReq());

    expect(await sample('ai_llm_pass_total', { purpose: 'generate', status: 'success' })).toBe(
      passBefore + 1,
    );
    expect(await sample('ai_llm_cost_usd_total', { org: 'metrics-org' })).toBeCloseTo(
      costBefore + 0.002,
      9,
    );
  });

  it('a failing pass lands in the failure bucket and costs nothing', async () => {
    const failBefore = await sample('ai_llm_pass_total', { purpose: 'generate', status: 'failure' });
    const costBefore = await sample('ai_llm_cost_usd_total', { org: 'metrics-org' });

    const router = new Router({
      cache: new RouterCache({ max: 10 }),
      adapter: vi.fn().mockRejectedValue(new OpenRouterHttpError({ status: 400, message: 'bad' })),
      resilience: createProviderResilience({ baseDelayMs: 1, maxDelayMs: 10 }),
    } as never);
    await router.route(makeReq({ messages: [{ role: 'user', content: 'fail me' }] })).catch(() => {});

    expect(await sample('ai_llm_pass_total', { purpose: 'generate', status: 'failure' })).toBe(
      failBefore + 1,
    );
    expect(await sample('ai_llm_cost_usd_total', { org: 'metrics-org' })).toBeCloseTo(costBefore, 9);
  });
});
