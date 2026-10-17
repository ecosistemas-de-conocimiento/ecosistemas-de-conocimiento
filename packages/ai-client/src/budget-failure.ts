/**
 * Turning an ai-service budget rejection into something a product can act on —
 * once, instead of three times.
 *
 * It classifies a 402 from ai-service into "no budget row" / "cap ran out" /
 * "profile mispriced", decides whether the caller is allowed to see the amounts,
 * and logs it. What a classifier gets wrong if it is not careful:
 *
 *   ⚠ A wire switch with no `BudgetMisconfigured` case falls through to
 *      `default: return null`, so a 402 that IS a budget failure arrives as a
 *      generic opaque `Error`. What is lost is the BRANCH — the endpoint cannot
 *      tell a platform condition from an extraction failure, so a mispriced
 *      effort profile surfaces as a generic AI-unavailable instead of the one
 *      message that names the fix.
 *   ⚠ An ownership predicate that does not trim sees two whitespace-only org
 *      keys as truthy AND equal, so it answers `true` for a caller from another
 *      tenant.
 *   ⚠ Without unwrapping `cause`, a budget error wrapped by a product's own
 *      error class classifies as "not a budget failure".
 *   ⚠ Without the `err.name` fallback, a duplicated copy of this package in the
 *      tree makes a pure `instanceof` misclassify.
 *
 * Those last two are complementary, not alternatives, so the shared classifier
 * does BOTH: walk the cause chain, and at each level test `instanceof` OR
 * `name`.
 *
 * ── What this module deliberately does NOT do ────────────────────────────────
 * No `Response`, no framework import, no user-facing copy. The Spanish sentence
 * a funcionario reads is CONTENT and stays in the product; the classification
 * and the disclosure rule are MACHINERY and live here. (Same signature
 * everywhere; fork at content, never at shape.)
 */

import {
  BudgetExceededError,
  BudgetMisconfiguredError,
  BudgetNotConfiguredError,
} from './errors.js';

/**
 * Which budget failure this is. The three are kept apart because the REMEDY
 * differs and the usual advice is actively wrong for one of them:
 *
 *   - `not_configured` — no budget row exists. An operator must provision one.
 *     Permanent; "try again in a few minutes" is a lie.
 *   - `exceeded` — a configured cap ran out. Someone tops it up.
 *   - `misconfigured` — the budget row EXISTS and is fine; the effort profile's
 *     `estimatedCostUsdPerCall` is zero/negative/non-finite, so no hold could
 *     bind. Provisioning or topping up will NOT help — an admin fixes the
 *     profile, a different row in a different table.
 */
export type BudgetFailureKind = 'not_configured' | 'exceeded' | 'misconfigured';

/** ai-service's `body.error` discriminator on a 402, and the SSE frame `code`. */
export const BUDGET_NOT_CONFIGURED_WIRE = 'BudgetNotConfigured';
export const BUDGET_EXCEEDED_WIRE = 'BudgetExceeded';
export const BUDGET_MISCONFIGURED_WIRE = 'BudgetMisconfigured';

/**
 * A classified budget failure, with every number the wire carried.
 *
 * Amounts are present on `exceeded` only. They are NOT safe to show
 * unconditionally — see `isRequesterBudgetOwner`.
 */
export interface BudgetFailure {
  kind: BudgetFailureKind;
  /** The org ai-service named. `''` when the wire omitted it. */
  org: string;
  /** `exceeded` only. Non-finite wire values are coerced to 0, never `NaN`. */
  requestedUsd: number;
  remainingUsd: number;
  shortfallUsd: number;
  /**
   * `misconfigured` only. `null` when the resolved value was `NaN`/`±Infinity`
   * (JSON cannot carry those) — the exact value is in `upstreamMessage`.
   */
  estimatedCostUsdPerCall: number | null;
  /**
   * ai-service's own message. OPERATOR-FACING: it names internal fields and
   * values. Log it; do not put it in a user response.
   */
  upstreamMessage: string;
}

/**
 * The operator-facing log line per kind. Constants, not interpolated strings,
 * so they are greppable across every product's logs as ONE phrase — which two
 * of the three forks already were, and the third (`misconfigured`) was not.
 */
export const BUDGET_FAILURE_LOG_MESSAGE: Record<BudgetFailureKind, string> = {
  not_configured:
    'ai-service budget failure: NO BUDGET CONFIGURED for org — provision a budget row',
  exceeded: 'ai-service budget failure: BUDGET EXHAUSTED for org — top up the cap',
  // It says what NOT to do, which is the part an operator gets wrong.
  misconfigured:
    'ai-service budget failure: EFFORT PROFILE MISCONFIGURED for org — fix ' +
    'estimatedCostUsdPerCall on the project/registry effort profile (the budget row ' +
    'EXISTS: do NOT provision or top up)',
};

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `null` only for a genuinely absent numeric field — 0 is a real cause value. */
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const EMPTY = {
  requestedUsd: 0,
  remainingUsd: 0,
  shortfallUsd: 0,
  estimatedCostUsdPerCall: null,
} as const;

/**
 * Classify a thrown error.
 *
 * Walks the `cause` chain (bounded, cycle-guarded) and at each level accepts
 * either a real `instanceof` or a matching `error.name`. Both are needed: the
 * chain because products wrap ai-client errors in their own, the name because
 * two hoisted copies of this package produce classes that are not `instanceof`
 * each other while being the same error.
 *
 * Returns `null` for anything that is not a budget failure — the caller falls
 * through to its generic handling.
 */
export function classifyBudgetFailure(err: unknown): BudgetFailure | null {
  const seen = new Set<unknown>();
  let current: unknown = err;

  for (let depth = 0; depth < 8 && current != null; depth++) {
    if (seen.has(current)) break;
    seen.add(current);

    const bag = current as Record<string, unknown>;
    const name = current instanceof Error ? current.name : '';
    const message = str(bag['message']);
    const org = str(bag['org']);

    if (current instanceof BudgetNotConfiguredError || name === 'BudgetNotConfiguredError') {
      return { kind: 'not_configured', org, upstreamMessage: message, ...EMPTY };
    }
    if (current instanceof BudgetMisconfiguredError || name === 'BudgetMisconfiguredError') {
      return {
        kind: 'misconfigured',
        org,
        upstreamMessage: message,
        ...EMPTY,
        estimatedCostUsdPerCall: numOrNull(bag['estimatedCostUsdPerCall']),
      };
    }
    if (current instanceof BudgetExceededError || name === 'BudgetExceededError') {
      return {
        kind: 'exceeded',
        org,
        upstreamMessage: message,
        estimatedCostUsdPerCall: null,
        requestedUsd: num(bag['requested']),
        remainingUsd: num(bag['remaining']),
        shortfallUsd: num(bag['shortfallUsd']),
      };
    }

    const next = bag['cause'];
    if (next === current) break;
    current = next;
  }

  return null;
}

/**
 * Classify a raw HTTP response the product read with its own `fetch` (the
 * bespoke wrappers that have not moved to `AIClient` yet).
 *
 * `null` unless the status is 402 AND the body carries a budget discriminator
 * — an unparseable body or an unknown `error` is NOT a budget failure, and
 * guessing would suppress a real error under a budget message.
 */
export function budgetFailureFromWire(status: number, rawBody: string): BudgetFailure | null {
  if (status !== 402) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as Record<string, unknown>;
  return budgetFailureFromDiscriminator(str(body['error']), body);
}

/**
 * Classify an SSE error frame, whose `code` carries the same discriminator.
 *
 * ⚠ The frame carries no amounts, so `exceeded` arrives with zeroed numbers.
 * That is safe only because the disclosure rule below gates on ownership — do
 * not start showing these numbers unconditionally.
 */
export function budgetFailureFromFrame(frame: {
  code?: unknown;
  [k: string]: unknown;
}): BudgetFailure | null {
  return budgetFailureFromDiscriminator(str(frame.code), frame);
}

function budgetFailureFromDiscriminator(
  discriminator: string,
  body: Record<string, unknown>,
): BudgetFailure | null {
  const org = str(body['org']);
  const upstreamMessage = str(body['message']);
  switch (discriminator) {
    case BUDGET_NOT_CONFIGURED_WIRE:
      return { kind: 'not_configured', org, upstreamMessage, ...EMPTY };
    case BUDGET_MISCONFIGURED_WIRE:
      return {
        kind: 'misconfigured',
        org,
        upstreamMessage,
        ...EMPTY,
        estimatedCostUsdPerCall: numOrNull(body['estimatedCostUsdPerCall']),
      };
    case BUDGET_EXCEEDED_WIRE:
      return {
        kind: 'exceeded',
        org,
        upstreamMessage,
        estimatedCostUsdPerCall: null,
        requestedUsd: num(body['requested']),
        remainingUsd: num(body['remaining']),
        shortfallUsd: num(body['shortfallUsd']),
      };
    default:
      return null;
  }
}

/**
 * May this caller be shown the AMOUNTS?
 *
 * Only when the org that ran out of budget is the caller's OWN org. A budget
 * balance is commercially sensitive: showing "$0.83 short" to a member of a
 * different tenant discloses another organisation's spend.
 *
 * 🔴 FAIL CLOSED on anything unresolved. Both sides are trimmed and must be
 * non-empty: a whitespace-only value on both sides is otherwise truthy and
 * equal. An unknown org is never "the same org".
 */
export function isRequesterBudgetOwner(
  failureOrg: string | null | undefined,
  requesterOrgKey: string | null | undefined,
): boolean {
  const a = (failureOrg ?? '').trim();
  const b = (requesterOrgKey ?? '').trim();
  if (a.length === 0 || b.length === 0) return false;
  return a === b;
}

/**
 * Whether amounts may be disclosed for this failure at all.
 *
 * `not_configured` and `misconfigured` NEVER disclose, whoever is asking:
 * there are no amounts to show, and both are platform faults whose remedy has
 * nothing to do with a number the user could act on.
 */
export function mayDiscloseBudgetAmounts(
  failure: BudgetFailure,
  requesterOrgKey: string | null | undefined,
): boolean {
  if (failure.kind !== 'exceeded') return false;
  return isRequesterBudgetOwner(failure.org, requesterOrgKey);
}

/**
 * The flat field bag to log alongside `BUDGET_FAILURE_LOG_MESSAGE[kind]`.
 *
 * One set of field NAMES fleet-wide. The three forks used three
 * (`estimatedCostUsd`/`requestedUsd`/nothing) for the same three numbers,
 * which makes a cross-product log query impossible to write.
 */
export function budgetFailureLogFields(
  failure: BudgetFailure,
  surface?: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    budgetFailure: failure.kind,
    org: failure.org,
    upstreamMessage: failure.upstreamMessage,
  };
  if (surface !== undefined) base['surface'] = surface;
  if (failure.kind === 'exceeded') {
    base['requestedUsd'] = failure.requestedUsd;
    base['remainingUsd'] = failure.remainingUsd;
    base['shortfallUsd'] = failure.shortfallUsd;
  }
  if (failure.kind === 'misconfigured') {
    base['estimatedCostUsdPerCall'] = failure.estimatedCostUsdPerCall;
  }
  return base;
}
