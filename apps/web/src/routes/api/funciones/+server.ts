import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { ECOSYSTEM_COOKIE } from '$lib/server/ecosystem';
import { fetchFeatures } from '$lib/server/features';

/**
 * GET /api/funciones → `{ features }` of the selected ecosistema, for the UI to
 * hide what is off. Presentation only: the backend enforces every switch.
 * The cookie is a hint; the backend checks membership (a stranger's id reads
 * as the defaults).
 */
export const GET: RequestHandler = async ({ locals, cookies }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
  const features = await fetchFeatures(locals.token, cookies.get(ECOSYSTEM_COOKIE) ?? null);
  return json({ features }, { headers: { 'cache-control': 'no-store' } });
};
