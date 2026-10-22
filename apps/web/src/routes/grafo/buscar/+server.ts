import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { isPlatformAdmin } from '$lib/components/admin/summary';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { fetchGraphView } from '$lib/server/graph';
import {
  canCombineEcosystems,
  GRAPH_COMBINED_ECO,
  GRAPH_COMBINED_ORGANIZATION,
  GRAPH_SEARCH_MAX_LENGTH,
  graphSearchEnabled,
} from '$lib/graph';

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

  const admin = isPlatformAdmin(locals.user);
  const requested = typeof body?.eco === 'string' ? body.eco.trim().slice(0, 120) : '';
  let organizationId: string | null = null;
  if (requested === GRAPH_COMBINED_ECO) {
    // 🔴 The combined scope is a WORD: the backend derives the ecosistemas from
    // the caller's memberships and 403s a member of fewer than two.
    const eco = admin ? null : await resolveEcosystem(cookies, locals.token);
    if (!admin && !canCombineEcosystems(eco?.list.length ?? 0, false)) return json({ ids: [] });
    organizationId = GRAPH_COMBINED_ORGANIZATION;
  } else if (admin && requested) {
    organizationId = requested;
  } else {
    const eco = await resolveEcosystem(cookies, locals.token);
    // A member may name one of their own ecosistemas (the /grafo picker).
    organizationId = eco.list.find((e) => e.id === requested)?.id ?? eco.selected?.id ?? null;
  }
  if (!organizationId) return json({ ids: [] });

  const result = await fetchGraphView(locals.token, { organizationId, q });
  if (!result.ok) return json({ error: 'unavailable' }, { status: 502 });
  return json(
    { ids: result.view.entities.map((e) => e.id) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
