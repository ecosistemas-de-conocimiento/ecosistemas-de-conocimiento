import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/admin', () => ({
  listAllEcosystems: vi.fn(),
  readEcosystem: vi.fn(),
  loadAdminOverview: vi.fn(async () => ({ ok: true })),
}));
vi.mock('$lib/server/ecosystem', () => ({ listEcosystems: vi.fn() }));
vi.mock('$lib/server/budget', () => ({ fetchEcosystemBudget: vi.fn(async () => ({ ok: false })) }));

import { load } from './+page.server';
import { listAllEcosystems, loadAdminOverview, readEcosystem } from '$lib/server/admin';
import { listEcosystems } from '$lib/server/ecosystem';

const eco = (id: string) => ({ id, name: `E${id}`, slug: `e${id}` });
const all = vi.mocked(listAllEcosystems);
const read = vi.mocked(readEcosystem);
const mine = vi.mocked(listEcosystems);
const overview = vi.mocked(loadAdminOverview);

const event = (user: unknown, url = '/admin') =>
  ({ locals: { user, token: 'tok' }, url: new URL(url, 'http://web.test') }) as never;

const withRoles = (...pairs: Array<[string, string]>) => ({
  id: 3,
  email: 'x@example.invalid',
  memberships: pairs.map(([organization, role]) => ({ organization, slug: `e${organization}`, role })),
});

beforeEach(() => {
  vi.clearAllMocks();
  // A scoped caller's organizations read is membership-constrained by the backend.
  all.mockResolvedValue({ rows: [eco('6'), eco('7'), eco('8')], totalDocs: 3, truncated: false, ok: true, search: '' } as never);
  mine.mockResolvedValue({ list: [eco('6'), eco('7'), eco('8')], ok: true } as never);
  read.mockImplementation(async (_t, id) => eco(id) as never);
});

describe('/admin load — scoped admins', () => {
  it('🔴 denies a member, an admin-role person and an estudiante', async () => {
    for (const role of ['member', 'admin', 'estudiante']) {
      await expect(load(event(withRoles(['8', role])))).rejects.toMatchObject({ status: 403 });
    }
  });

  it('opens to an investigador, listing only the ecosistemas they administer', async () => {
    const data = (await load(event(withRoles(['6', 'investigador'], ['7', 'investigador'], ['8', 'estudiante'])))) as {
      directory: { rows: Array<{ id: string }> };
      selected: { id: string };
    };
    expect(data.directory.rows.map((r) => r.id)).toEqual(['6', '7']);
    expect(data.selected.id).toBe('6');
  });

  it('🔴 an out-of-scope ?eco= is not found, and its overview is never read', async () => {
    const data = (await load(event(withRoles(['8', 'investigador']), '/admin?eco=6'))) as {
      selected: { id: string };
      notFound: boolean;
    };
    expect(data.notFound).toBe(true);
    expect(data.selected.id).toBe('8');
    expect(overview.mock.calls.map((c) => (c[1] as { id: string }).id)).toEqual(['8']);
  });

  it('a platform admin keeps the whole directory', async () => {
    const data = (await load(event({ id: 1, isPlatformAdmin: true }, '/admin?eco=7'))) as {
      directory: { rows: unknown[] };
      selected: { id: string };
    };
    expect(data.directory.rows).toHaveLength(3);
    expect(data.selected.id).toBe('7');
  });
});
