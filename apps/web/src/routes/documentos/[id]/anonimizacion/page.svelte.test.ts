import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

import { parseView } from '$lib/anonimizacion';

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

const { default: Page } = await import('./+page.svelte');

const view = parseView({
  id: '42',
  name: 'Informe',
  contentKind: 'documento',
  gated: true,
  publicationStatus: 'published',
  status: 'approved',
  kept: { authors: ['Ana Pérez'], publicFigures: [], citedAuthors: ['Freire'] },
  counts: { stages: [{ stage: 'deterministic', removed: 3 }], pseudonyms: 5, addresses: null },
  switches: {
    keepDocumentAuthor: { value: true, origin: 'documento' },
    keepCitedAuthors: { value: false, origin: 'ecosistema' },
  },
  editable: { keepDocumentAuthor: true, keepCitedAuthors: true, keepPublicFigures: false },
})!;

const body = (form: unknown = null, v = view) =>
  render(Page, { props: { data: { state: 'ready', view: v, back: '/revision' }, form } as never }).body;

const off = { value: false, origin: 'ecosistema' as const };
const on = { value: true, origin: 'ecosistema' as const };

describe('/documentos/[id]/anonimizacion page', () => {
  it('shows the status, the non-empty kept lists, and counts only', () => {
    const b = body();
    expect(b).toContain('Aprobado');
    expect(b).toMatch(/data-testid="anon-kept-authors"[\s\S]*Ana Pérez/);
    expect(b).toMatch(/data-testid="anon-kept-citedAuthors"[\s\S]*Freire/);
    expect(b).not.toContain('anon-kept-publicFigures');
    expect(b).toMatch(/Reglas<\/dt><dd[^>]*>3<\/dd>/);
    expect(b).toMatch(/Nombres reemplazados<\/dt><dd[^>]*>5<\/dd>/);
    expect(b).not.toContain('Direcciones');
    expect(b).toContain('href="/revision"');
  });

  it('shows each switch with its value and origin; "Usar el del ecosistema" only on a document override', () => {
    const b = body();
    expect(b).toMatch(/<input[^>]*name="keepDocumentAuthor"[^>]*checked/);
    expect(b).not.toMatch(/<input[^>]*name="keepCitedAuthors"[^>]*checked/);
    expect(b).toMatch(/anon-origin-keepDocumentAuthor[^>]*>De este documento/);
    expect(b).toMatch(/anon-origin-keepCitedAuthors[^>]*>Del ecosistema/);
    expect(b).toContain('data-testid="anon-reset-keepDocumentAuthor"');
    expect(b).not.toContain('data-testid="anon-reset-keepCitedAuthors"');
    expect(b).toMatch(/action="\?\/guardar"/);
  });

  it('🔴 R-09: a switch the backend marks not editable is drawn disabled, posts nothing and offers no reset', () => {
    const v = {
      ...view,
      switches: { ...view.switches, keepPublicFigures: { value: true, origin: 'documento' as const } },
    };
    const b = body(null, v);
    const tag = b.match(/<input[^>]*data-testid="anon-switch-keepPublicFigures"[^>]*>/)?.[0] ?? '';
    expect(tag).toMatch(/\bdisabled\b/);
    expect(tag).toMatch(/\bchecked\b/);
    expect(b).not.toMatch(/name="keepPublicFigures"/);
    expect(b).not.toContain('name="was-keepPublicFigures"');
    expect(b).not.toContain('data-testid="anon-reset-keepPublicFigures"');
    // The editable ones still post.
    expect(b).toContain('name="was-keepDocumentAuthor"');
    expect(b).toContain('data-testid="anon-save"');
  });

  it('🔴 R-09: nothing editable → no "Guardar"', () => {
    const v = { ...view, editable: { keepDocumentAuthor: false, keepCitedAuthors: false, keepPublicFigures: false } };
    const b = body(null, v);
    expect(b).not.toContain('data-testid="anon-save"');
    expect(b).not.toMatch(/name="was-/);
  });

  it('shows the save result and a refusal', () => {
    expect(body({ saved: true, message: 'Guardado.' })).toMatch(/anon-saved[^>]*>Guardado\./);
    expect(body({ message: 'El documento se está procesando.' })).toMatch(/anon-error[^>]*>El documento se está procesando\./);
  });

  it('unavailable: one line, no form', () => {
    const b = render(Page, { props: { data: { state: 'unavailable', view: null, back: '/documentos' }, form: null } as never }).body;
    expect(b).toContain('anon-unavailable');
    expect(b).not.toContain('anon-form');
  });

  it('warns on a testimonio with a keep-names switch on, by its effective value', () => {
    const warn = /data-testid="anon-testimony-warning"[^>]*>En un testimonio, esto puede dejar visible a quien habla\./;
    const t = (a: typeof on, c: typeof on) => ({ ...view, contentKind: 'testimonio', switches: { keepDocumentAuthor: a, keepCitedAuthors: c } });
    expect(body(null, t(on, off))).toMatch(warn);
    expect(body(null, t(off, on))).toMatch(warn);
    expect(body(null, t(off, off))).not.toContain('anon-testimony-warning');
    expect(body(null, { ...view, contentKind: 'documento', switches: { keepDocumentAuthor: on, keepCitedAuthors: on } })).not.toContain(
      'anon-testimony-warning',
    );
  });

  it('pendingRegate: one line, and the kept names stay on screen; absent otherwise', () => {
    const pending = body(null, { ...view, pendingRegate: true });
    expect(pending).toMatch(/data-testid="anon-pending-regate"[^>]*>Pendiente: los nombres conservados siguen visibles/);
    expect(pending).toMatch(/anon-kept-authors[\s\S]*Ana Pérez/);
    expect(body(null, { ...view, pendingRegate: false })).not.toContain('anon-pending-regate');
    expect(body()).not.toContain('anon-pending-regate');
  });

  it('I-04: a retryable pending re-check offers "Reintentar", whatever the switch origin', () => {
    const b = body(null, { ...view, pendingRegate: true, retryable: true });
    expect(b).toMatch(/action="\?\/reintentar"/);
    expect(b).toMatch(/data-testid="anon-retry"[^>]*>Reintentar/);
    expect(body(null, { ...view, pendingRegate: true, retryable: false })).not.toContain('anon-retry');
    expect(body()).not.toContain('anon-retry');
  });

  it('I-04: a failed re-check with nothing pending still offers "Reintentar", without claiming kept names are visible', () => {
    const b = body(null, { ...view, pendingRegate: false, retryable: true });
    expect(b).toMatch(/data-testid="anon-retry"[^>]*>Reintentar/);
    expect(b).toMatch(/data-testid="anon-pending-regate"[^>]*>Pendiente de volver a anonimizar\./);
    expect(b).not.toContain('siguen visibles');
  });

  it('I-02: no kept name — the pending line does not say kept names are visible', () => {
    const none = { ...view, pendingRegate: true, kept: { authors: [], publicFigures: [], citedAuthors: [] } };
    const b = body(null, none);
    expect(b).toMatch(/data-testid="anon-pending-regate"[^>]*>Pendiente de volver a anonimizar\./);
    expect(b).not.toContain('siguen visibles');
  });

  it('I-02: unpublishedByRegate shows that it went back to draft', () => {
    expect(body(null, { ...view, unpublishedByRegate: true })).toMatch(/data-testid="anon-unpublished"[^>]*>Volvió a borrador\./);
    expect(body()).not.toContain('anon-unpublished');
  });

  it('I-13: keepPublicFigures is drawn when the backend sends it', () => {
    const v = parseView({
      id: '42',
      switches: { keepDocumentAuthor: off, keepCitedAuthors: off, keepPublicFigures: { value: true, origin: 'documento' } },
      // A platform admin on a documento: the backend says all three are editable.
      editable: { keepDocumentAuthor: true, keepCitedAuthors: true, keepPublicFigures: true },
    })!;
    const b = body(null, v);
    expect(b).toMatch(/<input[^>]*name="keepPublicFigures"[^>]*checked/);
    expect(b).toMatch(/<input[^>]*name="was-keepPublicFigures"[^>]*value="on"|<input[^>]*value="on"[^>]*name="was-keepPublicFigures"/);
    expect(b).toContain('Conservar figuras públicas');
    expect(b).toContain('data-testid="anon-reset-keepPublicFigures"');
    expect(body()).not.toContain('keepPublicFigures');
  });

  it('a neutral name ("Testimonio") is shown as sent, nothing more', () => {
    expect(body(null, { ...view, name: 'Testimonio' })).toMatch(/anon-title"[^>]*>Testimonio<\/h1>/);
  });
});
