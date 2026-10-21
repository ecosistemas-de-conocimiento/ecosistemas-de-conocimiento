// "project" → "audience" rename, step 1 (D1a, 2026-10-21): the package accepts
// BOTH names so apps can switch one at a time. These tests pin the contract of
// that transition: the new names exist, the old names still work, and a
// configuration that says two different things fails at construction.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from './index.js';
import {
  canInAudience,
  canInProject,
  createIdentitySession,
  IdentityConfigError,
  resetIdentitySessionState,
  type IdentitySessionStore,
} from './index.js';

const BASE = 'https://identity.dev.example.org/api';
const TICKET = 'rt_live_00000000000000000000000000000000';

function store(): IdentitySessionStore {
  return { saveTicket: () => {}, saveToken: () => {}, clear: () => {} } as unknown as IdentitySessionStore;
}

function rotatedFetch() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { audience: string };
    return new Response(
      JSON.stringify({
        refreshToken: 'rt_live_11111111111111111111111111111111',
        expiresAt: '2026-11-04T00:00:00.000Z',
        token: `tok_${body.audience}`,
        audience: body.audience,
        expiresIn: 900,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
}

async function audienceSent(options: { audience: string; project?: string } | { project: string; audience?: string }): Promise<string> {
  const fetchImpl = rotatedFetch();
  const session = createIdentitySession({
    baseUrl: BASE,
    store: store(),
    fetch: fetchImpl as unknown as typeof fetch,
    ...options,
  });
  await session.renew(TICKET);
  const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  return (JSON.parse(String(init.body)) as { audience: string }).audience;
}

beforeEach(() => {
  resetIdentitySessionState();
});

describe('canInAudience', () => {
  it('is the SAME function object as canInProject, not a wrapper', () => {
    expect(canInAudience).toBe(canInProject);
    expect(client.canInAudience).toBe(client.canInProject);
  });

  it('does not alias hasRoleInProject or projectsOf (no fleet consumer)', () => {
    expect(client).not.toHaveProperty('hasRoleInAudience');
    expect(client).not.toHaveProperty('audiencesOf');
  });
});

describe('IdentitySessionOptions.audience', () => {
  it('scopes tokens to `audience` when only `audience` is set', async () => {
    expect(await audienceSent({ audience: 'Frontend-Code' })).toBe('frontend-code');
  });

  it('still accepts the deprecated `project` alone', async () => {
    expect(await audienceSent({ project: 'chat' })).toBe('chat');
  });

  it('accepts both when they name the same audience', async () => {
    expect(await audienceSent({ audience: 'frontend-code', project: 'frontend-code' })).toBe('frontend-code');
  });

  it('accepts both when they differ only by case and whitespace (same normalised slug)', async () => {
    expect(await audienceSent({ audience: ' Frontend-Code', project: 'frontend-code' })).toBe('frontend-code');
  });

  it('throws IdentityConfigError when both are set and differ', () => {
    expect(() =>
      createIdentitySession({ baseUrl: BASE, store: store(), audience: 'frontend-code', project: 'chat' }),
    ).toThrow(IdentityConfigError);
    expect(() =>
      createIdentitySession({ baseUrl: BASE, store: store(), audience: 'frontend-code', project: 'chat' }),
    ).toThrow(/`audience`.*`project`/);
  });

  it('throws IdentityConfigError when neither is set (and it does not compile)', () => {
    // @ts-expect-error — `audience` (or deprecated `project`) is required by the type.
    expect(() => createIdentitySession({ baseUrl: BASE, store: store() })).toThrow(IdentityConfigError);
    // @ts-expect-error — same rule, checked against the message.
    expect(() => createIdentitySession({ baseUrl: BASE, store: store() })).toThrow(
      /`audience` \(or deprecated `project`\) is required/,
    );
  });

  it('throws when both are whitespace only', () => {
    expect(() =>
      createIdentitySession({ baseUrl: BASE, store: store(), audience: '  ', project: ' \t' }),
    ).toThrow(/`audience` \(or deprecated `project`\) is required/);
  });

  it('uses a real `audience` when `project` is blank', async () => {
    expect(await audienceSent({ audience: 'frontend-code', project: '  ' })).toBe('frontend-code');
  });

  it('treats a blank `audience` as unset and falls back to `project`', async () => {
    // A BFF passes `env.IDENTITY_AUDIENCE ?? ''` during the switch; an empty
    // new variable must not override the old one that is still set.
    expect(await audienceSent({ audience: '  ', project: 'chat' })).toBe('chat');
  });
});
