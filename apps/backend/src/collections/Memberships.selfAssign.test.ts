/**
 * 🔴 THE ESCALATION TEST. "admin es admin, no necesita ser miembro para ver
 * todo, y no deberá poderse asignar."
 *
 * A platform admin already reads every tenant: `withinMyOrganizations` returns
 * a bare `true` for them, on `memberships` as on everything else. So `create`
 * access on this collection does NOT stop them writing a membership row — and
 * the one row they must never write is their own. A membership is not read
 * access, it is PARTICIPATION: it puts them inside an ecosistema's private
 * drafts as a peer, able to upload and publish there.
 *
 * The exact bypass this suite pins down is one HTTP call:
 *
 *   POST /api/memberships { user: <their own id>, organization: <any tenant> }
 *
 * Access control waves it through. `refuseSelfAssignment` is the thing that
 * does not. It is a `beforeValidate` hook rather than a hidden button because
 * the REST API is the whole surface — there is no UI to hide.
 *
 * The suite also pins the four update-shaped variants of the same move, and —
 * just as load-bearing — the writes that must KEEP WORKING: assigning other
 * people, renaming yourself, and the seed path that has no `req.user` at all.
 */

import { describe, expect, it } from 'vitest'
import type { PayloadRequest } from 'payload'

import { refuseSelfAssignment, SELF_ASSIGNMENT_MESSAGE } from './Memberships'

const ADMIN = 1 // platform admin — reads everything, belongs to Organización Demo
const ORG_ADMIN = 2 // ordinary `admin` inside ECO_A
const ANA = 3 // an ordinary member

const ECO_A = 10
const ECO_FOREIGN = 99 // a tenant the platform admin has never been near

function reqAs(userId: number | null, isPlatformAdmin = false): PayloadRequest {
  return {
    user: userId === null ? null : { id: userId, isActive: true, isPlatformAdmin },
  } as unknown as PayloadRequest
}

type Args = {
  data: Record<string, unknown>
  operation?: 'create' | 'update'
  originalDoc?: Record<string, unknown>
  req: PayloadRequest
}

const run = ({ data, operation = 'create', originalDoc, req }: Args) =>
  refuseSelfAssignment({
    data,
    operation,
    originalDoc,
    req,
    collection: { slug: 'memberships' },
    context: {},
  } as never)

/** Assert the hook refused, and that the refusal explains itself. */
function expectRefusal(fn: () => unknown) {
  let thrown: unknown
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown, 'expected the hook to refuse this write').toBeDefined()
  const message = String((thrown as { message?: unknown })?.message ?? '')
  const nested = JSON.stringify((thrown as { data?: unknown })?.data ?? {})
  const said = `${message} ${nested}`
  // The refusal must say WHY, not just "no": oversight and participation are
  // different powers, and the person reading this is an administrator who can
  // otherwise do almost anything.
  expect(said).toContain('separate powers')
  return thrown
}

describe('the bypass itself — POST /api/memberships naming yourself', () => {
  it('refuses a platform admin granting themselves a foreign ecosistema', () => {
    expectRefusal(() =>
      run({
        data: { user: ADMIN, organization: ECO_FOREIGN, role: 'owner' },
        req: reqAs(ADMIN, true),
      }),
    )
  })

  it('refuses regardless of the role asked for — `member` is the same escalation', () => {
    expectRefusal(() =>
      run({
        data: { user: ADMIN, organization: ECO_FOREIGN, role: 'member' },
        req: reqAs(ADMIN, true),
      }),
    )
  })

  it('refuses when the id arrives as a string, as a JSON body sends it', () => {
    // ⚠ Payload ids are numeric here but every REST body is JSON from a form.
    // A string/number mismatch would silently open the whole hole.
    expectRefusal(() =>
      run({
        data: { user: String(ADMIN), organization: String(ECO_FOREIGN) },
        req: reqAs(ADMIN, true),
      }),
    )
  })

  it('refuses when the id arrives as a populated relationship object', () => {
    expectRefusal(() =>
      run({ data: { user: { id: ADMIN }, organization: ECO_FOREIGN }, req: reqAs(ADMIN, true) }),
    )
  })

  it('refuses an ordinary organization admin self-assigning too', () => {
    // Not a platform-admin-only rule. Self-granting is escalation whoever does
    // it; the platform admin is only the account that can currently reach it.
    expectRefusal(() =>
      run({ data: { user: ORG_ADMIN, organization: ECO_A }, req: reqAs(ORG_ADMIN) }),
    )
  })

  it('names the `user` field, so the admin panel shows the message on it', () => {
    const err = expectRefusal(() =>
      run({ data: { user: ADMIN, organization: ECO_FOREIGN }, req: reqAs(ADMIN, true) }),
    ) as { data?: { errors?: { path?: string; message?: string }[] } }
    const errors = err.data?.errors ?? []
    expect(errors[0]?.path).toBe('user')
    expect(errors[0]?.message).toBe(SELF_ASSIGNMENT_MESSAGE)
  })
})

describe('the update-shaped variants of the same move', () => {
  it("refuses re-pointing somebody else's membership at yourself", () => {
    expectRefusal(() =>
      run({
        data: { user: ADMIN },
        operation: 'update',
        originalDoc: { id: 5, user: ANA, organization: ECO_FOREIGN, role: 'member', isActive: true },
        req: reqAs(ADMIN, true),
      }),
    )
  })

  it('refuses re-activating your own revoked membership', () => {
    expectRefusal(() =>
      run({
        data: { isActive: true },
        operation: 'update',
        originalDoc: {
          id: 6,
          user: ADMIN,
          organization: ECO_FOREIGN,
          role: 'member',
          isActive: false,
        },
        req: reqAs(ADMIN, true),
      }),
    )
  })

  it('refuses promoting yourself inside an ecosistema you already belong to', () => {
    expectRefusal(() =>
      run({
        data: { role: 'owner' },
        operation: 'update',
        originalDoc: { id: 7, user: ADMIN, organization: ECO_A, role: 'member', isActive: true },
        req: reqAs(ADMIN, true),
      }),
    )
  })
})

describe('what must keep working', () => {
  it('lets an administrator assign somebody else — that is the job', () => {
    const data = { user: ANA, organization: ECO_A, role: 'member' }
    expect(run({ data, req: reqAs(ORG_ADMIN) })).toBe(data)
  })

  it('lets a platform admin assign somebody else into any ecosistema', () => {
    const data = { user: ANA, organization: ECO_FOREIGN, role: 'admin' }
    expect(run({ data, req: reqAs(ADMIN, true) })).toBe(data)
  })

  it('lets you edit the cosmetics of your own membership', () => {
    // `personName`, `title` and `team` grant nothing. Blocking these would make
    // the rule read as "admins may not exist", which is not what was decided.
    const data = { personName: 'Rodrigo', title: 'Coordinador' }
    expect(
      run({
        data,
        operation: 'update',
        originalDoc: { id: 8, user: ADMIN, organization: ECO_A, role: 'owner', isActive: true },
        req: reqAs(ADMIN, true),
      }),
    ).toBe(data)
  })

  it('lets a no-op re-save of your own row through', () => {
    const data = { role: 'owner', isActive: true, personName: 'Admin' }
    expect(
      run({
        data,
        operation: 'update',
        originalDoc: { id: 9, user: ADMIN, organization: ECO_A, role: 'owner', isActive: true },
        req: reqAs(ADMIN, true),
      }),
    ).toBe(data)
  })

  it('lets the seed through — no `req.user`, so there is nobody to self-assign', () => {
    // 🔴 The bootstrap creates the demo ecosistema's first owner with
    // `overrideAccess: true` and no request user. If this hook refused there,
    // a fresh install would come up with an ownerless tenant.
    const data = { user: ADMIN, organization: ECO_A, role: 'owner' }
    expect(run({ data, req: reqAs(null) })).toBe(data)
    expect(run({ data, req: undefined as unknown as PayloadRequest })).toBe(data)
  })
})
