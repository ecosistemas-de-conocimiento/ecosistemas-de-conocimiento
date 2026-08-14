/**
 * `GET /v1/identity/me` — requires a logged-in Payload user.
 *
 * Auth: Payload's own session, i.e. the `payload-token` cookie OR
 * `Authorization: JWT <payload-token>`. This is the BROWSER-facing route; it is
 * not part of the service-to-service surface, and it deliberately
 * does not accept an IdP-issued Bearer token (that would be a token echoing
 * itself). Service callers use `/v1/identity/resolve` instead.
 *
 * Returns the caller's profile plus the FULL ResolvedPrincipal — every
 * ORGANIZATION they can reach, with the role and permissions they hold in each
 * — so the UI can render an organization switcher in one round trip.
 *
 * ⚠ The map is called `projects` on the wire. It holds organization slugs. That
 * name is `@edc/identity-client`'s and renaming it would break the published
 * client; see `lib/permissions.ts`.
 *
 * Never returns: id, password, salt, hash, resetPasswordToken,
 * resetPasswordExpiration, loginAttempts, lockUntil. The response is built from
 * an explicit WHITELIST (`publicUserProfile`), not by deleting fields — a
 * blacklist silently leaks the next sensitive field somebody adds.
 *
 * RATE LIMITING (implemented): 60/min per authenticated user, 240/min per client
 * IP as a floor. This route mints
 * no credentials, but it hangs off the SAME session cookie as `/token` and it
 * resolves every organization the caller can reach — the most database work per
 * request in the app. Limiting `/token` and leaving its sibling wide open would
 * be a hole, so it is limited too, generously enough for a front-end that polls.
 * ⚠ In-process limiter: does not hold across replicas.
 *
 * Mounted at `/api/v1/identity/me` (Payload prefixes `routes.api`).
 */

import type { Endpoint } from 'payload'

import { resolvePrincipal } from '../lib/permissions'
import { rateLimits } from '../lib/rateLimit'
import {
  clientIp,
  errorResponse,
  getAuthenticatedUser,
  guardRateLimit,
  jsonResponse,
  publicUserProfile,
} from './http'

export const meEndpoint: Endpoint = {
  path: '/v1/identity/me',
  method: 'get',
  handler: async (req) => {
    const user = getAuthenticatedUser(req)
    if (!user) {
      return errorResponse(401, 'Authentication required.')
    }

    // Per-user, then an IP floor — the same shape as /token, deliberately.
    // Without the floor, an attacker holding N stolen sessions gets 60N/min on
    // the heaviest read in the app; the asymmetry with its sibling would be an
    // accident, not a decision.
    const limited = await guardRateLimit(req, [
      { scope: 'me:user', key: `me:user:${user.email}`, limit: rateLimits.mePerUser() },
      { scope: 'me:ip', key: `me:ip:${clientIp(req)}`, limit: rateLimits.mePerIp() },
    ])
    if (limited) return limited

    const principal = await resolvePrincipal(req.payload, user.email)
    if (!principal) {
      // Session is valid but the account is disabled or no longer resolvable.
      return errorResponse(403, 'This account is not active.')
    }

    return jsonResponse(
      {
        user: publicUserProfile(user),
        principal: {
          email: principal.email,
          name: principal.name,
          isPlatformAdmin: principal.isPlatformAdmin,
          projects: principal.projects,
        },
      },
      {
        status: 200,
        // Per-session data: never cache, never store in a shared proxy.
        headers: { 'Cache-Control': 'no-store' },
      },
    )
  },
}
