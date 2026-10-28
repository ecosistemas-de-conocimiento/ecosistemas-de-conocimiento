/**
 * The start screen ("Iniciar") for participantes and estudiantes
 * (owner ruling 2026-10-27: "una interfaz más como app, no tanto menú, sino
 * directo a la experiencia").
 *
 * 🔴 ROUTING SHAPE. `/` stays the one address of the conversations UI, so every
 * existing link to it keeps working. For a `member` or `estudiante` of the
 * SELECTED ecosistema, a bare `/` shows the start screen instead; the full UI
 * (sidebar + chat + documents) is `/?conversaciones`. Everyone else ignores the
 * parameter and gets today's `/`.
 *
 * A pure module so vitest (node, no DOM) can assert it; `routes/+page.server.ts`
 * asks it, `+layout.svelte` hides the menu off its answer.
 *
 * ⚠ PRESENTATION ONLY. It decides which screen shows, never what anyone may do.
 */

import type { OrgRole } from '$lib/roles';

/** The query parameter that opens the full conversations UI. */
export const CONVERSACIONES_PARAM = 'conversaciones';

/** The full conversations UI, for everyone. */
export const CONVERSACIONES_HREF = `/?${CONVERSACIONES_PARAM}`;

/** Roles that land on the start screen. Investigador, owner, admin: never. */
const START_ROLES: ReadonlySet<OrgRole> = new Set<OrgRole>(['member', 'estudiante']);

/**
 * Does this request to `/` show the start screen?
 *
 * `role` is the person's role in the selected ecosistema (`roleIn`), or null.
 * A platform admin never does, whatever their membership says.
 */
export function showsStartScreen(input: {
  role: OrgRole | null;
  isPlatformAdmin?: unknown;
  search: URLSearchParams;
}): boolean {
  if (input.isPlatformAdmin === true) return false;
  if (input.search.has(CONVERSACIONES_PARAM)) return false;
  return input.role !== null && START_ROLES.has(input.role);
}

/** Where the menu's "Conversaciones" entry points (`/` → the full UI). */
export function navHref(href: string): string {
  return href === '/' ? CONVERSACIONES_HREF : href;
}
