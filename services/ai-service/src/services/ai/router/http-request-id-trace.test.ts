// The HTTP correlation id must survive as far as the TRACE ROW, or it stops
// being a correlation id.
//
// The point of `httpRequestId` is to answer one support question end to end:
// "here is the id my client saw — what happened?" That only works if the same
// value is on the response header, on the span, AND on the row the operator
// actually queries. The header and span are pinned in
// `routes/generate-span.test.ts`; this file pins the last hop.
//
// 🔴 IT RIDES IN THE EXISTING `metadata` jsonb COLUMN. No migration, no schema
// churn for a field whose only job is to be greppable
// (`select … where metadata->>'httpRequestId' = $1`). The cost of that choice
// is that nothing in the type system says the key is there — hence this test.
//
// 🔴 …AND IT IS OMITTED WHEN ABSENT. The async worker path has no HTTP request
// of its own, so its rows must look exactly as they did before. A `null` or an
// empty string would quietly change every existing row's shape and break any
// consumer doing `metadata ? …`.
//
// BOTH OUTCOMES ARE COVERED on the real `Router`: a completed call (with a
// test-local adapter, so no network) and a budget refusal (a FAILED row).
//
// SABOTAGE (measured): drop `...httpRequestIdMeta(req)` from either write site
// and the matching test goes RED on `undefined`.

import { describe, expect, it, vi } from 'vitest';

import { BudgetNotConfigured } from '../../budget/errors.js';
import { Router, type RouterOptions } from './router.js';
import { RouterCache } from './cache.js';
import type { TraceWriter } from './trace-writer.js';
import type { RouteRequest } from './types.js';
import type { OpenRouterCompletion } from './adapters/openrouter.js';

/** Test-local adapter: a fixed completion, no network. */
async function fixedAdapter(): Promise<OpenRouterCompletion> {
  return {
    contentText: 'test adapter output',
    finishReason: 'stop',
    model: 'test/model',
    usage: { promptTokens: 5, completionTokens: 3, costUsd: 0, costSource: 'openrouter' },
  };
}

function stubDeps(): RouterOptions {
  return {
    adapter: fixedAdapter,
    cache: new RouterCache({ max: 10 }),
    traceWriter: {
      writeTrace: vi.fn(async () => undefined),
      writeUsage: vi.fn(async () => undefined),
    } as unknown as TraceWriter,
  };
}

const PROFILE = {
  model: 'test/model',
  maxOutputTokens: 200,
  validationPasses: 1,
  multiSample: 1,
  temperature: 0.4,
  estimatedCostUsdPerCall: 0.001,
};

function req(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    label: 'test',
    org: 'acme',
    unitKey: 'u-1',
    messages: [{ role: 'user', content: 'Hello there, model.' }],
    model: 'test/model',
    effortLevel: 'standard',
    effortProfile: PROFILE,
    ...over,
  } as RouteRequest;
}

function tracedMetadata(deps: RouterOptions): Record<string, unknown> {
  const writeTrace = deps.traceWriter!.writeTrace as unknown as ReturnType<typeof vi.fn>;
  expect(writeTrace.mock.calls.length, 'no trace row was written at all').toBeGreaterThan(0);
  const input = writeTrace.mock.calls[0]![0] as { metadata?: Record<string, unknown> };
  return input.metadata ?? {};
}

describe('traces.metadata.httpRequestId — a completed call on the real Router', () => {
  it('records the id the caller was handed', async () => {
    const deps = stubDeps();
    await new Router(deps).route(req({ httpRequestId: 'req-abc-123' }));
    expect(tracedMetadata(deps)['httpRequestId']).toBe('req-abc-123');
  });

  it('omits the key entirely when there is no HTTP request behind the call', async () => {
    // The worker path. `toBeUndefined()` alone would also pass on an explicit
    // `httpRequestId: undefined`, which serialises into the jsonb as a present
    // key — so assert on the KEY SET, which is what a consumer sees.
    const deps = stubDeps();
    await new Router(deps).route(req());
    expect(Object.keys(tracedMetadata(deps))).not.toContain('httpRequestId');
  });
});

describe('traces.metadata.httpRequestId — the real Router', () => {
  // A budget refusal is the cheapest real-`Router` path that writes a trace
  // row: it throws BEFORE any provider call, so no adapter, no network and no
  // fixture — and a FAILED row is where an operator most wants the id, because
  // a failure is what a consumer opens a ticket about.
  function refusingRouter(traceWriter: {
    writeTrace: ReturnType<typeof vi.fn>;
    writeUsage: ReturnType<typeof vi.fn>;
  }) {
    const budget = {
      assertConfigured: vi.fn(async (org: string) => {
        throw new BudgetNotConfigured(org);
      }),
      reserve: vi.fn(),
      refund: vi.fn(),
      adjust: vi.fn(),
      getRemaining: vi.fn(),
    };
    return new Router({
      cache: new RouterCache({ max: 10 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      budget: budget as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      traceWriter: traceWriter as any,
    });
  }

  it('records the id on a FAILED trace row', async () => {
    const traceWriter = {
      writeTrace: vi.fn().mockResolvedValue({ id: 't1' }),
      writeUsage: vi.fn().mockResolvedValue({ id: 'u1' }),
    };
    await expect(
      refusingRouter(traceWriter).route(
        req({ httpRequestId: 'req-def-456', effortProfile: { ...PROFILE, estimatedCostUsdPerCall: 0 } }),
      ),
    ).rejects.toBeInstanceOf(BudgetNotConfigured);

    const meta = traceWriter.writeTrace.mock.calls[0]![0].metadata as Record<string, unknown>;
    expect(meta['httpRequestId']).toBe('req-def-456');
  });
});
