/**
 * Token issuance.
 *
 * Claim set emitted (and nothing else):
 *   iss    AUTH_ISSUER
 *   sub    the user's EMAIL — never an internal id. Email is the join key
 *          across services, and an internal id crossing a service boundary is
 *          a coupling nobody can undo later.
 *   aud    the target ORGANIZATION slug. ONE ORGANIZATION PER TOKEN — this is
 *          the tenant boundary, and it is what makes the audience check
 *          meaningful: a token minted for org A cannot be replayed against
 *          org B.
 *   email  same as `sub`, kept explicit so a consumer never has to know that
 *          `sub` happens to be an address.
 *   name   display name, omitted entirely when unknown
 *   roles  the caller's role slugs IN THAT ORGANIZATION
 *   perms  the caller's permission slugs IN THAT ORGANIZATION
 *   iat / exp  unix seconds, exp - iat <= 900 (hard cap)
 *
 * Header: { alg: "EdDSA", kid: AUTH_KEY_ID, typ: "JWT" }.
 * `alg` is a compile-time constant. It is never derived from input.
 *
 * ⚠ The wire shape matches `@edc/identity-client`'s `IdentityTokenClaims`
 * exactly. That package calls the `aud` scope a "project"; in this product the
 * scope IS the organization. Do not rename the claims to match the concept —
 * renaming them is a breaking wire change for every future consumer.
 */

import { SignJWT } from 'jose'

import { getIssuer, getKeyId, getPrivateKey, SIGNING_ALG, warnOnce } from './keys'

/**
 * Access tokens are short-lived: 15 minutes, non-negotiable ceiling.
 *
 * ⚠ A token cannot be revoked. Deactivating a user or a membership stops the
 * NEXT token, not the one already in someone's hand — so the lifetime IS the
 * revocation delay, and that is why the cap is enforced in code rather than
 * left to an env var.
 */
export const MAX_TOKEN_TTL_SECONDS = 900

/** Used when AUTH_TOKEN_TTL is unset or unparseable. */
export const DEFAULT_TOKEN_TTL_SECONDS = 900

/** Floor, so a typo'd `AUTH_TOKEN_TTL=0` cannot mint pre-expired tokens. */
const MIN_TOKEN_TTL_SECONDS = 30

/**
 * Resolve the token lifetime: explicit arg > AUTH_TOKEN_TTL > default,
 * then clamped into [30, 900]. Requests for more than the cap are honoured
 * at the cap and logged.
 */
export function resolveTokenTtl(requested?: number): number {
  let ttl: number

  if (typeof requested === 'number' && Number.isFinite(requested)) {
    ttl = Math.floor(requested)
  } else {
    const raw = process.env.AUTH_TOKEN_TTL?.trim()
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
    if (raw && !Number.isFinite(parsed)) {
      warnOnce(
        'bad-ttl',
        `AUTH_TOKEN_TTL="${raw}" is not an integer — falling back to ${DEFAULT_TOKEN_TTL_SECONDS}s.`,
      )
    }
    ttl = Number.isFinite(parsed) ? parsed : DEFAULT_TOKEN_TTL_SECONDS
  }

  if (ttl > MAX_TOKEN_TTL_SECONDS) {
    warnOnce(
      'ttl-over-cap',
      `Requested token TTL of ${ttl}s exceeds the hard ceiling of ${MAX_TOKEN_TTL_SECONDS}s — clamping to ${MAX_TOKEN_TTL_SECONDS}s.`,
    )
    return MAX_TOKEN_TTL_SECONDS
  }
  if (ttl < MIN_TOKEN_TTL_SECONDS) {
    warnOnce(
      'ttl-under-floor',
      `Requested token TTL of ${ttl}s is below the ${MIN_TOKEN_TTL_SECONDS}s floor — clamping up.`,
    )
    return MIN_TOKEN_TTL_SECONDS
  }
  return ttl
}

export interface SignOrganizationTokenArgs {
  /** The cross-product user key. Becomes both `sub` and `email`. */
  email: string
  /** Display name. `null`/`undefined`/blank omits the `name` claim entirely. */
  name?: string | null
  /** Target organization slug. Becomes `aud`. Exactly one organization per token. */
  audience: string
  /** Role slugs held in `audience`. */
  roles: string[]
  /** Permission slugs held in `audience`. */
  perms: string[]
  /** Desired lifetime in seconds. Clamped to [30, 900]. */
  ttl?: number
}

export interface SignedOrganizationToken {
  /** Compact JWS. */
  token: string
  /** `aud` — the organization slug this token is scoped to. */
  audience: string
  /** `iss`. */
  issuer: string
  /** Header `kid`. */
  keyId: string
  /** Always `"EdDSA"`. */
  algorithm: typeof SIGNING_ALG
  /** `iat`, unix seconds. */
  issuedAt: number
  /** `exp`, unix seconds. */
  expiresAt: number
  /** `exp - iat`, seconds. */
  expiresIn: number
}

/**
 * Mint a short-lived, single-organization token.
 *
 * Throws {@link SigningKeyUnavailableError} when AUTH_PRIVATE_KEY is absent and
 * {@link IdentityConfigError} when AUTH_ISSUER is absent — both loudly, both at
 * first use. There is deliberately no symmetric fallback.
 */
export async function signOrganizationToken(
  args: SignOrganizationTokenArgs,
): Promise<SignedOrganizationToken> {
  const email = args.email.trim().toLowerCase()
  if (!email) {
    throw new TypeError('signOrganizationToken: `email` is required (it is the `sub` claim).')
  }
  const audience = args.audience.trim()
  if (!audience) {
    throw new TypeError('signOrganizationToken: `audience` (organization slug) is required.')
  }

  const issuer = getIssuer()
  const keyId = getKeyId()
  const privateKey = await getPrivateKey()

  const ttl = resolveTokenTtl(args.ttl)
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + ttl

  const name = typeof args.name === 'string' && args.name.trim().length > 0 ? args.name.trim() : null

  const builder = new SignJWT({
    email,
    ...(name ? { name } : {}),
    roles: dedupe(args.roles),
    perms: dedupe(args.perms),
  })
    .setProtectedHeader({ alg: SIGNING_ALG, kid: keyId, typ: 'JWT' })
    .setIssuer(issuer)
    .setSubject(email)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)

  const token = await builder.sign(privateKey)

  return {
    token,
    audience,
    issuer,
    keyId,
    algorithm: SIGNING_ALG,
    issuedAt,
    expiresAt,
    expiresIn: ttl,
  }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => typeof v === 'string' && v.length > 0))).sort()
}
