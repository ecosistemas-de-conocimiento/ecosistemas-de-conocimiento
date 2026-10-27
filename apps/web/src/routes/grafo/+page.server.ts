/**
 * `/grafo` — cómo se conecta lo que publica un ecosistema.
 *
 * ── 🔴 ONE VIEW, EVERY ROLE (ADR §7.1) ──────────────────────────────────────
 *
 * There is deliberately NO unprotected internal view. The minimum-support
 * threshold, the published-only scope and the person rule apply to a platform
 * admin exactly as they apply to a member. What differs by role is SCOPE
 * SELECTION — which ecosistema you may look at — and never content.
 *
 * ── 🔴 HOW THE SCOPE IS DECIDED, AND THE ONE PLACE IT BRANCHES ──────────────
 *
 * For an ordinary member: `resolveEcosystem`, which re-validates the selection
 * cookie against the caller's real memberships on every request. Unchanged.
 *
 * For a PLATFORM ADMIN: `?eco=<id>`, validated by a direct read against the
 * organizations that actually exist. This is `/admin`'s pattern
 * (`routes/admin/+page.server.ts`) and it is here for the same reason: oversight
 * is not membership. Before it, an admin with no membership was told *"no
 * perteneces a ningún ecosistema… pídele acceso a quien administra"* — on a page
 * whose backend (`endpoints/graph.ts`, `authoriseOrganization`) already accepts
 * any organization id from them.
 *
 * ⚠ IT SELECTS SCOPE, IT DOES NOT RELAX ANYTHING. The admin's request goes to
 * the same three org-scoped endpoints, which apply the same threshold and the
 * same published-only rule. There is no admin branch below this point.
 *
 * ⚠ AND IT NEVER WRITES THE `eco_selected` COOKIE. That cookie decides where
 * this person's OWN uploads and conversations land, and `Sessions.beforeValidate`
 * still refuses an ecosistema they are not a member of. Looking at a tenant must
 * not quietly re-point the tenant you WORK in. Hence a URL parameter: visible,
 * shareable, and gone when you leave. Same rule `/admin` states.
 *
 * ⚠ ONE DELIBERATE DIFFERENCE FROM `/admin`. An admin's DEFAULT here is their
 * own resolved membership (the cookie the sidebar picker sets), not
 * `mine.list[0]`. `/grafo` has a member reading of itself and `/admin` does
 * not: an admin who belongs to an ecosistema should see the same one here that
 * the rest of the app is showing them, or the menu and the page disagree.
 *
 * ⚠ FOR EVERYONE ELSE THE BROWSER STILL NAMES NO ECOSISTEMA. Same rule as
 * `/api/biblioteca`: a client that can name an organization can read one it does
 * not belong to. `?eco=` is read ONLY after `isPlatformAdmin` passes; for a
 * member the parameter does not exist. The other two things read out of the URL
 * are entity ids, and both go to an org-scoped endpoint that will simply not
 * find them if they belong somewhere else.
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
 * ⚠ The search box is NOT in the URL and this load does NOT re-run for it. It
 * asks `/grafo/buscar` (full-text over the published documents, backlog #31)
 * and only the highlight changes. Accent-insensitive — a Spanish product where
 * `migracion` does not find `Migración` reads as "eso no está".
 */

import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';
import { isPlatformAdmin } from '$lib/components/admin/summary';
import { listAllEcosystems, readEcosystem } from '$lib/server/admin';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { fetchGraphEntity, fetchGraphView, mergeLenguaIndexes } from '$lib/server/graph';
import { fetchLenguaIndex } from '$lib/server/lenguas';
import { fetchFeatures } from '$lib/server/features';
import { parseLengua, type GrafoLenguaData } from '$lib/lengua';
import {
  canCombineEcosystems,
  GRAPH_COMBINED_ECO,
  GRAPH_COMBINED_LABEL,
  GRAPH_COMBINED_ORGANIZATION,
  graphSearchEnabled,
  sharedDocuments,
  type GrafoPageData,
  type GraphScopePicker,
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

/** Same cap `/admin` puts on its ecosistema search box. */
const MAX_SEARCH_LENGTH = 120;

function readId(raw: string | null): string {
  return (raw ?? '').trim().slice(0, MAX_ID_LENGTH);
}

/** Combined view: lengua reads, one per ecosistema, at most this many. */
const MAX_LENGUA_READS = 20;

const EMPTY_VIEW: GraphView = { entities: [], hidden: 0, minSupport: null, publishedDocuments: null };

export const load: PageServerLoad = async ({
  locals,
  cookies,
  url,
}): Promise<GrafoPageData & GrafoLenguaData> => {
  // `?lengua=` narrows the DOCUMENT lists in the panel, never the graph itself:
  // entity and edge supports are counted by the backend over every published
  // document, and recounting them over a subset is the graph lane's call (and
  // its minimum-support threshold's). See `$lib/lengua.ts`.
  const lengua = parseLengua(url.searchParams.get('lengua'));
  const base: GrafoPageData & GrafoLenguaData = {
    lengua,
    lenguas: [],
    lenguaByDocument: {},
    state: 'ready',
    ecosystem: null,
    view: EMPTY_VIEW,
    viewOk: false,
    entity: null,
    entityState: 'none',
    edge: null,
    scope: null,
    searchEnabled: graphSearchEnabled(env.GRAPH_SEARCH_ENABLED),
    combined: false,
    ecosystemNames: {},
  };

  // `hooks.server.ts` already bounces anonymous callers to /sign-in; this is
  // the belt to that braces, and it keeps the check readable here.
  if (!locals.user) return { ...base, state: 'unavailable' };

  // 🔴 The ONE role check on this route, and the only thing it unlocks is which
  // ecosistema may be named. See the header.
  const admin = isPlatformAdmin(locals.user);
  const rawEco = readId(url.searchParams.get('eco'));
  // 🔴 `?eco=todos` is a WORD, not a list: the backend derives the set from
  // the caller's memberships (`authoriseCombined`). See `$lib/graph.ts`.
  const wantsCombined = rawEco === GRAPH_COMBINED_ECO;
  const requestedEcoId = admin && !wantsCombined ? rawEco : '';
  const ecoSearch = admin ? (url.searchParams.get('q') ?? '').slice(0, MAX_SEARCH_LENGTH) : '';

  // One round trip's latency for all three: the caller's memberships (which is
  // also the admin's default), the installation's directory, and the ecosistema
  // `?eco=` named — resolved by a DIRECT read so a term in the search box
  // cannot make the ecosistema being viewed disappear.
  const [eco, directory, requestedEco] = await Promise.all([
    resolveEcosystem(cookies, locals.token),
    admin ? listAllEcosystems(locals.token, ecoSearch) : null,
    admin && requestedEcoId ? readEcosystem(locals.token, requestedEcoId) : null,
  ]);

  const combinedOffered = canCombineEcosystems(eco.list.length, admin);
  const combined = wantsCombined && combinedOffered;
  // A member (2+ ecosistemas) may name one of THEIR OWN in `?eco=`; anything
  // else is ignored, and the backend re-checks membership regardless.
  const memberPick =
    !admin && rawEco && !wantsCombined ? (eco.list.find((e) => e.id === rawEco) ?? null) : null;

  const scope: GraphScopePicker | null =
    admin && directory
      ? {
          rows: directory.rows,
          total: directory.totalDocs,
          truncated: directory.truncated,
          ok: directory.ok,
          search: directory.search,
          // ⚠ Membership LABELS the rows; it restricts nothing. See the type.
          mine: eco.list.map((e) => e.id),
          notFound: Boolean(requestedEcoId) && requestedEco === null,
          admin: true,
          combined: combinedOffered,
        }
      : combinedOffered
        ? {
            rows: eco.list,
            total: eco.list.length,
            truncated: false,
            ok: eco.ok,
            search: '',
            mine: eco.list.map((e) => e.id),
            notFound: Boolean(rawEco) && !wantsCombined && memberPick === null,
            admin: false,
            combined: true,
          }
        : null;

  const ecosystemNames: Record<string, string> = {};
  for (const e of [...(directory?.rows ?? []), ...eco.list, ...(requestedEco ? [requestedEco] : [])]) {
    ecosystemNames[e.id] = e.name;
  }

  const selected = combined
    ? { id: GRAPH_COMBINED_ECO, name: GRAPH_COMBINED_LABEL }
    : (requestedEco ?? memberPick ?? eco.selected ?? directory?.rows[0] ?? null);

  // ⚠ Three different "nothing to show" cases, and they must not read the same.
  // `ok: false` means we could not tell — saying "no perteneces a ningún
  // ecosistema" there sends someone to ask for access they already have.
  if (!selected) {
    // For an admin, "we could not tell" needs BOTH reads to have failed: an
    // unreadable membership list is irrelevant when the directory came back.
    const couldNotTell = admin ? !eco.ok && !directory?.ok : !eco.ok;
    return { ...base, scope, state: couldNotTell ? 'unavailable' : 'no-ecosystem' };
  }

  const organizationId = combined ? GRAPH_COMBINED_ORGANIZATION : selected.id;
  const entityId = readId(url.searchParams.get('entidad'));
  const edgeId = readId(url.searchParams.get('conexion'));

  // One round trip's latency, not three: the view, the focused entity and the
  // neighbour whose shared documents we intersect all go out together.
  // The ecosistema's switches (`$lib/features`). Combined: the backend leaves
  // out each ecosistema whose `graph`/`combinedGraph` is off.
  const features = combined ? null : await fetchFeatures(locals.token, selected.id);
  if (features && !features.graph) {
    return { ...base, scope, ecosystem: { id: selected.id, name: selected.name }, graphOff: true };
  }

  const [viewResult, entityResult, edgeResult, lenguaResult] = await Promise.all([
    fetchGraphView(locals.token, { organizationId }),
    entityId ? fetchGraphEntity(locals.token, organizationId, entityId) : null,
    entityId && edgeId && edgeId !== entityId
      ? fetchGraphEntity(locals.token, organizationId, edgeId)
      : null,
    // Best-effort: a failed read just leaves the lengua panel and chips out.
    // Combined: one read per ecosistema the caller may name, merged.
    combined
      ? Promise.all(
          (admin ? (directory?.rows ?? []) : eco.list).slice(0, MAX_LENGUA_READS).map((e) => fetchLenguaIndex(locals.token, e.id)),
        ).then((all) => ({ index: mergeLenguaIndexes(all.map((r) => r.index)) }))
      : fetchLenguaIndex(locals.token, organizationId),
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
          // 🔴 PREFER THE REAL PER-EDGE EVIDENCE. `neighbours[].documents` comes
          // from `graph_relations` and answers "which documents evidence THIS
          // edge". The intersection below is the old approximation and stays
          // only as a fallback for a backend that does not send the field —
          // with `exact: false`, so the copy tells the truth either way.
          documents:
            neighbour.documents !== null
              ? neighbour.documents
              : edgeResult?.state === 'ok'
                ? sharedDocuments(detail.documents, edgeResult.detail.documents)
                : [],
          exact: neighbour.documents !== null,
          // The neighbour's own read only matters for the fallback; with
          // per-edge evidence in hand the centre's response is the whole answer.
          ok: neighbour.documents !== null || edgeResult?.state === 'ok',
        }
      : null;

  return {
    lengua,
    lenguas: lenguaResult.index.lenguas,
    lenguaByDocument: lenguaResult.index.byDocument,
    state: 'ready',
    ecosystem: { id: selected.id, name: selected.name },
    view: viewResult.view,
    viewOk: viewResult.ok,
    entity: detail,
    entityState: entityResult ? entityResult.state : 'none',
    edge,
    scope,
    searchEnabled: base.searchEnabled,
    combined,
    ecosystemNames,
    allow3d: features ? features.graph3d : true,
  };
};
