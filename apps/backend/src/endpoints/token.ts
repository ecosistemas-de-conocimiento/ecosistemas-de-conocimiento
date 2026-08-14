/**
 * `POST /v1/identity/token` — requires a logged-in Payload user.
 *
 * Exchanges a browser session for a short-lived, ASYMMETRICALLY signed,
 * SINGLE-ORGANIZATION access token. Body:
 *
 *   { "audience": "<organization-slug>" }
 *
 * Emitted claims — and nothing more:
 *   iss, sub (= email), aud (= organization slug), email, name?, roles[],
 *   perms[], iat, exp
 *
 * ⚠ THE AUDIENCE IS A TENANT, NOT A PRODUCT. There is one product and many
 * customers, so `aud` names the organization — which is what makes the audience
 * check worth doing: a token minted for one customer's data cannot be replayed
 * against another's. A person who works across two organizations holds two
 * tokens. See `lib/permissions.ts`.
 *
 * Gates, in order:
 *   401  no Payload session
 *   429  rate limit (per authenticated user, and per IP as a floor)
 *   400  missing/!string `audience`
 *   403  account not active / not resolvable
 *   404  organization slug unknown OR organization inactive
 *   403  no active membership in that organization (platform admins bypass)
 *   503  signing key not configured (logged, detail not echoed to the caller)
 *
 * TTL: AUTH_TOKEN_TTL, default 900s, HARD-CAPPED at 900s and clamped (with a
 * log line) if the env asks for more. A token cannot be revoked, so its
 * lifetime IS the revocation delay.
 *
 * RATE LIMITING: 30/min per authenticated user and 120/min per client IP, both
 * tunable — see `src/lib/rateLimit.ts` for the numbers and the reasoning.
 * ⚠ The limiter is IN-PROCESS and does not hold across replicas.
 *
 * ⚠ Limits are applied AFTER the 401. Anonymous requests are cheap (no DB, no
 * signing) and counting them would let an unauthenticated attacker fill a
 * shared office IP's bucket and lock the real team out — the limiter would
 * become the denial of service. Volumetric protection is the proxy's job.
 *
 * Mounted at `/api/v1/identity/token` (Payload prefixes `routes.api`).
 */

import type { Endpoint } from 'payload'

import { resolveForOrganization, resolvePrincipal, type ProjectGrant } from '../lib/permissions'
import { SigningKeyUnavailableError } from '../lib/jwt/keys'
import { signOrganizationToken } from '../lib/jwt/sign'
import { rateLimits } from '../lib/rateLimit'
import {
  clientIp,
  errorResponse,
  getAuthenticatedUser,
  guardRateLimit,
  jsonResponse,
  readJsonBody,
} from './http'

interface OrganizationDoc {
  slug?: unknown
  name?: unknown
  isActive?: unknown
}

export const tokenEndpoint: Endpoint = {
  path: '/v1/identity/token',
  method: 'post',
  handler: async (req) => {
    const user = getAuthenticatedUser(req)
    if (!user) {
      return errorResponse(401, 'Authentication required.')
    }

    // Per-user first: it is the meaningful bucket, and it is the one a normal
    // client can actually trip. The IP floor bounds one host working through
    // several stolen sessions.
    const limited = await guardRateLimit(req, [
      { scope: 'token:user', key: `token:user:${user.email}`, limit: rateLimits.tokenPerUser() },
      { scope: 'token:ip', key: `token:ip:${clientIp(req)}`, limit: rateLimits.tokenPerIp() },
    ])
    if (limited) return limited

    const body = await readJsonBody(req)
    const rawAudience = body?.audience
    if (typeof rawAudience !== 'string' || rawAudience.trim().length === 0) {
      return errorResponse(
        400,
        'Body must be JSON with a non-empty string `audience` (the target organization slug).',
      )
    }
    const audience = rawAudience.trim().toLowerCase()

    // --- the organization must exist and be active --------------------------
    // `overrideAccess` here is deliberate and narrow: the caller is already
    // authenticated, and whether a slug exists is not itself privileged. What
    // actually authorises issuance is the membership gate below — running this
    // lookup under access control would 404 for a non-member and make "wrong
    // slug" indistinguishable from "not your organization".
    const organizations = await req.payload.find({
      collection: 'organizations',
      where: { slug: { equals: audience } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
      req,
    })

    const organization = organizations.docs[0] as OrganizationDoc | undefined
    if (!organization) {
      return errorResponse(404, `Unknown organization "${audience}".`)
    }
    if (organization.isActive === false) {
      return errorResponse(404, `Organization "${audience}" is not active.`)
    }

    // --- who is this, and what do they hold in THIS organization -------------
    const [principal, scopedGrant] = await Promise.all([
      resolvePrincipal(req.payload, user.email),
      resolveForOrganization(req.payload, user.email, audience),
    ])

    if (!principal) {
      return errorResponse(403, 'This account is not active.')
    }

    let grant: ProjectGrant | null = scopedGrant
    if (!grant) {
      if (!principal.isPlatformAdmin) {
        return errorResponse(403, `You have no active membership in "${audience}".`)
      }
      // A platform admin always passes the gate. In practice `resolveForOrganization`
      // has already expanded them to the owner grant, so this branch only fires
      // if that ever changes — and it fires with an EMPTY grant rather than an
      // invented one. Role expansion belongs in the resolver, in one place.
      grant = { roles: [], permissions: [] }
    }

    // --- mint ---------------------------------------------------------------
    try {
      const signed = await signOrganizationToken({
        email: principal.email,
        name: principal.name,
        audience,
        roles: grant.roles,
        perms: grant.permissions,
      })

      return jsonResponse(
        {
          token: signed.token,
          tokenType: 'Bearer',
          algorithm: signed.algorithm,
          keyId: signed.keyId,
          issuer: signed.issuer,
          audience: signed.audience,
          issuedAt: signed.issuedAt,
          expiresAt: signed.expiresAt,
          expiresIn: signed.expiresIn,
          roles: grant.roles,
          perms: grant.permissions,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
      )
    } catch (err) {
      if (err instanceof SigningKeyUnavailableError) {
        req.payload.logger.error(
          { err },
          '[identity/token] cannot mint a token: AUTH_PRIVATE_KEY missing or invalid. Run `pnpm keygen`.',
        )
        return errorResponse(503, 'Token issuance is not configured on this server.')
      }
      req.payload.logger.error({ err }, '[identity/token] token issuance failed')
      return errorResponse(500, 'Could not issue a token.')
    }
  },
}
