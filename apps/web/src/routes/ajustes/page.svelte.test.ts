import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

import { FEATURE_DEFAULTS } from '$lib/features';

/**
 * 🔴 `keepPublicFigures` is the platform admin's (owner ruling Q16 A). The
 * backend refuses anyone else; the page shows them the switch read-only, with
 * the reason, and leaves every other switch live.
 */

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

const { default: Ajustes } = await import('./+page.svelte');

const page = (lockedFeatures: string[]) =>
  render(Ajustes, {
    props: {
      form: null,
      data: {
        state: 'ready',
        ecosistemas: [{ id: '1', name: 'Eco A', slug: 'a', features: { ...FEATURE_DEFAULTS, keepPublicFigures: true } }],
        selected: { id: '1', name: 'Eco A', slug: 'a', features: { ...FEATURE_DEFAULTS, keepPublicFigures: true } },
        plataforma: null,
        lockedFeatures,
      },
    } as never,
  }).body;

const checkbox = (body: string, name: string) => body.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';

describe('/ajustes — the keepPublicFigures switch', () => {
  it('is read-only for a responsable or investigador, with the reason, and shows its value', () => {
    const body = page(['keepPublicFigures']);
    const box = checkbox(body, 'keepPublicFigures');
    expect(box).toMatch(/type="checkbox"/);
    expect(box).toMatch(/disabled/);
    expect(box).toMatch(/checked/);
    expect(body).toContain('Solo administración de la plataforma puede cambiarlo');
    expect(body).toMatch(/<input[^>]*type="hidden"[^>]*name="locked"[^>]*value="keepPublicFigures"|<input[^>]*name="locked"[^>]*type="hidden"[^>]*value="keepPublicFigures"/);
    // Every other switch stays live.
    expect(checkbox(body, 'graph')).not.toMatch(/disabled/);
  });

  it('is live for a platform admin, without the note', () => {
    const body = page([]);
    expect(checkbox(body, 'keepPublicFigures')).not.toMatch(/disabled/);
    expect(body).not.toContain('Solo administración de la plataforma puede cambiarlo');
    expect(body).not.toMatch(/name="locked"/);
  });
});

describe('/ajustes — the studentTestimonios switch', () => {
  it('is shown, off by default, and read-only for a responsable or investigador', () => {
    const body = render(Ajustes, {
      props: {
        form: null,
        data: {
          state: 'ready',
          ecosistemas: [{ id: '1', name: 'Eco A', slug: 'a', features: { ...FEATURE_DEFAULTS } }],
          selected: { id: '1', name: 'Eco A', slug: 'a', features: { ...FEATURE_DEFAULTS } },
          plataforma: null,
          lockedFeatures: ['keepPublicFigures', 'studentTestimonios'],
        },
      } as never,
    }).body;
    const box = checkbox(body, 'studentTestimonios');
    expect(box).toMatch(/disabled/);
    expect(box).not.toMatch(/checked/);
    expect(body).toContain('Testimonios de estudiantes en el reporte (anonimizados)');
  });
});
