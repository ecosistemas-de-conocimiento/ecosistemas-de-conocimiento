// Public surface of @edc/identity-client.
//
// Four things, nothing more:
//   1. verifyIdentityToken — is this token real, and what does it claim?
//   2. can / canInProject  — pure checks over that claim.
//   3. resolveGrant        — server-to-server lookup when no token exists.
//   4. resolveExport       — every member of one project, for seeding.
//
// One runtime dependency (`jose`). Everything else is the platform `fetch`.
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

export type { ServiceCallOptions } from './serviceRequest.js';

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
  IdentityTokenError,
  type IdentityErrorBody,
  type TokenRejectionReason,
} from './errors.js';
