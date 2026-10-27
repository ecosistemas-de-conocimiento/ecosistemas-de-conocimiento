import { describe, expect, it } from 'vitest'

import { canAdminOrg, isInvestigador, isStudent, roleIn, type RoleUser } from './roles'

const user = (memberships: RoleUser['memberships'], extra: Partial<RoleUser> = {}): RoleUser => ({
  id: 1,
  memberships,
  ...extra,
})

const M = [
  { organization: '6', role: 'investigador' },
  { organization: 7, role: 'owner' },
  { organization: { id: 8 }, role: 'estudiante' },
  { organization: '9', role: 'admin' },
  { organization: '10', role: 'member' },
]

describe('roles — the session-payload helpers', () => {
  it('reads the role per ecosistema, whatever shape the id comes in', () => {
    const u = user(M)
    expect(roleIn(u, 6)).toBe('investigador')
    expect(roleIn(u, '7')).toBe('owner')
    expect(roleIn(u, 8)).toBe('estudiante')
    expect(roleIn(u, 11)).toBeNull()
  })

  it('isStudent / isInvestigador are true only in the ecosistema that grants them', () => {
    const u = user(M)
    expect(isStudent(u, 8)).toBe(true)
    expect(isStudent(u, 6)).toBe(false)
    expect(isInvestigador(u, 6)).toBe(true)
    expect(isInvestigador(u, 8)).toBe(false)
  })

  it('canAdminOrg: owner and investigador there, never admin/member/estudiante, never elsewhere', () => {
    const u = user(M)
    expect(canAdminOrg(u, 6)).toBe(true)
    expect(canAdminOrg(u, 7)).toBe(true)
    expect(canAdminOrg(u, 8)).toBe(false)
    expect(canAdminOrg(u, 9)).toBe(false)
    expect(canAdminOrg(u, 10)).toBe(false)
    expect(canAdminOrg(u, 11)).toBe(false)
  })

  it('canAdminOrg: a platform admin everywhere, with no membership', () => {
    expect(canAdminOrg(user([], { isPlatformAdmin: true }), 42)).toBe(true)
  })

  it('🔴 a deactivated account holds nothing — not even the platform-admin flag', () => {
    const off = user(M, { isActive: false, isPlatformAdmin: true })
    expect(canAdminOrg(off, 6)).toBe(false)
    expect(isStudent(off, 8)).toBe(false)
  })

  it('fails closed on junk: no user, no list, unknown role, missing org', () => {
    expect(canAdminOrg(null, 6)).toBe(false)
    expect(isStudent(user(undefined), 8)).toBe(false)
    expect(roleIn(user([{ organization: '6', role: 'superuser' }]), 6)).toBeNull()
    expect(roleIn(user(M), null)).toBeNull()
  })
})
