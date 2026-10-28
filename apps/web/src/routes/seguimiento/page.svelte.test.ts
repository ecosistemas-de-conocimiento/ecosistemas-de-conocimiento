import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';

/**
 * 🔴 The activity report renders what the backend sends and nothing more: a
 * draft without a name, and — only when the backend sends `testimonios`
 * (switch on) — each cleared testimonio's neutral title and redacted text, or
 * a status line.
 */

const { default: Seguimiento } = await import('./+page.svelte');

const reporte = (extra: Record<string, unknown> = {}) => ({
  student: { id: 4, name: 'Ana' },
  summary: { documents: 2, published: 1, topics: 0, conversations: 0 },
  uploads: [
    { id: 10, name: 'Mi ensayo', createdAt: '2026-10-01T00:00:00.000Z', status: 'published', kind: 'documento' },
    { id: 11, name: null, createdAt: '2026-10-02T00:00:00.000Z', status: 'draft', kind: 'documento' },
  ],
  topics: [],
  chatThemes: [],
  gaps: [],
  readings: [],
  ...extra,
});

const page = (r: unknown) =>
  render(Seguimiento, {
    props: { data: { estudiantes: [{ id: 4, name: 'Ana' }], sugerencias: [], chosen: '4', reporte: r } } as never,
  }).body;

describe('/seguimiento — activity report', () => {
  it('switch off: documents, a draft unnamed, no testimonios section', () => {
    const body = page(reporte());
    expect(body).toContain('Mi ensayo');
    expect(body).toMatch(/Borrador sin título/);
    expect(body).not.toContain('Testimonios');
  });

  it('switch on: cleared testimonios show title and redacted text; others a status line only', () => {
    const body = page(
      reporte({
        testimonios: [
          { id: 20, createdAt: '2026-10-03T00:00:00.000Z', state: 'visible', title: 'El río y la comunidad', text: 'Habló [Persona A] del río.' },
          { id: 22, createdAt: '2026-10-05T00:00:00.000Z', state: 'held' },
          { id: 23, createdAt: '2026-10-06T00:00:00.000Z', state: 'rejected' },
          { id: 24, createdAt: '2026-10-07T00:00:00.000Z', state: 'pending' },
        ],
      }),
    );
    expect(body).toContain('Testimonios');
    expect(body).toContain('El río y la comunidad');
    expect(body).toContain('Habló [Persona A] del río.');
    expect(body).toContain('En revisión de anonimización');
    expect(body).toContain('No aprobado');
    expect(body).toContain('Anonimización en curso');
  });

  it('🔴 shows the conversation count, never a title, even if one is sent (owner ruling Q23)', () => {
    const body = page(reporte({ summary: { documents: 2, published: 1, topics: 0, conversations: 3 }, chatThemes: ['Pregunta de Rosa'] }));
    expect(body).toContain('3 conversaciones');
    expect(body).not.toContain('Rosa');
  });

  it('switch on with none: says so', () => {
    expect(page(reporte({ testimonios: [] }))).toContain('Sin testimonios.');
  });
});
