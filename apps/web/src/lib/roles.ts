/**
 * "What is this person in THIS ecosistema?" — the web twin of
 * `apps/backend/src/lib/roles.ts` (owner ruling 2026-10-27).
 *
 *   isStudent(user, orgId)       role there is `estudiante`
 *   isInvestigador(user, orgId)  role there is `investigador`
 *   canAdminOrg(user, orgId)     platform admin, or `owner` / `investigador` there
 *
 * `user` is the session payload (`locals.user` / `data.user`): `/api/users/me`
 * carries `memberships: [{ organization, slug, role }]`, active memberships of
 * active ecosistemas only (backend `collections/Users.ts` `afterMe`).
 *
 * ⚠ PRESENTATION ONLY. These decide what to show. Every server gate re-asks.
 */

export type OrgRole = 'estudiante' | 'member' | 'admin' | 'investigador' | 'owner';

/** Least → most. Mirrors `ORG_ROLES` / `ROLE_RANK` in `apps/backend/src/lib/permissions.ts`. */
export const ROLE_RANK = {
  estudiante: 0,
  member: 1,
  admin: 2,
  investigador: 3,
  owner: 4,
} as const satisfies Record<OrgRole, number>;

export interface SessionMembership {
  organization: string;
  slug: string;
  role: OrgRole;
}

export interface RoleUser {
  isActive?: unknown;
  isPlatformAdmin?: unknown;
  memberships?: readonly { organization?: unknown; role?: unknown }[] | null;
}

const isOrgRole = (value: unknown): value is OrgRole =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROLE_RANK, value);

const idOf = (value: unknown): string | null => {
  if (typeof value === 'number' || (typeof value === 'string' && value !== '')) return String(value);
  if (value && typeof value === 'object') return idOf((value as { id?: unknown }).id);
  return null;
};

const active = (user: RoleUser): boolean => user.isActive !== false;

/** The role in `orgId`, or null. An inactive account holds none. */
export function roleIn(user: RoleUser | null | undefined, orgId: string | number | null | undefined): OrgRole | null {
  if (!user || !active(user) || orgId === null || orgId === undefined) return null;
  const target = String(orgId);
  for (const m of user.memberships ?? []) {
    if (idOf(m?.organization) === target && isOrgRole(m.role)) return m.role;
  }
  return null;
}

export const isStudent = (user: RoleUser | null | undefined, orgId: string | number | null | undefined): boolean =>
  roleIn(user, orgId) === 'estudiante';

export const isInvestigador = (user: RoleUser | null | undefined, orgId: string | number | null | undefined): boolean =>
  roleIn(user, orgId) === 'investigador';

export function canAdminOrg(user: RoleUser | null | undefined, orgId: string | number | null | undefined): boolean {
  if (user && active(user) && user.isPlatformAdmin === true) return true;
  const role = roleIn(user, orgId);
  return role === 'owner' || role === 'investigador';
}

/** The session's memberships, parsed defensively (unknown roles dropped). */
export function sessionMemberships(user: RoleUser | null | undefined): SessionMembership[] {
  const out: SessionMembership[] = [];
  for (const m of user?.memberships ?? []) {
    const organization = idOf(m?.organization);
    const slug = (m as { slug?: unknown }).slug;
    if (organization && isOrgRole(m.role)) out.push({ organization, slug: typeof slug === 'string' ? slug : '', role: m.role });
  }
  return out;
}

/** Ecosistema ids where `canAdminOrg` holds through a membership (not the platform flag). */
export function adminOrgIds(user: RoleUser | null | undefined): string[] {
  if (!user || !active(user)) return [];
  return sessionMemberships(user)
    .filter((m) => m.role === 'owner' || m.role === 'investigador')
    .map((m) => m.organization);
}
