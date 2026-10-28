import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

import { CONSENT_ACTIVITY, CONSENT_ACTIVITY_WITH_TESTIMONIOS } from '$lib/consent';

/**
 * 🔴 The "share my activity" consent says what the teacher will see. Switch
 * off (default): the wording as before. Switch on (`studentTestimonios`): it
 * says testimonios are visible to teachers and investigadores, anonymised.
 */

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

const { default: Estudiante } = await import('./+page.svelte');

const page = (testimoniosEnReporte: boolean | undefined) =>
  render(Estudiante, {
    props: {
      form: null,
      data: {
        organization: '1',
        overview: {
          perfil: { shareWithPeers: false, shareActivity: false },
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

describe('/estudiante — activity consent wording', () => {
  it('switch off: the ecosistema team, nothing about testimonios', () => {
    expect(CONSENT_ACTIVITY).toBe('Compartir mi actividad con el equipo del ecosistema');
    for (const flag of [false, undefined]) {
      const body = page(flag);
      expect(body).toContain(CONSENT_ACTIVITY);
      expect(body).not.toContain('testimonios');
    }
  });

  it('switch on: says testimonios are visible to teachers or investigadores, anonymised', () => {
    const body = page(true);
    expect(body).toContain(CONSENT_ACTIVITY_WITH_TESTIMONIOS);
    expect(CONSENT_ACTIVITY_WITH_TESTIMONIOS).toMatch(/testimonios/);
    expect(CONSENT_ACTIVITY_WITH_TESTIMONIOS).toMatch(/anonimizad/);
    expect(CONSENT_ACTIVITY_WITH_TESTIMONIOS).toMatch(/docentes|investigador/);
  });
});
