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

/**
 * 🔴 THE SERVER REFUSED BECAUSE THE CALLER IS GOING TOO FAST — and it told us
 * how long to wait.
 *
 * ai-service rate-limits the whole `/v1` surface per API key (100/min) with a
 * tighter cap on the generation routes (30/min). Those numbers are deliberate
 * cost control, not a defect, so the ONLY correct consumer behaviour is to back
 * off and come back. That is impossible unless a 429 is distinguishable from
 * every other 4xx, which is what this class exists for.
 *
 * ⚠ IT IS THE ONLY RETRYABLE ERROR IN THIS HIERARCHY. A 401 will not fix itself,
 * a 402 budget rejection will not fix itself, a 400 spec error will not fix
 * itself. Retrying any of them just burns the caller's time. So a consumer's
 * backoff loop should key on `instanceof RateLimitedError` — never on "4xx".
 *
 * `retryAfterSeconds` is always a finite number ≥ 1, so a caller can multiply it
 * by 1000 and sleep without validating it first. See {@link retryAfterFrom} for
 * where the value comes from and what happens when the server says nothing.
 */
export class RateLimitedError extends AIServiceError {
  /** How long the server asked us to wait, in seconds. Always finite and ≥ 1. */
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number, body: ErrorBody = {}) {
    super(message, 429, body);
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Fallback wait when a 429 arrives carrying no timing at all.
 *
 * 60s = one full `V1_RATE_LIMIT_WINDOW`. Any shorter guess is a retry that is
 * refused again, which is worse than waiting: it consumes another slot in the
 * window and pushes the recovery further out.
 */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

/** Upper clamp, so a malformed or hostile header cannot park a caller for hours. */
export const MAX_RETRY_AFTER_SECONDS = 300;

/** The one method of `Headers` this module needs — so tests can pass a plain object. */
export interface HeaderReader {
  get(name: string): string | null | undefined;
}

/**
 * Work out how long to wait, in seconds, from a 429.
 *
 * ⚠ THE ORDER IS NOT ARBITRARY — the header wins.
 *
 *   1. `Retry-After`. The HTTP standard's answer, and the one an intermediary
 *      (a proxy, a gateway, a CDN) can also set. If something between us and
 *      ai-service is doing the throttling, this is the ONLY field that will be
 *      populated at all.
 *   2. `body.retryAfterSeconds` — the shape a consumer would expect by name.
 *   3. `body.retryAfterMs` — ⚠ what ai-service ACTUALLY sends today. Its 429
 *      body is `{ error: 'RateLimitExceeded', message, retryAfterMs }`; there is
 *      no `retryAfterSeconds` field on the wire. Read both, because the wire
 *      shape is the server's to change and a client that only understood the
 *      documented name would silently fall through to the 60s default.
 *   4. {@link DEFAULT_RETRY_AFTER_SECONDS}.
 *
 * `Retry-After` is allowed to be either delta-seconds or an HTTP-date
 * (RFC 9110 §10.2.3), and both forms are accepted here. A date in the past, a
 * negative number, or unparseable text falls through to the next source rather
 * than yielding a zero wait — a zero wait is a hot loop against a server that
 * just said stop.
 *
 * The result is rounded UP and clamped to [1, {@link MAX_RETRY_AFTER_SECONDS}].
 * Rounding up matters: 0.4s rounded down is 0, and the retry lands inside the
 * still-closed window.
 */
export function retryAfterFrom(
  headers: HeaderReader | undefined,
  body: ErrorBody,
  now: Date = new Date(),
): number {
  const fromHeader = parseRetryAfterHeader(headers?.get('retry-after'), now);
  const fromSeconds = positiveNumber(body.retryAfterSeconds);
  const fromMs = positiveNumber(body.retryAfterMs);
  const seconds =
    fromHeader ?? fromSeconds ?? (fromMs !== undefined ? fromMs / 1000 : undefined);
  if (seconds === undefined) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)));
}

/** delta-seconds or HTTP-date → seconds from `now`. `undefined` when neither. */
function parseRetryAfterHeader(raw: unknown, now: Date): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (text === '') return undefined;
  // Numeric form first: `Date.parse` accepts bare integers in some runtimes and
  // would read "120" as a year, so the digit check has to come first.
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return undefined;
  const delta = (at - now.getTime()) / 1000;
  return delta > 0 ? delta : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Convert a non-2xx HTTP response into the most specific error class available.
 * Switches on `body.error` (the discriminator stamped by ai-service's
 * typed-error map) when present; otherwise falls back to a status-code-based
 * mapping; otherwise an `AIServiceError`.
 *
 * ⚠ `headers` IS OPTIONAL BUT MATTERS FOR EXACTLY ONE CASE: a 429, whose wait
 * is carried by the `Retry-After` header. Omitting it degrades a rate-limit
 * error to the 60s default instead of the server's real number, and loses the
 * only signal available when an intermediary — not ai-service — is throttling.
 * See {@link retryAfterFrom}.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  headers?: HeaderReader,
): AIServiceError {
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
    // ai-service stamps this on its 429 body. Handled by discriminator AND by
    // status below, because a 429 raised by a proxy in front of ai-service
    // carries neither our discriminator nor our body shape — only the status
    // and, if we are lucky, `Retry-After`.
    case 'RateLimitExceeded':
      return new RateLimitedError(message, retryAfterFrom(headers, safeBody), safeBody);
  }

  switch (status) {
    case 401:
      return new AuthError(message, safeBody);
    case 403:
      return new ForbiddenError(message, safeBody);
    case 404:
      return new NotFoundError(message, safeBody);
    case 429:
      return new RateLimitedError(message, retryAfterFrom(headers, safeBody), safeBody);
  }
  return new AIServiceError(message, status, safeBody);
}
