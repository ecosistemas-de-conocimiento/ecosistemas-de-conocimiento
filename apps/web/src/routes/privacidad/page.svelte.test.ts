import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';

const { default: Page } = await import('./+page.svelte');

describe('/privacidad page', () => {
  it('renders the draft header, the three parts and the gaps marked', () => {
    const b = render(Page, { props: {} }).body;
    expect(b).toContain('Borrador sin validación jurídica');
    expect(b).toContain('Aviso de privacidad integral');
    expect(b).toContain('Aviso de privacidad simplificado');
    expect(b).toContain('Tus derechos');
    expect(b).toMatch(/<mark class="pending[^"]*">\[POR DEFINIR: /);
    expect(b).toContain('href="mailto:unidad.enlace@cide.edu"');
  });
});
