import {
  HOLDS_REVIEW,
  mayReviewAnywhere,
  readIdentity,
  reviewCapabilityFrom,
} from '$lib/server/holds';
import { MEMBERS_MANAGE } from '$lib/server/miembros';
import { ECOSYSTEM_COOKIE } from '$lib/server/ecosystem';
import { fetchStudentAccess, NO_ACCESS } from '$lib/server/estudiante';
import { VOCES_UPLOAD } from '$lib/uploadKind';
import type { LayoutServerLoad } from './$types';

// Expose the authenticated user (or null) to all pages. Auth pages read it to
// detect "already signed in" and bounce to /. Protected pages can show
// display name / sign-out without re-fetching.
//
// ⚠ AND ONE CAPABILITY, because the menu has to branch on it.
//
// `canReviewHolds` answers "may this person review held documents ANYWHERE" —
// the only question `$lib/nav.ts` asks. It is computed here, from the backend's
// own flat permission list, rather than by expanding a role in the frontend:
// see the header of `$lib/server/holds.ts` for why that distinction is not
// cosmetic.
//
// 🔴 IT IS PRESENTATION, AND IT IS NOT ON THE USER OBJECT. Stamping it onto
// `user` would make it look like a field the backend vouches for. It is an
// answer this request computed, it only hides or shows a link, and
// `routes/revision/+page.server.ts` re-asks the real question — against a named
// ecosistema — before the page renders anything.
//
// ⚠ Costs one backend call per full page load, not per client-side navigation:
// this load reads only `locals`, which SvelteKit does not track as a
// dependency, so it does not re-run when the URL changes.
//
// ⚠ AND `vocesUpload` — where this person may file a Voz (`voces:upload`, per
// ecosistema). Same presentation-only status: `DocsPanel` shows the
// "Voz / testimonio" choice from it, and the backend's
// `enforceVocesUploadRights` is the control. One identity read serves both.
export const load: LayoutServerLoad = async ({ locals, cookies }) => {
  const identity = locals.user ? await readIdentity(locals.token) : null;
  const ok = identity !== null;
  const holds = ok ? reviewCapabilityFrom(identity, HOLDS_REVIEW) : null;
  const members = ok ? reviewCapabilityFrom(identity, MEMBERS_MANAGE) : null;
  // `organization:manage` = responsable (owner). Presentation; `/ajustes` re-asks.
  const owners = ok ? reviewCapabilityFrom(identity, 'organization:manage') : null;
  const vocesUpload = ok
    ? reviewCapabilityFrom(identity, VOCES_UPLOAD)
    : { isPlatformAdmin: false, slugs: [], ok: false };
  // Student view: presentation only; every `/api/estudiante` route re-checks.
  const studentAccess = locals.user
    ? await fetchStudentAccess(locals.token, cookies.get(ECOSYSTEM_COOKIE) ?? null)
    : NO_ACCESS;
  return {
    user: locals.user,
    studentAccess,
    canReviewHolds: holds ? mayReviewAnywhere(holds) : false,
    // Same presentation-only status; `routes/miembros` re-asks.
    canManageMembers: members ? mayReviewAnywhere(members) : false,
    canEditFeatures: owners ? mayReviewAnywhere(owners) : false,
    vocesUpload,
    /** Per-ecosistema `holds:review`: who sees a document card's "Anonimización" link. */
    holdsReview: holds ?? { isPlatformAdmin: false, slugs: [], ok: false },
  };
};
