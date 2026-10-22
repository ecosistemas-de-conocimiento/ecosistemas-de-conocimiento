// Budget metering for the retrieval path (AIS-7, retrieval half).
//
// A retrieve spends money in two places: the query embedding (always) and the
// cross-encoder rerank (when asked for and configured). Before this, neither
// touched `budget_state`, so retrieval spend never counted against the cap.
//
// Same shape as `/v1/embed` and the chat router: reserve an estimate BEFORE the
// paid call, true up to the actuals AFTER. A refused reserve throws the budget
// classes unchanged (`BudgetExceeded` / `BudgetNotConfigured` /
// `BudgetMisconfigured`, all 402), so a retrieve fails exactly the way
// `/v1/generate/sync` does.
//
// The enforcer is used through its public API only (`reserve` / `refund` /
// `adjust`); this module adds no budget semantics of its own.

import { randomUUID } from 'node:crypto';

import type { BudgetEnforcer } from '../budget/enforcer.js';
import { priceForEmbedding } from '../ai/router/task-profiles.js';

/** The slice of `BudgetEnforcer` retrieval needs. Injectable for tests. */
export type RetrievalBudget = Pick<BudgetEnforcer, 'reserve' | 'refund' | 'adjust'>;

/**
 * chars/4, the heuristic `/v1/embed` and the chunker use for a pre-call
 * estimate. The true-up corrects it against the provider-reported tokens.
 */
export function estimateQueryEmbedUsd(model: string, query: string): number {
  return priceForEmbedding(model, Math.ceil(query.length / 4));
}

/**
 * One reservation, opened before the paid calls and closed exactly once.
 *
 * The rerank has no price table, so it reserves nothing up front and its
 * provider-reported cost is charged at the true-up (a negative delta, the same
 * way the router charges an actual above its estimate).
 */
export class RetrievalMeter {
  private spentUsd = 0;
  private closed = false;

  private constructor(
    private readonly budget: RetrievalBudget | undefined,
    private readonly org: string,
    private readonly reservedUsd: number,
    private readonly traceId: string,
    /** True when the reserve crossed the org's soft cap. */
    readonly softCap: boolean,
  ) {}

  /**
   * Reserve `estimateUsd`. Throws the enforcer's 402 classes on refusal.
   * With no budget injected, nothing is reserved and nothing is charged.
   */
  static async open(
    budget: RetrievalBudget | undefined,
    args: { org: string; project: string; estimateUsd: number },
  ): Promise<RetrievalMeter> {
    const traceId = randomUUID();
    if (!budget) return new RetrievalMeter(undefined, args.org, 0, traceId, false);
    // Non-finite or negative collapses to 0, as in the router: a NaN reserve
    // would poison `remaining_usd`. A $0 reserve still fails closed on an
    // unconfigured org.
    const amountUsd =
      Number.isFinite(args.estimateUsd) && args.estimateUsd > 0 ? args.estimateUsd : 0;
    const out = await budget.reserve({
      org: args.org,
      project: args.project,
      amountUsd,
      traceId,
    });
    return new RetrievalMeter(budget, args.org, amountUsd, traceId, out.softCap);
  }

  /** Record an actual cost. Non-finite or negative values count as 0. */
  charge(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.spentUsd += usd;
  }

  /**
   * Close the reservation against what was really spent. Idempotent. Called
   * on success AND on failure: an embed that succeeded before a later step
   * threw was still paid for, so it is still charged.
   */
  async close(): Promise<void> {
    if (this.closed || !this.budget) return;
    this.closed = true;
    if (this.spentUsd === 0) {
      await this.budget.refund({
        org: this.org,
        amountUsd: this.reservedUsd,
        traceId: this.traceId,
      });
      return;
    }
    await this.budget.adjust({
      org: this.org,
      deltaUsd: this.reservedUsd - this.spentUsd,
      traceId: this.traceId,
    });
  }
}
