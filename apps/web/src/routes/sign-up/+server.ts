import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * 🔴 SIGN-UP IS CLOSED (UX demo backlog #6, decided 2026-10-21).
 *
 * A stranger who signed up got a login that belonged to no ecosistema — nothing
 * to do, and a confusing screen. Accounts are now created by a platform admin
 * (the backend refuses `POST /api/users` from anyone else). This path stays only
 * so old links land somewhere that explains it: the sign-in page reads
 * `?registro=cerrado` and says, in plain words, who to ask.
 */
export const GET: RequestHandler = () => {
  throw redirect(303, '/sign-in?registro=cerrado');
};
