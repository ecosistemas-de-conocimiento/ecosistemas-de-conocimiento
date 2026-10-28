/**
 * 🔴 NOBODY GRANTS A ROLE ABOVE THEIR OWN.
 *
 * `create`/`update` access on memberships is `withinMyOrganizationsWithRole('admin')`:
 * it says WHO may write, never WHAT role they may write. So an `admin` could
 * create an `owner`, or promote a colleague to `owner`, and an admin could
 * demote or remove an `owner`. `refuseRoleAboveOwn` and
 * `refuseDeleteAboveOwn` close both. Platform admins and the seed path are
 * untouched.
 */

import { describe, expect, it } from 'vitest'
import type { PayloadRequest } from 'payload'

import {
  makeRefuseDeleteAboveOwn,
  makeRefuseRoleAboveOwn,
  Memberships,
  refuseDeleteAboveOwn,
  refuseDeleteLastResponsable,
  refuseLeavingWithoutResponsable,
  ROLE_CEILING_MESSAGE,
} from './Memberships'
import type { OrgRole } from '../lib/permissions'

const PLATFORM_ADMIN = 1
const ADMIN_OF_A = 2
const OWNER_OF_A = 3
const ANA = 4
const INVESTIGADOR_OF_A = 5
const ESTUDIANTE_OF_A = 6

const ECO_A = 10

const ROLES: Record<number, OrgRole> = {
  [ADMIN_OF_A]: 'admin',
  [OWNER_OF_A]: 'owner',
  [INVESTIGADOR_OF_A]: 'investigador',
  [ESTUDIANTE_OF_A]: 'estudiante',
}
const roleIn = async (_payload: unknown, userId: number | string, orgId: number | string) =>
  String(orgId) === String(ECO_A) ? (ROLES[Number(userId)] ?? null) : null

const hook = makeRefuseRoleAboveOwn(roleIn)

function reqAs(userId: number | null, isPlatformAdmin = false, rows: Record<string, unknown> = {}) {
  return {
    user: userId === null ? null : { id: userId, isActive: true, isPlatformAdmin },
    payload: {
      async findByID({ id }: { id: number | string }) {
        return rows[String(id)] ?? null
      },
    },
  } as unknown as PayloadRequest
}

const run = (args: {
  data: Record<string, unknown>
  operation?: 'create' | 'update'
  originalDoc?: Record<string, unknown>
  req: PayloadRequest
}) => hook({ operation: 'create', collection: { slug: 'memberships' }, context: {}, ...args } as never)

async function expectCeiling(p: Promise<unknown>) {
  let thrown: unknown
  try {
    await p
  } catch (err) {
    thrown = err
  }
  expect(thrown, 'expected a refusal').toBeDefined()
  const said = `${String((thrown as { message?: unknown }).message ?? '')} ${JSON.stringify(
    (thrown as { data?: unknown }).data ?? {},
  )}`
  expect(said).toContain(ROLE_CEILING_MESSAGE)
}

describe('refuseRoleAboveOwn', () => {
  it('🔴 refuses an admin creating an owner', async () => {
    await expectCeiling(
      run({ data: { user: ANA, organization: ECO_A, role: 'owner' }, req: reqAs(ADMIN_OF_A) }),
    )
  })

  it('🔴 refuses an admin promoting a member to owner', async () => {
    await expectCeiling(
      run({
        operation: 'update',
        data: { role: 'owner' },
        originalDoc: { user: ANA, organization: ECO_A, role: 'member' },
        req: reqAs(ADMIN_OF_A),
      }),
    )
  })

  it('🔴 refuses an admin demoting an owner', async () => {
    await expectCeiling(
      run({
        operation: 'update',
        data: { role: 'member' },
        originalDoc: { user: OWNER_OF_A, organization: ECO_A, role: 'owner' },
        req: reqAs(ADMIN_OF_A),
      }),
    )
  })

  it('🔴 refuses an admin editing anything on an owner’s row', async () => {
    await expectCeiling(
      run({
        operation: 'update',
        data: { isActive: false },
        originalDoc: { user: OWNER_OF_A, organization: ECO_A, role: 'owner' },
        req: reqAs(ADMIN_OF_A),
      }),
    )
  })

  it('refuses a caller with no role in the target ecosistema', async () => {
    await expectCeiling(
      run({ data: { user: ANA, organization: ECO_A, role: 'member' }, req: reqAs(ANA) }),
    )
  })

  it('lets an admin grant up to their own rank', async () => {
    for (const role of ['estudiante', 'member', 'admin']) {
      const data = { user: ANA, organization: ECO_A, role }
      await expect(run({ data, req: reqAs(ADMIN_OF_A) })).resolves.toBe(data)
    }
  })

  it('🔴 refuses an admin granting investigador (it ranks above admin)', async () => {
    await expectCeiling(
      run({ data: { user: ANA, organization: ECO_A, role: 'investigador' }, req: reqAs(ADMIN_OF_A) }),
    )
  })

  it('lets an investigador grant everything up to investigador, never owner', async () => {
    for (const role of ['estudiante', 'member', 'admin', 'investigador']) {
      const data = { user: ANA, organization: ECO_A, role }
      await expect(run({ data, req: reqAs(INVESTIGADOR_OF_A) })).resolves.toBe(data)
    }
    await expectCeiling(
      run({ data: { user: ANA, organization: ECO_A, role: 'owner' }, req: reqAs(INVESTIGADOR_OF_A) }),
    )
  })

  it('🔴 refuses an estudiante granting anything above estudiante', async () => {
    await expectCeiling(
      run({ data: { user: ANA, organization: ECO_A, role: 'member' }, req: reqAs(ESTUDIANTE_OF_A) }),
    )
  })

  it('a create without a role is the default (member), within reach', async () => {
    const data = { user: ANA, organization: ECO_A }
    await expect(run({ data, req: reqAs(ADMIN_OF_A) })).resolves.toBe(data)
  })

  it('lets an owner grant owner', async () => {
    const data = { user: ANA, organization: ECO_A, role: 'owner' }
    await expect(run({ data, req: reqAs(OWNER_OF_A) })).resolves.toBe(data)
  })

  it('leaves a platform admin and the seed path alone', async () => {
    const data = { user: ANA, organization: ECO_A, role: 'owner' }
    await expect(run({ data, req: reqAs(PLATFORM_ADMIN, true) })).resolves.toBe(data)
    await expect(run({ data, req: reqAs(null) })).resolves.toBe(data)
  })
})

describe('refuseDeleteAboveOwn', () => {
  const del = makeRefuseDeleteAboveOwn(roleIn)
  const rows = {
    50: { id: 50, user: OWNER_OF_A, organization: ECO_A, role: 'owner' },
    51: { id: 51, user: ANA, organization: ECO_A, role: 'member' },
  }
  const runDelete = (id: number, req: PayloadRequest) =>
    del({ id, req, collection: { slug: 'memberships' }, context: {} } as never)

  it('🔴 refuses an admin removing an owner', async () => {
    await expectCeiling(runDelete(50, reqAs(ADMIN_OF_A, false, rows)))
  })

  it('lets an admin remove a member, and an owner remove an owner', async () => {
    await expect(runDelete(51, reqAs(ADMIN_OF_A, false, rows))).resolves.toBeUndefined()
    await expect(runDelete(50, reqAs(OWNER_OF_A, false, rows))).resolves.toBeUndefined()
  })

  it('leaves a platform admin alone', async () => {
    await expect(runDelete(50, reqAs(PLATFORM_ADMIN, true, rows))).resolves.toBeUndefined()
  })
})

describe('Memberships wiring', () => {
  it('runs the ceiling on every write and every delete', () => {
    expect(Memberships.hooks?.beforeValidate?.length).toBeGreaterThanOrEqual(5)
    expect(Memberships.hooks?.beforeValidate).toContain(refuseLeavingWithoutResponsable)
    expect(Memberships.hooks?.beforeDelete).toEqual([refuseDeleteAboveOwn, refuseDeleteLastResponsable])
  })
})
