import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { env, isApiKeyExpired, type ApiKeyEntry } from '../config/env.js';

export interface AuthContext {
  /**
   * Opaque scoping tag — cost/budget attribution, observability, RAG isolation. Never interpreted.
   * The EFFECTIVE org: the key's `org`, or `delegateOrgPrefix + X-AI-Org` for a delegating key.
   * Every downstream path must read the org from here, never from the key config.
   */
  org: string;
  /** Opaque scoping tag. Every stored row is stamped with {org, project}. */
  project: string;
  /** Coarse permission level. `admin` is required by registry write endpoints. */
  role: 'app' | 'admin';
  /**
   * Stable, opaque derivation of the raw bearer key (NOT the key itself).
   * SHA-256(key) hex-encoded, first 16 chars. Logged into `registry_audit.actor_key_id`
   * so we can attribute mutations without leaking the key. Anywhere that needs an
   * actor identity (audit rows, `updated_by`) reads this — single source of truth.
   */
  apiKeyId: string;
  /** The raw API key, useful for trace attribution. */
  apiKey: string;
  /**
   * Optional short human label from the key's `API_KEYS` entry (`kid`).
   * Present only when the operator configured one. Log/observability aid —
   * `apiKeyId` remains the identity written to `registry_audit.actor_key_id`.
   */
  kid?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

/**
 * Derives the opaque `apiKeyId` from a raw bearer key.
 *
 * Choice: SHA-256(key), hex-encoded, first 16 chars. Stable, non-reversible,
 * collision-resistant in the population sizes we care about (~thousands of keys
 * at most). Documented in `registry_audit.actor_key_id`'s schema comment too —
 * keep them in sync.
 */
export function deriveApiKeyId(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
}

/**
 * Finds the `API_KEYS` entry a presented bearer token authenticates as, in time
 * that does not depend on WHICH key matched or on HOW MUCH of a key the caller
 * got right.
 *
 * Mechanism: hash both sides to a fixed 32-byte SHA-256 digest and compare the
 * digests with `crypto.timingSafeEqual`. Hashing first means the byte-wise
 * compare runs over digests and never over the secret itself, and it makes both
 * operands exactly 32 bytes — `timingSafeEqual` THROWS on a length mismatch, so
 * comparing raw tokens would both leak the configured key's length and crash on
 * a short token.
 *
 * EVERY configured key is compared and the loop does NOT `break`. Both halves
 * matter, and the second is the one people drop:
 *
 *   - No early exit on a MISS. Otherwise the response time reveals how far down
 *     the map the scan got before failing, which is a read on how much of a
 *     real key the caller already has.
 *   - No early exit AFTER A MATCH. This is the clause that gets dropped as an
 *     obvious optimisation, and it is exactly why the loop cannot `break`:
 *     stopping at the hit makes a successful request's time a function of the
 *     matched key's POSITION in the map. Anyone able to time authenticated
 *     requests could then tell which configured key a token corresponds to, and
 *     separate "matched the first entry" from "matched the last" — an identity
 *     leak across tenants that costs nothing to close here.
 *
 * Cost: one SHA-256 over a short string per configured key per request. At the
 * single-digit key counts this service runs, that is microseconds — orders of
 * magnitude under the network floor. Do NOT "optimise" this loop.
 *
 * This mirrors the identity service's consumer-secret comparison on purpose:
 * the two services authenticate the same class of shared secret, and a split
 * timing posture between them is a difference nobody would remember to reason
 * about later.
 *
 * Digests are recomputed per request rather than cached: `env.API_KEYS` is
 * mutated at runtime (several suites add and remove entries), so a cache keyed
 * on the map would serve a stale key set.
 *
 * Returns the matching CONFIGURED key (the caller needs the raw string for
 * `deriveApiKeyId`), or `null` when nothing matched.
 */
function matchConfiguredKey(token: string): string | null {
  const presented = createHash('sha256').update(token).digest();
  let matched: string | null = null;
  // `Object.keys` yields own enumerable names only, so a prototype name
  // (`__proto__`, `constructor`, ...) is never even a candidate here. The
  // `Object.hasOwn` guard at the call site stays anyway — defence in depth for
  // the final lookup, and the mutation tests in `auth.test.ts` pin it.
  for (const configured of Object.keys(env.API_KEYS)) {
    const candidate = createHash('sha256').update(configured).digest();
    // Unconditional assignment, no `break` — see the header. Keeping the loop's
    // work independent of where the match sits IS the property under test in
    // `auth-timing.test.ts`.
    if (timingSafeEqual(presented, candidate)) matched = configured;
  }
  return matched;
}

/** Header a delegating key uses to pick the org it acts as. */
export const ORG_HEADER = 'x-ai-org';

/** Allowed shape of the `X-AI-Org` value (the suffix after the key's prefix). */
const ORG_SUFFIX_RE = /^[a-z0-9-]{1,48}$/;

/**
 * The org a request acts as. No header: the key's own `org`. With the header:
 * `delegateOrgPrefix + suffix`, only for a key that declares a prefix. A key
 * without one gets 403 rather than the header being ignored: ignoring it would
 * silently put every sub-tenant of a consumer into one org.
 */
function resolveEffectiveOrg(
  req: FastifyRequest,
  entry: ApiKeyEntry,
): { org: string } | { reject: { status: 400 | 403; body: Record<string, string> } } {
  const raw = req.headers[ORG_HEADER];
  if (raw === undefined) return { org: entry.org };
  if (!entry.delegateOrgPrefix) {
    return {
      reject: {
        status: 403,
        body: {
          error: 'org_delegation_forbidden',
          message: 'This API key cannot act on behalf of another org (X-AI-Org not allowed)',
        },
      },
    };
  }
  if (typeof raw !== 'string' || !ORG_SUFFIX_RE.test(raw)) {
    return {
      reject: {
        status: 400,
        body: {
          error: 'invalid_org',
          message: 'X-AI-Org must be one value matching ^[a-z0-9-]{1,48}$',
        },
      },
    };
  }
  return { org: entry.delegateOrgPrefix + raw };
}

/**
 * Decorates every request with `req.auth`. Use `app.requireAuth` as a preHandler
 * on protected routes (everything under /v1). Maps a per-consuming-project bearer
 * token to its {org, project, role, apiKeyId} via the API_KEYS env map.
 *
 * Timing posture: the token is matched by `matchConfiguredKey`, which compares
 * SHA-256 digests with `crypto.timingSafeEqual` against EVERY configured key and
 * never exits early — not on a miss, and NOT after a match — so the response
 * time reveals neither which key matched nor how much of a secret was correct.
 * Read that function's header before touching the loop.
 */
export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorateRequest('auth', null as unknown as AuthContext);

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearer(req);
    if (!token) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Missing bearer token' });
    }
    // Constant-time match against every configured key — see
    // `matchConfiguredKey`. Replaces a bare `Object.hasOwn(env.API_KEYS, token)`
    // map lookup, whose runtime varied with the token.
    const matchedKey = matchConfiguredKey(token);
    // Own-property guard: `env.API_KEYS` is a plain object, so a bare index
    // lookup resolves prototype-chain names too — `Authorization: Bearer
    // __proto__` (or `constructor`, `toString`, ...) would return a truthy
    // `Object.prototype` member and pass the `!entry` check with an undefined
    // org/project scope. Only own, configured keys may authenticate.
    if (matchedKey === null || !Object.hasOwn(env.API_KEYS, matchedKey)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Unknown API key' });
    }
    const entry = env.API_KEYS[matchedKey];
    // Defense in depth: never mint an auth context with a missing/empty scope,
    // even if a malformed entry slipped past the env schema.
    if (
      !entry ||
      typeof entry.org !== 'string' ||
      entry.org.length === 0 ||
      typeof entry.project !== 'string' ||
      entry.project.length === 0
    ) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Unknown API key' });
    }
    // Optional expiry. Additive: entries with no `expiresAt` never expire, so
    // every key configured before this field existed keeps authenticating.
    // A distinct `api_key_expired` code (still 401) lets a consumer tell
    // "this key needs rotating" apart from "this token was never valid".
    if (isApiKeyExpired(entry)) {
      return reply
        .code(401)
        .send({ error: 'api_key_expired', message: 'API key expired' });
    }
    // Org delegation (see `delegateOrgPrefix` in `src/config/env.ts`). Runs
    // AFTER the key is authenticated, so an unknown key + header stays a 401.
    const org = resolveEffectiveOrg(req, entry);
    if ('reject' in org) {
      return reply.code(org.reject.status).send(org.reject.body);
    }
    req.auth = {
      org: org.org,
      project: entry.project,
      role: entry.role,
      apiKeyId: deriveApiKeyId(token),
      apiKey: token,
      ...(entry.kid ? { kid: entry.kid } : {}),
    };
  });

  /**
   * preHandler that gates admin-only routes. Assumes `requireAuth` ran first
   * (mounted at the /v1 parent). Uses `@fastify/sensible`'s `reply.forbidden()`
   * for the 403 shape.
   */
  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.auth?.role !== 'admin') {
      return reply.forbidden('Admin role required');
    }
  });
});
