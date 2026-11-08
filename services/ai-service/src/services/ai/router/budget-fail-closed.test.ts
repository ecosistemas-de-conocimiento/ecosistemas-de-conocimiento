// The budget gate must not be SKIPPABLE by a reserve that resolves to zero.
//
// ── What this file pins, and why it is its own file ───────────────────────
// Security audit, finding C4 (the only Critical in
// `findings/ai-service.md`), fix-spec step 3. `Router.budgetReserve` used to
// open with:
//
//     if (!this.budget || args.amountUsd <= 0) return undefined;
//
// A zero reserve therefore skipped the budget system ENTIRELY — not "reserve
// nothing", but "do not consult the budget at all". An org with no
// `budget_state` row generated for free, which is the exact opposite of
// ADR-0003 D5 ("an org with no explicit cap is rejected, not bootstrapped").
//
// The caller-driven route to a zero reserve is already closed one layer up:
// `clampCallerLimits` floors `estimatedCostUsdPerCall` at the ADMIN-resolved
// value, so nothing on the wire can push it down (see
// `registry/caller-limits.test.ts`). What this file covers is the population
// that floor cannot reach: an ADMIN who writes `estimatedCostUsdPerCall: 0`
// into a `project_configs` / `registry_entries` effort profile. That resolves
// to a zero reserve for every caller of that org and silently disables the
// gate for all of them.
//
// ── The distinction these tests are built around ──────────────────────────
// STRICT (Rodrigo's ruling). A non-positive or non-finite
// reserve is a CONFIG FAULT and REFUSES. There is no "proceed and settle up"
// branch any more — a zero hold means metering is broken for that org, and a
// broken meter is not served. Two faults, two codes:
//
//   • org with NO budget_state row   → 402 BudgetNotConfigured (ADR-0003 D5).
//   • org WITH a budget_state row    → 402 BudgetMisconfigured, whose message
//                                      names `estimatedCostUsdPerCall` and says
//                                      the budget row itself is fine.
//
// In BOTH cases: no provider call, no spend, and a failed trace written.
//
// The first cut of this fix was SOFT — a configured org proceeded and was billed
// by the post-call true-up. That was overruled: the true-up runs AFTER the
// provider call, cannot decline anything, and with no reserve held it leaves
// unbounded concurrency against a cap that was never consulted. The tests below
// that used to assert "proceeds" now assert the refusal; the pair of
// `never inflate` / `never write NaN` ledger guards were rewritten as
// "the sanitiser still runs before the refusal" assertions, since with a strict
// refusal there is no true-up left to poison.
//
// Verified by sabotage — see the commit message for the captured output.

import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ChatMessage, RouteRequest } from './types.js';
import type { EffortProfile } from '../../registry/resolve.js';
import { RouterCache } from './cache.js';
import { getTaskProfile } from './task-profiles.js';
import { BudgetMisconfigured, BudgetNotConfigured } from '../../budget/errors.js';

// --- Mocks ---------------------------------------------------------------- //

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

vi.mock('../validators/index.js', () => ({
  runValidators: () => [],
}));

vi.mock('../../../config/env.js', () => ({
  env: {
    OPENROUTER_API_KEY: 'env-key-for-tests',
    LLM_REQUEST_TIMEOUT_MS: 0,
    LLM_STREAM_STALL_TIMEOUT_MS: 0,
  },
}));

const { Router } = await import('./router.js');

// --- Fixtures ------------------------------------------------------------- //

/**
 * A stand-in for `BudgetEnforcer`.
 *
 * `assertConfigured` is the seam under test: `configured: false` makes it throw
 * the REAL `BudgetNotConfigured`, because `route()` branches on
 * `err instanceof BudgetNotConfigured` to write the failed trace.
 */
function makeBudget(opts: { configured?: boolean } = {}) {
  const configured = opts.configured ?? true;
  return {
    assertConfigured: vi.fn().mockImplementation(async (org: string) => {
      if (!configured) throw new BudgetNotConfigured(org);
    }),
    reserve: vi.fn().mockResolvedValue({ remainingUsd: 1000, softCap: false }),
    refund: vi.fn().mockResolvedValue(undefined),
    adjust: vi.fn().mockResolvedValue(undefined),
    getRemaining: vi.fn().mockResolvedValue(1000),
  };
}

function makeTraceWriter() {
  return {
    writeTrace: vi.fn().mockResolvedValue({ id: 'trace-row-id' }),
    writeUsage: vi.fn().mockResolvedValue({ id: 'usage-row-id' }),
    assertParentTraceOrg: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCompletion(costUsd = 0.001) {
  return {
    contentText: 'provider answer',
    finishReason: 'stop',
    model: 'deepseek/deepseek-chat-v3.1',
    rawId: 'gen-x',
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      costUsd,
      costSource: 'openrouter' as const,
    },
  };
}

const baseMessages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

/**
 * A request whose ADMIN-resolved effort profile carries `reserve` as its
 * per-call estimate. `reserve` stands in for what an admin wrote into
 * `project_configs.effort_profiles[level].estimatedCostUsdPerCall` — the layer
 * `clampCallerLimits` treats as the floor and therefore cannot correct.
 */
function makeReq(reserve: number, over: Partial<RouteRequest> = {}): RouteRequest {
  const profile: EffortProfile = {
    ...getTaskProfile('standard'),
    estimatedCostUsdPerCall: reserve,
  };
  return {
    label: 'unit:fail-closed',
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

function makeRouter(budget: ReturnType<typeof makeBudget>, traceWriter = makeTraceWriter()) {
  return new Router({
    cache: new RouterCache({ max: 10 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    budget: budget as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    traceWriter: traceWriter as any,
  });
}

beforeEach(() => {
  adapterMock.mockReset();
  // Silence the operator warning the fail-closed branch emits; asserted
  // explicitly in its own test below.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

// ------------------------------------------------------------------------- //

describe('Router — a zero reserve refuses instead of skipping the budget', () => {
  it('refuses with BudgetNotConfigured when the org has no budget row, before any provider call', async () => {
    const budget = makeBudget({ configured: false });
    adapterMock.mockResolvedValue(makeCompletion());

    await expect(makeRouter(budget).route(makeReq(0))).rejects.toBeInstanceOf(
      BudgetNotConfigured,
    );

    // THE point of the finding: the money is never spent.
    expect(adapterMock).not.toHaveBeenCalled();
    expect(budget.assertConfigured).toHaveBeenCalledWith('acme');
    // A zero reserve has nothing to decrement, so `reserve()` is not reached —
    // the gate is `assertConfigured`, not a $0 UPDATE.
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it('writes a failed trace for the refusal, so the rejection is auditable', async () => {
    const budget = makeBudget({ configured: false });
    const traceWriter = makeTraceWriter();

    await expect(makeRouter(budget, traceWriter).route(makeReq(0))).rejects.toBeInstanceOf(
      BudgetNotConfigured,
    );

    expect(traceWriter.writeTrace).toHaveBeenCalledTimes(1);
    const trace = traceWriter.writeTrace.mock.calls[0]?.[0];
    expect(trace.status).toBe('failed');
    expect(trace.org).toBe('acme');
    expect(trace.actualCostUsd).toBe(0);
    expect(trace.metadata.errorCode).toBe('ERR_BUDGET_NOT_CONFIGURED');
  });

  it('logs the org/project/unitKey at warn so the faulty profile is findable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const budget = makeBudget({ configured: false });

    await expect(makeRouter(budget).route(makeReq(0))).rejects.toBeInstanceOf(
      BudgetNotConfigured,
    );

    // `BudgetNotConfigured` can only say "no budget configured for org acme";
    // it cannot name the zero `estimatedCostUsdPerCall` that produced it. This
    // log line is the only thing that points an operator at the actual fault
    // on the no-budget-row path (the `BudgetMisconfigured` MESSAGE does it on
    // the has-a-row path).
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('org=acme');
    expect(line).toContain('project=proj-a');
    expect(line).toContain('unitKey=unit-1');
    expect(line).toContain('estimatedCostUsdPerCall=0');
    expect(line).toContain('REFUSED');
  });

  it('REFUSES a CONFIGURED org too — a zero hold is a config fault, not a discount', async () => {
    // ── THE STRICT FLIP (Rodrigo) ──────────────────────────────
    // This case used to assert a 200 plus a post-call true-up. It is now the
    // headline refusal: the org HAS a budget row, and it is still refused,
    // because a $0 hold means the cap cannot bind. The true-up is a settlement
    // mechanism, not a gate — it runs after the provider call and can decline
    // nothing.
    const budget = makeBudget({ configured: true });
    adapterMock.mockResolvedValue(makeCompletion(0.001));

    await expect(makeRouter(budget).route(makeReq(0))).rejects.toBeInstanceOf(BudgetMisconfigured);

    // No provider call, so no spend to true up.
    expect(adapterMock).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(budget.adjust).not.toHaveBeenCalled();
    // The row check still runs first, so a genuinely-unconfigured org keeps
    // reporting the more fundamental fault instead of this one.
    expect(budget.assertConfigured).toHaveBeenCalledWith('acme');
  });

  it('names the offending field and value in the message, and says the budget row is fine', async () => {
    // The refusal reaches an ADMIN, and `estimatedCostUsdPerCall` lives in a
    // different table from the budget they would otherwise go check. If this
    // assertion is ever loosened, the 402 becomes unactionable.
    const budget = makeBudget({ configured: true });

    const err = await makeRouter(budget)
      .route(makeReq(0))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BudgetMisconfigured);
    const e = err as BudgetMisconfigured;
    expect(e.code).toBe('ERR_BUDGET_MISCONFIGURED');
    expect(e.org).toBe('acme');
    expect(e.estimatedCostUsdPerCall).toBe(0);
    expect(e.message).toContain('estimatedCostUsdPerCall=0');
    expect(e.message).toContain('org=acme');
    expect(e.message).toContain('project=proj-a');
    expect(e.message).toContain('unitKey=unit-1');
    // Must NOT send the admin to provision a budget they already have.
    expect(e.message).toContain("budget row is fine");
  });

  it('writes a failed trace for the CONFIGURED-org refusal too', async () => {
    const budget = makeBudget({ configured: true });
    const traceWriter = makeTraceWriter();

    await expect(makeRouter(budget, traceWriter).route(makeReq(0))).rejects.toBeInstanceOf(
      BudgetMisconfigured,
    );

    expect(traceWriter.writeTrace).toHaveBeenCalledTimes(1);
    const trace = traceWriter.writeTrace.mock.calls[0]?.[0];
    expect(trace.status).toBe('failed');
    expect(trace.actualCostUsd).toBe(0);
    expect(trace.metadata.errorCode).toBe('ERR_BUDGET_MISCONFIGURED');
  });
});

describe('Router — malformed reserves take the same fail-closed branch', () => {
  it('refuses a NEGATIVE reserve for an unconfigured org', async () => {
    const budget = makeBudget({ configured: false });
    adapterMock.mockResolvedValue(makeCompletion());

    await expect(makeRouter(budget).route(makeReq(-5))).rejects.toBeInstanceOf(
      BudgetNotConfigured,
    );
    expect(adapterMock).not.toHaveBeenCalled();
  });

  it('refuses a NEGATIVE reserve for a CONFIGURED org, so nothing reaches the ledger', async () => {
    // Was: "never lets a negative reserve inflate the true-up charge" (a 200
    // whose delta had to be checked). Under strict there is no true-up to
    // poison — the call never happens. Unsanitised AND soft, `totalReservedUsd`
    // would have been -5 and the org charged $5.001 for a $0.001 call.
    const budget = makeBudget({ configured: true });
    adapterMock.mockResolvedValue(makeCompletion(0.001));

    await expect(makeRouter(budget).route(makeReq(-5))).rejects.toBeInstanceOf(BudgetMisconfigured);

    expect(adapterMock).not.toHaveBeenCalled();
    expect(budget.adjust).not.toHaveBeenCalled();
  });

  it('refuses a NaN reserve for an unconfigured org instead of raising a 500', async () => {
    const budget = makeBudget({ configured: false });
    adapterMock.mockResolvedValue(makeCompletion());

    // NaN is not `<= 0`, so before the fix it reached `BudgetEnforcer.reserve`
    // and bottomed out as a bare `Error` (a 500), not a budget rejection.
    await expect(makeRouter(budget).route(makeReq(Number.NaN))).rejects.toBeInstanceOf(
      BudgetNotConfigured,
    );
    expect(adapterMock).not.toHaveBeenCalled();
  });

  it('refuses a NaN reserve for a CONFIGURED org, and never writes NaN to the ledger', async () => {
    const budget = makeBudget({ configured: true });
    adapterMock.mockResolvedValue(makeCompletion(0.001));

    await expect(makeRouter(budget).route(makeReq(Number.NaN))).rejects.toBeInstanceOf(
      BudgetMisconfigured,
    );

    // Postgres `numeric` ACCEPTS NaN, so a delta of NaN would latch
    // `budget_state.remaining_usd` at NaN — an org that can never spend or be
    // topped up again. Strict refusal means nothing is written at all.
    expect(budget.adjust).not.toHaveBeenCalled();
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it('reports the RAW value an admin wrote, not the sanitised 0', async () => {
    // The sanitiser collapses NaN to 0 for the arithmetic. If the diagnostic
    // reported the sanitised value, an admin whose profile holds `null` (→ NaN)
    // would be told it holds `0` and would go looking for a zero that is not in
    // the row.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const budget = makeBudget({ configured: true });

    const err = await makeRouter(budget)
      .route(makeReq(Number.NaN))
      .catch((e: unknown) => e);

    expect((err as BudgetMisconfigured).message).toContain('estimatedCostUsdPerCall=NaN');
    expect(String(warn.mock.calls[0]?.[0])).toContain('estimatedCostUsdPerCall=NaN');
  });

  it('refuses an INFINITE reserve — the one value the guard alone would let through', async () => {
    // Tripwire for the sanitiser specifically. `!(Infinity > 0)` is FALSE, so
    // the fail-closed guard would pass Infinity straight to
    // `BudgetEnforcer.reserve`. Only `Number.isFinite` collapses it to 0 and
    // brings it back into the refusal. Delete the sanitiser and this goes red
    // while every other case in this file stays green.
    const budget = makeBudget({ configured: true });
    adapterMock.mockResolvedValue(makeCompletion(0.001));

    await expect(
      makeRouter(budget).route(makeReq(Number.POSITIVE_INFINITY)),
    ).rejects.toBeInstanceOf(BudgetMisconfigured);

    expect(budget.reserve).not.toHaveBeenCalled();
    expect(adapterMock).not.toHaveBeenCalled();
  });
});

describe('Router — the healthy path is untouched', () => {
  it('reserves the profile amount verbatim and never consults assertConfigured', async () => {
    const budget = makeBudget({ configured: true });
    adapterMock.mockResolvedValue(makeCompletion(0.0005));

    // The built-in `standard` per-call estimate.
    const out = await makeRouter(budget).route(makeReq(0.000737));

    expect(out.content).toBe('provider answer');
    expect(budget.reserve).toHaveBeenCalledTimes(1);
    expect(budget.reserve.mock.calls[0]?.[0].amountUsd).toBe(0.000737);
    // The fail-closed branch is not on the healthy path at all.
    expect(budget.assertConfigured).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('still surfaces a BudgetNotConfigured raised by the positive-reserve path', async () => {
    // Regression guard on the OTHER direction: the new branch must not have
    // taken over the case where a real reserve hits an unconfigured org.
    const budget = makeBudget({ configured: true });
    budget.reserve.mockRejectedValueOnce(new BudgetNotConfigured('acme'));
    adapterMock.mockResolvedValue(makeCompletion());

    await expect(makeRouter(budget).route(makeReq(0.000737))).rejects.toBeInstanceOf(
      BudgetNotConfigured,
    );
    expect(adapterMock).not.toHaveBeenCalled();
  });
});
