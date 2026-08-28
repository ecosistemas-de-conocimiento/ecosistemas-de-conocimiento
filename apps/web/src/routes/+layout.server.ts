import { readReviewCapability, mayReviewAnywhere } from '$lib/server/holds';
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
export const load: LayoutServerLoad = async ({ locals }) => {
  const capability = locals.user ? await readReviewCapability(locals.token) : null;
  return {
    user: locals.user,
    canReviewHolds: capability ? mayReviewAnywhere(capability) : false,
  };
};
