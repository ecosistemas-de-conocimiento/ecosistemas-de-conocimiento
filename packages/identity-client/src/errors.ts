// Error hierarchy for @edc/identity-client.
//
// Three failure families, deliberately kept apart:
//   - IdentityTokenError   — the token is not trustworthy. ALWAYS a 401.
//   - IdentityRequestError — a SERVICE-lane HTTP call failed (`/resolve`,
//                            `/export`). Retryable or not depending on `status`.
//   - IdentitySessionError — a SESSION-lane call failed (`/login`, `/refresh`,
//                            `/revoke`), i.e. something about ONE human's
//                            session. Carries whether that session survived.
//
// Never collapse them. "The IdP is down", "this token is forged" and "this user
// has no access to that one product" must not take the same code path — the
// third one especially, because handling it like the second signs a person out
// of the whole fleet over a missing project assignment.

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/**
 * Why a token was rejected. Log the `reason`, never the token.
 *
 * - `malformed`   — not three base64url segments / unreadable header.
 * - `algorithm`   — header `alg` was not `EdDSA` (includes `none` and any HMAC).
 * - `signature`   — signature did not verify against the JWKS.
 * - `expired`     — `exp` in the past (or `nbf` in the future).
 * - `issuer`      — `iss` did not match the configured issuer.
 * - `audience`    — `aud` did not match the configured audience.
 * - `lifetime`    — declared `exp - iat` exceeded the allowed maximum.
 * - `claims`      — a required claim was missing or the wrong type.
 * - `jwks`        — the key set could not be fetched, or no key matched `kid`.
 */
export type TokenRejectionReason =
  | 'malformed'
  | 'algorithm'
  | 'signature'
  | 'expired'
  | 'issuer'
  | 'audience'
  | 'lifetime'
  | 'claims'
  | 'jwks';

export class IdentityTokenError extends IdentityError {
  readonly reason: TokenRejectionReason;
  /** The underlying `jose` error, when there was one. */
  override readonly cause?: unknown;

  constructor(reason: TokenRejectionReason, message: string, cause?: unknown) {
    super(message);
    this.name = 'IdentityTokenError';
    this.reason = reason;
    this.cause = cause;
  }

  /**
   * True when retrying with the same token cannot possibly help — the caller
   * must re-authenticate rather than back off.
   */
  get isPermanent(): boolean {
    return this.reason !== 'jwks';
  }
}

export interface IdentityErrorBody {
  error?: string;
  message?: string;
  [k: string]: unknown;
}

/** A non-2xx (or unreachable) response from an IdP HTTP endpoint. */
export class IdentityRequestError extends IdentityError {
  readonly status: number;
  readonly body: IdentityErrorBody;

  constructor(message: string, status: number, body: IdentityErrorBody = {}) {
    super(message);
    this.name = 'IdentityRequestError';
    this.status = status;
    this.body = body;
  }

  /** 0 (network/timeout) and 5xx are worth retrying. 4xx are not. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

/** Bad configuration caught before any network call — a programming error. */
export class IdentityConfigError extends IdentityError {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConfigError';
  }
}

// --- session lane -------------------------------------------------------------

/** Which session call failed. Part of what a `reason` means depends on it. */
export type IdentitySessionOperation = 'login' | 'refresh' | 'revoke';

/**
 * Why a session call failed. Log the `reason`, NEVER the refresh ticket.
 *
 * ⚠ THE SPLIT THAT MATTERS IS `session_expired` VS `project_access_denied` /
 * `unknown_project`. The IdP answers 401 for the first and 403/404 for the
 * others, and they mean opposite things to a consumer: the first says the
 * ticket is dead and the human must sign in again; the others say the ticket is
 * perfectly alive and the human simply holds nothing on that one product. A BFF
 * that treats them alike logs people out of the entire fleet the moment one
 * project assignment is missing. Branch on {@link IdentitySessionError.refreshTokenIsDead}
 * and {@link IdentitySessionError.refreshTokenSurvived}, never on `status >= 400`.
 *
 * - `invalid_credentials`       — login 401. Wrong password, unknown account, OR
 *                                 a locked-out account: the IdP answers all
 *                                 three identically so it cannot be used to
 *                                 enumerate accounts. Do not guess which.
 * - `account_inactive`          — login 403. Credentials were CORRECT and the
 *                                 account is deactivated. Retyping cannot help.
 * - `session_expired`           — refresh 401. The ticket is unknown, revoked,
 *                                 expired, already rotated, or belongs to an
 *                                 account that has since been deactivated. The
 *                                 IdP does not say which, deliberately. Drop the
 *                                 cookie and send the user to a login form.
 * - `project_access_denied`     — refresh 403. The TICKET IS FINE. The user has
 *                                 no active assignment on the requested
 *                                 `audience`. Keep them signed in; deny the one
 *                                 product.
 * - `unknown_project`           — refresh 404. The TICKET IS FINE. That project
 *                                 slug does not exist or is deactivated.
 *                                 ⚠ A wrong `baseUrl` (missing the `/api`
 *                                 suffix) 404s too and is indistinguishable
 *                                 here — check the URL before blaming the slug.
 * - `token_signing_unavailable` — refresh 503. The TICKET IS FINE. The IdP has
 *                                 no signing key configured, so nobody gets an
 *                                 access token until an operator fixes it.
 * - `malformed_request`         — 400. Your own bug: a missing field, or an
 *                                 `audience` that is not a non-empty string.
 *                                 Nothing was consumed.
 * - `rate_limited`              — 429. See `retryAfterSeconds`. Nothing was
 *                                 consumed.
 * - `response_unusable`         — 2xx with a body that carried no usable
 *                                 `refreshToken`. ⚠ On a refresh this is the
 *                                 worst case: the server almost certainly
 *                                 rotated, so the ticket you still hold is dead
 *                                 and re-presenting it reads as THEFT. Treated
 *                                 as a dead session on purpose.
 * - `server_error`              — 5xx, or a status this ladder does not model.
 * - `unreachable`               — network failure, timeout or abort; `status` 0.
 *                                 ⚠ On a refresh the outcome is UNKNOWN — the
 *                                 request may have reached the IdP and rotated.
 */
export type IdentitySessionFailureReason =
  | 'invalid_credentials'
  | 'account_inactive'
  | 'session_expired'
  | 'project_access_denied'
  | 'unknown_project'
  | 'token_signing_unavailable'
  | 'malformed_request'
  | 'rate_limited'
  | 'response_unusable'
  | 'server_error'
  | 'unreachable';

/**
 * A failed `loginWithPassword` / `refreshSession` / `revokeSession` call.
 *
 * ⚠ THIS OBJECT NEVER CONTAINS A CREDENTIAL. No refresh ticket, no password, no
 * response body is stored on it, and any credential the IdP echoed back inside
 * an error string is redacted before it reaches `message`. That is enforced by
 * a test, because an error object is the single most likely thing a consumer
 * pipes straight into a log aggregator — and a refresh ticket in a log line is
 * a 14-day fleet-wide session sitting in someone's search index.
 */
export class IdentitySessionError extends IdentityError {
  readonly reason: IdentitySessionFailureReason;
  /** Which call produced this. `session_expired` from a `login` is impossible. */
  readonly operation: IdentitySessionOperation;
  /** HTTP status, or 0 for a network failure / timeout / abort. */
  readonly status: number;
  /** Present on a 429, from the body's `retryAfterSeconds` or the `Retry-After` header. */
  readonly retryAfterSeconds?: number;

  constructor(
    reason: IdentitySessionFailureReason,
    operation: IdentitySessionOperation,
    message: string,
    status: number,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'IdentitySessionError';
    this.reason = reason;
    this.operation = operation;
    this.status = status;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }

  /**
   * ⚠ THE BRANCH THAT SIGNS SOMEBODY OUT. True only when the refresh ticket you
   * presented can never work again: delete the cookie and show a login form.
   *
   * `false` does NOT mean "definitely still valid" — see
   * {@link refreshTokenSurvived}. The two are not opposites, and the gap between
   * them (`unreachable`, `server_error` on a refresh) is real: the request may
   * have rotated the ticket before the wire broke. Keep the cookie there, retry
   * at most once, and treat the 401 that may follow as an ordinary logout.
   */
  get refreshTokenIsDead(): boolean {
    if (this.operation !== 'refresh') return false;
    return this.reason === 'session_expired' || this.reason === 'response_unusable';
  }

  /**
   * True when the ticket you presented came back untouched — the IdP answered
   * ABOUT A PROJECT, not about the session. KEEP THE COOKIE and return a 403 to
   * the browser; do not clear anything, do not redirect to a login form.
   *
   * The IdP mints the access token BEFORE it rotates the ticket precisely so
   * this case can exist (`src/endpoints/refresh.ts`): losing access to one
   * product must not end the user's session on every other one.
   */
  get refreshTokenSurvived(): boolean {
    if (this.operation !== 'refresh') return false;
    return (
      this.reason === 'project_access_denied' ||
      this.reason === 'unknown_project' ||
      this.reason === 'token_signing_unavailable' ||
      this.reason === 'malformed_request' ||
      this.reason === 'rate_limited'
    );
  }

  /**
   * True when the human has to type a password again — either because their
   * session is dead, or because they never got one.
   *
   * Deliberately FALSE for `account_inactive`: those credentials are correct and
   * always will be, so bouncing the user back to the login form is an infinite
   * loop. Tell them the account is deactivated instead.
   */
  get mustReauthenticate(): boolean {
    if (this.reason === 'invalid_credentials') return true;
    return this.refreshTokenIsDead;
  }

  /**
   * True when the IdP (or the wire) failed rather than the credential — worth
   * backing off and trying again.
   *
   * ⚠ NOT a licence to retry a REFRESH blindly. If `unreachable` fired after the
   * server rotated, a second attempt presents an already-spent ticket, which is
   * exactly what reuse detection kills whole session chains for. One retry, then
   * accept the logout.
   */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}
