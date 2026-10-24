import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/ecosystem', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/ecosystem')>(
    '$lib/server/ecosystem',
  );
  return { ...actual, listEcosystems: vi.fn() };
});
vi.mock('$lib/server/admin', () => ({ readEcosystem: vi.fn(), listAllEcosystems: vi.fn() }));
vi.mock('$lib/server/holds', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/holds')>('$lib/server/holds');
  return { ...actual, readReviewCapability: vi.fn() };
});
vi.mock('$lib/server/miembros', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/miembros')>('$lib/server/miembros');
  return {
    ...actual,
    listMembers: vi.fn(),
    addMember: vi.fn(),
    changeRole: vi.fn(),
    removeMember: vi.fn(),
  };
});

import { actions, load } from './+page.server';
import { listEcosystems } from '$lib/server/ecosystem';
import { listAllEcosystems, readEcosystem } from '$lib/server/admin';
import { readReviewCapability } from '$lib/server/holds';
import { addMember, changeRole, listMembers, removeMember, MEMBERS_MANAGE } from '$lib/server/miembros';

const m = (f: unknown) => f as ReturnType<typeof vi.fn>;

const A = { id: '1', name: 'Alfa', slug: 'alfa' };
const B = { id: '2', name: 'Beta', slug: 'beta' };

function loadEvent(url = 'http://web.test/miembros', user: unknown = { id: 9 }) {
  return {
    locals: { user, token: 'tok' },
    url: new URL(url),
    cookies: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
    depends: vi.fn(),
  } as unknown as Parameters<typeof load>[0];
}

function actionEvent(fields: Record<string, string>, user: unknown = { id: 9 }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return {
    locals: { user, token: 'tok' },
    request: { formData: async () => form },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  m(readReviewCapability).mockResolvedValue({ isPlatformAdmin: false, slugs: ['alfa'], ok: true });
  m(listEcosystems).mockResolvedValue({ list: [A, B], ok: true });
  m(readEcosystem).mockResolvedValue(null);
  m(listAllEcosystems).mockResolvedValue({ rows: [B], totalDocs: 1, truncated: false, ok: true, search: '' });
  m(listMembers).mockResolvedValue({
    state: 'ready',
    myRole: 'owner',
    members: [{ id: '5', email: 'ana@x.mx', name: 'Ana', role: 'member' }],
  });
});

describe('/miembros load', () => {
  it('asks for members:manage, and refuses a caller without it anywhere', async () => {
    m(readReviewCapability).mockResolvedValue({ isPlatformAdmin: false, slugs: [], ok: true });
    await expect(load(loadEvent())).rejects.toMatchObject({ status: 403 });
    expect(m(readReviewCapability).mock.calls[0]![1]).toBe(MEMBERS_MANAGE);
    expect(listMembers).not.toHaveBeenCalled();
  });

  it('lists the members of the ecosistema the caller manages', async () => {
    const data = (await load(loadEvent())) as { selected: { id: string }; members: unknown[]; myRole: string };
    expect(data.selected.id).toBe(A.id);
    expect(data.myRole).toBe('owner');
    expect(data.members).toHaveLength(1);
    expect(m(listMembers).mock.calls[0]![1]).toBe(A.id);
  });

  it('🔴 ?eco= naming an ecosistema the caller does not manage falls back, never opens it', async () => {
    m(readEcosystem).mockResolvedValue(B);
    const data = (await load(loadEvent('http://web.test/miembros?eco=2'))) as {
      selected: { id: string };
      notFound: boolean;
    };
    expect(data.selected.id).toBe(A.id);
    expect(data.notFound).toBe(true);
    expect(m(listMembers).mock.calls.map((c) => c[1])).toEqual([A.id]);
  });

  it('a platform admin may open any ecosistema', async () => {
    m(readReviewCapability).mockResolvedValue({ isPlatformAdmin: true, slugs: [], ok: true });
    m(readEcosystem).mockResolvedValue(B);
    const data = (await load(loadEvent('http://web.test/miembros?eco=2'))) as { selected: { id: string } };
    expect(data.selected.id).toBe(B.id);
  });

  it('a backend 403 is a refusal, not an empty list', async () => {
    m(listMembers).mockResolvedValue({ state: 'forbidden' });
    await expect(load(loadEvent())).rejects.toMatchObject({ status: 403 });
  });
});

describe('/miembros actions', () => {
  it('add forwards the form and hands back the one-time password', async () => {
    m(addMember).mockResolvedValue({ ok: true, value: { email: 'n@x.mx', temporaryPassword: 'pw-123' } });
    const out = await actions.add!(
      actionEvent({ organization: '1', email: 'n@x.mx', name: 'N', role: 'investigador' }),
    );
    expect(m(addMember).mock.calls[0]).toEqual([
      'tok',
      { organization: '1', email: 'n@x.mx', name: 'N', role: 'investigador' },
    ]);
    expect(out).toEqual({ added: { email: 'n@x.mx', temporaryPassword: 'pw-123' } });
  });

  it('add passes the backend’s refusal through with its status', async () => {
    m(addMember).mockResolvedValue({ ok: false, status: 409, message: 'Ya es miembro de este ecosistema.' });
    const out = await actions.add!(actionEvent({ organization: '1', email: 'a@x.mx', name: 'A', role: 'member' }));
    expect(out).toMatchObject({ status: 409, data: { message: 'Ya es miembro de este ecosistema.' } });
  });

  it('role and remove forward the membership id', async () => {
    m(changeRole).mockResolvedValue({ ok: true, value: null });
    m(removeMember).mockResolvedValue({ ok: true, value: null });
    await actions.role!(actionEvent({ id: '5', role: 'owner' }));
    await actions.remove!(actionEvent({ id: '5' }));
    expect(m(changeRole).mock.calls[0]).toEqual(['tok', '5', 'owner']);
    expect(m(removeMember).mock.calls[0]).toEqual(['tok', '5']);
  });

  it('refuses an anonymous caller without calling the backend', async () => {
    const out = await actions.add!(actionEvent({ organization: '1', email: 'a@x.mx', name: 'A', role: 'member' }, null));
    expect(out).toMatchObject({ status: 401 });
    expect(addMember).not.toHaveBeenCalled();
  });
});
