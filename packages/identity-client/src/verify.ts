// Token verification for @edc/identity-client.
//
// One job: turn an opaque string into `IdentityTokenClaims` you may act on,
// or throw. Everything here is a deliberate "closed by default" choice:
//
//   - `EdDSA` is the ONLY accepted algorithm. `alg: none` and every HMAC
//     variant are rejected before the JWKS is even fetched, so a forged
//     header cannot cost us a network round-trip.
//   - `issuer` AND `audience` are both mandatory and both checked. An
//     unchecked `aud` is a confused-deputy bug: a token minted for `chat`
//     would otherwise unlock `edc`.
//   - Declared lifetime (`exp - iat`) is capped at 900s per ADR-0001 §2.
//   - Required claims are type-checked after signature verification, so a
//     signed-but-malformed token fails loudly instead of silently granting
//     `undefined` permissions.
//
// JWKS responses are cached per URL, process-wide.

import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { IdentityConfigError, IdentityTokenError } from './errors.js';
import {
  IDENTITY_JWT_ALG,
  MAX_TOKEN_LIFETIME_SEC,
  type IdentityTokenClaims,
} from './types.js';

/** Cache the fetched key set for an hour (ADR-0001 "JWKS caching policy"). */
const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
/** Minimum gap between re-fetches triggered by an unknown `kid`. */
const DEFAULT_JWKS_COOLDOWN_MS = 30 * 1000;
const DEFAULT_JWKS_TIMEOUT_MS = 5_000;
/** Seconds of clock skew tolerated on `exp` / `nbf`. */
const DEFAULT_CLOCK_TOLERANCE_SEC = 5;

export interface VerifyIdentityTokenOptions {
  /** Expected `iss`, e.g. `https://backend.example.org`. Exact match. */
  issuer: string;
  /** Expected `aud` — YOUR project slug (`edc`, `chat`, ...). Exact match. */
  audience: string;
  /** Absolute URL of the IdP's `/.well-known/jwks.json`. */
  jwksUrl: string;
  /** Clock skew allowance in seconds. Default 5. */
  clockToleranceSec?: number;
  /**
   * Reject tokens whose declared lifetime (`exp - iat`) exceeds this many
   * seconds. Default 900 (the ADR-0001 cap). Raise it only if the contract
   * itself is amended — a longer-lived token is a longer-lived breach.
   */
  maxTokenLifetimeSec?: number;
  /** How long a fetched key set is reused before refetching. Default 1 hour. */
  jwksCacheMaxAgeMs?: number;
  /** JWKS fetch timeout in ms. Default 5000. */
  jwksTimeoutMs?: number;
}

type RemoteKeySet = ReturnType<typeof createRemoteJWKSet>;

const jwksCache = new Map<string, RemoteKeySet>();

/**
 * Get (or create) the cached remote key set for `jwksUrl`.
 *
 * `jose` handles the HTTP caching internally: it serves from memory until
 * `cacheMaxAge` elapses, and refetches early — but no more often than
 * `cooldownDuration` — when a token arrives with a `kid` it has not seen.
 * That is exactly the "cache, refresh on signature failure" policy ADR-0001
 * asks for, and it is what makes key rotation survivable without a redeploy.
 */
function keySetFor(jwksUrl: string, cacheMaxAgeMs: number, timeoutMs: number): RemoteKeySet {
  const cacheKey = `${jwksUrl}|${cacheMaxAgeMs}|${timeoutMs}`;
  const existing = jwksCache.get(cacheKey);
  if (existing) return existing;

  let url: URL;
  try {
    url = new URL(jwksUrl);
  } catch {
    throw new IdentityConfigError(`verifyIdentityToken: jwksUrl is not a valid URL: ${jwksUrl}`);
  }

  const created = createRemoteJWKSet(url, {
    cacheMaxAge: cacheMaxAgeMs,
    cooldownDuration: DEFAULT_JWKS_COOLDOWN_MS,
    timeoutDuration: timeoutMs,
  });
  jwksCache.set(cacheKey, created);
  return created;
}

/**
 * Drop every cached key set. Tests and key-rotation drills only — normal
 * operation should rely on the TTL.
 */
export function clearJwksCache(): void {
  jwksCache.clear();
}

/**
 * Verify an identity token and return its claims.
 *
 * Throws {@link IdentityTokenError} for anything untrustworthy — inspect
 * `.reason` to decide between "re-authenticate" (`isPermanent`) and "the IdP
 * is unreachable, back off" (`reason === 'jwks'`).
 *
 * ```ts
 * const claims = await verifyIdentityToken(bearer, {
 *   issuer: 'https://backend.example.org',
 *   audience: 'edc',
 *   jwksUrl: 'https://backend.example.org/.well-known/jwks.json',
 * })
 * ```
 */
export async function verifyIdentityToken(
  token: string,
  options: VerifyIdentityTokenOptions,
): Promise<IdentityTokenClaims> {
  const { issuer, audience, jwksUrl } = options;
  if (!issuer) throw new IdentityConfigError('verifyIdentityToken: `issuer` is required');
  if (!audience) throw new IdentityConfigError('verifyIdentityToken: `audience` is required');
  if (!jwksUrl) throw new IdentityConfigError('verifyIdentityToken: `jwksUrl` is required');
  if (typeof token !== 'string' || token.length === 0) {
    throw new IdentityTokenError('malformed', 'Token is empty.');
  }

  // Pre-flight the header so `alg: none` is refused without a network call.
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch (err) {
    throw new IdentityTokenError('malformed', 'Token header could not be decoded.', err);
  }
  if (header.alg !== IDENTITY_JWT_ALG) {
    throw new IdentityTokenError(
      'algorithm',
      `Token alg is "${header.alg ?? 'missing'}"; only "${IDENTITY_JWT_ALG}" is accepted.`,
    );
  }

  const keySet = keySetFor(
    jwksUrl,
    options.jwksCacheMaxAgeMs ?? DEFAULT_JWKS_CACHE_MAX_AGE_MS,
    options.jwksTimeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS,
  );

  let payload: Record<string, unknown>;
  let protectedHeader: { kid?: string };
  try {
    const result = await jwtVerify(token, keySet, {
      issuer,
      audience,
      // Belt and braces: `jose` refuses anything outside this list too.
      algorithms: [IDENTITY_JWT_ALG],
      clockTolerance: options.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC,
      requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp'],
    });
    payload = result.payload as unknown as Record<string, unknown>;
    protectedHeader = result.protectedHeader;
  } catch (err) {
    throw toTokenError(err);
  }

  return toClaims(payload, protectedHeader.kid, options.maxTokenLifetimeSec ?? MAX_TOKEN_LIFETIME_SEC);
}

/** Map a `jose` failure onto our reason taxonomy. */
function toTokenError(err: unknown): IdentityTokenError {
  const code = (err as { code?: string } | null)?.code;
  const claim = (err as { claim?: string } | null)?.claim;
  const message = err instanceof Error ? err.message : String(err);

  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return new IdentityTokenError('expired', 'Token has expired.', err);
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return new IdentityTokenError('signature', 'Token signature did not verify.', err);
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return new IdentityTokenError('algorithm', message, err);
    case 'ERR_JWKS_NO_MATCHING_KEY':
      return new IdentityTokenError(
        'jwks',
        'No JWKS key matched the token `kid` — the signing key may have rotated.',
        err,
      );
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
    case 'ERR_JWKS_TIMEOUT':
    case 'ERR_JWKS_INVALID':
      return new IdentityTokenError('jwks', `JWKS could not be used: ${message}`, err);
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      if (claim === 'iss') return new IdentityTokenError('issuer', 'Token `iss` mismatch.', err);
      if (claim === 'aud') return new IdentityTokenError('audience', 'Token `aud` mismatch.', err);
      if (claim === 'nbf') return new IdentityTokenError('expired', 'Token is not yet valid.', err);
      return new IdentityTokenError('claims', `Claim validation failed: ${message}`, err);
    case 'ERR_JWT_INVALID':
    case 'ERR_JWS_INVALID':
      return new IdentityTokenError('malformed', message, err);
    default:
      // A fetch/network failure inside the key-set getter surfaces here.
      if (/fetch|network|timed? ?out|ECONN|ENOTFOUND/i.test(message)) {
        return new IdentityTokenError('jwks', `JWKS fetch failed: ${message}`, err);
      }
      return new IdentityTokenError('signature', message, err);
  }
}

/** Shape-check the verified payload. Signed garbage is still garbage. */
function toClaims(
  payload: Record<string, unknown>,
  kid: string | undefined,
  maxLifetimeSec: number,
): IdentityTokenClaims {
  const iss = requireString(payload.iss, 'iss');
  const sub = requireString(payload.sub, 'sub');
  const aud = requireAudience(payload.aud);
  const iat = requireNumber(payload.iat, 'iat');
  const exp = requireNumber(payload.exp, 'exp');
  // `email` should equal `sub`, but we surface what was signed rather than
  // silently substituting one for the other.
  const email = requireString(payload.email ?? payload.sub, 'email');

  const lifetime = exp - iat;
  if (lifetime > maxLifetimeSec) {
    throw new IdentityTokenError(
      'lifetime',
      `Token lifetime ${lifetime}s exceeds the ${maxLifetimeSec}s maximum.`,
    );
  }

  const name = payload.name;
  if (name !== undefined && name !== null && typeof name !== 'string') {
    throw new IdentityTokenError('claims', 'Claim `name` must be a string when present.');
  }

  const claims: IdentityTokenClaims = {
    iss,
    sub,
    aud,
    email: email.toLowerCase(),
    iat,
    exp,
    roles: optionalStringArray(payload.roles, 'roles'),
    perms: optionalStringArray(payload.perms, 'perms'),
  };
  if (typeof name === 'string') claims.name = name;
  if (kid) claims.kid = kid;
  return claims;
}

function requireString(value: unknown, claim: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IdentityTokenError('claims', `Claim \`${claim}\` is missing or not a string.`);
  }
  return value;
}

function requireNumber(value: unknown, claim: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new IdentityTokenError('claims', `Claim \`${claim}\` is missing or not a number.`);
  }
  return value;
}

/**
 * Our tokens are single-audience by contract. `jose` has already checked the
 * value matches; we only collapse the array form the JWT spec permits.
 */
function requireAudience(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') {
    return value[0];
  }
  throw new IdentityTokenError(
    'audience',
    'Claim `aud` must be a single project slug; multi-audience tokens are not issued.',
  );
}

/** Absent means "none", which is different from "malformed". */
function optionalStringArray(value: unknown, claim: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new IdentityTokenError('claims', `Claim \`${claim}\` must be an array of strings.`);
  }
  return value as string[];
}
