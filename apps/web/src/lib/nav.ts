/**
 * The app's PRIMARY NAVIGATION, as pure data.
 *
 * ── 🔴 WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * Until now the product had no way to move between its own sections. The chat
 * lived at `/`, the ecosistema's library at `/biblioteca` and the admin view at
 * `/admin`, and the only links between them were ad hoc: a line in the document
 * panel's footer, a row at the bottom of the conversation list. Someone reading
 * a document had no way back except the browser's back button, and someone who
 * had never opened the document panel never learned the library existed at all.
 *
 * The items, the Spanish labels and the "which section am I in?" rule live here
 * rather than in `PrimaryNav.svelte` because `apps/web` runs vitest in `node`
 * with no DOM: nothing rendered can be asserted. A plain module can be.
 *
 * ── ⚠ HIDING A LINK IS PRESENTATION, NOT ACCESS CONTROL ─────────────────────
 *
 * `visibleNavItems` drops `/admin` for people who are not platform admins, and
 * `/revision` for people who may not review held documents. That is politeness —
 * it keeps the menu honest and stops a member clicking into a refusal. The
 * CONTROLS are `routes/admin/+page.server.ts` and
 * `routes/revision/+page.server.ts`, which call `denyAccess` before they read
 * anything, and behind those the backend, which answers 404 to a caller without
 * `holds:review`. Anyone can type a URL; nothing in this file would stop them,
 * and nothing in this file is meant to.
 */

import { isPlatformAdmin } from '$lib/components/admin/summary';

export interface NavItem {
  /** Where it goes. Also the section prefix — see `isCurrentSection`. */
  href: string;
  /**
   * What it says. ⚠ Plain Spanish nouns, no jargon and no English. These are
   * read by people for whom "dashboard" or "settings" is not a word, and the
   * label is the only thing telling them what is behind the link.
   */
  label: string;
  /**
   * One short line under the label on wide screens, and the link's
   * `title`/`aria-description` everywhere. A label alone ("Biblioteca") does
   * not tell a first-time visitor whether it holds their files or everyone's.
   */
  hint: string;
  /** `true` ⇒ only platform admins see it. See the header. */
  adminOnly?: boolean;
  /**
   * `true` ⇒ only people who may review held documents see it.
   *
   * ⚠ NOT THE SAME QUESTION AS `adminOnly`, and it cannot be folded into it.
   * `holds:review` belongs to the `investigador` role and up, PER ECOSISTEMA,
   * and most people who have it are not platform admins. The flag is computed
   * server-side in `routes/+layout.server.ts` by asking the backend for the
   * caller's own permission list — never by expanding a role here. See
   * `$lib/server/holds.ts`.
   */
  reviewerOnly?: boolean;
}

/**
 * Capabilities the menu branches on, as resolved by the server.
 *
 * ⚠ Separate from `user` on purpose. `isPlatformAdmin` is a field the backend
 * puts on the user record; `canReviewHolds` is an ANSWER the BFF computed for
 * this request. Keeping them apart stops the second from looking like something
 * the browser could set.
 */
export interface NavCapabilities {
  canReviewHolds?: boolean;
}

/**
 * Every real destination in the app, in the order they are shown.
 *
 * ⚠ ONLY PAGES THAT EXIST. `/`, `/documentos`, `/biblioteca`, `/grafo`,
 * `/revision` and `/admin` are the whole set of signed-in destinations under `src/routes` —
 * `/sign-in` is the way in, not a section, and
 * `/biblioteca/[id]` is a detail view inside Biblioteca rather than a section of
 * its own. A menu entry for a page that does not exist is worse than a missing
 * menu: it teaches people the app is broken.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: '/',
    label: 'Conversaciones',
    hint: 'Pregunta y guarda lo que platicaste.',
  },
  {
    href: '/documentos',
    /**
     * 🔴 The way back to a document that is in no conversation. Everything
     * else lists documents per conversation, so without this entry a loose
     * document is unreachable from the UI at all. Not gated on any role:
     * everyone owns documents.
     *
     * ⚠ "Mis documentos", not a second "Biblioteca". The biblioteca is what the
     * ecosistema has PUBLICADO — shared, everyone's. This is what YOU have,
     * borradores and loose files included. The hint says so, because two
     * entries about documents is exactly where someone opens the wrong one.
     */
    label: 'Mis documentos',
    hint: 'Todo lo que subiste, aunque no esté en una conversación.',
  },
  {
    href: '/biblioteca',
    label: 'Biblioteca',
    hint: 'Lo que tu ecosistema ha publicado.',
  },
  {
    href: '/grafo',
    /**
     * ⚠ "Conexiones", NOT "Grafo".
     *
     * `/grafo` is the route and the ADR's word for the feature. It is not this
     * menu's word for it: a *grafo* is a maths term, and this file's own rule
     * is plain Spanish nouns for readers who do not have that vocabulary. The
     * page's kicker says "Conexiones" too (`GRAPH_KICKER`), so clicking the
     * menu lands on a page that calls itself the same thing.
     *
     * It sits next to Biblioteca because it is the same material seen a
     * different way: both are about what the ecosistema has PUBLISHED, and
     * neither shows a draft.
     */
    label: 'Conexiones',
    hint: 'Cómo se relaciona lo que se ha publicado.',
  },
  {
    href: '/revision',
    label: 'Revisión',
    hint: 'Documentos que la anonimización detuvo.',
    reviewerOnly: true,
  },
  {
    href: '/admin',
    label: 'Administración',
    hint: 'Las cifras del ecosistema y quién ha aportado.',
    adminOnly: true,
  },
];

/**
 * The items this person may see.
 *
 * Takes the user off `$page.data.user` — the root layout's server load, which
 * gets it from the verified session — and not off the chat's app store, which
 * is about conversations and knows nothing about roles.
 */
export function visibleNavItems(user: unknown, caps: NavCapabilities = {}): NavItem[] {
  const admin = isPlatformAdmin(user);
  // 🔴 Literally `true`, nothing else — same rule as `isPlatformAdmin`. A
  // truthy string from a garbled payload must not advertise a section.
  const reviewer = caps.canReviewHolds === true;
  return NAV_ITEMS.filter((item) => {
    if (item.adminOnly && !admin) return false;
    if (item.reviewerOnly && !reviewer) return false;
    return true;
  });
}

/**
 * Is `pathname` inside the section that `href` names?
 *
 * ⚠ `/` IS EXACT, EVERYTHING ELSE IS A PREFIX. Treating `/` as a prefix would
 * mark the chat as current on every page in the app, which makes
 * `aria-current="page"` a lie for a screen-reader user and the highlight
 * meaningless for everyone else.
 *
 * ⚠ The prefix stops at a `/` boundary, so a future `/bibliotecarios` route
 * would not light up `Biblioteca`. `/biblioteca/42` — the detail view — does,
 * because it IS the library, one document deep.
 */
export function isCurrentSection(pathname: string, href: string): boolean {
  const path = normalizePath(pathname);
  if (href === '/') return path === '/';
  return path === href || path.startsWith(`${href}/`);
}

/** Trailing slashes are the same place. `''` is the root. */
function normalizePath(pathname: string): string {
  if (!pathname) return '/';
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * The item matching the current URL, or null when nothing does.
 *
 * ⚠ At most ONE item is ever current. The list is ordered most-general-first
 * (`/` is exact, so it cannot swallow the others), and the first match wins —
 * two `aria-current="page"` links on one page is an accessibility bug, not a
 * cosmetic one.
 */
export function currentNavItem(
  pathname: string,
  user: unknown,
  caps: NavCapabilities = {},
): NavItem | null {
  return visibleNavItems(user, caps).find((item) => isCurrentSection(pathname, item.href)) ?? null;
}

/**
 * Routes that get NO primary navigation.
 *
 * 🔴 The sign-in screen is deliberately bare. A menu offering
 * "Biblioteca" to someone who is not signed in is three clicks that all end in
 * the same redirect back here, and it makes the sign-in page look like it has
 * failed rather than like it is waiting.
 */
const CHROMELESS_PATHS = new Set(['/sign-in']);

/**
 * Should this request render the app shell (nav + content) at all?
 *
 * ⚠ Requires a `user`, so the nav never flashes on the way to `/sign-in`.
 * `hooks.server.ts` has already bounced anonymous page requests, so in practice
 * this only matters for the moment before that redirect lands.
 */
export function shouldShowNav(pathname: string, user: unknown): boolean {
  if (!user) return false;
  return !CHROMELESS_PATHS.has(normalizePath(pathname));
}

/** The nav's own accessible name, so assistive tech can tell it from the conversation list. */
export const PRIMARY_NAV_LABEL = 'Secciones';

/** Skip link target and copy. Keyboard users should not tab the menu on every page. */
export const MAIN_CONTENT_ID = 'contenido-principal';
export const SKIP_TO_CONTENT_LABEL = 'Saltar al contenido';
