import { describe, expect, it } from 'vitest';

import { assignableRoles, outranks, parseMembers, roleLabel } from './miembros';

describe('roles on the Miembros screen', () => {
  it('names the roles in the owner’s words', () => {
    expect(roleLabel('estudiante')).toBe('estudiante');
    expect(roleLabel('member')).toBe('participante');
    expect(roleLabel('investigador')).toBe('investigador');
    expect(roleLabel('owner')).toBe('responsable');
  });

  it('offers each manager the roles up to their own (estudiante < member < admin < investigador < owner)', () => {
    expect(assignableRoles('owner').map((r) => r.value)).toEqual(['estudiante', 'member', 'investigador', 'owner']);
    expect(assignableRoles('investigador').map((r) => r.value)).toEqual(['estudiante', 'member', 'investigador']);
    expect(assignableRoles('admin').map((r) => r.value)).toEqual(['estudiante', 'member']);
    expect(assignableRoles('member')).toEqual([]);
    expect(assignableRoles('estudiante')).toEqual([]);
    expect(assignableRoles('garbage')).toEqual([]);
  });

  it('an investigador outranks an admin, never an owner', () => {
    expect(outranks('investigador', 'admin')).toBe(true);
    expect(outranks('owner', 'investigador')).toBe(true);
    expect(outranks('member', 'estudiante')).toBe(true);
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
