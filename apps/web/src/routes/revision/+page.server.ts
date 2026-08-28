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
 *  2. WHICH ECOSISTEMA? Resolved to ONE id, from `?eco=` validated by
 *     `readEcosystem`, and passed explicitly into the query. Same shape as
 *     `/admin`, which has the same oversight problem: this is a screen where
 *     somebody looks at material on behalf of a tenant, so the tenant has to be
 *     named, visible in the URL, and gone when you leave.
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
 * `eco_selected` cookie. That cookie decides where this person's own uploads
 * land. Reviewing a tenant must never quietly re-point the tenant you work in.
 *
 * ── 🔴 WHAT THE QUEUE SHOWS, AND WHAT IT CANNOT ────────────────────────────
 *
 * Neutral titles, the stage that refused, how many identifiers survived, and
 * when. No text — the API deliberately sends none to a list endpoint — and
 * nothing about who the document is about or who uploaded it. There is no field
 * here that could name a person, and none may be added.
 */

import { denyAccess } from '$lib/server/deny';
import { listAllEcosystems, readEcosystem } from '$lib/server/admin';
import { listEcosystems } from '$lib/server/ecosystem';
import { listHolds, mayReviewAnywhere, mayReviewSlug, readReviewCapability } from '$lib/server/holds';
import { NOT_A_REVIEWER } from '$lib/holds';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
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
  let fallback = reviewable[0] ?? null;
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
      notFound: Boolean(requested),
    };
  }

  const result = await listHolds(locals.token, selected.id);

  return {
    // ⚠ `not-found` from the API is folded into `unavailable` for display. The
    // backend refuses to say which of five reasons it was, and inventing a
    // distinction here would undo that on the screen.
    state: result.state === 'ready' ? ('ready' as const) : ('unavailable' as const),
    selected,
    ecosystems: reviewable,
    holds: result.state === 'ready' ? result.value : [],
    /** `true` ⇒ `?eco=` named something they cannot review. Say so plainly. */
    notFound: Boolean(requested) && allowed === null,
  };
};
