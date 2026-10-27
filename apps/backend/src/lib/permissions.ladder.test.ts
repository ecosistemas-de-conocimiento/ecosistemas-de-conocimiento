/**
 * 🔴 THE ROLE LADDER — A RANK AND A GRANT, AND BOTH HAVE TO AGREE.
 *
 *   estudiante < member < admin < investigador < owner   (owner ruling 2026-10-27)
 *
 * Two independent claims per role:
 *
 *   1. WHERE IT SITS. Every rank-gated surface (member management, teams,
 *      projects, usage/metrics) asks `organizationIdsForUserWithMinRole`, and the
 *      role ceiling on memberships compares ranks. Slotting a role one step off
 *      silently hands it (or takes away) all of them at once.
 *   2. WHAT IT CARRIES. `ROLE_PERMISSIONS` is built by spread, and a rank that
 *      does not come with the lower role's grants is a lie — asserted below as a
 *      real superset check.
 *
 * ⚠ The output must stay byte-identical: grants are deduplicated and sorted
 * because tokens are compared and cached downstream.
 *
 * ROLE_RANK is private, so ordering is asserted through
 * `organizationIdsForUserWithMinRole` — the only thing callers depend on.
 */

import { describe, expect, it } from 'vitest'
import type { Payload } from 'payload'

import {
  ORG_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  grantForRole,
  organizationIdsForUserWithMinRole,
  organizationIdsForUserWithPermission,
  type OrgRole,
} from './permissions'

const USER = 1

/** One organization per role, numbered by rank, so one user walks the ladder. */
const ORG_OF: Record<OrgRole, number> = {
  estudiante: 5,
  member: 10,
  admin: 20,
  investigador: 30,
  owner: 40,
}

type Row = { role: OrgRole; membershipActive?: boolean; orgActive?: boolean }

/** The two queries `membershipsForUser` makes. Honours `isActive` at both levels. */
function fakePayload(rows: readonly Row[]): Payload {
  const find = async ({ collection }: { collection: string }): Promise<{ docs: unknown[] }> => {
    if (collection === 'memberships') {
      return {
        docs: rows
          .filter((row) => row.membershipActive !== false)
          .map((row, i) => ({ id: i + 1, user: USER, organization: ORG_OF[row.role], role: row.role, isActive: true })),
      }
    }
    if (collection === 'organizations') {
      return {
        docs: rows
          .filter((row) => row.orgActive !== false)
          .map((row) => ({ id: ORG_OF[row.role], slug: `eco-${ORG_OF[row.role]}`, isActive: true })),
      }
    }
    throw new Error(`unexpected collection ${collection}`)
  }
  return { find } as unknown as Payload
}

const ALL_ROLES: readonly Row[] = ORG_ROLES.map((role) => ({ role }))
const sorted = (ids: Array<number | string>) => [...ids].map(Number).sort((a, b) => a - b)

describe('ORG_ROLES — the ladder', () => {
  it('lists the five roles least → most privileged', () => {
    expect([...ORG_ROLES]).toEqual(['estudiante', 'member', 'admin', 'investigador', 'owner'])
  })

  it('🔴 estudiante ranks BELOW member — a member-level bar leaves the student out', async () => {
    const ids = await organizationIdsForUserWithMinRole(fakePayload(ALL_ROLES), USER, 'member')
    expect(sorted(ids)).toEqual([10, 20, 30, 40])
  })

  it('🔴 investigador clears the admin bar — member management, teams, usage', async () => {
    const ids = await organizationIdsForUserWithMinRole(fakePayload(ALL_ROLES), USER, 'admin')
    expect(sorted(ids)).toEqual([20, 30, 40])
  })

  it('🔴 an admin does NOT clear the investigador bar', async () => {
    const ids = await organizationIdsForUserWithMinRole(fakePayload(ALL_ROLES), USER, 'investigador')
    expect(sorted(ids)).toEqual([30, 40])
  })

  it('owner is still the top of the ladder', async () => {
    expect(await organizationIdsForUserWithMinRole(fakePayload(ALL_ROLES), USER, 'owner')).toEqual([40])
  })

  it('a deactivated organization drops out of every rank answer', async () => {
    const payload = fakePayload([{ role: 'investigador', orgActive: false }, { role: 'admin' }])
    expect(await organizationIdsForUserWithMinRole(payload, USER, 'estudiante')).toEqual([20])
  })
})

describe('grants per role', () => {
  it('🔴 estudiante holds exactly a member\'s grants — no Revisión, no rating comments', () => {
    expect(grantForRole('estudiante').permissions).toEqual(grantForRole('member').permissions)
    expect(grantForRole('estudiante').permissions).not.toContain(PERMISSIONS.holdsReview)
    expect(grantForRole('estudiante').permissions).not.toContain(PERMISSIONS.ratingsReadComments)
    expect(grantForRole('estudiante').roles).toEqual(['estudiante'])
  })

  it('🔴 investigador holds every admin grant plus organization:manage (/ajustes)', () => {
    const inv = grantForRole('investigador').permissions
    for (const p of ROLE_PERMISSIONS.admin) expect(inv).toContain(p)
    expect(inv).toContain(PERMISSIONS.organizationManage)
    expect(inv).toContain(PERMISSIONS.membersManage)
    expect(inv).toContain(PERMISSIONS.holdsReview)
    expect(grantForRole('admin').permissions).not.toContain(PERMISSIONS.organizationManage)
  })

  it('owner and investigador carry the same grants; rank is the difference', () => {
    expect(grantForRole('owner').permissions).toEqual(grantForRole('investigador').permissions)
  })

  it('every step of the ladder is a superset of the step below it', () => {
    for (let i = 1; i < ORG_ROLES.length; i += 1) {
      const lower = ROLE_PERMISSIONS[ORG_ROLES[i - 1]!]
      const higher = grantForRole(ORG_ROLES[i]!).permissions
      for (const permission of lower) expect(higher).toContain(permission)
    }
  })

  it('every permission the product defines is reachable by the top role', () => {
    const owner = grantForRole('owner').permissions
    for (const permission of Object.values(PERMISSIONS)) expect(owner).toContain(permission)
  })
})

describe('organizationIdsForUserWithPermission — only where the role really holds it', () => {
  it('voces:upload, rating comments and Revisión: admin and up, never member or estudiante', async () => {
    for (const p of [PERMISSIONS.vocesUpload, PERMISSIONS.ratingsReadComments, PERMISSIONS.holdsReview]) {
      const ids = await organizationIdsForUserWithPermission(fakePayload(ALL_ROLES), USER, p)
      expect(sorted(ids)).toEqual([20, 30, 40])
    }
  })

  it('organization:manage: investigador and owner only', async () => {
    const ids = await organizationIdsForUserWithPermission(fakePayload(ALL_ROLES), USER, PERMISSIONS.organizationManage)
    expect(sorted(ids)).toEqual([30, 40])
  })

  it('a permission every role holds returns every organization', async () => {
    const ids = await organizationIdsForUserWithPermission(fakePayload(ALL_ROLES), USER, PERMISSIONS.chatUse)
    expect(sorted(ids)).toEqual([5, 10, 20, 30, 40])
  })

  it('returns [] for a user with no active memberships — "sees nothing", not "sees everything"', async () => {
    expect(await organizationIdsForUserWithPermission(fakePayload([]), USER, PERMISSIONS.vocesUpload)).toEqual([])
  })

  it('a deactivated membership takes the permission with it', async () => {
    const payload = fakePayload([{ role: 'investigador', membershipActive: false }, { role: 'member' }])
    expect(await organizationIdsForUserWithPermission(payload, USER, PERMISSIONS.membersManage)).toEqual([])
  })
})

describe('⚠ grants stay deduplicated and sorted', () => {
  it('sorted and byte-identical across calls', () => {
    for (const role of ORG_ROLES) {
      const { permissions } = grantForRole(role)
      expect(permissions).toEqual([...permissions].sort())
      expect(permissions).toEqual([...new Set(permissions)])
      expect(JSON.stringify(grantForRole(role))).toBe(JSON.stringify(grantForRole(role)))
    }
  })

  it('hands back a fresh array each time, so a caller cannot mutate the role map', () => {
    const first = grantForRole('investigador')
    first.permissions.push('bogus:permission')
    expect(grantForRole('investigador').permissions).not.toContain('bogus:permission')
  })
})
