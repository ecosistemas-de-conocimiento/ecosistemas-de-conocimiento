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

  it('splits a grouped [1, 2, 4] into one button per source', () => {
    const three = `${citationButton(1)}${citationButton(2)}${citationButton(4)}`;
    expect(linkCitations('<p>Dato [1, 2, 4].</p>', [1, 2, 4])).toBe(`<p>Dato ${three}.</p>`);
    expect(linkCitations('<p>Dato [1,2,4].</p>', [1, 2, 4])).toBe(`<p>Dato ${three}.</p>`);
  });

  it('keeps unknown numbers of a group as plain text', () => {
    expect(linkCitations('<p>[1, 7]</p>', [1])).toBe(`<p>${citationButton(1)}[7]</p>`);
    expect(linkCitations('<p>[7, 8]</p>', [1])).toBe('<p>[7][8]</p>');
  });

  it('leaves groups inside code and links alone', () => {
    const html = '<p><code>a[1, 2]</code> <a href="/x">[1, 2]</a></p>';
    expect(linkCitations(html, [1, 2])).toBe(html);
  });

  it('returns the input when there are no sources', () => {
    expect(linkCitations('<p>[1]</p>', [])).toBe('<p>[1]</p>');
  });
});
