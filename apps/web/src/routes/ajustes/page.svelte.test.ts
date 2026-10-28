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
        answerStylesEditable: lockedFeatures.length === 0,
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

describe('/ajustes — the answer style (owner ruling 2026-10-28)', () => {
  const styled = (answerStylesEditable: boolean) =>
    render(Ajustes, {
      props: {
        form: null,
        data: {
          state: 'ready',
          ecosistemas: [],
          selected: {
            id: '7',
            name: 'Discapacidad',
            slug: 'discapacidad',
            features: { ...FEATURE_DEFAULTS },
            answerStyles: { generales: 'Tono "cálido" & <claro>.', resonancias: null, interviewer: null },
          },
          plataforma: null,
          lockedFeatures: answerStylesEditable ? [] : ['keepPublicFigures', 'studentTestimonios'],
          answerStylesEditable,
        },
      } as never,
    }).body;
  const textarea = (body: string, kind: string) =>
    body.match(new RegExp(`<textarea[^>]*name="style-${kind}"[^>]*>[\\s\\S]*?</textarea>`))?.[0] ?? '';
  const estilo = (body: string) => body.slice(body.indexOf('data-testid="ajustes-estilo"'));

  it('three textareas — Generales, Resonancias, Entrevista — with the stored text, escaped', () => {
    const body = styled(true);
    for (const kind of ['generales', 'resonancias', 'interviewer']) expect(textarea(body, kind)).not.toBe('');
    for (const label of ['Generales', 'Resonancias', 'Entrevista']) expect(estilo(body)).toContain(label);
    expect(textarea(body, 'generales')).toContain('Tono "cálido" &amp; &lt;claro>.');
    expect(textarea(body, 'generales')).toMatch(/maxlength="1500"/);
  });

  it('editable for the platform admin, with a save button', () => {
    const body = styled(true);
    expect(textarea(body, 'generales')).not.toMatch(/readonly/);
    expect(estilo(body)).toMatch(/<button[^>]*type="submit"/);
  });

  it('🔴 read-only for a responsable or investigador: no save button, the reason shown', () => {
    const body = styled(false);
    for (const kind of ['generales', 'resonancias', 'interviewer']) expect(textarea(body, kind)).toMatch(/readonly/);
    const section = estilo(body);
    expect(section.slice(0, section.indexOf('</form>'))).not.toMatch(/<button/);
    expect(section).toContain('Solo administración de la plataforma puede cambiarlo');
  });
});
