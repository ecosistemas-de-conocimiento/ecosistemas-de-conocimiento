// Typed errors for the ai-service consumer client. Mirrors the discriminants
// returned by ai-service routes (BudgetExceeded, IdempotencyConflict,
// SpecResolutionError, DependencyCycleError, CrossBatchDependencyError, …) and
// adds two consumer-side categories: `AIServiceUnavailableError` for network /
// 5xx / "route not deployed" 404s, and the generic `AIServiceError` base.
//
// Callers should `instanceof`-check the specific subclasses; the SvelteKit BFF
// uses `httpStatusFor()` to map them onto user-facing status codes.

import { AI_UNAVAILABLE_MESSAGE, AI_UNAVAILABLE_CODE } from './messages';

export class AIServiceError extends Error {
  readonly status: number;
  readonly bodyError: string | undefined;
  readonly body: unknown;
  constructor(message: string, opts: { status?: number; bodyError?: string; body?: unknown } = {}) {
    super(message);
    this.name = 'AIServiceError';
    this.status = opts.status ?? 0;
    this.bodyError = opts.bodyError;
    this.body = opts.body;
  }
}

/** Service unreachable, 5xx, or endpoint not deployed (404 with no JSON body). */
export class AIServiceUnavailableError extends AIServiceError {
  constructor(message: string, opts: { status?: number; body?: unknown; cause?: unknown } = {}) {
    super(message, opts);
    this.name = 'AIServiceUnavailableError';
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

export class BadRequestError extends AIServiceError {
  constructor(message: string, opts: ConstructorParameters<typeof AIServiceError>[1] = {}) {
    super(message, opts);
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends AIServiceError {
  constructor(message: string, opts: ConstructorParameters<typeof AIServiceError>[1] = {}) {
    super(message, opts);
    this.name = 'UnauthorizedError';
  }
}

/** 403 — caller used an `app` key on an `admin` route, or referenced another org/project. */
export class CrossOrgError extends AIServiceError {
  constructor(message: string, opts: ConstructorParameters<typeof AIServiceError>[1] = {}) {
    super(message, opts);
    this.name = 'CrossOrgError';
  }
}

export class NotFoundError extends AIServiceError {
  constructor(message: string, opts: ConstructorParameters<typeof AIServiceError>[1] = {}) {
    super(message, opts);
    this.name = 'NotFoundError';
  }
}

/**
 * 402 — the org has NO budget row at all, so nothing can be reserved.
 *
 * Distinct from `BudgetExceededError` on purpose: "never provisioned" and
 * "provisioned then exhausted" need different operator actions (create a row
 * vs. raise the cap), and collapsing them hides a misconfigured deployment
 * behind what looks like normal spend. ai-service tags the body
 * `error: 'BudgetNotConfigured'` and carries `org` but no amounts — there is no
 * budget to quote figures from.
 */
export class BudgetNotConfiguredError extends AIServiceError {
  readonly org: string | undefined;
  constructor(
    message: string,
    opts: {
      status?: number;
      bodyError?: string;
      body?: unknown;
      org?: string;
    } = {},
  ) {
    super(message, opts);
    this.name = 'BudgetNotConfiguredError';
    this.org = opts.org;
  }
}

/** 402 — request would push the org over its budget. */
export class BudgetExceededError extends AIServiceError {
  readonly org: string | undefined;
  readonly requested: number | undefined;
  readonly remaining: number | undefined;
  readonly shortfallUsd: number | undefined;
  constructor(
    message: string,
    opts: {
      status?: number;
      bodyError?: string;
      body?: unknown;
      org?: string;
      requested?: number;
      remaining?: number;
      shortfallUsd?: number;
    } = {},
  ) {
    super(message, opts);
    this.name = 'BudgetExceededError';
    this.org = opts.org;
    this.requested = opts.requested;
    this.remaining = opts.remaining;
    this.shortfallUsd = opts.shortfallUsd;
  }
}

/** 409 — same `clientRequestId` reused with a different body within 24 h. */
export class IdempotencyConflictError extends AIServiceError {
  readonly existingRequestId: string | undefined;
  constructor(
    message: string,
    opts: ConstructorParameters<typeof AIServiceError>[1] & { existingRequestId?: string } = {},
  ) {
    super(message, opts);
    this.name = 'IdempotencyConflictError';
    this.existingRequestId = opts.existingRequestId;
  }
}

/** 400 — registry resolution failed (no active entry + no inline spec). */
export class SpecResolutionError extends AIServiceError {
  readonly resolutionCause: string | undefined;
  constructor(
    message: string,
    opts: ConstructorParameters<typeof AIServiceError>[1] & { cause?: string } = {},
  ) {
    super(message, opts);
    this.name = 'SpecResolutionError';
    this.resolutionCause = opts.cause;
  }
}

/** 400 — `dependsOn` graph has a cycle, or refers to a unit not in the batch. */
export class DependencyError extends AIServiceError {
  readonly cycle: string[] | undefined;
  readonly missing: string[] | undefined;
  constructor(
    message: string,
    opts: ConstructorParameters<typeof AIServiceError>[1] & {
      cycle?: string[];
      missing?: string[];
    } = {},
  ) {
    super(message, opts);
    this.name = 'DependencyError';
    this.cycle = opts.cycle;
    this.missing = opts.missing;
  }
}

/** 422 — model output failed builtin validators (`json-schema` / `regex`). */
export class OutputValidationError extends AIServiceError {
  readonly flags: unknown;
  constructor(
    message: string,
    opts: ConstructorParameters<typeof AIServiceError>[1] & { flags?: unknown } = {},
  ) {
    super(message, opts);
    this.name = 'OutputValidationError';
    this.flags = opts.flags;
  }
}

/** 501 — endpoint exists but the underlying capability isn't enabled yet (e.g. M4 RAG). */
export class NotImplementedError extends AIServiceError {
  constructor(message: string, opts: ConstructorParameters<typeof AIServiceError>[1] = {}) {
    super(message, opts);
    this.name = 'NotImplementedError';
  }
}

// ── budget failures ────────────────────────────────────────────────────────

/**
 * May this requester be shown the failing budget's amounts, limits and org?
 *
 * True ONLY when the failing budget demonstrably belongs to the requester's own
 * org. Both sides must be non-empty and equal — an empty or unknown key can
 * never match, so the default is always the generic message.
 *
 * ⚠ Today this returns `false` for EVERY user, and that is correct and
 * intended, not a bug to route around. `App.Locals` carries no ai-service
 * tenant key, `BackendUser` carries none, and the BFF passes `engineOrgId()` —
 * a deployment-wide constant — for the engine turn. There is therefore no
 * verified per-user key to compare against, so callers pass `null` and everyone
 * gets the canonical message.
 *
 * Do NOT delete this predicate as dead code. It is the documented flip point:
 * when a verified per-user tenant key exists, pass it here and budget owners
 * start seeing their own numbers, with no other change needed.
 */
export function isRequesterBudgetOwner(
  errOrg: string | null | undefined,
  requesterOrgKey: string | null | undefined,
): boolean {
  if (!errOrg || !requesterOrgKey) return false;
  return errOrg === requesterOrgKey;
}

/** Which kind of budget failure this is, for the structured log. */
export type BudgetFailureKind = 'not_configured' | 'exceeded';

/**
 * Log the REAL cause of a budget failure, in full, server-side.
 *
 * The user gets one deliberately vague sentence; the operator needs the exact
 * opposite. These two messages are written to be greppable and mutually
 * distinguishable, because the fix differs: provision a row vs. raise the cap.
 *
 * Returns the kind it logged (or `null` when `err` was not a budget failure),
 * so callers and tests can assert that exactly one of the two branches fired.
 */
export function logBudgetFailure(
  err: unknown,
  surface: string,
  requesterOrgKey: string | null = null,
): BudgetFailureKind | null {
  if (err instanceof BudgetNotConfiguredError) {
    console.error(
      '[aiService] ai-service budget failure: NO BUDGET CONFIGURED for org — provision a budget row',
      {
        err,
        budgetFailure: 'not_configured' satisfies BudgetFailureKind,
        org: err.org,
        surface,
      },
    );
    return 'not_configured';
  }
  if (err instanceof BudgetExceededError) {
    console.error(
      '[aiService] ai-service budget failure: BUDGET EXHAUSTED for org — top up the cap',
      {
        err,
        budgetFailure: 'exceeded' satisfies BudgetFailureKind,
        org: err.org,
        requestedUsd: err.requested,
        remainingUsd: err.remaining,
        shortfallUsd: err.shortfallUsd,
        surface,
      },
    );
    return 'exceeded';
  }
  // Not a budget failure — nothing to log here; the caller's own handling wins.
  void requesterOrgKey;
  return null;
}

/**
 * SvelteKit BFF helper — map any error from the client onto a
 * `{status, message, code?}` the route handler can pass to `error(...)`.
 * Unavailability and truly unknown errors collapse to 503 (user-facing "service
 * unavailable") rather than 500 so the chat UI can render a degraded state
 * instead of a stack-trace page.
 *
 * `code` is set ONLY for the budget branches. Every other branch returns it
 * `undefined` so existing callers keep their current byte-for-byte behaviour.
 *
 * Budget failures are handled FIRST, before the generic `AIServiceError`
 * catch-all, and both collapse to 503 + the canonical Spanish message unless
 * the requester owns the failing budget. The upstream English text names the
 * org and its budget state, so it must never reach a bubble.
 */
export function httpStatusFor(
  err: unknown,
  opts: { requesterOrgKey?: string | null } = {},
): { status: number; message: string; code?: string } {
  // No budget row exists. This BYPASSES the ownership predicate entirely:
  // there are no amounts to leak, and a missing row is a deployment fault the
  // user can neither see nor fix, so it is always the generic message.
  if (err instanceof BudgetNotConfiguredError) {
    return { status: 503, message: AI_UNAVAILABLE_MESSAGE, code: AI_UNAVAILABLE_CODE };
  }
  if (err instanceof BudgetExceededError) {
    // Owner path: the requester's own org ran out, so the real message (with
    // its amounts) is actionable for them. Unreachable today — see
    // `isRequesterBudgetOwner`.
    if (isRequesterBudgetOwner(err.org, opts.requesterOrgKey)) {
      return { status: 402, message: err.message };
    }
    return { status: 503, message: AI_UNAVAILABLE_MESSAGE, code: AI_UNAVAILABLE_CODE };
  }
  if (err instanceof UnauthorizedError) return { status: 401, message: err.message };
  if (err instanceof CrossOrgError) return { status: 403, message: err.message };
  if (err instanceof NotFoundError) return { status: 404, message: err.message };
  if (err instanceof IdempotencyConflictError) return { status: 409, message: err.message };
  if (err instanceof OutputValidationError) return { status: 422, message: err.message };
  if (err instanceof NotImplementedError) return { status: 501, message: err.message };
  if (err instanceof SpecResolutionError) return { status: 400, message: err.message };
  if (err instanceof DependencyError) return { status: 400, message: err.message };
  if (err instanceof BadRequestError) return { status: 400, message: err.message };
  if (err instanceof AIServiceUnavailableError) return { status: 503, message: err.message };
  if (err instanceof AIServiceError) return { status: 502, message: err.message };
  return { status: 500, message: err instanceof Error ? err.message : 'Internal error' };
}
