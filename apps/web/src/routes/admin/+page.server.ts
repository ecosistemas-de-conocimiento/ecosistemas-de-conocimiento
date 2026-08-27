/**
 * `/admin` — "Contribuciones", the in-product admin view.
 *
 * ── 🔴 THE GATE ────────────────────────────────────────────────────────────
 *
 * Two independent checks, in this order, both server-side:
 *
 *  1. IS THE CALLER A PLATFORM ADMIN? Enforced here, in `load`, not by hiding
 *     the sidebar link. Anyone can type a URL. A hidden link is a UI courtesy;
 *     this is the control.
 *
 *  2. WHICH ECOSISTEMA ARE WE LOOKING AT? Resolved from the caller's own
 *     MEMBERSHIPS via `resolveEcosystem`, and passed explicitly into every
 *     query (see `$lib/server/admin.ts`).
 *
 * ⚠ CHECK 2 IS NOT REDUNDANT, AND IT IS THE ONE THAT IS EASY TO GET WRONG.
 * `Documents.visibleToCaller` in the backend returns `true` — no constraint —
 * for a platform admin. Correct for the CMS; wrong here. Without an explicit
 * organization filter this page would list every tenant's documents under one
 * ecosistema's name, and would look completely normal doing it. So access
 * control is never used as the tenant filter: the filter is in the query, and
 * the id in the query comes from a membership the caller actually holds.
 *
 * ⚠ The refusal is a structured `denyAccess`, so `+error.svelte` renders real
 * copy and an escape hatch — not a stack trace, not a blank page. It says only
 * that the section is for administrators: a non-admin learns nothing about
 * what is behind it.
 */

import { denyAccess } from '$lib/server/deny';
import { isPlatformAdmin } from '$lib/components/admin/summary';
import { loadAdminOverview } from '$lib/server/admin';
import { resolveEcosystem } from '$lib/server/ecosystem';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  // `hooks.server.ts` already bounced anonymous callers to /sign-in; this is
  // the belt to that braces, and it is what makes the check readable here.
  if (!locals.user || !isPlatformAdmin(locals.user)) {
    denyAccess({
      module: 'admin',
      reason: 'not-platform-admin',
      message: 'Esta sección es solo para administradores de la plataforma.',
      cta: { label: 'Volver al chat', href: '/' },
    });
  }

  const { selected, ok } = await resolveEcosystem(cookies, locals.token);

  // ⚠ Two different "no data" cases, and they must not be shown the same way.
  // `ok: false` means the backend read failed — saying "no perteneces a ningún
  // ecosistema" there tells an owner they have no access they demonstrably do.
  if (!ok) {
    return { state: 'unavailable' as const, overview: null };
  }
  if (!selected) {
    return { state: 'no-ecosystem' as const, overview: null };
  }

  const overview = await loadAdminOverview(locals.token, {
    id: selected.id,
    name: selected.name,
  });
  return { state: 'ready' as const, overview };
};
