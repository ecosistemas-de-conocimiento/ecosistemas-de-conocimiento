import { describe, expect, it } from 'vitest';

import { assignableRoles, parseMembers, roleLabel } from './miembros';

describe('roles on the Miembros screen', () => {
  it('names the three roles in the owner’s words', () => {
    expect(roleLabel('member')).toBe('participante');
    expect(roleLabel('investigador')).toBe('investigador');
    expect(roleLabel('owner')).toBe('responsable');
  });

  it('offers a responsable all three, and an admin nothing above their own', () => {
    expect(assignableRoles('owner').map((r) => r.value)).toEqual(['member', 'investigador', 'owner']);
    expect(assignableRoles('admin').map((r) => r.value)).toEqual(['member', 'investigador']);
    expect(assignableRoles('member')).toEqual([]);
    expect(assignableRoles('garbage')).toEqual([]);
  });

  it('parses the backend list defensively', () => {
    expect(
      parseMembers([
        { id: 1, email: 'a@x.mx', name: 'Ana', role: 'owner' },
        { id: '2', email: 'b@x.mx', name: null, role: 'member' },
        { id: 3, role: 'member' },
        null,
      ]),
    ).toEqual([
      { id: '1', email: 'a@x.mx', name: 'Ana', role: 'owner' },
      { id: '2', email: 'b@x.mx', name: null, role: 'member' },
    ]);
    expect(parseMembers('nope')).toEqual([]);
  });
});
