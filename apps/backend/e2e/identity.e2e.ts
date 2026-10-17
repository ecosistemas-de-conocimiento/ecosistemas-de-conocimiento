/**
 * IDENTITY, END TO END, AGAINST THE RUNNING SERVER.
 *
 * 🔴 The assertion that earns this file: a token minted by
 * `POST /api/v1/identity/token` VERIFIES against the JWK Set fetched from the
 * bare `/.well-known/jwks.json`. That path only exists because of a rewrite in
 * `next.config.ts`, and nothing else in the repo has ever exercised it. When it
 * breaks, signing keeps working and every verifier starts rejecting — the most
 * confusing possible failure, and invisible to a unit test.
 */

import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'

import { anonymous, apiGet, apiJson, type Caller } from './support/api'
import { BACKEND_URL, requireEnv } from './support/env'
import { stackDown } from './support/stack'
import { loginAdmin, provisionWorld, type World } from './support/world'

describe.skipIf(stackDown)('identity', () => {
  let admin: Caller
  let world: World

  beforeAll(async () => {
    // 🔴 A STACK WITHOUT A SIGNING KEYPAIR FAILS HERE, BY NAME. Nothing generates
    // AUTH_PRIVATE_KEY / AUTH_PUBLIC_KEY; a fresh `infra/.env` copied from
    // `.env.example` has neither. The backend then boots, serves an EMPTY JWK Set
    // and answers every mint with 503 — correct behaviour, but the tests below
    // would report it as a dozen unrelated status mismatches.
    const jwks = await apiGet(anonymous, '/.well-known/jwks.json')
    if (!Array.isArray(jwks.body?.keys) || jwks.body.keys.length === 0) {
      throw new Error(
        `[e2e] ${BACKEND_URL} serves an empty JWK Set: the stack has no identity signing ` +
          'keypair. Run `pnpm --filter @edc/backend keygen`, paste AUTH_PRIVATE_KEY and ' +
          'AUTH_PUBLIC_KEY into infra/.env, and recreate the backend container.',
      )
    }
    admin = await loginAdmin()
    world = await provisionWorld()
  }, 120_000)

  it('logs the seeded admin in and returns a usable session token', async () => {
    const res = await apiJson(anonymous, 'POST', '/api/users/login', {
      email: requireEnv('SEED_ADMIN_EMAIL'),
      password: requireEnv('SEED_ADMIN_PASSWORD'),
    })
    expect(res.status).toBe(200)
    expect(typeof res.body.token).toBe('string')
    expect(res.body.user.email).toBe(requireEnv('SEED_ADMIN_EMAIL').toLowerCase())
  })

  it('refuses a wrong password', async () => {
    const res = await apiJson(anonymous, 'POST', '/api/users/login', {
      email: requireEnv('SEED_ADMIN_EMAIL'),
      password: 'definitely-not-the-password',
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.body?.token).toBeUndefined()
  })

  it('GET /api/v1/identity/me returns the principal with every reachable ecosistema', async () => {
    const res = await apiGet(admin, '/api/v1/identity/me')
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe(requireEnv('SEED_ADMIN_EMAIL').toLowerCase())
    // The seeded admin is a platform admin, so the map expands over every ACTIVE
    // organization — including both of the ones this run just created.
    expect(res.body.principal.isPlatformAdmin).toBe(true)
    expect(Object.keys(res.body.principal.projects)).toEqual(
      expect.arrayContaining([world.orgA.slug, world.orgB.slug]),
    )
    // Never cacheable: it is per-session data.
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('GET /api/v1/identity/me is 401 without a session', async () => {
    const res = await apiGet(anonymous, '/api/v1/identity/me')
    expect(res.status).toBe(401)
  })

  it('/api/v1/identity/me never leaks password material', async () => {
    const res = await apiGet(admin, '/api/v1/identity/me')
    const serialized = JSON.stringify(res.body)
    for (const forbidden of ['password', 'salt', 'hash', 'resetPasswordToken', 'loginAttempts']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('serves the JWK Set at the BARE root path (the next.config rewrite)', async () => {
    const res = await apiGet(anonymous, '/.well-known/jwks.json')
    // ⚠ A rewrite, not a redirect. A 3xx here would still work in a browser and
    // would quietly halve the cache behaviour of every verifier.
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.keys)).toBe(true)
    expect(res.body.keys.length).toBeGreaterThan(0)
    expect(res.headers.get('cache-control')).toContain('max-age=3600')
    // Public by definition — every peer service fetches it cross-origin.
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('publishes only PUBLIC key material in the JWK Set', async () => {
    const res = await apiGet(anonymous, '/.well-known/jwks.json')
    for (const key of res.body.keys) {
      expect(key.use).toBe('sig')
      expect(key.alg).toBe('EdDSA')
      // `d` is the Ed25519 PRIVATE scalar. Its presence would be a total compromise.
      expect(key.d).toBeUndefined()
      expect(key.kid).toBeTruthy()
    }
  })

  it('the bare path and the Payload-mounted path serve the same key set', async () => {
    const bare = await apiGet(anonymous, '/.well-known/jwks.json')
    const mounted = await apiGet(anonymous, '/api/.well-known/jwks.json')
    expect(mounted.status).toBe(200)
    expect(mounted.body).toEqual(bare.body)
  })

  it('🔴 a minted token VERIFIES against the published JWK Set', async () => {
    const minted = await apiJson(admin, 'POST', '/api/v1/identity/token', {
      audience: world.orgA.slug,
    })
    expect(minted.status).toBe(200)
    expect(minted.body.tokenType).toBe('Bearer')
    expect(minted.body.algorithm).toBe('EdDSA')

    const jwks = await apiGet(anonymous, '/.well-known/jwks.json')
    const keySet = createLocalJWKSet(jwks.body)

    const header = decodeProtectedHeader(minted.body.token)
    expect(header.kid).toBe(minted.body.keyId)
    // The kid on the token has to be findable in the published set, or a
    // verifier fails with ERR_JWKS_NO_MATCHING_KEY.
    expect(jwks.body.keys.map((k: { kid: string }) => k.kid)).toContain(header.kid)

    const { payload } = await jwtVerify(minted.body.token, keySet, {
      issuer: minted.body.issuer,
      audience: world.orgA.slug,
    })
    expect(payload.sub).toBe(requireEnv('SEED_ADMIN_EMAIL').toLowerCase())
    expect(payload.aud).toBe(world.orgA.slug)
    expect(payload.iss).toBe(requireEnv('AUTH_ISSUER'))
    expect(Array.isArray(payload.roles)).toBe(true)
    expect(payload.perms).toEqual(expect.arrayContaining(['documents:read', 'chat:use']))
  })

  it('a token minted for one ecosistema does NOT verify against another audience', async () => {
    const minted = await apiJson(admin, 'POST', '/api/v1/identity/token', {
      audience: world.orgA.slug,
    })
    const jwks = await apiGet(anonymous, '/.well-known/jwks.json')
    const keySet = createLocalJWKSet(jwks.body)
    // ⚠ THE AUDIENCE IS A TENANT. A token for one customer must not be replayable
    // against another's data.
    await expect(
      jwtVerify(minted.body.token, keySet, { audience: world.orgB.slug }),
    ).rejects.toThrow()
  })

  it('an ordinary member gets a token for their own ecosistema and 403 for the other', async () => {
    const mine = await apiJson(world.alice.caller, 'POST', '/api/v1/identity/token', {
      audience: world.orgA.slug,
    })
    expect(mine.status).toBe(200)
    expect(mine.body.roles).toContain('owner')

    const theirs = await apiJson(world.alice.caller, 'POST', '/api/v1/identity/token', {
      audience: world.orgB.slug,
    })
    expect(theirs.status).toBe(403)
    expect(theirs.body.token).toBeUndefined()
  })

  it('404s an unknown audience and 400s a missing one', async () => {
    const unknown = await apiJson(admin, 'POST', '/api/v1/identity/token', {
      audience: `${world.ns}-does-not-exist`,
    })
    expect(unknown.status).toBe(404)

    const missing = await apiJson(admin, 'POST', '/api/v1/identity/token', {})
    expect(missing.status).toBe(400)
  })

  it('mints nothing without a session', async () => {
    const res = await apiJson(anonymous, 'POST', '/api/v1/identity/token', {
      audience: world.orgA.slug,
    })
    expect(res.status).toBe(401)
  })

  it('an issued token expires within the documented hard cap (900s)', async () => {
    const minted = await apiJson(admin, 'POST', '/api/v1/identity/token', {
      audience: world.orgA.slug,
    })
    expect(minted.body.expiresIn).toBeLessThanOrEqual(900)
    expect(minted.body.expiresIn).toBeGreaterThan(0)
  })

  it('the JWKS URL a verifier would derive from AUTH_ISSUER actually answers', async () => {
    // `@edc/identity-client` defaults to `<issuer>/.well-known/jwks.json`. If the
    // issuer is not this backend's own origin the rewrite above proves nothing.
    const issuer = requireEnv('AUTH_ISSUER').replace(/\/+$/, '')
    expect(issuer).toBe(BACKEND_URL)
  })
})
