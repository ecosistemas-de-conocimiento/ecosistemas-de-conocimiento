import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The picker must only offer ecosistemas the backend would accept on
 * `POST /api/sessions`. The backend's `membershipsForUser` drops switched-off
 * organizations and inactive memberships; this list has to drop them too, or
 * picking one fails 400 `You do not belong to that ecosistema.`
 *
 * `$lib/server/auth` is mocked, which also keeps `$env` out of the test.
 */

const backendFetch = vi.fn();
vi.mock('$lib/server/auth', () => ({ backendFetch: (...args: unknown[]) => backendFetch(...args) }));

const { listEcosystems } = await import('./ecosystem');

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function withMemberships(docs: unknown[]) {
  backendFetch.mockImplementation((_t: unknown, path: string) =>
    Promise.resolve(
      String(path).startsWith('/api/users/me') ? ok({ user: { id: 5 } }) : ok({ docs }),
    ),
  );
}

beforeEach(() => {
  backendFetch.mockReset();
});

describe('listEcosystems — switched-off organizations', () => {
  it('drops an organization with isActive === false', async () => {
    withMemberships([
      { isActive: true, organization: { id: 1, name: 'Activa', isActive: true } },
      { isActive: true, organization: { id: 2, name: 'Apagada', isActive: false } },
    ]);
    const { list, ok: readOk } = await listEcosystems('tok');
    expect(readOk).toBe(true);
    expect(list.map((e) => e.id)).toEqual(['1']);
  });

  // 🔴 The backend's `membershipsForUser` asks for `isActive = true` on BOTH
  // rows, so a NULL or missing flag is INACTIVE there. Offering it here is
  // offering an ecosistema `POST /api/sessions` will refuse.
  it('treats a missing or null organization isActive as inactive, as the backend does', async () => {
    withMemberships([
      { isActive: true, organization: { id: 3, name: 'Sin bandera' } },
      { isActive: true, organization: { id: 7, name: 'Nula', isActive: null } },
      { isActive: true, organization: { id: 8, name: 'Activa', isActive: true } },
    ]);
    const { list } = await listEcosystems('tok');
    expect(list.map((e) => e.id)).toEqual(['8']);
  });

  it('treats a missing or null membership isActive as inactive, as the backend does', async () => {
    withMemberships([
      { organization: { id: 9, name: 'Sin bandera', isActive: true } },
      { isActive: null, organization: { id: 10, name: 'Nula', isActive: true } },
      { isActive: true, organization: { id: 11, name: 'Activa', isActive: true } },
    ]);
    const { list } = await listEcosystems('tok');
    expect(list.map((e) => e.id)).toEqual(['11']);
  });

  it('drops an inactive membership, as the backend does', async () => {
    withMemberships([
      { isActive: false, organization: { id: 4, name: 'Ex miembro', isActive: true } },
      { isActive: true, organization: { id: 6, name: 'Miembro', isActive: true } },
    ]);
    const { list } = await listEcosystems('tok');
    expect(list.map((e) => e.id)).toEqual(['6']);
  });
});
