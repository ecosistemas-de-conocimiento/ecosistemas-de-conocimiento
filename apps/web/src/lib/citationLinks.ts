/**
 * Turn the `[N]` markers (and grouped `[1, 2, 4]`) in a rendered answer into buttons that open source N
 * (UX backlog #10). Before this, `[3]` was plain text and the reader had to
 * find source 3 in a collapsed list by hand.
 *
 * Runs on HTML that DOMPurify has ALREADY sanitised. 🔴 It rewrites on the
 * DOM, never with a regex over the HTML (audit 2026-10-28 item 7): the old
 * regex took a `>` inside an attribute value for the end of the tag, so a
 * `[N]` after it gained button markup inside the attribute and an
 * `<img onerror>` there broke out, on serialisers that leave `<`/`>` raw in
 * attributes. Here the HTML is parsed into an inert `<template>`, only TEXT
 * nodes are visited, and each button is built with `createElement` from the
 * number alone. Text inside `<code>`, `<pre>`, `<a>` and `<button>` is left
 * alone.
 *
 * Only ordinals that have a source become buttons. A `[7]` with no source 7
 * stays plain text, so the reader never gets a button that does nothing.
 */
import { CITATION_MARKER } from './citationOrdinals';

const SKIP_TAGS = new Set(['CODE', 'PRE', 'A', 'BUTTON']);
const MARKER_RE = new RegExp(CITATION_MARKER, 'g');
const HAS_MARKER = new RegExp(CITATION_MARKER);
const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT; `NodeFilter` is not a global under node.

/** The button's markup as a string. Tests compare against it. */
export function citationButton(n: number): string {
  return `<button type="button" class="cite-ref" data-cite="${n}" aria-label="Ver la fuente ${n}">[${n}]</button>`;
}

function buttonElement(doc: Document, n: number): HTMLButtonElement {
  const b = doc.createElement('button');
  b.setAttribute('type', 'button');
  b.setAttribute('class', 'cite-ref');
  b.setAttribute('data-cite', String(n));
  b.setAttribute('aria-label', `Ver la fuente ${n}`);
  b.textContent = `[${n}]`;
  return b;
}

function skipped(node: Node, root: Node): boolean {
  for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
    if (SKIP_TAGS.has((p as Element).nodeName)) return true;
  }
  return false;
}

/**
 * `doc` defaults to the page's document; the markdown renderer is
 * client-only. Without a document (server), the HTML is returned unchanged.
 */
export function linkCitations(
  html: string,
  ordinals: Iterable<number>,
  doc: Document | undefined = globalThis.document,
): string {
  const known = new Set(ordinals);
  if (known.size === 0 || !html || !doc) return html;

  const template = doc.createElement('template');
  template.innerHTML = html;
  const root = template.content;

  const texts: Text[] = [];
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (HAS_MARKER.test(t.data) && !skipped(t, root)) texts.push(t);
  }

  for (const t of texts) {
    const out = doc.createDocumentFragment();
    let last = 0;
    // `[3]`, and groups like `[1, 2, 4]` or `[1,2]`: one button per known number.
    for (const m of t.data.matchAll(MARKER_RE)) {
      const pieces = m[1]!.split(',').map((d) => Number(d.trim()));
      out.append(t.data.slice(last, m.index));
      for (const n of pieces) out.append(known.has(n) ? buttonElement(doc, n) : `[${n}]`);
      last = m.index! + m[0].length;
    }
    out.append(t.data.slice(last));
    t.replaceWith(out);
  }
  return template.innerHTML;
}
