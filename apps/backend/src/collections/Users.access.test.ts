/**
 * 🔴 SIGN-UP IS CLOSED (UX demo backlog #6, decided 2026-10-21).
 *
 * `Users.access.create` used to be `() => true` — anyone on the internet could
 * make an account. Only a platform admin creates accounts now; everybody else,
 * signed in or not, is refused.
 */

import { describe, expect, it } from 'vitest'
import type { PayloadRequest } from 'payload'

import { Users } from './Users'

const create = Users.access!.create!

function asReq(user: Record<string, unknown> | null): Parameters<typeof create>[0] {
  return { req: { user } as unknown as PayloadRequest } as Parameters<typeof create>[0]
}

describe('Users.access.create — closed sign-up', () => {
  it('refuses an anonymous caller', async () => {
    expect(await create(asReq(null))).toBe(false)
  })

  it('refuses an ordinary signed-in account', async () => {
    expect(await create(asReq({ id: 7, isActive: true, isPlatformAdmin: false }))).toBe(false)
  })

  it('refuses a deactivated platform admin', async () => {
    expect(await create(asReq({ id: 1, isActive: false, isPlatformAdmin: true }))).toBe(false)
  })

  it('lets an active platform admin create accounts', async () => {
    expect(await create(asReq({ id: 1, isActive: true, isPlatformAdmin: true }))).toBe(true)
  })
})
