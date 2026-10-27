import { describe, expect, it } from 'vitest';

import { adminOrgIds, canAdminOrg, isInvestigador, isStudent, roleIn, sessionMemberships } from './roles';

const user = {
  id: 1,
  memberships: [
    { organization: '6', slug: 'a', role: 'investigador' },
    { organization: '7', slug: 'b', role: 'owner' },
    { organization: '8', slug: 'c', role: 'estudiante' },
    { organization: '9', slug: 'd', role: 'admin' },
    { organization: '10', slug: 'e', role: 'bogus' },
  ],
};

describe('roles — session payload helpers (web twin of the backend)', () => {
  it('reads per-ecosistema roles', () => {
    expect(roleIn(user, 6)).toBe('investigador');
    expect(roleIn(user, '8')).toBe('estudiante');
    expect(roleIn(user, 10)).toBeNull();
    expect(isStudent(user, 8)).toBe(true);
    expect(isStudent(user, 6)).toBe(false);
    expect(isInvestigador(user, 6)).toBe(true);
  });

  it('canAdminOrg: owner and investigador there, platform admin anywhere; never admin or estudiante', () => {
    expect([6, 7, 8, 9, 11].map((o) => canAdminOrg(user, o))).toEqual([true, true, false, false, false]);
    expect(canAdminOrg({ isPlatformAdmin: true }, 99)).toBe(true);
    expect(canAdminOrg({ isPlatformAdmin: true, isActive: false }, 99)).toBe(false);
    expect(canAdminOrg(null, 6)).toBe(false);
  });

  it('lists memberships defensively and the ecosistemas this person administers', () => {
    expect(sessionMemberships(user).map((m) => m.role)).toEqual(['investigador', 'owner', 'estudiante', 'admin']);
    expect(adminOrgIds(user)).toEqual(['6', '7']);
    expect(adminOrgIds({ ...user, isActive: false })).toEqual([]);
  });
});
