import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { normalizeSearch, parseKindFilter } from '$lib/biblioteca';
import { listPublished, LIBRARY_PAGE_SIZE } from '$lib/server/biblioteca';
import { resolveEcosystem } from '$lib/server/ecosystem';

/**
 * `GET /api/biblioteca` — one page of the ecosistema's PUBLISHED library.
 *
 * ⚠ THE BROWSER NAMES NOTHING BUT THE FILTER. No user id, no organization, no
 * corpus — same rule as every other BFF route here. The ecosistema is DERIVED
 * from the caller's session and the selection cookie, re-validated against
 * their real memberships on every request by `resolveEcosystem`. A client that
 * could name an ecosistema could read one it does not belong to.
 *
 * ⚠ `?page=` and `?q=` and `?kind=` are the only inputs, and all three are
 * normalised before they reach a query string.
 */
export const GET: RequestHandler = async ({ locals, cookies, url }) => {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const eco = await resolveEcosystem(cookies, locals.token);

  // ⚠ Three different "nothing to show" cases, and they must not read the same.
  // `ok: false` means we could not tell — saying "no perteneces a ningún
  // ecosistema" there sends someone to ask for access they already have.
  if (!eco.ok) {
    return json(
      { state: 'unavailable', ecosystem: null, items: [], total: 0, page: 1, hasNextPage: false },
      { status: 200 },
    );
  }
  if (!eco.selected) {
    return json(
      { state: 'no-ecosystem', ecosystem: null, items: [], total: 0, page: 1, hasNextPage: false },
      { status: 200 },
    );
  }

  const kind = parseKindFilter(url.searchParams.get('kind'));
  const search = normalizeSearch(url.searchParams.get('q'));
  const requestedPage = Number(url.searchParams.get('page'));
  const page = Number.isFinite(requestedPage) && requestedPage >= 1 ? Math.floor(requestedPage) : 1;

  const result = await listPublished(locals.token, {
    organizationId: eco.selected.id,
    kind,
    search,
    page,
  });

  return json(
    {
      // ⚠ The read failed, and that is not the same as an empty library. The
      // page renders this as "no pudimos leerla", never as "no hay nada".
      state: result.ok ? 'ready' : 'unavailable',
      ecosystem: { id: eco.selected.id, name: eco.selected.name },
      items: result.items,
      total: result.total,
      page: result.page,
      pageSize: LIBRARY_PAGE_SIZE,
      hasNextPage: result.hasNextPage,
      kind,
      q: search,
    },
    { status: 200 },
  );
};
