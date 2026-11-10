/**
 * Cleanup 2 of the 2026-11-10 audit: a NULL `isActive` is off. Only a user
 * shape with no such key (built in-process) passes as active.
 */

import { describe, expect, it } from 'vitest'

import { isActiveUser, isPlatformAdminUser } from './index'

describe('isActiveUser', () => {
  it.each([
    [{ id: 1, isActive: true }, true],
    [{ id: 1 }, true],
    [{ id: 1, isActive: false }, false],
    [{ id: 1, isActive: null }, false],
    [{ id: 1, isActive: 'true' }, false],
    [null, false],
  ])('%j → %s', (user, expected) => {
    expect(isActiveUser(user)).toBe(expected)
  })

  it('a platform admin whose flag is NULL is no platform admin', () => {
    expect(isPlatformAdminUser({ id: 1, isActive: null, isPlatformAdmin: true })).toBe(false)
    expect(isPlatformAdminUser({ id: 1, isActive: true, isPlatformAdmin: true })).toBe(true)
  })
})
