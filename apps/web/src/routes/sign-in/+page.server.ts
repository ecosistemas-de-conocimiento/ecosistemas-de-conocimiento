import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { dev } from '$app/environment';
import { signIn } from '$lib/server/auth';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (locals.user) throw redirect(303, '/');
  // 🔴 A GET never signs anyone in. If credentials arrived in the query (an old
  // pre-hydration GET submit, a pasted link), drop them from the address bar.
  if (url.searchParams.has('password') || url.searchParams.has('email')) {
    throw redirect(303, '/sign-in');
  }
  return {};
};

/**
 * The no-JS path: a submit before hydration posts the form natively here. Same
 * helper as `/api/auth/login`, so the same cookie and the same redirect as the
 * JS path.
 */
export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const form = await request.formData();
    const result = await signIn(form.get('email'), form.get('password'), cookies, !dev);
    // 🔴 Only the Spanish sentence goes back — never the email or password.
    if (!result.ok) return fail(result.status, { error: result.error });
    throw redirect(303, '/');
  },
};
