import { describe, expect, it, vi } from 'vitest';

const fetchCompanero = vi.fn();
vi.mock('$lib/server/estudiante', () => ({ fetchCompanero }));
vi.mock('$lib/server/ecosystem', () => ({ resolveEcosystem: async () => ({ selected: { id: '8', name: 'Eco' } }) }));

const { load } = await import('./+page.server');

const event = (id: string, user: unknown = { id: 1 }) => ({ locals: { user, token: 'tok' }, cookies: {}, params: { id } }) as never;

describe('/estudiante/companero/[id] load', () => {
  it('asks the backend for the slug in the SELECTED ecosistema; the browser names no ecosistema', async () => {
    const companero = { id: 'abc', name: 'Beto', temas: [], trabajos: [] };
    fetchCompanero.mockResolvedValueOnce({ ok: true, value: { companero } });
    expect(await load(event('abc'))).toEqual({ organization: '8', ecosystemName: 'Eco', companero });
    expect(fetchCompanero).toHaveBeenLastCalledWith('tok', '8', 'abc');
  });

  it.each([403, 404, 400])('🔴 backend %i (not opted in, withdrawn, other ecosistema…) → 404 page', async (status) => {
    fetchCompanero.mockResolvedValueOnce({ ok: false, status, message: 'No disponible.' });
    await expect(load(event('abc'))).rejects.toMatchObject({ status: 404 });
  });

  it('signed out → 404 without asking', async () => {
    fetchCompanero.mockClear();
    await expect(load(event('abc', null))).rejects.toMatchObject({ status: 404 });
    expect(fetchCompanero).not.toHaveBeenCalled();
  });
});
