// Typed errors thrown by `BudgetEnforcer.reserve`.
//
// `BudgetExceeded` — the org has an explicit budget row but it can't cover the
//   requested amount. HTTP 402 with `org`/`requested`/`remaining`/`shortfall`.
//
// `BudgetNotConfigured` — the org has NO `budget_state` row at all. Per
//   ADR-0003 D5 the service is FAIL-CLOSED: an unconfigured org is rejected
//   rather than silently fabricating a $100 bootstrap. HTTP 402 with a clear
//   "no budget configured for org <org>" message so the operator knows to
//   provision a cap (seed/admin) rather than chase a phantom overspend.

export const ERR_BUDGET_EXCEEDED = 'ERR_BUDGET_EXCEEDED';
export const ERR_BUDGET_NOT_CONFIGURED = 'ERR_BUDGET_NOT_CONFIGURED';

export class BudgetExceeded extends Error {
  readonly code = ERR_BUDGET_EXCEEDED;
  readonly shortfallUsd: number;

  constructor(
    public readonly org: string,
    public readonly requested: number,
    public readonly remaining: number,
  ) {
    const shortfall = Math.max(0, requested - remaining);
    super(
      `Budget exceeded for org=${org}: requested $${requested.toFixed(6)} ` +
        `but only $${remaining.toFixed(6)} remaining (shortfall $${shortfall.toFixed(6)})`,
    );
    this.name = 'BudgetExceeded';
    this.shortfallUsd = shortfall;
  }
}

export class BudgetNotConfigured extends Error {
  readonly code = ERR_BUDGET_NOT_CONFIGURED;

  constructor(public readonly org: string) {
    super(`no budget configured for org ${org}`);
    this.name = 'BudgetNotConfigured';
  }
}
