import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { fetchLenguaIndex } from '$lib/server/lenguas';

/**
 * `GET /api/lenguas` — the languages the current ecosistema's published
 * documentos are about, with counts. Feeds the chat's "Lengua" control.
 *
 * ⚠ The browser names no ecosistema: `resolveEcosystem` derives it from the
 * session and the re-validated selection cookie, as `/api/biblioteca` does.
 * Only the facets leave; the document id → lengua map is not needed here.
 */
export const GET: RequestHandler = async ({ locals, cookies }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const eco = await resolveEcosystem(cookies, locals.token);
  if (!eco.ok) return json({ ok: false, lenguas: [] });
  if (!eco.selected) return json({ ok: true, lenguas: [] });

  const result = await fetchLenguaIndex(locals.token, eco.selected.id);
  return json({ ok: result.ok, lenguas: result.index.lenguas });
};
