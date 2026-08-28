/**
 * 🔴 THE `investigador` ROLE — A RANK AND A GRANT, AND BOTH HAVE TO AGREE.
 *
 * A role inserted into the middle of a ladder is the kind of change that looks
 * like one line and is actually two independent claims:
 *
 *   1. WHERE IT SITS. `ORG_ROLES` is ordered least → most privileged and
 *      `ROLE_RANK` is derived from that order. Every rank-gated surface in the
 *      product — member management, organization settings — asks
 *      `organizationIdsForUserWithMinRole`. Slotting `investigador` above
 *      `admin` by accident would hand every Investigador the member-management
 *      surface of their ecosistema in a single silent commit; slotting it below
 *      `member` would take away the participation an Investigador is supposed
 *      to keep.
 *
 *   2. WHAT IT CARRIES. `ROLE_PERMISSIONS` is built by SPREAD — investigador is
 *      member plus two, admin is investigador plus two, owner is admin plus one.
 *      The file says this in a comment: *"a rank that does not come with the
 *      lower role's grants is a lie"*. That is a property, not prose, and it is
 *      asserted below as a real superset check over every permission — so a
 *      future refactor that replaces the spreads with hand-written lists cannot
 *      quietly drop `voces:upload` from `admin` and leave an admin refused
 *      something their colleague can do.
 *
 * ⚠ RANK IS NOT THE SAME QUESTION AS PERMISSION, and the file is explicit that
 * asking by rank for anything that is not a strict ladder bakes today's ordering
 * into a call site. `organizationIdsForUserWithPermission` is the right question
 * for "who may file a Voz", and it is tested here against the same fake rows as
 * the rank resolver so the two answers can be compared directly.
 *
 * ⚠ AND THE OUTPUT MUST STAY BYTE-IDENTICAL. Grants are deduplicated and sorted
 * because tokens are compared and cached downstream. Two calls over the same
 * rows producing differently-ordered arrays would churn every cache key for
 * nothing, and nothing would ever fail loudly.
 *
 * ROLE_RANK itself is private, so the ordering is asserted through the observable
 * behaviour of `organizationIdsForUserWithMinRole` — which is also the only thing
 * callers can actually depend on.
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

// ---------------------------------------------------------------------------
// A fake Payload with just `find`
// ---------------------------------------------------------------------------

const USER = 1

/** One organization per role, so a single user exercises the whole ladder. */
const ORG_OF: Record<OrgRole, number> = {
  member: 10,
  investigador: 20,
  admin: 30,
  owner: 40,
}

type Row = { role: OrgRole; membershipActive?: boolean; orgActive?: boolean }

/**
 * The two queries `membershipsForUser` makes, and nothing else.
 *
 * ⚠ The fake HONOURS `isActive`, because deactivation is the revoke switch at
 * three levels and a fake that ignored it would let a test pass on rows the real
 * resolver would never have seen.
 */
function fakePayload(rows: readonly Row[]): Payload {
  const find = async ({
    collection,
  }: {
    collection: string
    where?: unknown
  }): Promise<{ docs: unknown[] }> => {
    if (collection === 'memberships') {
      return {
        docs: rows
          .filter((row) => row.membershipActive !== false)
          .map((row, i) => ({
            id: i + 1,
            user: USER,
            organization: ORG_OF[row.role],
            role: row.role,
            isActive: true,
          })),
      }
    }
    if (collection === 'organizations') {
      return {
        docs: rows
          .filter((row) => row.orgActive !== false)
          .map((row) => ({
            id: ORG_OF[row.role],
            slug: `eco-${ORG_OF[row.role]}`,
            isActive: true,
          })),
      }
    }
    throw new Error(`unexpected collection ${collection}`)
  }

  return { find } as unknown as Payload
}

/** Every role, once each. The standard fixture for the ladder assertions. */
const ALL_ROLES: readonly Row[] = ORG_ROLES.map((role) => ({ role }))

// ---------------------------------------------------------------------------
// Where the role sits
// ---------------------------------------------------------------------------

describe('ORG_ROLES — investigador sits between member and admin', () => {
  it('lists the four roles least → most privileged', () => {
    expect([...ORG_ROLES]).toEqual(['member', 'investigador', 'admin', 'owner'])
  })

  it('🔴 ranks investigador ABOVE member — asked for member, an investigador answers', async () => {
    const payload = fakePayload(ALL_ROLES)
    const ids = await organizationIdsForUserWithMinRole(payload, USER, 'member')
    expect([...ids].sort()).toEqual([10, 20, 30, 40])
  })

  it('🔴 ranks investigador BELOW admin — the member-management gate is unchanged', async () => {
    // This is the assertion that protects everything gated on
    // `minRole: 'admin'`. If `investigador` were ever slotted at or above
    // `admin`, every Investigador would silently gain the member-management
    // surface of their ecosistema, and nothing else in the codebase would fail.
    const payload = fakePayload(ALL_ROLES)
    const ids = await organizationIdsForUserWithMinRole(payload, USER, 'admin')
    expect([...ids].sort()).toEqual([30, 40])
    expect(ids).not.toContain(ORG_OF.investigador)
  })

  it('a member does not clear an investigador-level bar', async () => {
    const payload = fakePayload(ALL_ROLES)
    const ids = await organizationIdsForUserWithMinRole(payload, USER, 'investigador')
    expect([...ids].sort()).toEqual([20, 30, 40])
    expect(ids).not.toContain(ORG_OF.member)
  })

  it('owner is still the top of the ladder', async () => {
    const payload = fakePayload(ALL_ROLES)
    expect(await organizationIdsForUserWithMinRole(payload, USER, 'owner')).toEqual([40])
  })

  it('a deactivated organization drops out of every rank answer', async () => {
    // ⚠ Deactivation is the revoke switch. An org switched off must vanish from
    // the ladder, not merely lose the surfaces someone remembered to gate.
    const payload = fakePayload([
      { role: 'investigador', orgActive: false },
      { role: 'admin' },
    ])
    expect(await organizationIdsForUserWithMinRole(payload, USER, 'member')).toEqual([30])
  })
})

// ---------------------------------------------------------------------------
// What the role carries
// ---------------------------------------------------------------------------

describe('grantForRole(investigador) — what it gains, and what it must not', () => {
  it('gains voces:upload and ratings:read-comments over a plain member', () => {
    const grant = grantForRole('investigador')
    expect(grant.permissions).toContain(PERMISSIONS.vocesUpload)
    expect(grant.permissions).toContain(PERMISSIONS.ratingsReadComments)

    const member = grantForRole('member').permissions
    expect(member).not.toContain(PERMISSIONS.vocesUpload)
    expect(member).not.toContain(PERMISSIONS.ratingsReadComments)
  })

  it('🔴 manages nobody and deletes nothing', () => {
    // The whole argument for putting the role below `admin`: an Investigador
    // files other people's material, and that is all the extra standing they
    // have. If either of these ever appeared here, the rank order would still
    // read as before while the grant had quietly become an admin's.
    const grant = grantForRole('investigador')
    expect(grant.permissions).not.toContain(PERMISSIONS.membersManage)
    expect(grant.permissions).not.toContain(PERMISSIONS.documentsDelete)
    expect(grant.permissions).not.toContain(PERMISSIONS.organizationManage)
  })

  it('keeps everything a member already had — nothing is traded away', () => {
    // ⚠ A SUPERSET, NOT A SIDEWAYS ROLE. An Investigador participates in their
    // ecosistema exactly like anybody else: same chat, same uploads, same
    // ratings.
    const grant = grantForRole('investigador').permissions
    for (const permission of ROLE_PERMISSIONS.member) {
      expect(grant).toContain(permission)
    }
  })

  it('reports the role itself, so a consumer can still read it off the token', () => {
    expect(grantForRole('investigador').roles).toEqual(['investigador'])
  })
})

describe('🔴 the ladder is cumulative — a higher rank carries every lower grant', () => {
  it('🔴 admin and owner are supersets of investigador', () => {
    // "A rank that does not come with the lower role's grants is a lie." The
    // failure it prevents is concrete and confusing in production: an admin
    // being refused `voces:upload` — something a colleague one rank BELOW them
    // can do — because the permission lists drifted apart.
    for (const higher of ['admin', 'owner'] as const) {
      for (const permission of ROLE_PERMISSIONS.investigador) {
        expect(grantForRole(higher).permissions).toContain(permission)
      }
    }
  })

  it('every step of the ladder is a superset of the step below it', () => {
    for (let i = 1; i < ORG_ROLES.length; i += 1) {
      const lower = ROLE_PERMISSIONS[ORG_ROLES[i - 1]!]
      const higher = grantForRole(ORG_ROLES[i]!).permissions
      for (const permission of lower) expect(higher).toContain(permission)
    }
  })

  it('every permission the product defines is reachable by the top role', () => {
    // Catches a permission added to `PERMISSIONS` and then never granted to
    // anybody — decoration that reads like a real gate in review.
    const owner = grantForRole('owner').permissions
    for (const permission of Object.values(PERMISSIONS)) {
      expect(owner).toContain(permission)
    }
  })
})

// ---------------------------------------------------------------------------
// Asking by permission rather than by rank
// ---------------------------------------------------------------------------

describe('organizationIdsForUserWithPermission — only where the role really holds it', () => {
  it('🔴 voces:upload lands in the investigador, admin and owner orgs only', async () => {
    // Phrased as a permission on purpose. `minRole: 'investigador'` would give
    // the same answer TODAY and a different one the day a role is reordered —
    // and it would change silently, with no test and no review touching the
    // call site.
    const payload = fakePayload(ALL_ROLES)
    const ids = await organizationIdsForUserWithPermission(payload, USER, PERMISSIONS.vocesUpload)
    expect([...ids].sort()).toEqual([20, 30, 40])
  })

  it('ratings:read-comments is narrowed the same way', async () => {
    // ⚠ This used to be implicit and tenant-wide: every member of an ecosistema
    // could read every colleague's written complaint about an answer. The
    // narrowing IS the permission, so the member org must be absent.
    const payload = fakePayload(ALL_ROLES)
    const ids = await organizationIdsForUserWithPermission(
      payload,
      USER,
      PERMISSIONS.ratingsReadComments,
    )
    expect(ids).not.toContain(ORG_OF.member)
    expect([...ids].sort()).toEqual([20, 30, 40])
  })

  it('members:manage stays with admin and owner, even though investigador outranks member', async () => {
    const payload = fakePayload(ALL_ROLES)
    const ids = await organizationIdsForUserWithPermission(payload, USER, PERMISSIONS.membersManage)
    expect([...ids].sort()).toEqual([30, 40])
  })

  it('a permission every role holds returns every organization', async () => {
    const payload = fakePayload(ALL_ROLES)
    const ids = await organizationIdsForUserWithPermission(payload, USER, PERMISSIONS.chatUse)
    expect([...ids].sort()).toEqual([10, 20, 30, 40])
  })

  it('returns [] for a user with no active memberships — "sees nothing", not "sees everything"', async () => {
    const payload = fakePayload([])
    expect(await organizationIdsForUserWithPermission(payload, USER, PERMISSIONS.vocesUpload)).toEqual([])
  })

  it('a deactivated membership takes the permission with it', async () => {
    const payload = fakePayload([
      { role: 'investigador', membershipActive: false },
      { role: 'member' },
    ])
    expect(await organizationIdsForUserWithPermission(payload, USER, PERMISSIONS.vocesUpload)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The byte-identical-JSON invariant
// ---------------------------------------------------------------------------

describe('⚠ grants stay deduplicated and sorted', () => {
  it('sorts permissions, so two calls over the same rows are byte-identical', () => {
    // Tokens are compared and cached downstream. An unsorted array would make
    // every cache key churn on nothing, and no test would ever go red for it.
    for (const role of ORG_ROLES) {
      const { permissions } = grantForRole(role)
      expect(permissions).toEqual([...permissions].sort())
      expect(JSON.stringify(grantForRole(role))).toBe(JSON.stringify(grantForRole(role)))
    }
  })

  it('deduplicates, even though investigador is built by spreading member', () => {
    // The spread-based construction is exactly what could produce a duplicate
    // the day someone re-lists a permission "for clarity".
    for (const role of ORG_ROLES) {
      const { permissions } = grantForRole(role)
      expect(permissions).toEqual([...new Set(permissions)])
    }
  })

  it('hands back a fresh array each time, so a caller cannot mutate the role map', () => {
    const first = grantForRole('investigador')
    first.permissions.push('bogus:permission')
    expect(grantForRole('investigador').permissions).not.toContain('bogus:permission')
  })
})
