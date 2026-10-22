/**
 * THE CORPUS GRAPH, ON THE WIRE. `plan/adr-corpus-graph.md` §6, §7, §8.3.
 *
 *   GET  /api/graph/view?organization=<id>&type=<t>&q=<text>
 *   GET  /api/graph/entity/:id?organization=<id>
 *        → { entity, neighbours: [{ entity, relationType, support, documents }],
 *            documents }   — `neighbours[].documents` is the evidence for THAT
 *                            EDGE, not the intersection of two entity lists.
 *   POST /api/graph/retrieve      { organization, query, limit? }
 *
 *   `organization=all` on the first two: the COMBINED graph over the caller's
 *   own ecosistemas (`authoriseCombined`; `lib/graph/combined.ts`). Retrieval
 *   (chat) stays one ecosistema.
 *
 * ⚠ THESE THREE ROUTES ARE THE ONLY WAY TO READ THE GRAPH. The collections
 * themselves have `read: () => false` for everyone, platform admins included
 * (`collections/GraphEntities.ts` carries the full argument): Payload's access
 * control can express ONE of ADR §6's three gates, and the other two are a JOIN
 * and a `HAVING`. All three live in SQL in `lib/graph/queries.ts`, which is what
 * these handlers call.
 *
 * ── 🔴 AUTHORISATION IS MEMBERSHIP, RESOLVED SERVER-SIDE ───────────────────
 *
 * `organization` arrives from the client on every route and is NEVER trusted.
 * {@link authoriseOrganization} checks it against the caller's own active
 * memberships before a single graph row is read. This is the `/admin` route's
 * pattern (`apps/web/src/lib/server/admin.ts:10-30`) and it exists because
 * `visibleToCaller` returns bare `true` for a platform admin
 * (`collections/Documents.ts:83-107`) — access control is not a tenant filter.
 *
 * ⚠ A PLATFORM ADMIN MAY NAME ANY ECOSISTEMA, and that is deliberate, not an
 * oversight. ADR §7.1: what differs by role is SCOPE SELECTION, never content.
 * They see the same rows, under the same published-only and minimum-support
 * thresholds, as an ordinary member of that ecosistema — there is no unfiltered
 * view of this graph anywhere in the product. It matches the existing
 * `EcosystemSwitcher`, whose organization list is already unrestricted for that
 * role (`collections/Organizations.ts` → `withinMyOrganizations`).
 *
 * ⚠ AN UNKNOWN ECOSISTEMA AND ONE YOU DO NOT BELONG TO GET THE SAME 403. Telling
 * them apart turns the parameter into an existence oracle over every tenant.
 *
 * ── RATE LIMITING: PER USER AND PER ECOSISTEMA, NEVER PER IP ───────────────
 *
 * The reads are aggregate `GROUP BY … HAVING` over one tenant's rows, so the
 * exposure here is CPU rather than credentials, and the thing worth bounding is
 * total work per tenant. Hence two buckets: one that identifies the caller and
 * one that caps the ecosistema.
 *
 * 🔴 THERE IS NO PER-IP BUCKET, AND ADDING ONE WOULD BE AN OUTAGE. Every graph
 * request arrives from the web BFF, which forwards no `X-Forwarded-For` — so
 * `clientIp(req)` is the literal string `'unknown'` for every caller, and a
 * per-IP bucket would be one global bucket shared by every user of every
 * ecosistema. The full reasoning is on the buckets themselves in
 * `lib/rateLimit.ts`; it is written there because that is where someone adding
 * "one more bucket, for consistency" would be looking.
 *
 * ⚠ The limits are counted AFTER authorisation, like `/me` and `/token`, so the
 * bucket is keyed on a verified user and a verified ecosistema rather than on
 * anything a caller can assert.
 *
 * ── SPANISH ────────────────────────────────────────────────────────────────
 *
 * Every message a person can see is Spanish; identifiers are English. A 4xx
 * body from here reaches the UI unmodified.
 */

import type { Endpoint, PayloadRequest } from 'payload'

import { organizationIdsForUser } from '../lib/permissions'
import { isPlatformAdminUser } from '../access'
import {
  MAX_RETRIEVE_SEEDS,
  MAX_VIEW_ENTITIES,
  readEntityDetail,
  readEntityView,
  readGraphRetrieval,
  type GraphQueryPayload,
} from '../lib/graph/queries'
import { GRAPH_ENTITY_TYPES, type GraphEntityType } from '../lib/graph/types'
import {
  errorResponse,
  getAuthenticatedUser,
  guardRateLimit,
  jsonResponse,
  queryParam,
  readJsonBody,
} from './http'
import { rateLimits } from '../lib/rateLimit'
import { sql } from '@payloadcms/db-postgres'
import {
  normaliseOrgIds,
  readCombinedEntityDetail,
  readCombinedView,
} from '../lib/graph/combined'

/**
 * ⚠ `no-store` ON EVERY RESPONSE. A graph answer is scoped to one ecosistema and
 * one caller's membership; a shared proxy holding it would serve one tenant's
 * entity list to the next request that happened to match the URL.
 */
const NO_STORE = { 'Cache-Control': 'no-store' } as const

const ok = (body: unknown): Response => jsonResponse(body, { status: 200, headers: NO_STORE })

/**
 * A positive integer id, or `null`.
 *
 * ⚠ Strict on purpose. `Number('12abc')` is `NaN` but `parseInt('12abc')` is 12,
 * and an id parsed out of junk is an id somebody did not mean to name.
 */
function positiveIntParam(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** The same, for a value that arrived in a JSON body and may be a number already. */
function positiveIntValue(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null
  }
  return positiveIntParam(typeof raw === 'string' ? raw : null)
}

interface Authorised {
  organizationId: number
}

/**
 * 🔴 GATE 1, AT THE DOOR: may this caller read THIS ecosistema's graph?
 *
 * Returns the organization id, or a Response to send back. Never returns an id
 * the caller has no membership in — except for a platform admin, see the file
 * header.
 *
 * ⚠ The membership lookup is `organizationIdsForUser`, the SAME resolver access
 * control uses (`access/index.ts`). A second, subtly different implementation of
 * "which orgs may this person touch" is how a tenant leak gets written, so this
 * route does not write one.
 */
export async function authoriseOrganization(
  req: PayloadRequest,
  rawOrganization: unknown,
): Promise<Authorised | Response> {
  const user = getAuthenticatedUser(req)
  if (!user) return errorResponse(401, 'Necesitas iniciar sesión.')

  const organizationId = positiveIntValue(rawOrganization)
  if (organizationId === null) {
    return errorResponse(400, 'Falta el parámetro `organization` (el id del ecosistema).')
  }

  // Platform admins pick the ecosistema they are looking at; they do not get a
  // different graph. An id that names nothing simply has no rows, and every
  // query below is scoped to it, so no existence check is needed here.
  if (isPlatformAdminUser(req.user)) return { organizationId }

  const allowed = await organizationIdsForUser(req.payload, user.id)
  const member = allowed.some((id) => String(id) === String(organizationId))
  // ⚠ Same answer for "no such ecosistema" and "not yours". See the header.
  if (!member) return errorResponse(403, 'No perteneces a este ecosistema.')

  return { organizationId }
}

function isAuthorised(value: Authorised | Response): value is Authorised {
  return !(value instanceof Response)
}

/**
 * `organization=all` asks for the COMBINED graph ("Todos mis ecosistemas").
 * The word is the whole request: the set itself is never read from the client.
 */
export const COMBINED_ORGANIZATION = 'all'

function isCombinedRequest(raw: unknown): boolean {
  return typeof raw === 'string' && raw.trim() === COMBINED_ORGANIZATION
}

/** Fewest memberships that unlock the combined graph for a non-admin. */
export const MIN_COMBINED_MEMBERSHIPS = 2

/**
 * 🔴 GATE 1 FOR THE COMBINED GRAPH: WHICH ECOSISTEMAS DOES IT COVER?
 *
 * Derived ONLY here, from the caller's own memberships (`organizationIdsForUser`,
 * the resolver `authoriseOrganization` uses). A platform admin gets every
 * ecosistema, under the same gates a member gets (ADR §7.1). A member of fewer
 * than {@link MIN_COMBINED_MEMBERSHIPS} gets a 403: there is nothing to combine.
 */
export async function authoriseCombined(
  req: PayloadRequest,
): Promise<{ organizationIds: number[] } | Response> {
  const user = getAuthenticatedUser(req)
  if (!user) return errorResponse(401, 'Necesitas iniciar sesión.')

  if (isPlatformAdminUser(req.user)) {
    const rows = await asQueryPayload(req).db.drizzle.execute(
      sql`SELECT id FROM organizations ORDER BY id`,
    )
    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? [])
    return { organizationIds: normaliseOrgIds(list.map((r) => (r as { id?: unknown })?.id)) }
  }

  const organizationIds = normaliseOrgIds(await organizationIdsForUser(req.payload, user.id))
  if (organizationIds.length < MIN_COMBINED_MEMBERSHIPS) {
    return errorResponse(403, 'No perteneces a varios ecosistemas.')
  }
  return { organizationIds }
}

/**
 * Rate limit for a combined read. ⚠ One bucket per CALLER for the combined
 * scope, not a charge to every included ecosistema's bucket: one person's map
 * must not spend the budget of tenants they merely belong to.
 */
async function guardCombined(req: PayloadRequest): Promise<Response | null> {
  const user = getAuthenticatedUser(req)
  if (!user) return errorResponse(401, 'Necesitas iniciar sesión.')
  return guardRateLimit(req, [
    {
      scope: 'graph:view:user',
      key: `graph:view:user:${user.id}`,
      limit: rateLimits.graphViewPerUser(),
    },
    {
      scope: 'graph:org',
      key: `graph:org:combined:${user.id}`,
      limit: rateLimits.graphPerOrganization(),
    },
  ])
}

/**
 * Count one authorised graph request against its two buckets.
 *
 * Returns a `429` to hand straight back, or `null` to continue — the same shape
 * `guardRateLimit` uses everywhere else.
 *
 * ⚠ `perUser` differs by route on purpose. Browsing is a person clicking, and
 * `retrieve` is the GraphRAG leg on every chat turn — a shared limit would
 * either throttle conversation or fail to bound browsing.
 */
async function guardGraph(
  req: PayloadRequest,
  organizationId: number,
  kind: 'view' | 'retrieve',
  perUser: number,
): Promise<Response | null> {
  const user = getAuthenticatedUser(req)
  // Unreachable: every caller runs `authoriseOrganization` first, which 401s
  // without a user. Belt and braces — a limiter that silently no-ops when it
  // cannot identify the caller is worse than no limiter, because it looks like
  // one.
  if (!user) return errorResponse(401, 'Necesitas iniciar sesión.')

  return guardRateLimit(req, [
    /**
     * 🔴 THE KEY IS NAMESPACED BY ROUTE KIND, AND IT HAS TO BE.
     *
     * `view` and `retrieve` have different limits on purpose. A SHARED key with
     * two different limits is not two allowances — it is one counter read
     * against whichever number the current route passed, so browsing spends the
     * chat path's budget. A test caught exactly that.
     *
     * The consequence would have been the worst kind: GraphRAG dropping its
     * context mid-conversation because the person had been clicking around
     * `/grafo` beforehand, and dropping it SILENTLY, because the fallback is
     * silent by design (ADR §8.2).
     */
    { scope: `graph:${kind}:user`, key: `graph:${kind}:user:${user.id}`, limit: perUser },
    /**
     * ⚠ The tenant ceiling is deliberately SHARED across both routes. It exists
     * to bound total aggregate-SQL work for one ecosistema, and that cost does
     * not care which route asked.
     */
    {
      scope: 'graph:org',
      key: `graph:org:${organizationId}`,
      limit: rateLimits.graphPerOrganization(),
    },
  ])
}

/** The graph queries need only `db.drizzle`; `req.payload` supplies it. */
const asQueryPayload = (req: PayloadRequest): GraphQueryPayload =>
  req.payload as unknown as GraphQueryPayload

function parseEntityType(raw: string | null): GraphEntityType | null | undefined {
  if (raw == null || raw === '') return null
  return (GRAPH_ENTITY_TYPES as readonly string[]).includes(raw)
    ? (raw as GraphEntityType)
    : undefined // `undefined` means "given, but not a real type" — a 400.
}

/**
 * `GET /api/graph/view` — the ranked entity lists behind `/grafo` (ADR §7.2).
 *
 * 🔴 `hidden` IS PART OF THE ANSWER, NOT DEBUG OUTPUT. A young ecosistema's
 * graph is legitimately empty (ADR §7.3.3), and an invisible threshold looks
 * like a broken database. `hidden`, `minSupport` and `publishedDocuments`
 * together let the UI say which of the two it is, in Spanish, instead of
 * rendering a blank canvas.
 */
export const graphViewEndpoint: Endpoint = {
  path: '/graph/view',
  method: 'get',
  handler: async (req) => {
    if (isCombinedRequest(queryParam(req, 'organization'))) {
      const combined = await authoriseCombined(req)
      if (combined instanceof Response) return combined
      const limitedCombined = await guardCombined(req)
      if (limitedCombined) return limitedCombined
      const combinedType = parseEntityType(queryParam(req, 'type'))
      if (combinedType === undefined) {
        return errorResponse(
          400,
          `El parámetro \`type\` debe ser uno de: ${GRAPH_ENTITY_TYPES.join(', ')}.`,
        )
      }
      return ok(
        await readCombinedView(asQueryPayload(req), {
          organizationIds: combined.organizationIds,
          type: combinedType,
          q: queryParam(req, 'q'),
          limit: positiveIntParam(queryParam(req, 'limit')) ?? MAX_VIEW_ENTITIES,
        }),
      )
    }

    const auth = await authoriseOrganization(req, queryParam(req, 'organization'))
    if (!isAuthorised(auth)) return auth

    const limited = await guardGraph(req, auth.organizationId, 'view', rateLimits.graphViewPerUser())
    if (limited) return limited

    const type = parseEntityType(queryParam(req, 'type'))
    if (type === undefined) {
      return errorResponse(
        400,
        `El parámetro \`type\` debe ser uno de: ${GRAPH_ENTITY_TYPES.join(', ')}.`,
      )
    }

    const view = await readEntityView(asQueryPayload(req), {
      organizationId: auth.organizationId,
      type,
      q: queryParam(req, 'q'),
      limit: positiveIntParam(queryParam(req, 'limit')) ?? MAX_VIEW_ENTITIES,
    })

    return ok(view)
  },
}

/**
 * `GET /api/graph/entity/:id` — one node, ONE HOP, and its published documents.
 *
 * 404 covers three different situations on purpose: no such entity, no such
 * entity IN THIS ECOSISTEMA, and an entity the minimum-support threshold hides.
 * 🔴 Separating them would let a caller walk the id space and learn exactly what
 * the threshold is suppressing — which is the thing the threshold exists to
 * prevent (ADR §7.3.3).
 *
 * ── EACH NEIGHBOUR CARRIES ITS OWN EVIDENCE, AND THERE IS NO `/edge` ROUTE ──
 *
 * `neighbours[].documents` is the published documents that EVIDENCE THAT EDGE,
 * straight out of `graph_relations` (ADR §7.2). It is folded into this answer
 * rather than given a route of its own, and the reason is the shape of the
 * caller: the panel behind this data draws an ego-network of up to twenty edges
 * and lets a person click between them. A `GET /api/graph/edge/:from/:to/:type`
 * would turn one click into a round-trip, and filling the panel into twenty of
 * them — each re-running authorisation, both rate-limit buckets and the same
 * `ent_support` CTE.
 *
 * 🔴 It would also be a FOURTH place ADR §6's three gates are written. They are
 * written once, in `lib/graph/queries.ts`, and the per-edge statement reuses the
 * very fragments the neighbour statement uses, so the two cannot come to
 * disagree about which edges exist. A separate route with its own copy of the
 * thresholds is precisely the drift `queries.test.ts` exists to catch — and the
 * thing it could not catch is two correct queries that disagree.
 *
 * ⚠ The response grows: worst case twenty edges × ten documents. That is the
 * trade, it is bounded in SQL by `MAX_EDGE_DOCUMENTS`, and it is one body
 * instead of twenty.
 */
export const graphEntityEndpoint: Endpoint = {
  path: '/graph/entity/:id',
  method: 'get',
  handler: async (req) => {
    if (isCombinedRequest(queryParam(req, 'organization'))) {
      const combined = await authoriseCombined(req)
      if (combined instanceof Response) return combined
      const limitedCombined = await guardCombined(req)
      if (limitedCombined) return limitedCombined
      const combinedId = positiveIntParam((req.routeParams as { id?: string } | undefined)?.id)
      if (combinedId === null) return errorResponse(400, 'Id de nodo inválido.')
      const combinedDetail = await readCombinedEntityDetail(asQueryPayload(req), {
        organizationIds: combined.organizationIds,
        entityId: combinedId,
      })
      if (!combinedDetail) return errorResponse(404, 'Ese nodo no existe en tus ecosistemas.')
      return ok(combinedDetail)
    }

    const auth = await authoriseOrganization(req, queryParam(req, 'organization'))
    if (!isAuthorised(auth)) return auth

    // Same bucket as the lists: opening a node is part of browsing, and a
    // person clicking through an ego-network does both in one sitting.
    const limited = await guardGraph(req, auth.organizationId, 'view', rateLimits.graphViewPerUser())
    if (limited) return limited

    const entityId = positiveIntParam((req.routeParams as { id?: string } | undefined)?.id)
    if (entityId === null) return errorResponse(400, 'Id de nodo inválido.')

    const detail = await readEntityDetail(asQueryPayload(req), {
      organizationId: auth.organizationId,
      entityId,
    })
    // ⚠ One answer for three causes. See the header of this endpoint.
    if (!detail) return errorResponse(404, 'Ese nodo no existe en este ecosistema.')

    return ok(detail)
  },
}

/** The longest query string worth matching. Beyond this it is not a question. */
const MAX_QUERY_CHARS = 2000

/**
 * `POST /api/graph/retrieve` — the GraphRAG contribution for one turn (ADR §8).
 *
 * ⚠ POST, NOT GET, AND THE REASON IS NOT REST PURITY. The body carries the
 * user's condensed question. In a URL it lands in access logs, proxy logs and
 * `Referer` headers — an unbounded free-text field from a corpus of testimonies
 * is the last thing that should be sitting in a log line.
 *
 * 🔴 THE SAME THRESHOLD AS THE VIEW. ADR §7.3.3 names retrieval as the side door
 * that would otherwise leak what the view refuses to show; `queries.ts` applies
 * minimum support to the candidate list BEFORE matching, so a below-threshold
 * entity cannot even be a seed.
 *
 * Matching is deterministic string work over this ecosistema's entity labels —
 * no LLM call, no cost (ADR §8.1). A query that matches nothing returns four
 * empty collections, which is the silent fallback the pipeline expects: no
 * chunks, no block, an ordinary answer.
 */
export const graphRetrieveEndpoint: Endpoint = {
  path: '/graph/retrieve',
  method: 'post',
  handler: async (req) => {
    const body = (await readJsonBody(req)) ?? {}

    const auth = await authoriseOrganization(req, body.organization)
    if (!isAuthorised(auth)) return auth

    const limited = await guardGraph(req, auth.organizationId, 'retrieve', rateLimits.graphRetrievePerUser())
    if (limited) return limited

    const raw = typeof body.query === 'string' ? body.query.trim() : ''
    if (raw === '') return errorResponse(400, 'Falta `query`: el texto a buscar en el grafo.')

    const limit = positiveIntValue(body.limit) ?? MAX_RETRIEVE_SEEDS

    const retrieval = await readGraphRetrieval(asQueryPayload(req), {
      organizationId: auth.organizationId,
      query: raw.slice(0, MAX_QUERY_CHARS),
      limit,
    })

    return ok(retrieval)
  },
}

/** Registered in `payload.config.ts`. Payload prefixes them with `routes.api`. */
export const graphEndpoints: Endpoint[] = [
  graphViewEndpoint,
  graphEntityEndpoint,
  graphRetrieveEndpoint,
]
