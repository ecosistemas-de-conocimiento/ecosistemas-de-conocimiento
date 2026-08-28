/**
 * `/grafo` — cómo se conecta lo que publica un ecosistema.
 *
 * ── 🔴 ONE VIEW, EVERY ROLE (ADR §7.1) ──────────────────────────────────────
 *
 * There is deliberately NO unprotected internal view. The minimum-support
 * threshold, the published-only scope and the person rule apply to a platform
 * admin exactly as they apply to a member. What differs by role is WHICH
 * ecosistema you may look at — and even that is not decided here: it comes from
 * `resolveEcosystem`, which re-validates the selection cookie against the
 * caller's real memberships on every request.
 *
 * ⚠ THE BROWSER NAMES NO ECOSISTEMA. Same rule as `/api/biblioteca`: a client
 * that can name an organization can read one it does not belong to. The only
 * things this route reads out of the URL are two entity ids, and both are
 * passed to an org-scoped backend endpoint that will simply not find them if
 * they belong somewhere else.
 *
 * ── WHY A `+page.server.ts` AND NOT A BFF ROUTE ─────────────────────────────
 *
 * SSR is off app-wide (`+layout.ts`), and `/admin` proves a server `load` still
 * works: SvelteKit fetches it as a data request. Keeping the reads here means
 * the tenant scope is decided in ONE place, and it means the selected entity
 * lives in the URL — so "mira las conexiones de este tema" is a link somebody
 * can send, and the back button undoes a selection instead of leaving the page.
 * Same reasoning as `/biblioteca`'s `?q=` and `/admin`'s `?eco=`.
 *
 * ⚠ The search box is NOT in the URL and does NOT round-trip. The ranked lists
 * are loaded once and filtered in the browser, accent-insensitively — a Spanish
 * product where `migracion` does not find `Migración` reads as "eso no está".
 */

import type { PageServerLoad } from './$types';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { fetchGraphEntity, fetchGraphView } from '$lib/server/graph';
import {
  sharedDocuments,
  type GrafoPageData,
  type GraphView,
  type SelectedEdge,
} from '$lib/graph';

/**
 * ⚠ NOTHING IS EXPORTED FROM THIS FILE BUT `load`. SvelteKit rejects any other
 * export from a `+page.server.ts` at REQUEST time — the page 500s with "Invalid
 * export" and `svelte-check` says nothing. The page's data shapes therefore
 * live in `$lib/graph.ts`, which the page component imports directly. Same
 * footgun `/admin` records in its own header, for `?eco=` and `?q=`.
 */

/** Ids are opaque strings from our own backend; cap them so the URL cannot grow one. */
const MAX_ID_LENGTH = 120;

function readId(raw: string | null): string {
  return (raw ?? '').trim().slice(0, MAX_ID_LENGTH);
}

const EMPTY_VIEW: GraphView = { entities: [], hidden: 0, minSupport: null, publishedDocuments: null };

export const load: PageServerLoad = async ({ locals, cookies, url }): Promise<GrafoPageData> => {
  const base: GrafoPageData = {
    state: 'ready',
    ecosystem: null,
    view: EMPTY_VIEW,
    viewOk: false,
    entity: null,
    entityState: 'none',
    edge: null,
  };

  // `hooks.server.ts` already bounces anonymous callers to /sign-in; this is
  // the belt to that braces, and it keeps the check readable here.
  if (!locals.user) return { ...base, state: 'unavailable' };

  const eco = await resolveEcosystem(cookies, locals.token);
  // ⚠ Three different "nothing to show" cases, and they must not read the same.
  // `ok: false` means we could not tell — saying "no perteneces a ningún
  // ecosistema" there sends someone to ask for access they already have.
  if (!eco.ok) return { ...base, state: 'unavailable' };
  if (!eco.selected) return { ...base, state: 'no-ecosystem' };

  const organizationId = eco.selected.id;
  const entityId = readId(url.searchParams.get('entidad'));
  const edgeId = readId(url.searchParams.get('conexion'));

  // One round trip's latency, not three: the view, the focused entity and the
  // neighbour whose shared documents we intersect all go out together.
  const [viewResult, entityResult, edgeResult] = await Promise.all([
    fetchGraphView(locals.token, { organizationId }),
    entityId ? fetchGraphEntity(locals.token, organizationId, entityId) : null,
    entityId && edgeId && edgeId !== entityId
      ? fetchGraphEntity(locals.token, organizationId, edgeId)
      : null,
  ]);

  const detail = entityResult?.state === 'ok' ? entityResult.detail : null;

  // The edge is only real if the focused entity actually claims that neighbour.
  // A `?conexion=` naming anything else is ignored rather than half-rendered.
  const neighbour = detail?.neighbours.find((n) => n.entity.id === edgeId) ?? null;
  const edge: SelectedEdge | null =
    detail && neighbour
      ? {
          entity: neighbour.entity,
          relationType: neighbour.relationType,
          documents:
            edgeResult?.state === 'ok'
              ? sharedDocuments(detail.documents, edgeResult.detail.documents)
              : [],
          ok: edgeResult?.state === 'ok',
        }
      : null;

  return {
    state: 'ready',
    ecosystem: { id: eco.selected.id, name: eco.selected.name },
    view: viewResult.view,
    viewOk: viewResult.ok,
    entity: detail,
    entityState: entityResult ? entityResult.state : 'none',
    edge,
  };
};
