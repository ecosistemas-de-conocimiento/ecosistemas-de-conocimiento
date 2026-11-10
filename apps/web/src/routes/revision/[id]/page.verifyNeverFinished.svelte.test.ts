import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';

/** 🔴 Ola 4: a verify hold whose verification never finished is not offered "aprobar tal cual". */

vi.mock('$app/forms', () => ({ enhance: () => ({}) }));

const { default: Detail } = await import('./+page.svelte');

const page = (reason: string) =>
  render(Detail, {
    props: {
      form: null,
      data: {
        state: 'ready',
        hold: {
          id: '12',
          title: 'Testimonio retenido',
          label: 'Testimonio retenido',
          generatedTitle: null,
          contentKind: 'testimonio',
          stage: 'verify',
          reason,
          survivorCount: 0,
          updatedAt: null,
          heldText: 'Vivo con [Persona A].',
          survivors: [],
          report: null,
          publicFiguresKept: [],
        },
      },
    } as never,
  }).body;

describe('/revision/[id] — verify never finished', () => {
  it('🔴 no approve until the text is edited; edit and reject are offered', () => {
    const body = page('La segunda revisión automática no pudo terminar (transporte). Todavía no se agregó a la búsqueda.');
    expect(body).not.toContain('data-testid="hold-approve"');
    expect(body).toContain('data-testid="hold-edit-to-approve"');
    expect(body).toContain('Corregir el texto');
    expect(body).toContain('data-testid="hold-reject"');
  });

  it('a verify hold with survivors still offers approve', () => {
    const body = page('La verificación encontró 1 dato(s) personal(es) que siguen en el texto.');
    expect(body).toContain('data-testid="hold-approve"');
  });
});
