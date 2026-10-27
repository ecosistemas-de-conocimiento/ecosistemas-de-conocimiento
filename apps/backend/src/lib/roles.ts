/**
 * ROLE QUESTIONS, ASKED OF A SESSION USER (contract with the roles lane,
 * 2026-10-27).
 *
 * ⚠ MINIMAL STUB written by the student-view lane. The roles lane owns this
 * file; on merge, keep ITS version and these signatures:
 *
 *   isStudent(user, orgId)      membership role `estudiante`
 *   isInvestigador(user, orgId) membership role `investigador`
 *   canAdminOrg(user, orgId)    platform admin, or `admin` / `owner` there
 *
 * `user.memberships[].role` is read as a RAW STRING on purpose:
 * `permissions.ts` folds an unknown role to `member`, so `estudiante` would be
 * invisible there until the roles lane adds it to `ORG_ROLES`.
 */

export type RoleId = number | string

export interface RoleMembership {
  organization: RoleId | { id: RoleId } | null | undefined
  role: string | null | undefined
  isActive?: boolean | null
}

export interface RoleUser {
  isPlatformAdmin?: boolean | null
  memberships?: readonly RoleMembership[] | null
}

const idOf = (v: RoleMembership['organization']): string | null =>
  v == null ? null : typeof v === 'object' ? String(v.id) : String(v)

function rolesIn(user: RoleUser | null | undefined, orgId: RoleId): string[] {
  if (!user?.memberships) return []
  return user.memberships
    .filter((m) => m.isActive !== false && idOf(m.organization) === String(orgId))
    .map((m) => String(m.role ?? ''))
}

export function isStudent(user: RoleUser | null | undefined, orgId: RoleId): boolean {
  return rolesIn(user, orgId).includes('estudiante')
}

export function isInvestigador(user: RoleUser | null | undefined, orgId: RoleId): boolean {
  return rolesIn(user, orgId).includes('investigador')
}

export function canAdminOrg(user: RoleUser | null | undefined, orgId: RoleId): boolean {
  if (user?.isPlatformAdmin === true) return true
  return rolesIn(user, orgId).some((r) => r === 'admin' || r === 'owner')
}
