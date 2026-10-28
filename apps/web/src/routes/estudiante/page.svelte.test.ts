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

const page = (
  testimoniosEnReporte: boolean | undefined,
  shareTestimonios = false,
  form: unknown = null,
  documentos: Array<{ id: number; name: string; status: string }> = [],
) =>
  render(Estudiante, {
    props: {
      form,
      data: {
        organization: '1',
        overview: {
          perfil: { shareWithPeers: false, shareActivity: false, shareTestimonios },
          temas: [],
          documentos,
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

describe('/estudiante — the consent version travels with the page', () => {
  it('🔴 the testimonio form carries the version this page was built with', () => {
    const body = page(true);
    const f = body.match(/<form[^>]*>(?:(?!<\/form>)[\s\S])*share-testimonios[\s\S]*?<\/form>/)?.[0] ?? '';
    expect(f).toContain(`name="consentVersion" value="${TESTIMONIO_CONSENT_VERSION}"`);
  });

  it('a 409 from a stale page shows the reload message', () => {
    const body = page(true, false, { message: 'El texto del consentimiento cambió. Recarga la página y léelo de nuevo.' });
    expect(body).toMatch(/data-testid="estudiante-error"[^>]*>El texto del consentimiento cambió\. Recarga la página/);
  });
});

describe('/estudiante — no topics yet', () => {
  it('nothing written: asks for a trabajo', () => {
    expect(page(false)).toContain('Sube un trabajo.');
  });

  it('🔴 a note or upload not processed yet: not told to upload', () => {
    const body = page(false, false, null, [{ id: 1, name: 'Mi nota', status: 'draft' }]);
    expect(body).not.toContain('Sube un trabajo');
    expect(body).toContain('Sin temas todavía.');
  });
});

const full = (form: unknown = null) =>
  render(Estudiante, {
    props: {
      form,
      data: {
        organization: '1',
        ecosystemName: 'Semiosis práctica',
        overview: {
          perfil: { shareWithPeers: true, shareActivity: false },
          temas: [
            { id: 41, label: 'semiosis' },
            { id: 42, label: 'zapoteco' },
          ],
          documentos: [
            { id: 1, name: 'Ensayo', status: 'published' },
            { id: 2, name: 'Notas', status: 'draft' },
          ],
          companeros: [{ id: 'Zq3xY_-abcdefghijklmno', name: 'Luis Hernández', topics: [{ id: 41, label: 'semiosis' }] }],
          autores: [
            { name: 'Charles S. Peirce', docs: 4, page: { id: 201, name: 'Peirce' } },
            { name: 'Iuri Lotman', docs: 1, page: null },
          ],
          autoresParaLeer: [{ name: 'Thomas A. Sebeok', docs: 6, page: { id: 301, name: 'Sebeok' } }],
          temasDelEcosistema: [],
        },
      },
    } as never,
  }).body;

describe('/estudiante — layout', () => {
  it('🔴 keeps every test id the evidencia videos use (e2e/evidencia/comun.ts miInvestigacion)', () => {
    const body = full();
    for (const id of ['mis-temas', 'preguntas-generar', 'companeros', 'mis-autores', 'autores-leer', 'sugerir', 'share-activity', 'share-peers']) {
      expect(body, id).toContain(`data-testid="${id}"`);
    }
    expect(body).toMatch(/<textarea[^>]*aria-label="Sugerencia"/);
  });

  it('tabs: one selected, each controls a panel, the others are hidden', () => {
    const body = full();
    const tabs = [...body.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
    expect(tabs).toHaveLength(4);
    expect(tabs.filter((t) => t.includes('aria-selected="true"'))).toHaveLength(1);
    expect(tabs[0]).toContain('aria-selected="true"');
    for (const id of ['autores', 'companeros', 'privacidad', 'sugerir']) {
      const panel = body.match(new RegExp(`<div[^>]*role="tabpanel"[^>]*id="panel-${id}"[^>]*>`))?.[0] ?? '';
      expect(panel, id).toContain(`aria-labelledby="tab-${id}"`);
      expect(/\shidden/.test(panel), id).toBe(id !== 'autores');
    }
  });

  it('tab counts say what is inside; an empty list gets no count', () => {
    const body = full();
    expect(body).toMatch(/data-testid="tab-autores"[^>]*>[\s\S]*?<span class="count[^"]*">3<\/span>/);
    expect(body).toMatch(/data-testid="tab-companeros"[^>]*>[\s\S]*?<span class="count[^"]*">1<\/span>/);
    expect(page(false)).not.toMatch(/class="count/);
  });

  it('an author with a Biblioteca page is a link to it; one without is plain text', () => {
    const body = full();
    expect(body).toMatch(/href="\/biblioteca\/201"[\s\S]*?Charles S\. Peirce/);
    expect(body).toMatch(/href="\/biblioteca\/301"[\s\S]*?Thomas A\. Sebeok[\s\S]*?6 documentos/);
    expect(body).not.toMatch(/<a[^>]*>(?:(?!<\/a>)[\s\S])*Iuri Lotman/);
  });

  it('the topics card links to the trabajos they come from; the kicker names the ecosistema', () => {
    const body = full();
    expect(body).toMatch(/<a[^>]*href="\/documentos"[^>]*>2 trabajos/);
    expect(body).toContain('Semiosis práctica');
  });

  it('nothing written: "Sube un trabajo." is the link to upload one', () => {
    expect(page(false)).toMatch(/<a[^>]*href="\/documentos"[^>]*data-testid="temas-vacio"[\s\S]*?Sube un trabajo\./);
  });

  it('consent switches are native checkboxes with a visible label', () => {
    const body = full();
    expect(body).toMatch(/<label[^>]*for="share-peers"[^>]*>Mostrar mi nombre, mis temas y mis trabajos publicados a otros estudiantes<\/label>/);
    expect(box(body, 'share-peers')).toMatch(/type="checkbox"[^>]*role="switch"/);
    expect(box(body, 'share-peers')).toMatch(/checked/);
    expect(box(body, 'share-activity')).not.toMatch(/checked/);
  });
});

describe('/estudiante — links (V3)', () => {
  it('each topic chip opens that topic in the ecosistema graph', () => {
    const body = full();
    const links = [...body.matchAll(/<a[^>]*data-testid="tema-link"[^>]*>[^<]*<\/a>/g)].map((m) => m[0]);
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('href="/grafo?entidad=41&amp;eco=1"');
    expect(links[0]).toContain('>semiosis<');
    expect(links[1]).toContain('href="/grafo?entidad=42&amp;eco=1"');
  });

  it('a peer card links to their page by the opaque id; shared topics link to the graph', () => {
    const body = full();
    expect(body).toMatch(/<a[^>]*href="\/estudiante\/companero\/Zq3xY_-abcdefghijklmno"[^>]*data-testid="companero-link"[^>]*>[\s\S]*?Luis Hernández/);
    expect(body).toMatch(/<a[^>]*href="\/grafo\?entidad=41&amp;eco=1"[^>]*data-testid="companero-tema-link"[^>]*>semiosis<\/a>/);
  });
});
