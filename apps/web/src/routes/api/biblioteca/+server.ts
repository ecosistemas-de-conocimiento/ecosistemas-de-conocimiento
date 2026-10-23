import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { normalizeSearch, parseKindFilter } from '$lib/biblioteca';
import { listPublished, LIBRARY_PAGE_SIZE } from '$lib/server/biblioteca';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { fetchLenguaIndex } from '$lib/server/lenguas';
import { documentIdsForLengua, parseLengua } from '$lib/lengua';

/**
 * `GET /api/biblioteca` — one page of the ecosistema's PUBLISHED library.
 *
 * ⚠ THE BROWSER NAMES NOTHING BUT THE FILTER. No user id, no organization, no
 * corpus — same rule as every other BFF route here. The ecosistema is DERIVED
 * from the caller's session and the selection cookie, re-validated against
 * their real memberships on every request by `resolveEcosystem`. A client that
 * could name an ecosistema could read one it does not belong to.
 *
 * ⚠ `?page=`, `?q=`, `?kind=` and `?lengua=` are the only inputs, and all four
 * are normalised before they reach a query string. `?lengua=` becomes a list of
 * documento ids (`/api/lenguas`), never a `where[lengua]` — see `$lib/lengua.ts`.
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

  const lengua = parseLengua(url.searchParams.get('lengua'));
  const lenguas = await fetchLenguaIndex(locals.token, eco.selected.id);
  const ecosystem = { id: eco.selected.id, name: eco.selected.name };

  // ⚠ A lengua was asked for and we cannot tell which documentos have it.
  // Listing everything under that filter label would be the wrong answer.
  if (lengua && !lenguas.ok) {
    return json(
      { state: 'unavailable', ecosystem, items: [], total: 0, page: 1, hasNextPage: false, lengua, lenguas: [] },
      { status: 200 },
    );
  }
  const documentIds = lengua ? documentIdsForLengua(lenguas.index.byDocument, lengua) : undefined;
  if (documentIds && documentIds.length === 0) {
    return json(
      {
        state: 'ready',
        ecosystem,
        items: [],
        total: 0,
        page: 1,
        pageSize: LIBRARY_PAGE_SIZE,
        hasNextPage: false,
        kind,
        q: search,
        lengua,
        lenguas: lenguas.index.lenguas,
      },
      { status: 200 },
    );
  }

  const result = await listPublished(locals.token, {
    organizationId: eco.selected.id,
    kind,
    search,
    page,
    ...(documentIds ? { documentIds } : {}),
    ecosystemName: eco.selected.name,
  });

  return json(
    {
      // ⚠ The read failed, and that is not the same as an empty library. The
      // page renders this as "no pudimos leerla", never as "no hay nada".
      state: result.ok ? 'ready' : 'unavailable',
      ecosystem,
      items: result.items,
      total: result.total,
      page: result.page,
      pageSize: LIBRARY_PAGE_SIZE,
      hasNextPage: result.hasNextPage,
      kind,
      q: search,
      lengua,
      // The facets for the filter control. Empty when the index could not be
      // read — the control then simply does not appear.
      lenguas: lenguas.index.lenguas,
    },
    { status: 200 },
  );
};
