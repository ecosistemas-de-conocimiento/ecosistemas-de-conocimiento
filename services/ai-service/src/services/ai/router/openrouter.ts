// `createOpenRouter` — the default-wired router factory.
//
// Returns the real `Router` (which routes through `callOpenRouter` /
// `callOpenRouterStream`) with its persistence deps filled in. There is no
// mock branch: the `MOCK_LLM` / `MOCK_LLM_STREAM` switches were removed
// so the shipped service cannot produce fake model output. Tests
// that need a provider point `CHAT_COMPLETIONS_URL` at the TEST-ONLY fake
// provider (`test-support/fake-provider/`), or mock the adapter directly via
// `vi.mock('./adapters/openrouter.js')`.

import type { LLMRouter } from './types.js';
import { Router, createRouter, type RouterOptions } from './router.js';
import { db as defaultDb } from '../../../db/client.js';
import { BudgetEnforcer } from '../../budget/enforcer.js';
import { TraceWriter } from './trace-writer.js';
import { getSharedRouterCache } from './cache.js';

/**
 * Return the real `Router`.
 *
 * Default-wires the persistence deps (`BudgetEnforcer`, `TraceWriter`, shared
 * `RouterCache`) so callers don't have to pass them. Without this, the router
 * silently no-ops budget reserves + trace/usage writes — that's a bug that
 * survived M3 and only surfaced when the deployed dev box's `/v1/generate/sync`
 * stopped decrementing `budget_state.remaining_usd` despite real OpenRouter
 * calls.
 *
 * Tests that need to isolate the router pass their own deps via `opts` and
 * still bypass these defaults.
 */
export function createOpenRouter(opts: RouterOptions = {}): LLMRouter {
  return createRouter({
    ...opts,
    budget: opts.budget ?? new BudgetEnforcer(defaultDb),
    traceWriter: opts.traceWriter ?? new TraceWriter(defaultDb),
    cache: opts.cache ?? getSharedRouterCache(),
  });
}

// Re-export for ergonomic single-import surface (`import { Router, createOpenRouter } from '.../openrouter.js'`).
export { Router, createRouter };
export type { RouterOptions };
