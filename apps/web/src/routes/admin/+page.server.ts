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
 *  2. WHICH ECOSISTEMA ARE WE LOOKING AT? Resolved to ONE id and passed
 *     explicitly into every query (see `$lib/server/admin.ts`).
 *
 * ⚠ CHECK 2 IS NOT REDUNDANT, AND IT IS THE ONE THAT IS EASY TO GET WRONG.
 * `Documents.visibleToCaller` in the backend returns `true` — no constraint —
 * for a platform admin. Correct for the CMS; wrong here. Without an explicit
 * organization filter this page would list every tenant's documents under one
 * ecosistema's name, and would look completely normal doing it. So access
 * control is never used as the tenant filter: the filter is in the query, and
 * the id in the query is a single, named, visible-in-the-URL value.
 *
 * ── 🔴 WHAT CHANGED: OVERSIGHT IS NOT MEMBERSHIP ───────────────────────────
 *
 * The owner's decision, verbatim: *"admin es admin, no necesita ser miembro
 * para ver todo, y no deberá poderse asignar."*
 *
 * So check 2 no longer resolves from the caller's MEMBERSHIPS. It resolves from
 * `?eco=<id>`, validated against the organizations that actually exist
 * (`readEcosystem`). A platform admin reviews any ecosistema without joining
 * it — and the backend makes sure they cannot join one either
 * (`refuseSelfAssignment` in `collections/Memberships.ts`). Those two halves go
 * together: without the second, this page would have turned `isPlatformAdmin`
 * into a master key over CONTENT rather than a role for running the platform.
 *
 * ⚠ THIS ROUTE WRITES NOTHING. In particular it does NOT touch the
 * `eco_selected` cookie. That cookie decides where this person's OWN uploads
 * and conversations land, and `Sessions.beforeValidate` still refuses any
 * ecosistema they are not a member of — admin or not. Reviewing a tenant must
 * never quietly re-point the tenant you are working in. Hence a URL parameter,
 * not a stored selection: the scope of the page is visible, shareable, and
 * gone when you leave.
 *
 * ⚠ WHAT THIS PAGE SHOWS OF A DRAFT, AND WHAT IT WITHHOLDS. That a draft
 * exists, who uploaded it, when, its kind and its state — that is
 * administration. Its TEXT is never read into the page: `DOC_FIELDS` omits
 * `extractedText`, and the one query that touches it converts it to a character
 * count server-side and drops the string (`withTranscriptSizes`). A draft's
 * promise is "solo tú lo ves", and oversight of every tenant must not be the
 * thing that quietly breaks it for every user.
 *
 * ⚠ The refusal is a structured `denyAccess`, so `+error.svelte` renders real
 * copy and an escape hatch — not a stack trace, not a blank page. It says only
 * that the section is for administrators: a non-admin learns nothing about
 * what is behind it.
 */

import { denyAccess } from '$lib/server/deny';
import { isPlatformAdmin } from '$lib/components/admin/summary';
import { listAllEcosystems, loadAdminOverview, readEcosystem } from '$lib/server/admin';
import { listEcosystems } from '$lib/server/ecosystem';
import type { PageServerLoad } from './$types';

/**
 * ⚠ The two URL parameters this page reads: `?eco=` (which ecosistema is being
 * reviewed) and `?q=` (the search term). They are NOT exported — SvelteKit
 * rejects any export from a `+page.server.ts` other than `load`, `actions` and
 * its own options, and it does so at REQUEST time, not at typecheck time. The
 * page 500s with "Invalid export"; `svelte-check` says nothing.
 */

export const load: PageServerLoad = async ({ locals, url }) => {
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

  const search = (url.searchParams.get('q') ?? '').slice(0, 120);
  const requested = url.searchParams.get('eco') ?? '';

  // ⚠ Two lists, two different questions, and they must not be confused.
  //  · `directory` — every ecosistema on the installation. The oversight list.
  //  · `mine`      — the ones the caller is a MEMBER of. Only used to label
  //                  rows and to pick a sensible default, never to restrict
  //                  what an admin may review.
  const [directory, mine] = await Promise.all([
    listAllEcosystems(locals.token, search),
    listEcosystems(locals.token),
  ]);

  // Resolved by a direct read, so a search term in the box cannot make the
  // ecosistema being reviewed "disappear".
  const requestedEco = requested ? await readEcosystem(locals.token, requested) : null;
  const selected =
    requestedEco ??
    // Default: where this person actually works, if anywhere. Falling back to
    // "the first tenant on the installation" as the FIRST choice would open an
    // admin's own page on a stranger's ecosistema every morning.
    mine.list[0] ??
    directory.rows[0] ??
    null;

  // ⚠ Three different "nothing to show" cases, and they must not be shown the
  // same way. `ok: false` means the backend read failed — saying "no hay
  // ecosistemas" there tells an owner their installation is empty when it is
  // merely unreachable.
  if (!selected) {
    if (!directory.ok && !mine.ok) {
      return { state: 'unavailable' as const, overview: null, directory, selected: null, mine: [], notFound: false };
    }
    return { state: 'no-ecosystem' as const, overview: null, directory, selected: null, mine: [], notFound: false };
  }

  const overview = await loadAdminOverview(locals.token, {
    id: selected.id,
    name: selected.name,
  });

  return {
    state: 'ready' as const,
    overview,
    directory,
    selected,
    /** Ids the caller is a member of. Labels rows; grants nothing. */
    mine: mine.list.map((e) => e.id),
    /** `true` ⇒ `?eco=` named something that does not exist. Say so. */
    notFound: Boolean(requested) && requestedEco === null,
  };
};
