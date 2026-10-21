/**
 * Turn the `[N]` markers in a rendered answer into buttons that open source N
 * (UX backlog #10). Before this, `[3]` was plain text and the reader had to
 * find source 3 in a collapsed list by hand.
 *
 * Runs on HTML that DOMPurify has ALREADY sanitised: it only rewrites text
 * between tags, and the markup it adds is fixed apart from the digits. Text
 * inside `<code>`, `<pre>`, `<a>` and `<button>` is left alone.
 *
 * Only ordinals that have a source become buttons. A `[7]` with no source 7
 * stays plain text, so the reader never gets a button that does nothing.
 */
const SKIP_TAGS = new Set(['code', 'pre', 'a', 'button']);

export function citationButton(n: number): string {
  return `<button type="button" class="cite-ref" data-cite="${n}" aria-label="Ver la fuente ${n}">[${n}]</button>`;
}

export function linkCitations(html: string, ordinals: Iterable<number>): string {
  const known = new Set(ordinals);
  if (known.size === 0 || !html) return html;
  let skipDepth = 0;
  return html.replace(/(<[^>]*>)|([^<]+)/g, (_m, tag: string | undefined, text: string | undefined) => {
    if (tag) {
      const t = /^<\s*(\/)?\s*([a-zA-Z0-9]+)/.exec(tag);
      if (t && SKIP_TAGS.has(t[2]!.toLowerCase())) skipDepth += t[1] ? -1 : 1;
      if (skipDepth < 0) skipDepth = 0;
      return tag;
    }
    if (skipDepth > 0 || !text) return text ?? '';
    return text.replace(/\[(\d{1,3})\]/g, (whole, d: string) =>
      known.has(Number(d)) ? citationButton(Number(d)) : whole,
    );
  });
}
