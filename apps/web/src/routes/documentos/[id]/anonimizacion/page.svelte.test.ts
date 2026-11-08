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

  it('a neutral name ("Testimonio") is shown as sent, nothing more', () => {
    expect(body(null, { ...view, name: 'Testimonio' })).toMatch(/anon-title"[^>]*>Testimonio<\/h1>/);
  });
});
