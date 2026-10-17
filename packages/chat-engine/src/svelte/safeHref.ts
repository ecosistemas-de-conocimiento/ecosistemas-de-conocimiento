/**
 * The one href guard for every link this component library renders
 * (sec chat-engine/L8). `MessageContent` and `CitationCard` both call it; do
 * not inline a copy in a component — a second copy is how one of them drifts.
 *
 * Svelte does NOT sanitize `href` values, so a consumer resolver (or citation
 * metadata from retrieval) emitting `javascript:` would be XSS in every
 * consumer of this shared package.
 *
 * A link is allowed when it is EITHER
 *   - absolute http(s): it names its scheme (`https://…`, `http://…`), or
 *   - a root-relative path that stays on the page's own origin (`/docs/42`).
 *
 * 🔴 "Starts with `/`" is NOT "stays on the origin". The browser's URL parser
 * reads `//host/x` as protocol-relative (another host), treats `\` as `/` in
 * http(s) URLs (`/\host/x` → `//host/x`), and strips tab and newline anywhere
 * (`/\t/host/x` → `//host/x`). The old rule `/^(https?:|\/)/i` linked all of
 * them. So the relative case is decided by the same WHATWG URL parser the
 * browser runs: resolve against a placeholder origin and require the result
 * to keep that origin.
 *
 * Returns the href unchanged when it may become a link, else null.
 */
const PLACEHOLDER = 'https://placeholder.invalid';

export function safeHref(href: string | null | undefined): string | null {
  // Typed string, but resolvers are consumer code and metadata is data: a URL
  // object, number or array must mean "no link", never a crash.
  if (typeof href !== 'string' || !href) return null;
  if (/^https?:/i.test(href)) return href;
  if (!href.startsWith('/')) return null;
  let resolved: URL;
  try {
    resolved = new URL(href, `${PLACEHOLDER}/`);
  } catch {
    return null;
  }
  return resolved.origin === PLACEHOLDER ? href : null;
}
