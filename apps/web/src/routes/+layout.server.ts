import type { LayoutServerLoad } from './$types';

// Expose the authenticated user (or null) to all pages. Auth pages read it to
// detect "already signed in" and bounce to /. Protected pages can show
// display name / sign-out without re-fetching.
export const load: LayoutServerLoad = async ({ locals }) => {
  return { user: locals.user };
};
