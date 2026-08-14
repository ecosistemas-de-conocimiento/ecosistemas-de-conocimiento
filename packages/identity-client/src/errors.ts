// Error hierarchy for @edc/identity-client.
//
// Two failure families, deliberately kept apart:
//   - IdentityTokenError  — the token is not trustworthy. ALWAYS a 401.
//   - IdentityRequestError — an HTTP call to the IdP failed. Retryable or not
//                            depending on `status`.
//
// Never collapse the two. "The IdP is down" and "this token is forged" must
// not take the same code path.

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
