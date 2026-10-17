// Public surface of @edc/identity-client.
//
// Five things, nothing more:
//   1. verifyIdentityToken — is this token real, and what does it claim?
//   2. can / canInProject  — pure checks over that claim.
//   3. resolveGrant        — server-to-server lookup when no token exists.
//   4. resolveExport       — every member of one project, for seeding.
//   5. loginWithPassword / refreshSession / revokeSession — run ONE human's
//      session: password in, a rotating refresh ticket out, project access
//      tokens minted from it, and a logout that ends the whole chain.
//   6. createIdentitySession — the STATEFUL layer over (5) that every BFF was
//      writing by hand: rotate → persist → classify dead/survived/unavailable,
//      single-flight per ticket so a parallel refresh cannot read as theft.
//   7. checkCatalogueDrift — does the IdP hand out every permission this
//      product enforces? (identity OPEN.md R14.)
//
// One runtime dependency (`jose`), and only (1) uses it — the session lane is
// pure `fetch`. Everything else is the platform `fetch` too.
//
// ⚠ ZERO peerDependencies, deliberately. Keep it that way — this package is
// consumed by both the SvelteKit app and the Payload backend, and a peer here
// would force one of them to carry a dependency it does not otherwise need.
//
// In this repo the tokens it verifies are issued by `apps/backend` (the Payload
// app also acts as the identity provider); there is no separate IdP host.

export {
  verifyIdentityToken,
  clearJwksCache,
  type VerifyIdentityTokenOptions,
} from './verify.js';

export {
  can,
  canInProject,
  grantOf,
  hasRoleInProject,
  isPlatformAdmin,
  isTokenClaims,
  projectsOf,
} from './permissions.js';

export { resolveGrant, resolvePrincipal, type ResolveOptions } from './resolve.js';

export { resolveExport, type ResolveExportOptions } from './export.js';

export {
  checkCatalogueDrift,
  type CatalogueDrift,
  type CatalogueDriftOptions,
} from './catalogue.js';

export {
  createIdentitySession,
  resetIdentitySessionState,
  type IdentitySessionManager,
  type IdentitySessionOptions,
  type IdentitySessionStore,
  type LoginFailure,
  type LoginFailureKind,
  type LoginResult,
  type MintedSession,
  type SessionFailure,
  type SessionFailureKind,
  type SessionResult,
  type StoredTicket,
  type StoredToken,
} from './sessionManager.js';

export {
  loginWithPassword,
  refreshSession,
  revokeSession,
  type IdentitySession,
  type IdentitySessionUser,
  type RefreshedSession,
  type RotatedSession,
  type RotatedSessionWithToken,
  type SessionOptions,
} from './session.js';

export type { HttpCallOptions, ServiceCallOptions } from './serviceRequest.js';

export {
  EMPTY_GRANT,
  IDENTITY_JWT_ALG,
  MAX_TOKEN_LIFETIME_SEC,
  SERVICE_TOKEN_HEADER,
  type IdentityTokenClaims,
  type Principal,
  type ProjectExport,
  type ProjectGrant,
  type ProjectMember,
  type ResolvedPrincipal,
} from './types.js';

export {
  IdentityConfigError,
  IdentityError,
  IdentityRequestError,
  IdentitySessionError,
  IdentityTokenError,
  type IdentityErrorBody,
  type IdentitySessionFailureReason,
  type IdentitySessionOperation,
  type TokenRejectionReason,
} from './errors.js';
