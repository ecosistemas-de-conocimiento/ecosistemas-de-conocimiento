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
      { organization: { id: 1, name: 'Activa', isActive: true } },
      { organization: { id: 2, name: 'Apagada', isActive: false } },
    ]);
    const { list, ok: readOk } = await listEcosystems('tok');
    expect(readOk).toBe(true);
    expect(list.map((e) => e.id)).toEqual(['1']);
  });

  it('treats a missing isActive as active', async () => {
    withMemberships([{ organization: { id: 3, name: 'Sin bandera' } }]);
    const { list } = await listEcosystems('tok');
    expect(list.map((e) => e.id)).toEqual(['3']);
  });

  it('drops an inactive membership, as the backend does', async () => {
    withMemberships([
      { isActive: false, organization: { id: 4, name: 'Ex miembro', isActive: true } },
      { organization: { id: 6, name: 'Miembro' } },
    ]);
    const { list } = await listEcosystems('tok');
    expect(list.map((e) => e.id)).toEqual(['6']);
  });
});
