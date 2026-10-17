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
    workshops: { roles: ['facilitator'], permissions: ['workshop:facilitate'] },
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
    expect(can(principal, 'workshop:facilitate')).toBe(true);
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
    expect(canInProject(principal, 'edc', 'workshop:facilitate')).toBe(false);
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
    expect(hasRoleInProject(principal, 'workshops', 'facilitator')).toBe(true);
    expect(hasRoleInProject(principal, 'edc', 'facilitator')).toBe(false);
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

/**
 * MEASURED DEFECT: a real token carrying
 * `aud` but NO `perms` claim made `canInProject` THROW
 * (`Cannot read properties of undefined (reading 'includes')`), because the
 * `isTokenClaims` guard only checked `typeof aud === 'string'` and every call
 * site then read `.perms`/`.roles` unguarded.
 *
 * Without a try/catch at the call site it surfaced as a 500, not a 403.
 *
 * These helpers are documented "no I/O, no state, NO THROWING". A missing or
 * malformed claim means the holder was granted NOTHING, so the honest answer is
 * `false` / `[]` — never an exception, and never `true`.
 */
describe('malformed claims deny rather than throw', () => {
  const tokenNoPerms = {
    iss: 'https://identity.dev.example.org',
    sub: 'ana@example.org',
    aud: 'edc',
    email: 'ana@example.org',
    iat: 1_700_000_000,
    exp: 1_700_000_900,
  } as unknown as IdentityTokenClaims;

  const tokenBadPerms = {
    ...tokenNoPerms,
    roles: 'coordinator',
    perms: 'not-an-array',
  } as unknown as IdentityTokenClaims;

  it('canInProject: a token with `aud` and no `perms` is false, not a throw', () => {
    expect(() => canInProject(tokenNoPerms, 'edc', 'story:edit')).not.toThrow();
    expect(canInProject(tokenNoPerms, 'edc', 'story:edit')).toBe(false);
    expect(canInProject(tokenNoPerms, 'chat', 'story:edit')).toBe(false);
  });

  it('canInProject: a token whose `perms` is not an array is false, not a throw', () => {
    expect(() => canInProject(tokenBadPerms, 'edc', 'story:edit')).not.toThrow();
    expect(canInProject(tokenBadPerms, 'edc', 'story:edit')).toBe(false);
    // A string `perms` must NOT be treated as a haystack of characters either.
    expect(canInProject(tokenBadPerms, 'edc', 'not')).toBe(false);
  });

  it('can: denies on a token with missing or malformed `perms`', () => {
    expect(can(tokenNoPerms, 'story:edit')).toBe(false);
    expect(can(tokenBadPerms, 'story:edit')).toBe(false);
  });

  it('grantOf: normalises a malformed token to the empty grant', () => {
    expect(grantOf(tokenNoPerms, 'edc')).toEqual({ roles: [], permissions: [] });
    expect(grantOf(tokenBadPerms, 'edc')).toEqual({ roles: [], permissions: [] });
  });

  it('hasRoleInProject / projectsOf survive a malformed token', () => {
    expect(hasRoleInProject(tokenNoPerms, 'edc', 'coordinator')).toBe(false);
    expect(hasRoleInProject(tokenBadPerms, 'edc', 'coordinator')).toBe(false);
    expect(projectsOf(tokenNoPerms)).toEqual(['edc']);
  });

  // Same shape assumption on the OTHER arm of the union: `ResolvedPrincipal`.
  const principalNoProjects = {
    email: 'ana@example.org',
    name: null,
    isPlatformAdmin: false,
  } as unknown as ResolvedPrincipal;

  const principalBadGrant = {
    email: 'ana@example.org',
    name: null,
    isPlatformAdmin: false,
    projects: { 'edc': { roles: null, permissions: 'story:edit' } },
  } as unknown as ResolvedPrincipal;

  it('a principal with no `projects` denies rather than throws', () => {
    expect(() => can(principalNoProjects, 'story:edit')).not.toThrow();
    expect(can(principalNoProjects, 'story:edit')).toBe(false);
    expect(canInProject(principalNoProjects, 'edc', 'story:edit')).toBe(false);
    expect(projectsOf(principalNoProjects)).toEqual([]);
    expect(grantOf(principalNoProjects, 'edc')).toEqual({ roles: [], permissions: [] });
  });

  it('a principal whose grant arrays are malformed denies rather than throws', () => {
    expect(() => can(principalBadGrant, 'story:edit')).not.toThrow();
    expect(can(principalBadGrant, 'story:edit')).toBe(false);
    expect(canInProject(principalBadGrant, 'edc', 'story:edit')).toBe(false);
    expect(hasRoleInProject(principalBadGrant, 'edc', 'coordinator')).toBe(false);
  });

  it('isPlatformAdmin stays a strict boolean check', () => {
    expect(isPlatformAdmin(principalNoProjects)).toBe(false);
    expect(isPlatformAdmin(tokenNoPerms)).toBe(false);
  });
});
