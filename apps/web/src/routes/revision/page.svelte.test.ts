import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { readable } from 'svelte/store';

/** Each held and published row links to the document's anonymisation page. */

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://edc.test/revision') }) }));

const { default: Revision } = await import('./+page.svelte');

describe('/revision — the anonimización link', () => {
  it('is on every held row and every published row, and comes back to the queue', () => {
    const { body } = render(Revision, {
      props: {
        form: null,
        data: {
          state: 'ready',
          selected: { id: '1', name: 'Eco', slug: 'eco' },
          ecosystems: [],
          notFound: false,
          holds: [
            { id: '11', title: 'Testimonio retenido', label: '', stage: 'verify', reason: null, survivorCount: 2, updatedAt: 0 },
          ],
          published: [{ id: '12', title: 'Voz', updatedAt: 0 }],
        },
      } as never,
    });
    expect(body).toMatch(/href="\/documentos\/11\/anonimizacion\?volver=%2Frevision"[^>]*data-testid="anon-link-11"/);
    expect(body).toMatch(/href="\/documentos\/12\/anonimizacion\?volver=%2Frevision"[^>]*data-testid="anon-link-12"/);
    expect(body).toMatch(/anon-link-11"[^>]*>Anonimización/);
  });
});
