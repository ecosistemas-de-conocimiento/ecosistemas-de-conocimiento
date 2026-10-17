// Typed budget refusals. All three are HTTP 402 and all three mean "the org's
// cost ceiling could not be enforced for this call, so the call was not made".
// They are separate classes because the OPERATOR REMEDY differs, and that is
// the only reason a consumer would ever branch on them:
//
// `BudgetExceeded` — the org has an explicit budget row but it can't cover the
//   requested amount. Remedy: top up. HTTP 402 with
//   `org`/`requested`/`remaining`/`shortfall`.
//
// `BudgetNotConfigured` — the org has NO `budget_state` row at all. Per
//   ADR-0003 D5 the service is FAIL-CLOSED: an unconfigured org is rejected
//   rather than silently fabricating a $100 bootstrap. Remedy: provision a cap
//   (`npm run set-budget`). HTTP 402 with a clear "no budget configured for
//   org <org>" message so the operator knows to provision rather than chase a
//   phantom overspend.
//
// `BudgetMisconfigured` — the org HAS a `budget_state` row, but the resolved
//   effort profile carries a non-positive / non-finite
//   `estimatedCostUsdPerCall`, so the pre-flight hold would be $0 and the cap
//   cannot bind. Remedy: fix the effort profile — NOT the budget row. Added
//   by Rodrigo's ruling on security audit finding C4:
//   a zero hold means metering is broken for that org, and a broken meter is
//   refused rather than served on the strength of the post-call true-up alone.
//
//   Why a sibling class instead of reusing `BudgetNotConfigured`: ADR-0003 §2
//   defines `BudgetNotConfigured` strictly as "the org has no `budget_state`
//   row", and the typed client documents its remedy as "ask the platform to
//   provision a budget". Both are FALSE for this population — the row exists —
//   so reusing that class would send an operator to provision a budget they
//   already have. The wire addition is additive: `errorFromResponse` in
//   `@edc/ai-client` degrades an unknown discriminator to a plain
//   `AIServiceError` carrying this status and message, and no previously
//   succeeding call path changes shape.

import { AiServiceError } from '../../errors/base.js';

export const ERR_BUDGET_EXCEEDED = 'ERR_BUDGET_EXCEEDED';
export const ERR_BUDGET_NOT_CONFIGURED = 'ERR_BUDGET_NOT_CONFIGURED';
export const ERR_BUDGET_MISCONFIGURED = 'ERR_BUDGET_MISCONFIGURED';

export class BudgetExceeded extends AiServiceError {
  readonly code = ERR_BUDGET_EXCEEDED;
  readonly status = 402;
  /** The router refuses mid-stream too, so this must name itself in a frame. */
  override readonly midStream = true;
  readonly shortfallUsd: number;

  protected override bodyFields() {
    return {
      org: this.org,
      requested: this.requested,
      remaining: this.remaining,
      shortfallUsd: this.shortfallUsd,
    };
  }

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

export class BudgetNotConfigured extends AiServiceError {
  readonly code = ERR_BUDGET_NOT_CONFIGURED;
  readonly status = 402;
  override readonly midStream = true;

  protected override bodyFields() {
    return { org: this.org };
  }

  constructor(public readonly org: string) {
    super(`no budget configured for org ${org}`);
    this.name = 'BudgetNotConfigured';
  }
}

/**
 * The org's budget row exists, but the resolved per-call cost estimate is
 * non-positive or non-finite, so nothing can be held against it.
 *
 * The message names the offending field and value on purpose: this error is
 * read by an ADMIN hunting a config fault, and `estimatedCostUsdPerCall` lives
 * on a `project_configs` / `registry_entries` effort profile — a different row,
 * in a different table, from the budget the operator would otherwise go check.
 *
 * `estimatedCostUsdPerCall` is kept on the instance for the wire body. It may
 * be `NaN` or `±Infinity`; `JSON.stringify` turns those into `null`, so the
 * route layer normalises before serialising and the MESSAGE (which uses
 * `String(...)`) stays the authoritative record of the actual value.
 */
export class BudgetMisconfigured extends AiServiceError {
  readonly code = ERR_BUDGET_MISCONFIGURED;
  readonly status = 402;
  override readonly midStream = true;
  readonly estimatedCostUsdPerCall: number;

  protected override bodyFields() {
    return {
      org: this.org,
      // NaN / ±Infinity serialise to `null`, which would read as "no value" —
      // the exact value always survives in `message`.
      estimatedCostUsdPerCall: Number.isFinite(this.estimatedCostUsdPerCall)
        ? this.estimatedCostUsdPerCall
        : null,
    };
  }

  constructor(
    public readonly org: string,
    estimatedCostUsdPerCall: number,
    ctx: { project?: string | undefined; unitKey?: string | undefined } = {},
  ) {
    super(
      `Budget metering misconfigured for org=${org}: the resolved effort profile has ` +
        `estimatedCostUsdPerCall=${String(estimatedCostUsdPerCall)}, so no budget could be ` +
        `held for this call (project=${ctx.project ?? '-'} unitKey=${ctx.unitKey ?? '-'}). ` +
        `The org's budget row is fine — set a positive estimatedCostUsdPerCall on the ` +
        `project_configs / registry_entries effort profile for this org.`,
    );
    this.name = 'BudgetMisconfigured';
    this.estimatedCostUsdPerCall = estimatedCostUsdPerCall;
  }
}
