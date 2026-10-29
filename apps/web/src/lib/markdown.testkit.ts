import { expect } from 'vitest';

/** Test fixtures for the Markdown views (`*.dom.test.ts`). */

/** Everything a document can carry that must never reach the page as markup or a request. */
export const HOSTILE_MD = [
  '# Título de la nota',
  '',
  'Un **dato clave** y *énfasis*, con [[Semiótica]] y [[semiotica-practica|otro tema]] [3].',
  '',
  '- primero',
  '- segundo',
  '',
  '![espía](https://evil.example/p.png?leak=1)',
  '',
  '<img src="https://evil.example/q.png" onerror="alert(1)">',
  '',
  '<script>alert(1)</script>',
].join('\n');

/** The checks every rendered document view must pass. */
export function expectRenderedDocument(html: string): void {
  expect(html).toMatch(/<h1[^>]*>Título de la nota<\/h1>/);
  expect(html).toContain('<strong>dato clave</strong>');
  expect(html).toContain('<em>énfasis</em>');
  expect(html).toMatch(/<li>primero<\/li>/);
  // Wikilinks read as their text.
  expect(html).toContain('Semiótica');
  expect(html).toContain('otro tema');
  expect(html).not.toContain('[[');
  // `[N]` in a document is text, never a citation button.
  expect(html).toContain('[3]');
  expect(html).not.toContain('cite-ref');
  // No raw notation left.
  expect(html).not.toContain('**');
  expect(html).not.toMatch(/(^|>)\s*# /m);
  // No image of any kind, no script.
  expect(html).not.toMatch(/<img/i);
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toContain('evil.example/p.png');
}

