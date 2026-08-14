/**
 * `GET /.well-known/jwks.json` — PUBLIC, unauthenticated.
 *
 * The JWK Set is how a peer checks a token this backend issued WITHOUT holding
 * a shared secret. It is the only such route, so it must stay open and must
 * never 500.
 *
 * Serves the Ed25519 PUBLIC key only, as a JWK Set:
 *   { "keys": [ { kty, crv, x, kid, alg: "EdDSA", use: "sig" } ] }
 *
 * The private key is never read on this path — `getJwks()` derives the JWK from
 * AUTH_PUBLIC_KEY exclusively, and strips any private JWK members defensively.
 *
 * Degradation: if AUTH_PUBLIC_KEY is unset we return `{ "keys": [] }` with a
 * warning in the logs rather than crashing. A verifier then fails closed
 * (`ERR_JWKS_NO_MATCHING_KEY`), which is the correct posture.
 *
 * ⚠⚠ DELIBERATELY NOT RATE-LIMITED. This is a decision, not an oversight, and
 * it is the opposite of the decision made for every other endpoint. Four
 * reasons, in order of weight:
 *
 *   1. FAILING CLOSED HERE MEANS AN AUTH OUTAGE EVERYWHERE AT ONCE. Everywhere else, a
 *      429 costs one caller one request. Here it costs a consumer its key set,
 *      so every token it verifies fails with ERR_JWKS_NO_MATCHING_KEY until its
 *      cache refills. A limiter on this path converts a burst into an outage of
 *      exactly the thing the IdP exists to provide.
 *   2. PER-IP BUCKETING IS ACTIVELY WRONG HERE. Consumers are our own services,
 *      and on one host they share an egress IP. One service's restart
 *      would rate-limit every other product's verifier. The natural bucket key
 *      does not exist: there is no session, no service token, no identity of
 *      any kind on this route — by design, because a verifier must be able to
 *      fetch it before it can trust anything.
 *   3. THE STAMPEDE IS LEGITIMATE TRAFFIC AND MUST SUCCEED. A cold
 *      restart is N instances fetching once each, then not again for an hour.
 *      That is the system working, not abuse — and it is precisely the moment
 *      a limiter would fire.
 *   4. THE RESPONSE IS ALREADY CHEAP. No database, no session lookup; the JWK
 *      is derived once and memoised in `getPublicJwk()`, so a repeat request is
 *      a cached object and a JSON stringify. The public key is public by
 *      definition, so there is nothing to enumerate and no secret to guess.
 *
 * The right control for this route is CACHING, which is already in place: a
 * one-hour `Cache-Control` that consumers honour and any proxy can serve from.
 * If raw volume ever becomes a problem it belongs at the edge, where a limit
 * can be volumetric rather than fail-closed. Do not add an in-app limiter here.
 *
 * Mount note: Payload prefixes custom endpoints with `routes.api` (`/api`), so
 * the real URL is `/api/.well-known/jwks.json`. A rewrite from the bare
 * `/.well-known/jwks.json` belongs in the Next config / app router (owned
 * elsewhere); AUTH_ISSUER-relative discovery expects the bare path.
 */

import type { Endpoint } from 'payload'

import { getJwks } from '../lib/jwt/keys'
import { jsonResponse } from './http'

/** 1 hour — matches `@edc/identity-client`'s default JWKS cache TTL. */
const CACHE_MAX_AGE_SECONDS = 3600

export const jwksEndpoint: Endpoint = {
  path: '/.well-known/jwks.json',
  method: 'get',
  handler: async () => {
    const jwks = await getJwks()

    return jsonResponse(jwks, {
      status: 200,
      headers: {
        'Cache-Control': `public, max-age=${CACHE_MAX_AGE_SECONDS}, stale-while-revalidate=60`,
        // Public, non-secret, cross-origin by design: every peer service fetches this.
        'Access-Control-Allow-Origin': '*',
      },
    })
  },
}
