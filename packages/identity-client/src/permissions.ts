// Pure permission helpers for @edc/identity-client.
//
// No I/O, no state, no throwing. Safe to call on every render and every
// request. They read ONLY what the IdP already decided — they never expand a
// role into permissions, because role→permission expansion is the IdP's job
// and duplicating it is how two products drift apart.

import { EMPTY_GRANT, type Principal, type ProjectGrant, type ResolvedPrincipal } from './types.js';

/** True when `p` is a verified single-project token rather than a full principal. */
export function isTokenClaims(p: Principal): p is import('./types.js').IdentityTokenClaims {
  return typeof (p as { aud?: unknown }).aud === 'string';
}

/**
 * The grant a principal holds in one project.
 *
 * Always returns an object, never `undefined` — `grantOf(p, 'chat').permissions`
 * is safe to read. A token only ever grants its own `aud`; asking it about
 * another project returns the empty grant, which is the honest answer.
 *
 * Platform admins are NOT expanded here: the IdP flattens their permissions
 * into what it returns. Use `canInProject` if you want the admin short-circuit.
 */
export function grantOf(principal: Principal, projectSlug: string): ProjectGrant {
  if (isTokenClaims(principal)) {
    if (principal.aud !== projectSlug) return EMPTY_GRANT;
    return { roles: principal.roles, permissions: principal.perms };
  }
  return principal.projects[projectSlug] ?? EMPTY_GRANT;
}

/**
 * Does this principal hold `permission` in the scope it already carries?
 *
 * - Given a **token**, that scope is the token's own `aud`. This is the common
 *   case inside a product: the token was minted for you, so `can()` reads
 *   exactly right.
 * - Given a **ResolvedPrincipal**, the scope is "anywhere on the platform" — true
 *   if the permission is held in *any* project, or the user is a platform
 *   admin. That is rarely what a route handler means. Prefer
 *   {@link canInProject} whenever you know the project.
 */
export function can(principal: Principal, permission: string): boolean {
  if (isTokenClaims(principal)) {
    return principal.perms.includes(permission);
  }
  if (principal.isPlatformAdmin) return true;
  for (const grant of Object.values(principal.projects)) {
    if (grant.permissions.includes(permission)) return true;
  }
  return false;
}

/**
 * Does this principal hold `permission` **in `projectSlug`**? The check to
 * reach for in a route handler.
 *
 * A token scoped to a different project always answers `false`, even for a
 * platform admin — a token cannot grant beyond its audience, and pretending
 * otherwise would defeat the audience check that made it safe to accept.
 */
export function canInProject(
  principal: Principal,
  projectSlug: string,
  permission: string,
): boolean {
  if (isTokenClaims(principal)) {
    return principal.aud === projectSlug && principal.perms.includes(permission);
  }
  if (principal.isPlatformAdmin) return true;
  return (principal.projects[projectSlug]?.permissions ?? []).includes(permission);
}

/** Does the principal hold `role` in `projectSlug`? Prefer permissions over roles. */
export function hasRoleInProject(
  principal: Principal,
  projectSlug: string,
  role: string,
): boolean {
  return grantOf(principal, projectSlug).roles.includes(role);
}

/** Project slugs the principal has any assignment in. A token yields its own `aud`. */
export function projectsOf(principal: Principal): string[] {
  return isTokenClaims(principal) ? [principal.aud] : Object.keys(principal.projects);
}

/** True when the principal is a platform admin. A token never carries this flag. */
export function isPlatformAdmin(principal: Principal): principal is ResolvedPrincipal {
  return !isTokenClaims(principal) && principal.isPlatformAdmin === true;
}
