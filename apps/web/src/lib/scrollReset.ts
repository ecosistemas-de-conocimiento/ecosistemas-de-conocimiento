/**
 * Should a finished navigation scroll `.app-main` back to the top?
 *
 * 🔴 A NEW SECTION OPENS AT ITS TOP. SvelteKit resets the WINDOW's scroll on
 * navigation, but in this app `.app-main` is what scrolls, so the next page
 * kept the last one's offset: on a phone, Conexiones opened half-way down its
 * list (dev, 2026-10-28). The root layout calls this from `afterNavigate`.
 *
 * Left alone: back/forward (`popstate`), `#anchor` links, and a change of
 * query only (Biblioteca's filters, the graph's search) — same page, so the
 * reader keeps their place.
 *
 * ⚠ `from.url` can be null while `from` is not: SvelteKit 2.70 passes
 * `from = { url: null }` on the first client navigation when SSR is off.
 * Reading `from.url.pathname` there threw inside `afterNavigate` and turned
 * every later link into a full page reload (audit, measured 2026-10-28). The
 * shape below accepts that case on purpose, so the test can pin it.
 */
export interface ScrollNav {
  type: string;
  from: { url: URL | null } | null;
  to: { url: URL | null } | null;
}

export function shouldResetScroll({ type, from, to }: ScrollNav): boolean {
  if (type === 'popstate') return false;
  if (to?.url?.hash) return false;
  if (from?.url?.pathname === to?.url?.pathname) return false;
  return true;
}
