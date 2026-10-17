import { describe, expect, it, vi } from 'vitest';
import { checkCatalogueDrift } from './catalogue.js';

const OPTS = { baseUrl: 'https://identity.dev.example.org/api', serviceToken: 's3cret' };

function exportBody(members: unknown[]) {
  return { project: 'edc', exportedAt: '2026-08-19T12:00:00.000Z', members };
}

function member(over: Record<string, unknown> = {}) {
  return {
    email: 'ana@example.org',
    name: 'Ana',
    isPlatformAdmin: false,
    roles: ['coordinator'],
    permissions: ['story:edit'],
    ...over,
  };
}

const admin = (permissions: string[]) =>
  member({ email: 'root@example.org', isPlatformAdmin: true, permissions });

function respond(body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

function check(expected: string[], members: unknown[]) {
  return checkCatalogueDrift(expected, {
    ...OPTS,
    project: 'edc',
    fetch: respond(exportBody(members)),
  });
}

describe('checkCatalogueDrift', () => {
  it('reads EXISTENCE off a platform admin and GRANTS off the real members', async () => {
    const drift = await check(
      ['story:edit', 'dm:use'],
      [member({ permissions: ['story:edit'] }), admin(['story:edit', 'dm:use'])],
    );

    expect(drift.catalogueKnown).toBe(true);
    expect(drift.exists).toEqual(['dm:use', 'story:edit']);
    expect(drift.granted).toEqual(['story:edit']); // admins excluded
    expect(drift.memberCount).toBe(2);
    expect(drift.adminCount).toBe(1);
  });

  it('names the SILENT UNDER-GRANT: a key the product enforces and the IdP never seeded', async () => {
    // R14's live instance: edc enforced `dm:use`, the IdP had never heard of
    // it, so nobody could hold it and the DM surface was dead with no error.
    const drift = await check(['story:edit', 'dm:use'], [admin(['story:edit'])]);

    expect(drift.ok).toBe(false);
    expect(drift.missingFromIdp).toEqual(['dm:use']);
    expect(drift.extraInIdp).toEqual([]);
  });

  it('🔴 a key that EXISTS but sits on NO ROLE is `ungranted`, not `ok`-and-done', async () => {
    // The regression this rework exists for: reading existence off the admin
    // made this pass `ok: true` while every ordinary user was still denied.
    const drift = await check(
      ['story:edit', 'dm:use'],
      [member({ permissions: ['story:edit'] }), admin(['story:edit', 'dm:use'])],
    );

    expect(drift.ok).toBe(true); // it EXISTS, so the seed is not behind…
    expect(drift.ungranted).toEqual(['dm:use']); // …but nobody can ever hold it
  });

  it('names the OVER-grant too — a stale key the IdP still hands out', async () => {
    const drift = await check(['story:edit'], [admin(['story:edit', 'observer:peek'])]);

    expect(drift.ok).toBe(true);
    expect(drift.extraInIdp).toEqual(['observer:peek']);
  });

  it('with NO platform admin there is no catalogue: `exists` falls back to `granted`', async () => {
    // 🔴 The observed set is then only what members happen to hold — a LOWER
    // BOUND. `missingFromIdp` may name a permission the IdP does have, and
    // `ungranted` cannot mean anything. CI must gate on `catalogueKnown`.
    const drift = await check(['story:edit', 'dm:use'], [member({ permissions: ['story:edit'] })]);

    expect(drift.catalogueKnown).toBe(false);
    expect(drift.exists).toEqual(drift.granted);
    expect(drift.missingFromIdp).toEqual(['dm:use']);
    expect(drift.ungranted).toEqual([]);
  });

  it('an empty project reports zero members and everything missing', async () => {
    const drift = await check(['story:edit'], []);

    expect(drift.memberCount).toBe(0);
    expect(drift.adminCount).toBe(0);
    expect(drift.exists).toEqual([]);
    expect(drift.missingFromIdp).toEqual(['story:edit']);
    expect(drift.catalogueKnown).toBe(false);
  });

  it('deduplicates and sorts every side, so the diff is stable', async () => {
    const drift = await check(
      ['b:x', 'a:x', ' a:x ', 'b:x'],
      [member({ permissions: ['a:x', 'b:x', 'a:x'] }), admin(['b:x', 'a:x', 'b:x'])],
    );

    expect(drift.expected).toEqual(['a:x', 'b:x']);
    expect(drift.exists).toEqual(['a:x', 'b:x']);
    expect(drift.granted).toEqual(['a:x', 'b:x']);
    expect(drift.ok).toBe(true);
    expect(drift.ungranted).toEqual([]);
  });

  it('accepts an export the caller already fetched, and makes no call', async () => {
    const fetchImpl = vi.fn();
    const drift = await checkCatalogueDrift(['story:edit'], {
      ...OPTS,
      project: 'edc',
      fetch: fetchImpl as unknown as typeof fetch,
      export: {
        project: 'edc',
        exportedAt: '2026-08-19T12:00:00.000Z',
        members: [
          { email: 'a@b.io', name: null, isPlatformAdmin: true, roles: [], permissions: ['story:edit'] },
        ],
      },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(drift.ok).toBe(true);
  });

  it('a 404 THROWS — an unknown slug is a broken config, not an empty catalogue', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: 'Unknown project.' }] }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await expect(
      checkCatalogueDrift(['story:edit'], { ...OPTS, project: 'nope', fetch: fetchImpl }),
    ).rejects.toThrow();
  });
});

describe('checkCatalogueDrift — the platform-admin split is strict', () => {
  // Reached through `options.export`, the pre-fetched-export path. `resolveExport`
  // narrows `isPlatformAdmin` to `=== true` on the way in, so a body off the wire
  // is already clean — but an export the caller assembled itself (its own DB, an
  // older client, a fixture) is passed straight to the split, unchecked.
  const preFetched = (members: unknown[]) =>
    checkCatalogueDrift(['story:edit', 'dm:use'], {
      ...OPTS,
      project: 'edc',
      fetch: vi.fn() as unknown as typeof fetch,
      export: exportBody(members) as never,
    });

  it("🔴 `isPlatformAdmin: 'yes'` is NOT a platform admin", async () => {
    // A truthy split promoted a malformed member to platform admin, so that
    // member's ROLE GRANT was read as the project's whole CATALOGUE — which
    // silences `missingFromIdp` and invents `catalogueKnown: true`.
    const drift = await preFetched([member({ isPlatformAdmin: 'yes', permissions: ['story:edit'] })]);

    expect(drift.adminCount).toBe(0);
    expect(drift.catalogueKnown).toBe(false);
    expect(drift.granted).toEqual(['story:edit']);
    expect(drift.missingFromIdp).toEqual(['dm:use']);
  });

  it('only a real `true` counts; `1` and `null` do not', async () => {
    const drift = await preFetched([
      member({ email: 'a@b.io', isPlatformAdmin: true, permissions: ['story:edit', 'dm:use'] }),
      member({ email: 'b@b.io', isPlatformAdmin: 1, permissions: ['story:edit'] }),
      member({ email: 'c@b.io', isPlatformAdmin: null, permissions: ['story:edit'] }),
    ]);

    expect(drift.adminCount).toBe(1);
    expect(drift.memberCount).toBe(3);
    expect(drift.catalogueKnown).toBe(true);
    expect(drift.granted).toEqual(['story:edit']);
    expect(drift.ungranted).toEqual(['dm:use']);
  });
});
