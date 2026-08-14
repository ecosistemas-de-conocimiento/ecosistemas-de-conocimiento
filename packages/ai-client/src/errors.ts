// Error class hierarchy for @edc/ai-client.
//
// Mirrors the server-side typed errors (`SpecResolutionError`,
// `IdempotencyConflictError`, `BudgetExceeded`, ...) so a consumer can do
// `try { ... } catch (e) { if (e instanceof BudgetExceededError) ... }`
// without parsing response bodies by hand.
//
// All concrete errors inherit from `AIServiceError`, which carries the raw
// HTTP `status` and the `body` we received. The mapping in `http.ts`
// switches on the `error` discriminator returned by ai-service's
// `mapGenerateError` / `reply.badRequest` / etc.

export interface ErrorBody {
  error?: string;
  message?: string;
  [k: string]: unknown;
}

export class AIServiceError extends Error {
  readonly status: number;
  readonly body: ErrorBody;
  constructor(message: string, status: number, body: ErrorBody = {}) {
    super(message);
    this.name = 'AIServiceError';
    this.status = status;
    this.body = body;
  }
}

export class AuthError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}) {
    super(message, 401, body);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}) {
    super(message, 403, body);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}) {
    super(message, 404, body);
    this.name = 'NotFoundError';
  }
}

export class CorpusNotFoundError extends AIServiceError {
  constructor(message: string, body: ErrorBody = {}) {
    super(message, 404, body);
    this.name = 'CorpusNotFoundError';
  }
}

export class SpecResolutionError extends AIServiceError {
  readonly resolutionCause: string;
  constructor(message: string, cause: string, body: ErrorBody = {}) {
    super(message, 400, body);
    this.name = 'SpecResolutionError';
    this.resolutionCause = cause;
  }
}

export class DependencyCycleError extends AIServiceError {
  readonly cycle: string[];
  constructor(message: string, cycle: string[], body: ErrorBody = {}) {
    super(message, 400, body);
    this.name = 'DependencyCycleError';
    this.cycle = cycle;
  }
}

export class CrossBatchDependencyError extends AIServiceError {
  readonly missing: string[];
  constructor(message: string, missing: string[], body: ErrorBody = {}) {
    super(message, 400, body);
    this.name = 'CrossBatchDependencyError';
    this.missing = missing;
  }
}

export class BudgetExceededError extends AIServiceError {
  readonly org: string;
  readonly requested: number;
  readonly remaining: number;
  readonly shortfallUsd: number;
  constructor(
    message: string,
    args: { org: string; requested: number; remaining: number; shortfallUsd: number },
    body: ErrorBody = {},
  ) {
    super(message, 402, body);
    this.name = 'BudgetExceededError';
    this.org = args.org;
    this.requested = args.requested;
    this.remaining = args.remaining;
    this.shortfallUsd = args.shortfallUsd;
  }
}

/**
 * Fail-closed budget rejection (ADR-0003 D5): the org has NO budget configured
 * in ai-service, so generation/embed is refused (402) rather than silently
 * spending. Distinct from `BudgetExceededError` (which means a configured cap
 * ran out) so a consumer can surface "ask the platform to provision a budget"
 * vs "top up". Additive — consumers catching `AIServiceError` are unaffected.
 */
export class BudgetNotConfiguredError extends AIServiceError {
  readonly org: string;
  constructor(message: string, org: string, body: ErrorBody = {}) {
    super(message, 402, body);
    this.name = 'BudgetNotConfiguredError';
    this.org = org;
  }
}

export class IdempotencyConflictError extends AIServiceError {
  readonly existingRequestId: string;
  constructor(message: string, existingRequestId: string, body: ErrorBody = {}) {
    super(message, 409, body);
    this.name = 'IdempotencyConflictError';
    this.existingRequestId = existingRequestId;
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Convert a non-2xx HTTP response body into the most specific error class
 * available. Switches on `body.error` (the discriminator stamped by
 * ai-service's typed-error map) when present; otherwise falls back to a
 * status-code-based mapping; otherwise an `AIServiceError`.
 */
export function errorFromResponse(status: number, body: unknown): AIServiceError {
  const safeBody: ErrorBody =
    body && typeof body === 'object' ? (body as ErrorBody) : { message: String(body ?? '') };
  const message = safeBody.message ?? `ai-service request failed (status ${status})`;

  switch (safeBody.error) {
    case 'BudgetExceeded':
      return new BudgetExceededError(
        message,
        {
          org: String(safeBody.org ?? ''),
          requested: Number(safeBody.requested ?? 0),
          remaining: Number(safeBody.remaining ?? 0),
          shortfallUsd: Number(safeBody.shortfallUsd ?? 0),
        },
        safeBody,
      );
    case 'BudgetNotConfigured':
      return new BudgetNotConfiguredError(message, String(safeBody.org ?? ''), safeBody);
    case 'IdempotencyConflict':
      return new IdempotencyConflictError(
        message,
        String(safeBody.existingRequestId ?? ''),
        safeBody,
      );
    case 'SpecResolutionError':
      return new SpecResolutionError(message, String(safeBody.cause ?? ''), safeBody);
    case 'DependencyCycleError':
      return new DependencyCycleError(
        message,
        Array.isArray(safeBody.cycle) ? (safeBody.cycle as string[]) : [],
        safeBody,
      );
    case 'CrossBatchDependencyError':
      return new CrossBatchDependencyError(
        message,
        Array.isArray(safeBody.missing) ? (safeBody.missing as string[]) : [],
        safeBody,
      );
  }

  switch (status) {
    case 401:
      return new AuthError(message, safeBody);
    case 403:
      return new ForbiddenError(message, safeBody);
    case 404:
      return new NotFoundError(message, safeBody);
  }
  return new AIServiceError(message, status, safeBody);
}
