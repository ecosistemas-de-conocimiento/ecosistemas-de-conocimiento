/**
 * `/revision` — the queue of documents the anonymisation gate REFUSED.
 *
 * ── 🔴 THE GATE ────────────────────────────────────────────────────────────
 *
 * Three checks, in this order, all server-side:
 *
 *  1. MAY THIS PERSON REVIEW HOLDS AT ALL? Asked of the backend's own flat
 *     permission list (`$lib/server/holds.ts`), never worked out from a role
 *     here. Enforced in `load`, not by hiding the menu entry — anyone can type
 *     a URL, and a hidden link is a courtesy.
 *
 *  2. WHICH ECOSISTEMA? Resolved to ONE id and passed explicitly into the
 *     query. In order: `?eco=` validated by `readEcosystem` (an explicit,
 *     visible override, `/admin`'s shape); else the ecosistema the sidebar
 *     picker selected (the `eco_selected` cookie, checked against the caller's
 *     real memberships), so this screen agrees with `/biblioteca` and `/grafo`;
 *     else the first ecosistema they may review here.
 *
 *     🔴 This used to skip the cookie and open on the first reviewable
 *     ecosistema, so the queue ignored the picker and only `?eco=` moved it.
 *     The load `depends` on `ECOSYSTEM_DEPENDENCY`, which the picker
 *     invalidates after a switch.
 *
 *  3. MAY THEY REVIEW IN *THAT* ONE? `holds:review` is per-ecosistema. Being an
 *     investigador in one place says nothing about another.
 *
 * ⚠ AND NONE OF THE THREE IS THE REAL CONTROL. `GET /api/holds` refuses
 * independently, and it answers 404 to "no such ecosistema", "not yours" and
 * "you may not review" indistinguishably. This route exists so a person meets a
 * sentence instead of an empty screen — if it were deleted, nothing would leak.
 *
 * ⚠ THIS ROUTE WRITES NOTHING, and in particular does not touch the
 * `eco_selected` cookie: it READS it with the pure `resolveEcosystemSelection`,
 * never with `resolveEcosystem`, which rewrites it. That cookie decides where this person's own uploads
 * land. Reviewing a tenant must never quietly re-point the tenant you work in.
 *
 * ── 🔴 WHAT THE QUEUE SHOWS, AND WHAT IT CANNOT ────────────────────────────
 *
 * Neutral titles, the stage that refused, how many identifiers survived, and
 * when. No text — the API deliberately sends none to a list endpoint — and
 * nothing about who the document is about or who uploaded it. There is no field
 * here that could name a person, and none may be added.
 */

import { fail, redirect } from '@sveltejs/kit';

import { denyAccess } from '$lib/server/deny';
import { listPublished, rejectPublishedDoc } from '$lib/server/published';
import { listAllEcosystems, readEcosystem } from '$lib/server/admin';
import { ECOSYSTEM_COOKIE, listEcosystems } from '$lib/server/ecosystem';
import { listHolds, mayReviewAnywhere, mayReviewSlug, readReviewCapability } from '$lib/server/holds';
import { ECOSYSTEM_DEPENDENCY, resolveEcosystemSelection } from '$lib/ecosystems';
import { MAX_NOTE_LENGTH, NOT_A_REVIEWER } from '$lib/holds';

const REJECT_FAILED = 'No pudimos guardar tu decisión. Vuelve a intentarlo.';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url, cookies, depends }) => {
  // Re-run when the sidebar picker switches. The cookie is not a tracked
  // dependency, so without this a mounted page keeps the old ecosistema.
  depends(ECOSYSTEM_DEPENDENCY);

  // `hooks.server.ts` already bounced anonymous callers; this is the belt to
  // that braces, and it is what makes the check readable here.
  const capability = locals.user ? await readReviewCapability(locals.token) : null;
  if (!capability || !mayReviewAnywhere(capability)) {
    denyAccess({
      module: 'holds',
      reason: 'no-holds-review',
      message: NOT_A_REVIEWER,
      cta: { label: 'Volver al chat', href: '/' },
    });
  }

  // The caller's OWN ecosistemas, used to offer a choice and to pick a default.
  // ⚠ Filtered by the capability, not merely listed: someone who is an
  // investigador in one ecosistema and an ordinary member in another must not
  // be offered a switcher that lands on a refusal.
  const mine = await listEcosystems(locals.token);
  const reviewable = mine.list.filter((eco) => mayReviewSlug(capability, eco.slug));

  const requested = url.searchParams.get('eco') ?? '';
  // ⚠ Read with the CALLER'S OWN token, so an id they cannot see comes back
  // null. The browser therefore cannot name an arbitrary ecosistema here.
  const requestedEco = requested ? await readEcosystem(locals.token, requested) : null;
  const allowed = requestedEco && mayReviewSlug(capability, requestedEco.slug) ? requestedEco : null;

  // ⚠ A PLATFORM ADMIN MAY BELONG TO NOTHING and still review everywhere —
  // that is the owner's rule, verbatim: *"admin es admin, no necesita ser
  // miembro para ver todo"*. Without this branch their queue would open on
  // "no perteneces a ningún ecosistema", which is true and useless. The
  // directory is read ONLY to pick a default; the switcher above still lists
  // memberships, because 90 chips is not a switcher.
  // ⚠ The picker's choice counts only if it is a real membership (`requested`,
  // not `fallback`) AND this person may review there. Otherwise a member who
  // reviews in A but picked B would open on a refusal.
  const picked = resolveEcosystemSelection(mine.list, cookies.get(ECOSYSTEM_COOKIE));
  const pickedEco =
    picked.source === 'requested' && picked.selected && mayReviewSlug(capability, picked.selected.slug)
      ? picked.selected
      : null;

  let fallback = pickedEco ?? reviewable[0] ?? null;
  if (!allowed && !fallback && capability.isPlatformAdmin) {
    const directory = await listAllEcosystems(locals.token, '');
    fallback = directory.rows[0] ?? null;
  }

  const selected = allowed ?? fallback;

  if (!selected) {
    // ⚠ Three different "nothing here" cases and they are not the same
    // sentence. `mine.ok === false` means the backend read failed — telling
    // someone they belong to nothing when the backend is merely unreachable
    // sends them to ask an administrator for access they already have.
    return {
      state: mine.ok ? ('no-ecosystem' as const) : ('unavailable' as const),
      selected: null,
      ecosystems: [],
      holds: [],
      published: [],
      notFound: Boolean(requested),
    };
  }

  const [result, published] = await Promise.all([
    listHolds(locals.token, selected.id),
    listPublished(locals.token, selected.id),
  ]);

  return {
    // ⚠ `not-found` from the API is folded into `unavailable` for display. The
    // backend refuses to say which of five reasons it was, and inventing a
    // distinction here would undo that on the screen.
    state: result.state === 'ready' ? ('ready' as const) : ('unavailable' as const),
    selected,
    ecosystems: reviewable,
    holds: result.state === 'ready' ? result.value : [],
    /** Owner rule 2026-10-24: review is after the fact, so published testimonios are listed too. */
    published: published.state === 'ready' ? published.value : [],
    /** `true` ⇒ `?eco=` named something they cannot review. Say so plainly. */
    notFound: Boolean(requested) && allowed === null,
  };
};

/**
 * Reject a published testimonio (owner rule 2026-10-24: participants'
 * testimonios publish on their own; review is occasional and after the fact).
 * The backend checks the reviewer and the ecosistema; this only forwards.
 */
export const actions: Actions = {
  rechazar: async ({ locals, request }) => {
    const capability = locals.user ? await readReviewCapability(locals.token) : null;
    if (!capability || !mayReviewAnywhere(capability)) {
      denyAccess({
        module: 'holds',
        reason: 'no-holds-review',
        message: NOT_A_REVIEWER,
        cta: { label: 'Volver al chat', href: '/' },
      });
    }
    const form = await request.formData();
    const id = String(form.get('id') ?? '');
    if (!id) return fail(400, { message: REJECT_FAILED });
    const note = String(form.get('note') ?? '').trim().slice(0, MAX_NOTE_LENGTH) || undefined;

    const result = await rejectPublishedDoc(locals.token, id, note);
    if (result.state === 'not-found') {
      return fail(404, { message: 'Este testimonio ya no está publicado.' });
    }
    if (result.state !== 'ready') return fail(502, { message: REJECT_FAILED });
    redirect(303, '/revision?hecho=rejected');
  },
};
