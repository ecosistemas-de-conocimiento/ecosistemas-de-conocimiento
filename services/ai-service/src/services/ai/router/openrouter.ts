// MOCK_LLM=1 short-circuit factory.
//
// In production, `createOpenRouter` returns the real `Router` (which routes
// through `callOpenRouter`). When the `MOCK_LLM` env var is set to `'1'`, it
// returns a deterministic mock implementation that:
//   - bypasses the cache, budget, and HTTP adapter entirely;
//   - still calls `TraceWriter.writeTrace` / `writeUsage` (so observability
//     tests don't break);
//   - returns the canned `'[MOCK] response'` content with zero-cost / zero-token
//     usage.
//
// Tests that need to assert content shape should mock the adapter directly via
// `vi.mock('./adapters/openrouter.js')` and NOT rely on this switch.

import type {
  LLMRouter,
  RouteRequest,
  RouteResult,
  TokenUsage,
} from './types.js';
import { Router, createRouter, type RouterOptions } from './router.js';
import { db as defaultDb } from '../../../db/client.js';
import { BudgetEnforcer } from '../../budget/enforcer.js';
import { TraceWriter } from './trace-writer.js';
import { getSharedRouterCache } from './cache.js';
import { mockStreamingAdapter } from './adapters/mock-stream.js';

const DEFAULT_PROVIDER = 'openrouter' as const;

/**
 * Return the real `Router`, or a minimal mock when `MOCK_LLM === '1'`.
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
  const resolved: RouterOptions = {
    ...opts,
    budget: opts.budget ?? new BudgetEnforcer(defaultDb),
    traceWriter: opts.traceWriter ?? new TraceWriter(defaultDb),
    cache: opts.cache ?? getSharedRouterCache(),
  };
  if (process.env['MOCK_LLM_STREAM'] === '1') {
    // Real router pipeline (budget, traces, validators) with a fake streaming
    // adapter that respects AbortSignal. Used by the e2e cancel-flow test.
    return createRouter({ ...resolved, adapter: mockStreamingAdapter });
  }
  if (process.env['MOCK_LLM'] === '1') {
    return createMockRouter(resolved);
  }
  return createRouter(resolved);
}

function createMockRouter(opts: RouterOptions): LLMRouter {
  return {
    async route(req: RouteRequest): Promise<RouteResult> {
      const traceId = req.traceId ?? crypto.randomUUID();
      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      };

      if (opts.traceWriter) {
        await opts.traceWriter.writeTrace({
          org: req.org,
          project: req.project ?? null,
          label: req.label,
          status: 'completed',
          model: req.model,
          provider: DEFAULT_PROVIDER,
          generationRequestId: req.generationRequestId,
          generationJobId: req.generationJobId,
          registryEntryId: req.registryEntryId,
          parentTraceId: req.parentTraceId,
          promptVersion: req.promptVersion,
          tokenUsage: usage,
          durationMs: 0,
          effort: req.effortLevel,
          effortProfileUsed: req.effortProfile,
          estimatedCostUsd: 0,
          actualCostUsd: 0,
          outputPayload: { content: '[MOCK] response' },
          metadata: { mock: true, traceId, unitKey: req.unitKey, unitType: req.unitType },
        });
        await opts.traceWriter.writeUsage({
          org: req.org,
          project: req.project ?? null,
          traceId,
          generationRequestId: req.generationRequestId,
          generationJobId: req.generationJobId,
          provider: DEFAULT_PROVIDER,
          model: req.model,
          endpoint: 'router.route',
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          actualCostUsd: 0,
          status: 'completed',
        });
      }

      return {
        content: '[MOCK] response',
        parsed: undefined,
        flags: [],
        usage,
        model: req.model,
        provider: DEFAULT_PROVIDER,
        traceId,
        cached: false,
        durationMs: 0,
        effort: req.effortLevel,
        effortProfileUsed: req.effortProfile,
      };
    },
  };
}

// Re-export for ergonomic single-import surface (`import { Router, createOpenRouter } from '.../openrouter.js'`).
export { Router, createRouter };
export type { RouterOptions };
