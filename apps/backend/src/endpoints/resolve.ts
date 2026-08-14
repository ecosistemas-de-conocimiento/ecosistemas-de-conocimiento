/**
 * `GET /v1/identity/resolve?email=<e>&organization=<slug>` — SERVICE-TO-SERVICE ONLY.
 *
 * How a background job, a webhook consumer or a server-rendered page asks
 * "what can this person do in this organization?" while holding an email but no
 * browser session.
 *
 * NOT for browsers. It is authenticated by `X-Service-Token` — a shared secret
 * per consumer, never a cookie — and it deliberately sends no CORS headers, so
 * a browser cannot use it cross-origin even if a secret leaked into front-end
 * code.
 *
 * Authentication — including the CONSTANT-TIME secret comparison and the
 * per-IP brute-force cap — lives in `serviceAuth.ts`.
 *
 * ⚠ `project` IS ACCEPTED AS AN ALIAS FOR `organization`. `@edc/identity-client`
 * calls this parameter `project`; here it is a tenant. Both names are read so
 * the published client works
 * unmodified, and `organization` is the name to use in new code. The response
 * echoes BOTH keys for the same reason — see the note on the body below.
 *
 * ⚠ 404 MEANS BOTH "no such active account" AND "that account holds nothing
 * here". The caller cannot tell them apart. That is correct for an
 * authorization decision and wrong for a provisioning one: do not build
 * find-or-create on top of this endpoint.
 *
 * RATE LIMITING: 600/min per authenticated CONSUMER SLUG, plus the shared
 * 20/min-per-IP cap on rejected tokens. Bucketing by consumer rather than by IP
 * is what makes the limit meaningful: several services can share one egress IP
 * and each is entitled to its own budget.
 * ⚠ The limiter is IN-PROCESS and does not hold across replicas.
 *
 * Mounted at `/api/v1/identity/resolve` (Payload prefixes `routes.api`).
 */

import type { Endpoint } from 'payload'

import { resolveForOrganization, resolvePrincipal, type ProjectGrant } from '../lib/permissions'
import { rateLimits } from '../lib/rateLimit'
import { errorResponse, guardRateLimit, jsonResponse, queryParam } from './http'
import { authenticateServiceRequest } from './serviceAuth'

export const resolveEndpoint: Endpoint = {
  path: '/v1/identity/resolve',
  method: 'get',
  handler: async (req) => {
    const auth = await authenticateServiceRequest(req)
    if (!auth.ok) return auth.response

    const limited = await guardRateLimit(req, [
      {
        scope: 'resolve:consumer',
        key: `resolve:consumer:${auth.consumer}`,
        limit: rateLimits.resolvePerConsumer(),
      },
    ])
    if (limited) return limited

    const email = queryParam(req, 'email')?.toLowerCase() ?? null
    // `organization` first, `project` as the compatibility alias.
    const organization =
      queryParam(req, 'organization')?.toLowerCase() ?? queryParam(req, 'project')?.toLowerCase() ?? null

    if (!email || !organization) {
      return errorResponse(
        400,
        'Both `email` and `organization` query parameters are required (`project` is accepted as an alias for `organization`).',
      )
    }

    const [principal, scopedGrant] = await Promise.all([
      resolvePrincipal(req.payload, email),
      resolveForOrganization(req.payload, email, organization),
    ])

    if (!principal) {
      return errorResponse(404, 'No active principal for that email.')
    }

    let grant: ProjectGrant | null = scopedGrant
    if (!grant) {
      if (!principal.isPlatformAdmin) {
        return errorResponse(404, 'No grant for that email in that organization.')
      }
      // Mirrors /v1/identity/token: platform admins are never locked out, and
      // we do not invent role/permission slugs on their behalf.
      grant = { roles: [], permissions: [] }
    }

    return jsonResponse(
      {
        email: principal.email,
        // No internal user id: internal ids do not cross a service boundary.
        // Email is the join key, so a consumer can never accidentally key its
        // own rows on ours.
        name: principal.name,
        organization,
        // ⚠ Echoed under BOTH names. `@edc/identity-client` reads `project`;
        // new callers should read `organization`. Dropping `project` is a
        // breaking change to that client, so it stays until the client moves.
        project: organization,
        roles: grant.roles,
        permissions: grant.permissions,
        isPlatformAdmin: principal.isPlatformAdmin,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  },
}
