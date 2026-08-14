/**
 * Key material for this backend acting as the identity provider.
 *
 * SIGNING IS ASYMMETRIC ONLY. There is no HMAC path here, and `PAYLOAD_SECRET`
 * is never used for token signing — it stays scoped to Payload's own
 * cookie/session machinery. With a symmetric secret, "able to verify" and
 * "able to mint" are the same capability, so every consumer handed a
 * verification key could forge tokens for every other consumer. Asymmetric
 * signing is the whole reason this file exists.
 *
 * Algorithm: EdDSA over Ed25519 (recommended by `ai-service-verification-posture.md`).
 * The algorithm is pinned as a module constant and is NEVER read from a token
 * header, a request body, or an env var.
 *
 * Env:
 *   AUTH_PRIVATE_KEY  PKCS#8 PEM, newlines may be escaped as `\n`
 *   AUTH_PUBLIC_KEY   SPKI PEM,   newlines may be escaped as `\n`
 *   AUTH_KEY_ID       `kid` published in the JWK Set and stamped on every token
 *   AUTH_ISSUER       `iss` claim, e.g. https://api.dev.example.org
 */

import { exportJWK, importPKCS8, importSPKI, type JWK, type KeyLike } from 'jose'

/** The ONLY signature algorithm this service issues or accepts. */
export const SIGNING_ALG = 'EdDSA' as const

/** Fallback `kid` used when AUTH_KEY_ID is unset (dev convenience only). */
const FALLBACK_KEY_ID = 'identity-unversioned'

/** Thrown when something tries to sign but no usable private key is configured. */
export class SigningKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SigningKeyUnavailableError'
  }
}

/** Thrown when required issuance config (issuer, etc.) is missing. */
export class IdentityConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityConfigError'
  }
}

const warnedOnce = new Set<string>()

/** console.warn, but only the first time for a given key (avoids per-request log spam). */
export function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return
  warnedOnce.add(key)
  console.warn(`[identity/jwt] ${message}`)
}

/**
 * Turn an env-carried PEM back into a real PEM.
 * Handles: `\n` escapes, `\r\n`, and accidental wrapping quotes from .env files.
 */
export function normalizePem(raw: string): string {
  let pem = raw.trim()
  if (
    (pem.startsWith('"') && pem.endsWith('"')) ||
    (pem.startsWith("'") && pem.endsWith("'"))
  ) {
    pem = pem.slice(1, -1)
  }
  return pem
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

function readEnv(name: string): string | null {
  const value = process.env[name]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

// --- module-scope caches ------------------------------------------------------
// Cached as promises so concurrent requests share a single import.
let privateKeyPromise: Promise<KeyLike> | null = null
let publicKeyPromise: Promise<KeyLike> | null = null
let jwkPromise: Promise<JWK> | null = null

/** Test/rotation hook: drop the cached imports so the next call re-reads env. */
export function resetKeyCache(): void {
  privateKeyPromise = null
  publicKeyPromise = null
  jwkPromise = null
}

/** Is a public key configured? Used by the JWKS route to degrade instead of crash. */
export function hasPublicKey(): boolean {
  return readEnv('AUTH_PUBLIC_KEY') !== null
}

/** Is a private key configured? */
export function hasPrivateKey(): boolean {
  return readEnv('AUTH_PRIVATE_KEY') !== null
}

/** The `kid` stamped on issued tokens and published in the JWK Set. */
export function getKeyId(): string {
  const kid = readEnv('AUTH_KEY_ID')
  if (kid) return kid
  warnOnce(
    'missing-kid',
    `AUTH_KEY_ID is not set — falling back to "${FALLBACK_KEY_ID}". Set it before deploying; rotation depends on a stable kid.`,
  )
  return FALLBACK_KEY_ID
}

/** The `iss` claim. Required for signing — throws loudly if absent. */
export function getIssuer(): string {
  const issuer = readEnv('AUTH_ISSUER')
  if (!issuer) {
    throw new IdentityConfigError(
      'AUTH_ISSUER is not set. Every token must carry an `iss` claim; refusing to mint an unattributable token.',
    )
  }
  return issuer
}

/**
 * Import the Ed25519 PRIVATE key. Throws a loud, actionable error when missing
 * or malformed — signing must never silently fall back to anything symmetric.
 */
export async function getPrivateKey(): Promise<KeyLike> {
  if (!privateKeyPromise) {
    privateKeyPromise = (async (): Promise<KeyLike> => {
      const raw = readEnv('AUTH_PRIVATE_KEY')
      if (!raw) {
        throw new SigningKeyUnavailableError(
          'AUTH_PRIVATE_KEY is not set. This service signs with Ed25519 (asymmetric only, never PAYLOAD_SECRET). Generate a keypair with `npm run keygen` and set AUTH_PRIVATE_KEY / AUTH_PUBLIC_KEY.',
        )
      }
      try {
        return await importPKCS8(normalizePem(raw), SIGNING_ALG, { extractable: true })
      } catch (err) {
        throw new SigningKeyUnavailableError(
          `AUTH_PRIVATE_KEY could not be imported as a PKCS#8 Ed25519 key: ${
            err instanceof Error ? err.message : String(err)
          }. It must be a PEM block starting with "-----BEGIN PRIVATE KEY-----" (newlines may be escaped as \\n).`,
        )
      }
    })()
    // Do not cache a rejected promise — a fixed env var should recover without a restart.
    privateKeyPromise.catch(() => {
      privateKeyPromise = null
    })
  }
  return privateKeyPromise
}

/**
 * Import the Ed25519 PUBLIC key. Callers that must degrade gracefully (JWKS)
 * should gate on {@link hasPublicKey} first.
 */
export async function getPublicKey(): Promise<KeyLike> {
  if (!publicKeyPromise) {
    publicKeyPromise = (async (): Promise<KeyLike> => {
      const raw = readEnv('AUTH_PUBLIC_KEY')
      if (!raw) {
        throw new IdentityConfigError(
          'AUTH_PUBLIC_KEY is not set. Peers cannot verify tokens without a published JWKS.',
        )
      }
      try {
        return await importSPKI(normalizePem(raw), SIGNING_ALG, { extractable: true })
      } catch (err) {
        throw new IdentityConfigError(
          `AUTH_PUBLIC_KEY could not be imported as an SPKI Ed25519 key: ${
            err instanceof Error ? err.message : String(err)
          }. It must be a PEM block starting with "-----BEGIN PUBLIC KEY-----" (newlines may be escaped as \\n).`,
        )
      }
    })()
    publicKeyPromise.catch(() => {
      publicKeyPromise = null
    })
  }
  return publicKeyPromise
}

/**
 * The public key as a signing JWK: `{ kty, crv, x, kid, alg, use }`.
 *
 * Derived from AUTH_PUBLIC_KEY only. The private key is never touched here, so
 * there is no code path by which `d` (the private scalar) can reach the wire.
 */
export async function getPublicJwk(): Promise<JWK> {
  if (!jwkPromise) {
    jwkPromise = (async (): Promise<JWK> => {
      const key = await getPublicKey()
      const exported = await exportJWK(key)

      // WHITELIST, do not blacklist. We rebuild the JWK from the three public
      // OKP members only, so no private material (`d`, and the RSA CRT params)
      // can ever reach the wire even if `exportJWK` starts returning more.
      const { kty, crv, x } = exported
      if (kty !== 'OKP' || crv !== 'Ed25519' || typeof x !== 'string') {
        throw new IdentityConfigError(
          `AUTH_PUBLIC_KEY is not an Ed25519 public key (got kty=${String(kty)}, crv=${String(crv)}). This service signs with ${SIGNING_ALG}/Ed25519 only.`,
        )
      }

      return { kty, crv, x, alg: SIGNING_ALG, kid: getKeyId(), use: 'sig' }
    })()
    jwkPromise.catch(() => {
      jwkPromise = null
    })
  }
  return jwkPromise
}

/** The full JWK Set served at `/.well-known/jwks.json`. Empty when unconfigured. */
export async function getJwks(): Promise<{ keys: JWK[] }> {
  if (!hasPublicKey()) {
    warnOnce(
      'missing-public-key',
      'AUTH_PUBLIC_KEY is not set — serving an EMPTY JWK Set. Every consumer product will fail to verify tokens issued by this IdP until it is configured (`npm run keygen`).',
    )
    return { keys: [] }
  }
  try {
    return { keys: [await getPublicJwk()] }
  } catch (err) {
    console.error('[identity/jwt] failed to export AUTH_PUBLIC_KEY as a JWK:', err)
    return { keys: [] }
  }
}
