import { describe, expect, it, vi } from 'vitest';

import { TESTIMONIO_CONSENT_VERSION } from '$lib/consent';

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
  it('passes the testimonio consent through with the wording version THE PAGE showed; the backend decides', async () => {
    const shown = String(TESTIMONIO_CONSENT_VERSION);
    await actions.perfil!(event({ key: 'shareTestimonios', value: 'true', consentVersion: shown }));
    expect(savePerfil).toHaveBeenLastCalledWith('tok', '1', { shareTestimonios: true, consentVersion: TESTIMONIO_CONSENT_VERSION });
    await actions.perfil!(event({ key: 'shareTestimonios', value: 'false', consentVersion: shown }));
    expect(savePerfil).toHaveBeenLastCalledWith('tok', '1', { shareTestimonios: false });
  });

  // 🔴 Audit 2026-10-28: the action used to fill in the SERVER's current
  // version, so a page built before a wording change never got the 409.
  it('🔴 a stale page sends its OWN older version, never the server\'s', async () => {
    savePerfil.mockResolvedValueOnce({ ok: false, status: 409, message: 'cambió' } as never);
    const r = await actions.perfil!(event({ key: 'shareTestimonios', value: 'true', consentVersion: '1' }));
    expect(savePerfil).toHaveBeenLastCalledWith('tok', '1', { shareTestimonios: true, consentVersion: 1 });
    expect(r).toMatchObject({ status: 409, data: { message: expect.stringMatching(/[Rr]ecarga la página/) } });
  });

  it('🔴 a form with no version is sent without one, so the backend refuses it', async () => {
    await actions.perfil!(event({ key: 'shareTestimonios', value: 'true' }));
    expect(savePerfil).toHaveBeenLastCalledWith('tok', '1', { shareTestimonios: true, consentVersion: undefined });
  });

  it('refuses any other key', async () => {
    savePerfil.mockClear();
    expect(await actions.perfil!(event({ key: 'isPlatformAdmin', value: 'true' }))).toMatchObject({ status: 400 });
    expect(savePerfil).not.toHaveBeenCalled();
  });
});
