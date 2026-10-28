import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

import { CONSENT_ACTIVITY, CONSENT_ACTIVITY_WITH_TESTIMONIOS, TESTIMONIO_CONSENT_VERSION } from '$lib/consent';

/**
 * 🔴 The "share my activity" consent says what the teacher will see. Switch
 * off (default): the wording as before. Switch on (`studentTestimonios`): it
 * says testimonios are visible to teachers and investigadores, anonymised.
 */

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

const { default: Estudiante } = await import('./+page.svelte');

const page = (testimoniosEnReporte: boolean | undefined, shareTestimonios = false) =>
  render(Estudiante, {
    props: {
      form: null,
      data: {
        organization: '1',
        overview: {
          perfil: { shareWithPeers: false, shareActivity: false, shareTestimonios },
          temas: [],
          documentos: [],
          companeros: [],
          autores: [],
          autoresParaLeer: [],
          temasDelEcosistema: [],
          ...(testimoniosEnReporte === undefined ? {} : { testimoniosEnReporte }),
        },
      },
    } as never,
  }).body;

const box = (body: string, testid: string) => body.match(new RegExp(`<input[^>]*data-testid="${testid}"[^>]*>`))?.[0] ?? '';

describe('/estudiante — activity consent wording', () => {
  it('switch off: the ecosistema team, and no testimonio consent line at all', () => {
    expect(CONSENT_ACTIVITY).toBe('Compartir mi actividad con el equipo del ecosistema');
    for (const flag of [false, undefined]) {
      const body = page(flag);
      expect(body).toContain(CONSENT_ACTIVITY);
      expect(body).not.toContain('testimonios');
      expect(box(body, 'share-testimonios')).toBe('');
    }
  });

  it('🔴 switch on: a separate testimonio consent line naming every reader, version 2 (owner 2026-10-28)', () => {
    expect(CONSENT_ACTIVITY_WITH_TESTIMONIOS).toBe(
      'Compartir mi actividad con el equipo del ecosistema. El equipo del ecosistema (docentes, investigadores y responsables) y la administración de la plataforma también verán mis testimonios publicados, solo en versión anonimizada.',
    );
    // Changing the wording without bumping the version fails here and in the backend's testimonioConsent.test.ts.
    expect(TESTIMONIO_CONSENT_VERSION).toBe(2);
    const body = page(true);
    expect(body).toContain(CONSENT_ACTIVITY);
    expect(body).toContain(CONSENT_ACTIVITY_WITH_TESTIMONIOS);
    expect(box(body, 'share-testimonios')).not.toMatch(/checked/);
    expect(box(page(true, true), 'share-testimonios')).toMatch(/checked/);
  });
});
