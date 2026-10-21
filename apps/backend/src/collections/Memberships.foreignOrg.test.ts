/**
 * 🔴 THE CROSS-ECOSISTEMA TEST. An admin of A must not write memberships into B.
 *
 * Payload ignores the WHERE constraint that `create` access returns, so
 * `withinMyOrganizationsWithRole('admin')` alone let an admin of A
 * `POST /api/memberships { organization: B }`. `refuseForeignOrganization`
 * closes that — and must keep the legitimate writes working: an admin adding
 * people to their own ecosistema, a platform admin, and the seed path.
 */

import { describe, expect, it } from 'vitest'
import type { PayloadRequest } from 'payload'

import {
  FOREIGN_ORGANIZATION_MESSAGE,
  makeRefuseForeignOrganization,
  Memberships,
  refuseForeignOrganization,
  refuseSelfAssignment,
} from './Memberships'

const PLATFORM_ADMIN = 1
const ADMIN_OF_A = 2
const ANA = 3

const ECO_A = 10
const ECO_B = 20

// ADMIN_OF_A administers A only. Nobody else administers anything.
const hook = makeRefuseForeignOrganization(async (_payload, userId) =>
  String(userId) === String(ADMIN_OF_A) ? [ECO_A] : [],
)

function reqAs(userId: number | null, isPlatformAdmin = false): PayloadRequest {
  return {
    user: userId === null ? null : { id: userId, isActive: true, isPlatformAdmin },
    payload: {},
  } as unknown as PayloadRequest
}

const run = (args: {
  data: Record<string, unknown>
  operation?: 'create' | 'update'
  originalDoc?: Record<string, unknown>
  req: PayloadRequest
}) =>
  hook({
    operation: 'create',
    collection: { slug: 'memberships' },
    context: {},
    ...args,
  } as never)

async function expectRefusal(p: Promise<unknown>) {
  let thrown: unknown
  try {
    await p
  } catch (err) {
    thrown = err
  }
  expect(thrown, 'expected the hook to refuse this write').toBeDefined()
  const said = `${String((thrown as { message?: unknown }).message ?? '')} ${JSON.stringify(
    (thrown as { data?: unknown }).data ?? {},
  )}`
  expect(said).toContain(FOREIGN_ORGANIZATION_MESSAGE)
}

describe('refuseForeignOrganization', () => {
  it('🔴 refuses an admin of A adding someone to B', async () => {
    await expectRefusal(
      run({ data: { user: ANA, organization: ECO_B, role: 'member' }, req: reqAs(ADMIN_OF_A) }),
    )
  })

  it('refuses it with the organization populated as an object, too', async () => {
    await expectRefusal(
      run({ data: { user: ANA, organization: { id: ECO_B } }, req: reqAs(ADMIN_OF_A) }),
    )
  })

  it('lets an admin of A add someone to A', async () => {
    const data = { user: ANA, organization: ECO_A, role: 'member' }
    await expect(run({ data, req: reqAs(ADMIN_OF_A) })).resolves.toBe(data)
  })

  it('accepts a string id for an org the caller administers', async () => {
    const data = { user: ANA, organization: String(ECO_A) }
    await expect(run({ data, req: reqAs(ADMIN_OF_A) })).resolves.toBe(data)
  })

  it('🔴 refuses moving an existing A membership into B on update', async () => {
    await expectRefusal(
      run({
        operation: 'update',
        data: { organization: ECO_B },
        originalDoc: { user: ANA, organization: ECO_A },
        req: reqAs(ADMIN_OF_A),
      }),
    )
  })

  it('lets an admin of A re-role a membership in A (no organization in the patch)', async () => {
    const data = { role: 'investigador' }
    await expect(
      run({
        operation: 'update',
        data,
        originalDoc: { user: ANA, organization: ECO_A },
        req: reqAs(ADMIN_OF_A),
      }),
    ).resolves.toBe(data)
  })

  it('refuses an ordinary member, who administers nothing', async () => {
    await expectRefusal(run({ data: { user: ADMIN_OF_A, organization: ECO_A }, req: reqAs(ANA) }))
  })

  it('leaves a platform admin alone — they administer every ecosistema', async () => {
    const data = { user: ANA, organization: ECO_B }
    await expect(run({ data, req: reqAs(PLATFORM_ADMIN, true) })).resolves.toBe(data)
  })

  it('leaves the seed path alone (no req.user)', async () => {
    const data = { user: ANA, organization: ECO_B }
    await expect(run({ data, req: reqAs(null) })).resolves.toBe(data)
  })
})

describe('the Memberships collection wires the hook in', () => {
  // 🔴 Every test above calls the hook directly, so they would all keep
  // passing if someone deleted it from the collection config — and the hole
  // would be back. This one fails in that case.
  it('runs refuseForeignOrganization on beforeValidate, after the self-assignment check', () => {
    const hooks = Memberships.hooks?.beforeValidate ?? []
    expect(hooks).toContain(refuseForeignOrganization)
    expect(hooks).toContain(refuseSelfAssignment)
    expect(hooks.indexOf(refuseForeignOrganization)).toBeGreaterThan(
      hooks.indexOf(refuseSelfAssignment),
    )
  })
})
