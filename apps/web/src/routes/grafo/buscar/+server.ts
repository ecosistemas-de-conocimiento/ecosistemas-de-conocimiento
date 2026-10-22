import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { isPlatformAdmin } from '$lib/components/admin/summary';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { fetchGraphView } from '$lib/server/graph';
import { GRAPH_SEARCH_MAX_LENGTH, graphSearchEnabled } from '$lib/graph';

/**
 * `POST /grafo/buscar` `{ q, eco? }` → `{ ids }` — the /grafo full-text search
 * (backlog #31). The ids are the entities the map highlights.
 *
 * The backend does the work (`/api/graph/view?q=`, `lib/graph/queries.ts`
 * `buildSearchFilter`): names, plus the published documents of this ecosistema
 * whose corpus text matches, under the view's own gates and threshold. So a
 * search can only narrow what the map already shows.
 *
 * 🔴 SCOPE IS DECIDED EXACTLY AS `+page.server.ts` DECIDES IT. A member's
 * ecosistema comes from `resolveEcosystem` (the re-validated cookie) and `eco`
 * is ignored; only a platform admin may name one, and the backend's
 * `authoriseOrganization` re-checks membership either way.
 *
 * ⚠ POST, so the words stay out of the browser history and `Referer`.
 */
export const POST: RequestHandler = async ({ locals, cookies, request }) => {
  if (!graphSearchEnabled(env.GRAPH_SEARCH_ENABLED)) return json({ error: 'not found' }, { status: 404 });
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { q?: unknown; eco?: unknown } | null;
  // NUL bytes would 500 in Postgres; the backend strips them too.
  const q = (typeof body?.q === 'string' ? body.q : '')
    .replaceAll('\u0000', '')
    .trim()
    .slice(0, GRAPH_SEARCH_MAX_LENGTH);
  if (q === '') return json({ ids: [] });

  let organizationId: string | null = null;
  if (isPlatformAdmin(locals.user) && typeof body?.eco === 'string' && body.eco.trim()) {
    organizationId = body.eco.trim().slice(0, 120);
  } else {
    const eco = await resolveEcosystem(cookies, locals.token);
    organizationId = eco.selected?.id ?? null;
  }
  if (!organizationId) return json({ ids: [] });

  const result = await fetchGraphView(locals.token, { organizationId, q });
  if (!result.ok) return json({ error: 'unavailable' }, { status: 502 });
  return json(
    { ids: result.view.entities.map((e) => e.id) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
