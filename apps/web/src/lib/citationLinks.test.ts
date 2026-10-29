import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { citationButton, linkCitations as link } from './citationLinks';

// The suite runs under node; the rewrite walks a real DOM. happy-dom's
// serialiser leaves `<`/`>` raw inside attribute values, the legacy behaviour
// that broke the old regex rewrite (audit 2026-10-28 item 7).
const doc = new Window().document as unknown as Document;
const linkCitations = (html: string, ordinals: Iterable<number>) => link(html, ordinals, doc);

/** Parse an output string the way `{@html}` would, to inspect what it really builds. */
function parse(html: string) {
  const t = doc.createElement('template');
  t.innerHTML = html;
  return t.content;
}

/** Every attribute in the tree whose name is an event handler (`onerror`, `onclick`, …). */
function handlers(html: string): string[] {
  return [...parse(html).querySelectorAll('*')].flatMap((el) =>
    [...el.attributes].map((a) => a.name).filter((n) => n.toLowerCase().startsWith('on')),
  );
}

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
    // `<pre>` sits outside `<p>`, as markdown-it emits it: the DOM parser closes a `<p>` before a `<pre>`.
    const html = '<p><code>a[1]</code> <a href="/x?q=[1]">[1]</a> [1]</p><pre>[1]</pre>';
    expect(linkCitations(html, [1])).toBe(
      `<p><code>a[1]</code> <a href="/x?q=[1]">[1]</a> ${citationButton(1)}</p><pre>[1]</pre>`,
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

  it('leaves a [N] inside a nested <strong> of a link alone', () => {
    const html = '<p><a href="/x"><strong>[1]</strong></a> [1]</p>';
    expect(linkCitations(html, [1])).toBe(`<p><a href="/x"><strong>[1]</strong></a> ${citationButton(1)}</p>`);
  });
});

describe('🔴 linkCitations never breaks markup out of an attribute (audit 2026-10-28 item 7)', () => {
  const PAYLOAD = '<p title="a>[1]<img src=x onerror=alert(1)>">texto [1]</p>';

  it('an [N] inside an attribute holding a raw `>` stays inside that attribute', () => {
    const out = linkCitations(PAYLOAD, [1]);
    expect(handlers(out)).toEqual([]);
    expect(parse(out).querySelectorAll('img')).toHaveLength(0);
    const p = parse(out).querySelector('p')!;
    expect(p.getAttribute('title')).toBe('a>[1]<img src=x onerror=alert(1)>');
    // The text marker still becomes its button; the attribute's does not.
    expect(p.querySelectorAll('button.cite-ref')).toHaveLength(1);
  });

  it('a grouped marker inside an attribute stays inside it too', () => {
    const out = linkCitations('<p><a href="/x" title="x>[1, 2]<svg onload=alert(1)>">l</a> [1, 2]</p>', [1, 2]);
    expect(handlers(out)).toEqual([]);
    expect(parse(out).querySelectorAll('svg')).toHaveLength(0);
    expect(parse(out).querySelector('a')!.getAttribute('title')).toBe('x>[1, 2]<svg onload=alert(1)>');
    expect(parse(out).querySelectorAll('button.cite-ref')).toHaveLength(2);
  });

  it('an [N] in an image alt is never rewritten', () => {
    const out = linkCitations('<p><img alt="[1]&quot; onerror=&quot;alert(1)" src="a.png"> [1]</p>', [1]);
    expect(handlers(out)).toEqual([]);
    expect(parse(out).querySelector('img')!.getAttribute('alt')).toBe('[1]" onerror="alert(1)');
    expect(parse(out).querySelectorAll('button.cite-ref')).toHaveLength(1);
  });

  it('escaped markup in text stays text next to the button', () => {
    const out = linkCitations('<p>&lt;img src=x onerror=alert(1)&gt; [1]</p>', [1]);
    expect(handlers(out)).toEqual([]);
    expect(parse(out).querySelectorAll('img')).toHaveLength(0);
    expect(parse(out).textContent).toBe('<img src=x onerror=alert(1)> [1]');
  });

  it('the button is built from the number alone: nothing else reaches its markup', () => {
    const out = linkCitations('<p>[1]</p>', [1]);
    const b = parse(out).querySelector('button')!;
    expect([...b.attributes].map((a) => `${a.name}=${a.value}`)).toEqual([
      'type=button',
      'class=cite-ref',
      'data-cite=1',
      'aria-label=Ver la fuente 1',
    ]);
    expect(b.getAttribute('data-cite')).toBe('1');
  });
});
