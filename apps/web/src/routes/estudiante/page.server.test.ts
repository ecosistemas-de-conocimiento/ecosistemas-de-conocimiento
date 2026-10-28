import { describe, expect, it, vi } from 'vitest';

const savePerfil = vi.fn(async () => ({ ok: true, value: {} }));
vi.mock('$lib/server/estudiante', () => ({ fetchOverview: vi.fn(), postSuggestion: vi.fn(), savePerfil }));
vi.mock('$lib/server/ecosystem', () => ({ resolveEcosystem: async () => ({ selected: { id: '1' } }) }));
vi.mock('$lib/server/preguntas', () => ({ allowQuestions: () => true, generateQuestions: vi.fn() }));

const { actions } = await import('./+page.server');

const event = (form: Record<string, string>) =>
  ({
    locals: { user: { id: 4 }, token: 'tok' },
    cookies: {},
    request: {
      formData: async () => {
        const f = new FormData();
        for (const [k, v] of Object.entries(form)) f.set(k, v);
        return f;
      },
    },
  }) as never;

describe('/estudiante perfil action', () => {
  it('passes the testimonio consent through; the backend decides whether it may be given', async () => {
    await actions.perfil!(event({ key: 'shareTestimonios', value: 'true' }));
    expect(savePerfil).toHaveBeenLastCalledWith('tok', '1', { shareTestimonios: true });
    await actions.perfil!(event({ key: 'shareTestimonios', value: 'false' }));
    expect(savePerfil).toHaveBeenLastCalledWith('tok', '1', { shareTestimonios: false });
  });

  it('refuses any other key', async () => {
    savePerfil.mockClear();
    expect(await actions.perfil!(event({ key: 'isPlatformAdmin', value: 'true' }))).toMatchObject({ status: 400 });
    expect(savePerfil).not.toHaveBeenCalled();
  });
});
