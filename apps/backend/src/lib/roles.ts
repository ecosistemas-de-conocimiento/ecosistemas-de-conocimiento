/**
 * "What is this person in THIS ecosistema?" — the three questions the student
 * view and the investigador surfaces ask (owner ruling 2026-10-27).
 *
 *   isStudent(user, orgId)       role there is `estudiante`
 *   isInvestigador(user, orgId)  role there is `investigador`
 *   canAdminOrg(user, orgId)     platform admin, or `owner` / `investigador` there
 *
 * The functions are PURE over a user that carries `memberships` — the shape
 * `/api/users/me` returns (`collections/Users.ts` `afterMe`), and the shape
 * `withMemberships` builds from the database. The web keeps a byte-for-byte
 * twin in `apps/web/src/lib/roles.ts`.
 *
 * ⚠ ONLY ACTIVE MEMBERSHIPS OF ACTIVE ECOSISTEMAS ARE EVER ON THE LIST
 * (`membershipsForUser`). A user with no list answers "no" to everything except
 * the platform-admin half of `canAdminOrg`.
 *
 * ⚠ `canAdminOrg` does NOT include `admin` ("administra"). The owner named
 * owner and investigador; `admin` keeps its narrower grants (no /ajustes).
 * Ask by permission (`lib/permissions.ts`) for anything finer.
 */

import type { Payload } from 'payload'

import { isActiveUser, isPlatformAdminUser } from '../access'

import { isOrgRole, membershipsForUser, type OrgRole } from './permissions'

type Id = number | string

/** One entry of `user.memberships` on the session payload. */
export interface SessionMembership {
  /** The ecosistema id, as a string (Postgres hands back `7` or `'7'`). */
  organization: string
  slug: string
  role: OrgRole
}

export interface RoleUser {
  id?: Id
  isActive?: unknown
  isPlatformAdmin?: unknown
  memberships?: readonly { organization?: unknown; role?: unknown }[] | null
}

const idOf = (value: unknown): string | null => {
  if (typeof value === 'number' || (typeof value === 'string' && value !== '')) return String(value)
  if (value && typeof value === 'object') return idOf((value as { id?: unknown }).id)
  return null
}

/** The caller's role in `orgId`, or null. An inactive account holds none. */
export function roleIn(user: RoleUser | null | undefined, orgId: Id | null | undefined): OrgRole | null {
  if (!user || !isActiveUser(user) || orgId === null || orgId === undefined) return null
  const target = String(orgId)
  for (const m of user.memberships ?? []) {
    if (idOf(m?.organization) === target && isOrgRole(m.role)) return m.role
  }
  return null
}

export const isStudent = (user: RoleUser | null | undefined, orgId: Id | null | undefined): boolean =>
  roleIn(user, orgId) === 'estudiante'

export const isInvestigador = (user: RoleUser | null | undefined, orgId: Id | null | undefined): boolean =>
  roleIn(user, orgId) === 'investigador'

const ORG_ADMIN_ROLES: readonly OrgRole[] = ['owner', 'investigador']

export function canAdminOrg(user: RoleUser | null | undefined, orgId: Id | null | undefined): boolean {
  if (isPlatformAdminUser(user)) return true
  const role = roleIn(user, orgId)
  return role !== null && ORG_ADMIN_ROLES.includes(role)
}

/** The caller's active memberships, in the session-payload shape, sorted by id. */
export async function sessionMemberships(payload: Payload, userId: Id): Promise<SessionMembership[]> {
  const rows = await membershipsForUser(payload, userId)
  return rows
    .map(({ organization, role }) => ({ organization: String(organization.id), slug: organization.slug, role }))
    .sort((a, b) => Number(a.organization) - Number(b.organization) || a.organization.localeCompare(b.organization))
}

/** `user` with `memberships` read from the database, for the pure checks above. */
export async function withMemberships<U extends RoleUser>(
  payload: Payload,
  user: U,
): Promise<U & { memberships: SessionMembership[] }> {
  const memberships = user.id === undefined ? [] : await sessionMemberships(payload, user.id)
  return { ...user, memberships }
}
