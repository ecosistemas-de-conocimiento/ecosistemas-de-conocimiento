import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

import { FEATURE_DEFAULTS, FEATURE_KEYS } from '$lib/features';

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
    expect(box).toMatch(/aria-describedby="switch-keepPublicFigures-lock"/);
    expect(body).toMatch(/id="switch-keepPublicFigures-lock"[^>]*>[\s\S]*?Solo administración de la plataforma/);
    expect(body).toMatch(/<input[^>]*type="hidden"[^>]*name="locked"[^>]*value="keepPublicFigures"|<input[^>]*name="locked"[^>]*type="hidden"[^>]*value="keepPublicFigures"/);
    // Every other switch stays live.
    expect(checkbox(body, 'graph')).not.toMatch(/disabled/);
  });

  it('is live for a platform admin, without the note', () => {
    const body = page([]);
    expect(checkbox(body, 'keepPublicFigures')).not.toMatch(/disabled/);
    expect(body).not.toContain('Solo administración de la plataforma');
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
    expect(section).toContain('Solo administración de la plataforma');
  });
});

describe('/ajustes — tabs and switches (redesign 2026-10-28)', () => {
  const render0 = (over: Record<string, unknown> = {}, form: unknown = null) =>
    render(Ajustes, {
      props: {
        form,
        data: {
          state: 'ready',
          ecosistemas: [],
          selected: {
            id: '1',
            name: 'Eco A',
            slug: 'a',
            features: { ...FEATURE_DEFAULTS, graph: false },
            answerStyles: { generales: null, resonancias: null, interviewer: null },
          },
          plataforma: null,
          lockedFeatures: ['keepPublicFigures', 'studentTestimonios'],
          answerStylesEditable: false,
          ...over,
        },
      } as never,
    }).body;
  const funciones = (body: string) => {
    const at = body.indexOf('data-testid="ajustes-funciones"');
    return body.slice(at, body.indexOf('</form>', at));
  };

  it('🔴 every switch is in the one switches form, hidden tabs included, so a save never drops one', () => {
    const form = funciones(render0());
    for (const key of FEATURE_KEYS) expect(form).toMatch(new RegExp(`<input[^>]*name="${key}"`));
  });

  it('each switch is a checkbox read as an on/off switch', () => {
    expect(checkbox(render0(), 'liveMic')).toMatch(/role="switch"/);
  });

  it('five tabs; the first is selected and its panel is the only one showing', () => {
    const body = render0();
    expect(body).toMatch(/role="tablist"/);
    expect(body.match(/role="tab"/g)).toHaveLength(5);
    expect(body).toMatch(/<button[^>]*id="tab-conversacion"[^>]*aria-selected="true"/);
    expect(body).toMatch(/<div[^>]*id="panel-conversacion"[^>]*>/);
    expect(body.match(/<div[^>]*id="panel-conversacion"[^>]*>/)![0]).not.toMatch(/hidden/);
    expect(body.match(/<div[^>]*id="panel-grafo"[^>]*>/)![0]).toMatch(/hidden/);
  });

  it('a switch under one that is off is hidden, but still posts its stored value', () => {
    const body = render0();
    const row = body.match(/<div[^>]*class="row[^"]*child[^"]*"[^>]*>(?:(?!<div class="row)[\s\S])*?name="graph3d"/)?.[0] ?? '';
    expect(row).toMatch(/hidden/);
    expect(checkbox(body, 'graph3d')).toMatch(/checked/);
  });

  it('the answer-style tab shows a lock for a non-admin', () => {
    expect(render0()).toMatch(/id="tab-estilo"[\s\S]*?solo lectura/);
    expect(render0({ answerStylesEditable: true, lockedFeatures: [] })).not.toMatch(/solo lectura/);
  });

  it('before the page is live the save button is there, so the form posts without JS', () => {
    expect(funciones(render0())).toMatch(/<button[^>]*type="submit"/);
  });

  it('"Guardado" and a refusal show under the form they answer', () => {
    const saved = render0({}, { saved: true, scope: 'funciones' });
    expect(funciones(saved)).toContain('data-testid="ajustes-saved"');
    const refused = render0({ answerStylesEditable: true, lockedFeatures: [] }, { message: 'No se pudo guardar.', scope: 'estilo' });
    expect(funciones(refused)).not.toContain('ajustes-error');
    expect(refused.slice(refused.indexOf('data-testid="ajustes-estilo"'))).toMatch(/role="alert" data-testid="ajustes-error">No se pudo guardar\./);
  });

  it('🔴 I-12: each live switch posts the value the page loaded; a locked one does not', () => {
    const form = funciones(render0());
    expect(form).toMatch(/<input[^>]*name="was-graph"[^>]*value="off"|<input[^>]*value="off"[^>]*name="was-graph"/);
    expect(form).toMatch(/<input[^>]*name="was-liveMic"[^>]*value="on"|<input[^>]*value="on"[^>]*name="was-liveMic"/);
    expect(form).not.toContain('name="was-keepPublicFigures"');
  });

  it('🔴 I-01: after a save with documents still waiting, never a bare "Guardado": the count and "Reintentar"', () => {
    const body = render0({ anon: { pendingRegate: 3, regating: false, unpublishedByRegate: 0 } }, { saved: true, scope: 'funciones' });
    expect(body).not.toContain('data-testid="ajustes-saved"');
    expect(body).toMatch(/data-testid="ajustes-anon-pending">Guardado\. Quedan 3 documentos por volver a anonimizar\./);
    expect(body).toMatch(/action="\?\/reintentar"/);
    expect(body).toMatch(/data-testid="ajustes-anon-retry"[^>]*>Reintentar/);
  });

  it('I-01: while it runs, the count but no "Reintentar"; nothing waiting, a plain "Guardado"', () => {
    const running = render0({ anon: { pendingRegate: 1, regating: true, unpublishedByRegate: 0 } }, { saved: true, scope: 'funciones' });
    expect(running).toMatch(/ajustes-anon-pending">Guardado\. Volviendo a anonimizar: queda 1 documento\./);
    expect(running).not.toContain('ajustes-anon-retry');
    const clear = render0({ anon: { pendingRegate: 0, regating: false, unpublishedByRegate: 0 } }, { saved: true, scope: 'funciones' });
    expect(clear).toContain('data-testid="ajustes-saved"');
    expect(clear).not.toContain('ajustes-anon');
  });

  it('I-01: on a plain visit the backlog shows too, without "Guardado"', () => {
    const body = render0({ anon: { pendingRegate: 2, regating: false, unpublishedByRegate: 0 } });
    expect(body).toMatch(/ajustes-anon-pending">Quedan 2 documentos por volver a anonimizar\./);
    expect(body).toContain('ajustes-anon-retry');
  });

  it('I-02: documents a re-check put back to draft, in one line', () => {
    expect(render0({ anon: { pendingRegate: 0, regating: false, unpublishedByRegate: 4 } })).toMatch(
      /data-testid="ajustes-anon-unpublished">4 documentos volvieron a borrador\./,
    );
    expect(render0({ anon: { pendingRegate: 0, regating: false, unpublishedByRegate: 1 } })).toMatch(
      /ajustes-anon-unpublished">1 documento volvió a borrador\./,
    );
  });

  it('a refused retry shows the backend\'s message', () => {
    const body = render0(
      { anon: { pendingRegate: 2, regating: false, unpublishedByRegate: 0 } },
      { message: 'No administras este ecosistema.', scope: 'reintentar' },
    );
    expect(body).toMatch(/data-testid="ajustes-anon-error">No administras este ecosistema\./);
  });

  it('the platform switch is its own card, for a platform admin only', () => {
    expect(render0()).not.toContain('ajustes-plataforma');
    const body = render0({
      plataforma: { detectorFallback: null, detectorFallbackEnv: 'hosted', detectorFallbackEffective: 'hosted' },
    });
    expect(body).toMatch(/data-testid="ajustes-plataforma"[\s\S]*?<select[^>]*name="detectorFallback"/);
    expect(body).toContain('Según el entorno (modelo alojado)');
  });
});
