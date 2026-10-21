import { describe, expect, it } from 'vitest';
import { citationButton, linkCitations } from './citationLinks';

describe('linkCitations', () => {
  it('turns a known [N] into a button that names its source', () => {
    expect(linkCitations('<p>Las parteras [1][2].</p>', [1, 2])).toBe(
      `<p>Las parteras ${citationButton(1)}${citationButton(2)}.</p>`,
    );
  });

  it('leaves an [N] with no source as plain text', () => {
    expect(linkCitations('<p>Dato [7].</p>', [1])).toBe('<p>Dato [7].</p>');
  });

  it('does not touch code, links or attributes', () => {
    const html = '<p><code>a[1]</code> <a href="/x?q=[1]">[1]</a> <pre>[1]</pre> [1]</p>';
    expect(linkCitations(html, [1])).toBe(
      `<p><code>a[1]</code> <a href="/x?q=[1]">[1]</a> <pre>[1]</pre> ${citationButton(1)}</p>`,
    );
  });

  it('returns the input when there are no sources', () => {
    expect(linkCitations('<p>[1]</p>', [])).toBe('<p>[1]</p>');
  });
});
