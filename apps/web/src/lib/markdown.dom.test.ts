/**
 * The app's one Markdown renderer, run in a DOM (jsdom): DOMPurify needs
 * `window`, so under node `renderMarkdown` returns ''. Document mode is what
 * notes, transcripts, published documents and testimonios render through
 * (owner, 2026-10-28: those views showed raw `**`, `#` and `[[…]]`).
 */
import { describe, expect, it } from 'vitest';
import { markdownToPlainText, renderHighlightedMarkdown, renderMarkdown } from './markdown';
import { expectRenderedDocument, HOSTILE_MD } from './markdown.testkit';

describe('renderMarkdown — document text', () => {
  it('renders headings, emphasis and lists; wikilinks and [N] as text; no images or scripts', () => {
    expectRenderedDocument(renderMarkdown(HOSTILE_MD, { document: true }));
  });

  it('keeps [N] as text even when citations are passed', () => {
    const html = renderMarkdown('Según [1].', { document: true, citations: [1] });
    expect(html).toContain('[1]');
    expect(html).not.toContain('cite-ref');
  });

  it('keeps line breaks of a transcript', () => {
    expect(renderMarkdown('línea uno\nlínea dos', { document: true })).toMatch(/línea uno<br>\s*línea dos/);
  });
});

describe('renderMarkdown — chat answers', () => {
  it('still turns [N] into source buttons', () => {
    const html = renderMarkdown('La respuesta **es** esta [1].', { citations: [1] });
    expect(html).toContain('<strong>es</strong>');
    expect(html).toContain('data-cite="1"');
  });

  it('renders no remote image either (code audit 2026-10-28, item 6)', () => {
    const html = renderMarkdown('Mira ![la foto](https://evil.example/a.png)');
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain('evil.example');
    // Its alt text stays, as text.
    expect(html).toContain('la foto');
  });

  it('keeps [[…]] literal outside document mode', () => {
    expect(renderMarkdown('[[x]]')).toContain('[[x]]');
  });
});

describe('renderHighlightedMarkdown — the held text in /revision/[id]', () => {
  const segments = [
    { text: '## Entrevista\n\nHabló **', type: null },
    { text: 'Juan Pérez', type: 'persona' },
    { text: '** desde ', type: null },
    { text: 'Oaxaca', type: 'lugar' },
    { text: '.', type: null },
  ];
  const label = (t: string) => (t === 'persona' ? 'Nombre de una persona' : 'Lugar');

  it('renders the Markdown and marks exactly the flagged stretches', () => {
    const html = renderHighlightedMarkdown(segments, label);
    expect(html).toMatch(/<h2[^>]*>Entrevista<\/h2>/);
    expect(html).toContain('<strong><mark class="hit" title="Nombre de una persona">Juan Pérez</mark></strong>');
    expect(html).toContain('<mark class="hit" title="Lugar">Oaxaca</mark>');
    expect(html).not.toContain('**');
    expect(html).not.toMatch(/[\uE000-\uF8FF]/);
  });

  it('a mark across formatting becomes one mark per piece', () => {
    const html = renderHighlightedMarkdown([{ text: '**Ju**an', type: 'persona' }], label);
    expect(html).toContain('<strong><mark class="hit" title="Nombre de una persona">Ju</mark></strong><mark class="hit" title="Nombre de una persona">an</mark>');
  });

  it('a highlight inside a link URL never reaches the attribute', () => {
    const html = renderHighlightedMarkdown(
      [
        { text: 'ver https://x.example/', type: null },
        { text: 'juan', type: 'persona' },
      ],
      () => '"><script>',
    );
    const box = document.createElement('div');
    box.innerHTML = html;
    expect(box.querySelector('script')).toBeNull();
    expect(box.querySelector('a')?.getAttribute('href')).toBe('https://x.example/juan');
    expect(html).not.toMatch(/[\uE000-\uF8FF]/);
  });

  it('drops images and scripts in held text too', () => {
    const html = renderHighlightedMarkdown([{ text: HOSTILE_MD, type: null }], label);
    expect(html).not.toMatch(/<img|<script/i);
  });
});

describe('markdownToPlainText — quoted passages', () => {
  it('strips the notation and keeps the words', () => {
    expect(markdownToPlainText('# Título\n\nUn **dato** con [[Tema|el tema]].\n\n- uno')).toBe(
      'Título Un dato con el tema. uno',
    );
  });
});
