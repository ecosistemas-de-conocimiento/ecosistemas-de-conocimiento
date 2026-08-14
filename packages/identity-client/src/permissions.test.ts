import { describe, expect, it } from 'vitest';
import {
  can,
  canInProject,
  grantOf,
  hasRoleInProject,
  isPlatformAdmin,
  isTokenClaims,
  projectsOf,
} from './permissions.js';
import type { IdentityTokenClaims, ResolvedPrincipal } from './types.js';

const token: IdentityTokenClaims = {
  iss: 'https://backend.example.org',
  sub: 'ana@example.org',
  aud: 'edc',
  email: 'ana@example.org',
  iat: 1_700_000_000,
  exp: 1_700_000_900,
  roles: ['coordinator'],
  perms: ['story:edit', 'surface:brainstorm'],
};

const principal: ResolvedPrincipal = {
  email: 'ana@example.org',
  name: 'Ana',
  isPlatformAdmin: false,
  projects: {
    'edc': { roles: ['coordinator'], permissions: ['story:edit'] },
    workshops: { roles: ['facilitador'], permissions: ['taller:facilitate'] },
  },
};

const admin: ResolvedPrincipal = {
  email: 'root@example.org',
  name: null,
  isPlatformAdmin: true,
  projects: {},
};

describe('isTokenClaims', () => {
  it('discriminates on `aud`', () => {
    expect(isTokenClaims(token)).toBe(true);
    expect(isTokenClaims(principal)).toBe(false);
  });
});

describe('can', () => {
  it('reads a token against its own audience', () => {
    expect(can(token, 'story:edit')).toBe(true);
    expect(can(token, 'story:delete')).toBe(false);
  });

  it('reads a principal across every project', () => {
    expect(can(principal, 'taller:facilitate')).toBe(true);
    expect(can(principal, 'nope')).toBe(false);
  });

  it('gives a platform admin everything', () => {
    expect(can(admin, 'anything:at:all')).toBe(true);
  });
});

describe('canInProject', () => {
  it('scopes a principal to one project', () => {
    expect(canInProject(principal, 'edc', 'story:edit')).toBe(true);
    // Held in workshops, NOT in edc — the whole point of the check.
    expect(canInProject(principal, 'edc', 'taller:facilitate')).toBe(false);
  });

  it('refuses a token outside its audience', () => {
    expect(canInProject(token, 'edc', 'story:edit')).toBe(true);
    expect(canInProject(token, 'chat', 'story:edit')).toBe(false);
  });

  it('gives a platform admin everything, in every project', () => {
    expect(canInProject(admin, 'chat', 'thread:delete')).toBe(true);
  });

  it('is false for an unknown project', () => {
    expect(canInProject(principal, 'other-project', 'story:edit')).toBe(false);
  });
});

describe('grantOf', () => {
  it('never returns undefined', () => {
    expect(grantOf(principal, 'unknown').permissions).toEqual([]);
    expect(grantOf(token, 'chat').roles).toEqual([]);
  });

  it('projects a token onto its own audience', () => {
    expect(grantOf(token, 'edc')).toEqual({
      roles: ['coordinator'],
      permissions: ['story:edit', 'surface:brainstorm'],
    });
  });
});

describe('misc helpers', () => {
  it('hasRoleInProject', () => {
    expect(hasRoleInProject(principal, 'workshops', 'facilitador')).toBe(true);
    expect(hasRoleInProject(principal, 'edc', 'facilitador')).toBe(false);
  });

  it('projectsOf', () => {
    expect(projectsOf(token)).toEqual(['edc']);
    expect(projectsOf(principal).sort()).toEqual(['edc', 'workshops']);
  });

  it('isPlatformAdmin is never true for a token', () => {
    expect(isPlatformAdmin(admin)).toBe(true);
    expect(isPlatformAdmin(principal)).toBe(false);
    expect(isPlatformAdmin(token)).toBe(false);
  });
});
