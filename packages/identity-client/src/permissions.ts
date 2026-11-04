// Pure permission helpers for @edc/identity-client.
//
// No I/O, no state, no throwing. Safe to call on every render and every
// request. They read ONLY what the IdP already decided — they never expand a
// role into permissions, because role→permission expansion is the IdP's job
// and duplicating it is how two products drift apart.
//
// ⚠ "NO THROWING" IS A CONTRACT, NOT AN ASPIRATION. A claims object arrives
// from a decoded JWT, so its shape is whatever the issuer signed — not whatever
// `IdentityTokenClaims` declares. TypeScript checks the call site; it cannot
// check the token. Every array these helpers read therefore goes through
// {@link grantOf}, the single normaliser, which turns an absent or malformed
// claim into the empty grant. A missing claim means the holder was granted
// NOTHING, so the honest answer is `false` — never an exception, and never
// `true`.

import { EMPTY_GRANT, type Principal, type ProjectGrant, type ResolvedPrincipal } from './types.js';

/**
 * True when `p` is a verified single-project token rather than a full principal.
 *
 * This is the union DISCRIMINANT, nothing more: it answers "which arm is this?",
 * not "is this token well-formed?". `aud` is the only field that separates the
 * two shapes. Well-formedness is {@link grantOf}'s job.
 */
export function isTokenClaims(p: Principal): p is import('./types.js').IdentityTokenClaims {
  return typeof (p as { aud?: unknown }).aud === 'string';
}

/**
 * The one place a claims array is trusted.
 *
 * Anything that is not an array — absent, `null`, a bare string — becomes `[]`.
 * A string matters especially: `'story:edit'.includes('story:edit')` is `true`,
 * so passing a malformed claim straight to `.includes()` would GRANT the
 * permission rather than deny it.
 */
function claimArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

/**
 * Normalise ANY value that claims to be a project grant into a real one.
 *
 * The array-level counterpart to {@link claimArray}, exported so that every
 * module which reads a grant off the wire — not just the token helpers — goes
 * through the same normaliser. 0.3.2 said `grantOf()` was "the single place a
 * claims array is trusted", but `resolve.ts` read the IdP's `projects` map raw,
 * so the substring-GRANT hazard survived on that path. It no longer does.
 *
 * @internal Not part of the published API surface.
 */
export function normalizeGrant(value: unknown): ProjectGrant {
  if (!value || typeof value !== 'object') return EMPTY_GRANT;
  const grant = value as { roles?: unknown; permissions?: unknown };
  return { roles: claimArray(grant.roles), permissions: claimArray(grant.permissions) };
}

/**
 * The platform-admin flag, read STRICTLY.
 *
 * `isPlatformAdmin` is the widest grant there is — it means "holds every
 * permission in every project" — so it is the last flag that may be read as
 * truthy. `'yes'`, `1` and `'false'` are all malformed, and a malformed claim
 * grants NOTHING.
 *
 * @internal Not part of the published API surface.
 */
export function isPlatformAdminFlag(value: unknown): boolean {
  return value === true;
}

/** The principal's project map, or `{}` when the field is absent or not an object. */
function projectMap(principal: ResolvedPrincipal): Record<string, ProjectGrant> {
  const projects = (principal as { projects?: unknown }).projects;
  return typeof projects === 'object' && projects !== null
    ? (projects as Record<string, ProjectGrant>)
    : {};
}

/**
 * The grant a principal holds in one project.
 *
 * Always returns an object with two real arrays, never `undefined` and never a
 * malformed claim passed through — `grantOf(p, 'chat').permissions.includes(x)`
 * is safe on any input. A token only ever grants its own `aud`; asking it about
 * another project returns the empty grant, which is the honest answer.
 *
 * Platform admins are NOT expanded here: the IdP flattens their permissions
 * into what it returns. Use `canInProject` if you want the admin short-circuit.
 */
export function grantOf(principal: Principal, projectSlug: string): ProjectGrant {
  if (isTokenClaims(principal)) {
    if (principal.aud !== projectSlug) return EMPTY_GRANT;
    return { roles: claimArray(principal.roles), permissions: claimArray(principal.perms) };
  }
  return normalizeGrant(projectMap(principal)[projectSlug]);
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
    return grantOf(principal, principal.aud).permissions.includes(permission);
  }
  if (isPlatformAdminFlag(principal.isPlatformAdmin)) return true;
  for (const slug of Object.keys(projectMap(principal))) {
    if (grantOf(principal, slug).permissions.includes(permission)) return true;
  }
  return false;
}

/**
 * Does this principal hold `permission` **in `projectSlug`**? The check to
 * reach for in a route handler.
 *
 * A token scoped to a different project always answers `false`, even for a
 * platform admin — a token cannot grant beyond its audience, and pretending
 * otherwise would defeat the audience check that made it safe to accept. The
 * admin short-circuit is therefore tested only on the principal arm.
 */
export function canInProject(
  principal: Principal,
  projectSlug: string,
  permission: string,
): boolean {
  if (!isTokenClaims(principal) && isPlatformAdminFlag(principal.isPlatformAdmin)) return true;
  return grantOf(principal, projectSlug).permissions.includes(permission);
}

/**
 * {@link canInProject} under its new name — the SAME function object, not a
 * wrapper (D1a, 2026-10-21: the IdP's "project" is the token's audience).
 * Prefer this name in new code; `canInProject` stays for existing callers.
 */
export const canInAudience = canInProject;

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
  return isTokenClaims(principal) ? [principal.aud] : Object.keys(projectMap(principal));
}

/** True when the principal is a platform admin. A token never carries this flag. */
export function isPlatformAdmin(principal: Principal): principal is ResolvedPrincipal {
  return !isTokenClaims(principal) && isPlatformAdminFlag(principal.isPlatformAdmin);
}
