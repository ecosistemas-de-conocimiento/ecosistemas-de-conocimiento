import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';

const { default: Companero } = await import('./+page.svelte');

const page = (companero: unknown) =>
  render(Companero, { props: { data: { organization: '8', ecosystemName: 'Semiosis', companero } } as never }).body;

describe('/estudiante/companero/[id]', () => {
  it('name, shared topics to the graph, published works to the Biblioteca', () => {
    const body = page({
      id: 'abc',
      name: 'Luis Hernández',
      temas: [{ id: 41, label: 'semiosis' }],
      trabajos: [{ id: 501, name: 'Ensayo sobre el índice' }],
    });
    expect(body).toMatch(/data-testid="companero-nombre"[^>]*>Luis Hernández</);
    expect(body).toMatch(/<a[^>]*href="\/grafo\?entidad=41&amp;eco=8"[^>]*data-testid="companero-tema-link"[^>]*>semiosis<\/a>/);
    expect(body).toMatch(/<a[^>]*href="\/biblioteca\/501"[^>]*data-testid="companero-trabajo-link"[^>]*>[\s\S]*?Ensayo sobre el índice/);
    expect(body).toMatch(/<a[^>]*href="\/estudiante"[^>]*data-testid="companero-volver"/);
  });

  it('empty lists say so, briefly', () => {
    const body = page({ id: 'abc', name: 'Ana', temas: [], trabajos: [] });
    expect(body.match(/Ninguno todavía\./g)).toHaveLength(2);
    expect(body).not.toContain('data-testid="companero-trabajos"');
  });
});
