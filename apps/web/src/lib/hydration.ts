/**
 * WHEN DOES THE APP READ ITSELF FROM THE SERVER — pure decision, no runes.
 *
 * 🔴 THE BUG THIS FILE EXISTS TO PREVENT, WRITTEN DOWN SO IT CANNOT COME BACK.
 *
 * `routes/+layout.svelte` used to call `app.hydrateFromServer()` from
 * `onMount()`, gated on "is this an auth route?". That is wrong for one reason
 * that is invisible until you actually sign in through the form:
 *
 *   The root layout is SHARED by `/sign-in`, `/sign-up` and `/`. It mounts
 *   ONCE — on whichever of them you land on first. Sign in through the form and
 *   that first route is `/sign-in`, where the gate says "don't hydrate". The
 *   `goto('/')` that follows is a CLIENT-SIDE navigation: the layout does not
 *   remount, `onMount` does not run again, and hydration never happens at all.
 *
 * The result was an app that, after a successful sign-in, sat on "Cargando…"
 * for the ecosistema with an empty conversation list and a dead upload button —
 * until the user pressed reload by hand. It looked fine to anyone who arrived
 * at `/` on a full page load with the cookie already set, which is why it
 * survived.
 *
 * So the decision is a function of the CURRENT ROUTE, re-evaluated on every
 * navigation, not a one-shot taken at mount. Keeping it here — pure, no
 * `$app/stores`, no `fetch` — is what lets it be unit-tested: this repo has no
 * DOM test environment, so logic that lives inside a `.svelte` file cannot be
 * covered by anything but the Playwright journey.
 */

/**
 * The routes that are reachable WITHOUT a session, and must never trigger a
 * hydration: every request it makes would 401 and paint a degraded banner over
 * the sign-in form.
 *
 * ⚠ Mirrors `PUBLIC_PATHS` in `src/hooks.server.ts`. They are deliberately not
 * shared: that set decides who gets redirected (a security boundary, server
 * side), this one decides when to fetch (a UX concern, browser side). Coupling
 * them would mean a change to one silently reaching into the other.
 */
export const AUTH_ROUTES: readonly string[] = ['/sign-in', '/sign-up'];

/** Is this one of the unauthenticated routes? Trailing slash tolerated. */
export function isAuthRoute(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return AUTH_ROUTES.includes(path);
}

/**
 * What the root layout should do for the route it is now showing.
 *
 * - `hydrate` — an authenticated route, and nothing has been read yet. Read it.
 * - `reset`   — we are back on an auth route with a populated store. Drop it.
 *               Whoever signs in next may not be the person whose conversations
 *               are still in memory, and a client-side sign-in would otherwise
 *               find `hydrated` already true and never re-read.
 * - `none`    — nothing to do.
 */
export type HydrationAction = 'hydrate' | 'reset' | 'none';

export interface HydrationInput {
  /** `$page.url.pathname` — the route being rendered right now. */
  pathname: string;
  /** Has a hydration already been started for the current signed-in visit? */
  hydrated: boolean;
}

export function hydrationAction({ pathname, hydrated }: HydrationInput): HydrationAction {
  if (isAuthRoute(pathname)) {
    // Leaving the app for the sign-in form is the end of a visit. Forget it,
    // so the NEXT sign-in hydrates instead of inheriting these conversations.
    return hydrated ? 'reset' : 'none';
  }
  return hydrated ? 'none' : 'hydrate';
}
