/**
 * RATE LIMITING ON THE GRAPH ROUTES.
 *
 * The reads are aggregate `GROUP BY … HAVING` over one tenant's rows, so what
 * needs bounding is CPU per tenant, not credential guessing. Two buckets: one
 * that identifies the caller, one that caps the ecosistema.
 *
 * 🔴 THE TEST THAT MATTERS MOST IS "two users do not share a bucket". Every
 * graph request arrives from the web BFF, which forwards no `X-Forwarded-For`,
 * so `clientIp()` is the literal string `'unknown'` for everybody. A per-IP
 * bucket — the obvious thing to add "for consistency" with `/me` and `/token` —
 * would collapse every user of every ecosistema into ONE counter and 429 the
 * whole product as soon as one team got busy. The test below fails loudly if
 * anyone keys these buckets on anything but the user.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PayloadRequest } from 'payload'

import { resetRateLimits } from '../lib/rateLimit'
import { graphRetrieveEndpoint, graphViewEndpoint } from './graph'

const ANA = { id: 1, email: 'ana@example.test', isActive: true }
const BENI = { id: 2, email: 'beni@example.test', isActive: true }

/** Minimal request double — the limiter only needs a user and a payload. */
function fakeRequest(
  url: string,
  user: Record<string, unknown>,
  memberOf: number[],
  body?: unknown,
): PayloadRequest {
  const payload = {
    async find({ collection }: { collection: string }) {
      if (collection === 'memberships') {
        return { docs: memberOf.map((id) => ({ id, organization: id, role: 'member', isActive: true })) }
      }
      if (collection === 'organizations') {
        return { docs: memberOf.map((id) => ({ id, name: `Eco ${id}`, isActive: true })) }
      }
      return { docs: [] }
    },
    db: { drizzle: { async execute() { return { rows: [] } } } },
    logger: { warn() {} },
  }
  return {
    user,
    payload,
    searchParams: new URL(url, 'http://test.local').searchParams,
    routeParams: {},
    headers: new Headers(),
    json: async () => body ?? {},
  } as unknown as PayloadRequest
}

const view = (user: Record<string, unknown>, org = 1, memberOf = [1]) =>
  graphViewEndpoint.handler(
    fakeRequest(`/graph/view?organization=${org}&type=tema`, user, memberOf),
  ) as Promise<Response>

const retrieve = (user: Record<string, unknown>, org = 1, memberOf = [1]) =>
  graphRetrieveEndpoint.handler(
    fakeRequest('/graph/retrieve', user, memberOf, { organization: org, query: 'agua' }),
  ) as Promise<Response>

const ENV_KEYS = [
  'GRAPH_RATELIMIT_VIEW_USER_MAX',
  'GRAPH_RATELIMIT_RETRIEVE_USER_MAX',
  'GRAPH_RATELIMIT_ORG_MAX',
] as const

beforeEach(() => {
  resetRateLimits()
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  resetRateLimits()
  for (const key of ENV_KEYS) delete process.env[key]
})

describe('the per-user bucket', () => {
  it('lets a caller through while there is room', async () => {
    process.env.GRAPH_RATELIMIT_VIEW_USER_MAX = '3'
    for (let i = 0; i < 3; i++) {
      expect((await view(ANA)).status).toBe(200)
    }
  })

  it('answers 429 with Retry-After once the bucket is spent', async () => {
    process.env.GRAPH_RATELIMIT_VIEW_USER_MAX = '2'
    await view(ANA)
    await view(ANA)

    const denied = await view(ANA)
    expect(denied.status).toBe(429)
    expect(denied.headers.get('Retry-After')).toBeTruthy()
    expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0)
    // Never says WHICH bucket fired — that tells an attacker how many accounts
    // they have. `guardRateLimit`'s rule, inherited here.
    const text = JSON.stringify(await denied.json())
    expect(text).not.toContain('graph:user')
    expect(text).not.toContain('graph:org')
  })

  it('🔴 does NOT share a bucket between two users — the per-IP trap', async () => {
    // If these buckets were ever keyed on `clientIp(req)`, both callers would
    // land in the `'unknown'` bucket and Beni would be denied for Ana's
    // traffic. That is the whole reason there is no per-IP rule here.
    process.env.GRAPH_RATELIMIT_VIEW_USER_MAX = '2'
    await view(ANA)
    await view(ANA)
    expect((await view(ANA)).status).toBe(429)

    // Beni has touched nothing.
    expect((await view(BENI)).status).toBe(200)
  })

  it('gives `retrieve` its own, larger allowance than browsing', async () => {
    // `retrieve` is the GraphRAG leg and runs on EVERY chat turn. Sharing
    // browsing's counter would make a conversation lose its graph context —
    // silently, because the fallback is silent by design.
    process.env.GRAPH_RATELIMIT_VIEW_USER_MAX = '1'
    process.env.GRAPH_RATELIMIT_RETRIEVE_USER_MAX = '3'

    await view(ANA)
    expect((await view(ANA)).status).toBe(429)

    for (let i = 0; i < 3; i++) {
      expect((await retrieve(ANA)).status).toBe(200)
    }
    expect((await retrieve(ANA)).status).toBe(429)
  })
})

describe('the per-ecosistema bucket', () => {
  it('denies once the tenant ceiling is reached, even with room on the user bucket', async () => {
    // The org bucket is what actually bounds aggregate SQL cost: many members
    // each under their own limit can still add up to real work for one tenant.
    process.env.GRAPH_RATELIMIT_VIEW_USER_MAX = '100'
    process.env.GRAPH_RATELIMIT_ORG_MAX = '3'

    await view(ANA)
    await view(BENI)
    await view(ANA)

    // Fourth request to the same ecosistema, from a user with plenty of
    // personal allowance left.
    expect((await view(BENI)).status).toBe(429)
  })

  it('scopes the ceiling to one ecosistema, so a busy tenant cannot starve another', async () => {
    process.env.GRAPH_RATELIMIT_VIEW_USER_MAX = '100'
    process.env.GRAPH_RATELIMIT_ORG_MAX = '2'

    await view(ANA, 1, [1, 2])
    await view(ANA, 1, [1, 2])
    expect((await view(ANA, 1, [1, 2])).status).toBe(429)

    // Ecosistema 2 is untouched.
    expect((await view(ANA, 2, [1, 2])).status).toBe(200)
  })
})

describe('what is counted', () => {
  it('does not count a request it refused to authorise', async () => {
    // Rate limiting runs AFTER authorisation, like `/me` and `/token`, so the
    // bucket is keyed on a verified user and a verified ecosistema rather than
    // on anything a caller can assert in a query string.
    process.env.GRAPH_RATELIMIT_VIEW_USER_MAX = '2'

    // Ana is not a member of ecosistema 9.
    expect((await view(ANA, 9, [1])).status).toBe(403)
    expect((await view(ANA, 9, [1])).status).toBe(403)
    expect((await view(ANA, 9, [1])).status).toBe(403)

    // Her real allowance is intact.
    expect((await view(ANA, 1, [1])).status).toBe(200)
  })
})
