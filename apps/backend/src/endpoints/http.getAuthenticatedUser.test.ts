/**
 * `getAuthenticatedUser` fails CLOSED on a NULL `isActive`, like access control
 * (`isActiveUser`, `access/index.ts`). It used to test `=== false`, so a row
 * whose column was NULL passed as active.
 */
import type { PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { getAuthenticatedUser } from './http'

const as = (user: unknown) => getAuthenticatedUser({ user } as unknown as PayloadRequest)
const ana = { id: 1, email: 'ana@example.invalid' }

describe('getAuthenticatedUser', () => {
  it('passes an active user', () => {
    expect(as({ ...ana, isActive: true })).toMatchObject(ana)
  })

  it('refuses a deactivated user', () => {
    expect(as({ ...ana, isActive: false })).toBeNull()
  })

  it('refuses a NULL isActive: a stored row that says neither yes nor no', () => {
    expect(as({ ...ana, isActive: null })).toBeNull()
  })

  it('refuses anything else that is not `true`', () => {
    expect(as({ ...ana, isActive: undefined })).toBeNull()
    expect(as({ ...ana, isActive: 'true' })).toBeNull()
  })

  it('passes a shape with no isActive key at all (built in-process), as access control does', () => {
    expect(as(ana)).toMatchObject(ana)
  })

  it('refuses no user and a user without an email', () => {
    expect(as(null)).toBeNull()
    expect(as({ id: 1, email: '', isActive: true })).toBeNull()
  })
})
