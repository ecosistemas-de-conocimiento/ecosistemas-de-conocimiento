/**
 * Barrel for the JWT layer.
 *
 * This half is ISSUER-ONLY: `./keys` reads AUTH_PRIVATE_KEY and `./sign` mints
 * tokens with it. Neither may ever ship to a consumer.
 *
 * ⚠ THE VERIFIER LIVES IN `@edc/identity-client`, NOT HERE. Keeping a second copy in the
 * backend would be two implementations of
 * the one check that decides whether a token is trustworthy, free to drift.
 * A service that needs to verify a token imports `@edc/identity-client`.
 */

export {
  getIssuer,
  getJwks,
  getKeyId,
  getPrivateKey,
  getPublicJwk,
  getPublicKey,
  hasPrivateKey,
  hasPublicKey,
  IdentityConfigError,
  normalizePem,
  resetKeyCache,
  SIGNING_ALG,
  SigningKeyUnavailableError,
} from './keys'

export {
  DEFAULT_TOKEN_TTL_SECONDS,
  MAX_TOKEN_TTL_SECONDS,
  resolveTokenTtl,
  signOrganizationToken,
  type SignedOrganizationToken,
  type SignOrganizationTokenArgs,
} from './sign'
