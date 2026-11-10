/**
 * 🔴 `/v1/identity/me` PER-IP FLOOR, BEHIND THE WEB BFF (audit 2026-11-10, A-08).
 *
 * The web calls this route from the server, once per page load. It used to
 * forward no client IP, so every browser landed in ONE `me:ip:unknown` bucket
 * and a busy room 429'd everybody. The BFF now sends the browser's IP as
 * `X-Forwarded-For` (`apps/web/src/lib/server/clientIp.ts`); these tests pin
 * the backend half of that contract:
 *
 *   - two browsers forwarded by the BFF get two buckets;
 *   - a caller on the public host cannot pick its bucket by pre-seeding the
 *     header, because the proxy appends and `clientIp` reads from the right.
 */
import type { PayloadRequest } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/permissions', () => ({
  resolvePrincipal: async (_payload: unknown, email: string) => ({
    email,
    name: null,
    isPlatformAdmin: false,
    projects: {},
  }),
}))

const { meEndpoint } = await import('./me')
const { clientIp } = await import('./http')
const { resetRateLimits, useDefaultRateLimitStore } = await import('../lib/rateLimit')

let nextUser = 0

/** A distinct signed-in user per call, so only the IP bucket can bind. */
function request(xff?: string): PayloadRequest {
  nextUser += 1
  return {
    user: { id: nextUser, email: `u${nextUser}@example.test`, isActive: true },
    headers: new Headers(xff ? { 'x-forwarded-for': xff } : {}),
    payload: { logger: { warn() {} } },
  } as unknown as PayloadRequest
}

const me = async (xff?: string) => ((await meEndpoint.handler(request(xff))) as Response).status

beforeEach(() => {
  useDefaultRateLimitStore()
  resetRateLimits()
  process.env.IDENTITY_RATELIMIT_ME_IP_MAX = '3'
})

afterEach(() => {
  delete process.env.IDENTITY_RATELIMIT_ME_IP_MAX
  delete process.env.IDENTITY_TRUSTED_PROXY_HOPS
})

describe('clientIp', () => {
  it('reads the single entry the BFF forwards', () => {
    expect(clientIp(request('203.0.113.7'))).toBe('203.0.113.7')
  })

  it('reads the rightmost entry, the one the proxy appended, not a forged left one', () => {
    expect(clientIp(request('6.6.6.6, 203.0.113.7'))).toBe('203.0.113.7')
  })

  it('treats unset, 0 and junk hop counts as one proxy', () => {
    for (const hops of [undefined, '0', 'x']) {
      if (hops === undefined) delete process.env.IDENTITY_TRUSTED_PROXY_HOPS
      else process.env.IDENTITY_TRUSTED_PROXY_HOPS = hops
      expect(clientIp(request('6.6.6.6, 203.0.113.7'))).toBe('203.0.113.7')
    }
  })

  it('is `unknown` with no header at all, the case the BFF no longer produces', () => {
    expect(clientIp(request())).toBe('unknown')
  })
})

describe('/v1/identity/me per-IP floor', () => {
  it('gives two browsers forwarded by the BFF two buckets', async () => {
    for (let i = 0; i < 3; i += 1) expect(await me('203.0.113.7')).toBe(200)
    expect(await me('203.0.113.7')).toBe(429)
    expect(await me('198.51.100.1')).toBe(200)
  })

  it('a direct caller cannot dodge its own bucket by pre-seeding X-Forwarded-For', async () => {
    // What reaches the backend through Traefik: the forged entry, then the
    // address Traefik saw.
    for (let i = 0; i < 3; i += 1) expect(await me(`10.0.0.${i}, 203.0.113.7`)).toBe(200)
    expect(await me('192.0.2.50, 203.0.113.7')).toBe(429)
  })

  it('a direct caller cannot burn someone else\'s bucket by naming their IP', async () => {
    for (let i = 0; i < 5; i += 1) await me('198.51.100.1, 203.0.113.7')
    expect(await me('198.51.100.1')).toBe(200)
  })
})
