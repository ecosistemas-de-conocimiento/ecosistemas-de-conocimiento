/**
 * 🔴 WHO MAY FLIP A SWITCH. `/api/funciones` and `/api/plataforma` against a
 * real Postgres (every migration, including the one that adds
 * `organizations.features` and `platform_settings`) and the real Payload config.
 *
 * Pinned: a platform admin flips any ecosistema and the platform; a
 * responsable (`owner`) flips only their own ecosistema and never the
 * platform; an `admin` or `member` flips nothing — on the routes AND on the
 * plain collection/global API.
 *
 * ⚠ No docker → the suite SKIPS, with a console warning naming the reason.
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import type { Endpoint, Payload, PayloadRequest } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { FEATURE_DEFAULTS, featureEnabled, invalidateFeatures } from '../lib/features'
import { detectorFallbackMode, invalidatePlatformSettings } from '../lib/platformSettings'
import { migrations } from '../migrations'
import { funcionesEndpoints } from './funciones'

const CONTAINER = `edc-backend-funciones-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'

const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
if (!dockerOk) console.warn('[funciones.pg.test] docker is not usable — the real-Postgres tests SKIP.')

type Db = ReturnType<typeof drizzle>
let db: Db
let payload: Payload

const stopContainer = () => spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })

async function startPostgres(): Promise<string> {
  stopContainer()
  const run = spawnSync(
    'docker',
    [
      'run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data', '--name', CONTAINER, '-p', '0:5432',
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=funciones_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/funciones_test`
}

async function waitForQueries(candidate: Db): Promise<void> {
  const deadline = Date.now() + 25_000
  let last: unknown
  while (Date.now() < deadline) {
    try {
      await candidate.execute(sql`select 1`)
      return
    } catch (err) {
      last = err
      await delay(300)
    }
  }
  throw new Error(`postgres never answered: ${String(last)}`)
}

// 1 root (platform admin) · 2 olga, owner of A · 3 adan, admin of A ·
// 4 memo, member of A · 5 bea, owner of B · 6 ines, investigador of A.
const ROOT = 1
const OLGA = 2
const ADAN = 3
const MEMO = 4
const BEA = 5
const INES = 6
const ECO_A = 1
const ECO_B = 2

const endpoint = (method: string, path: string): Endpoint => {
  const found = funcionesEndpoints.find((e) => e.method === method && e.path === path)
  if (!found) throw new Error(`no ${method} ${path}`)
  return found
}

const userDoc = async (id: number) =>
  ({ ...(await payload.findByID({ collection: 'users', id, overrideAccess: true })), collection: 'users' }) as never

async function call(
  method: 'get' | 'patch',
  path: string,
  as: number,
  opts: { query?: Record<string, string>; body?: Record<string, unknown> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { createLocalReq } = await import('payload')
  const req = (await createLocalReq({ user: await userDoc(as) }, payload)) as PayloadRequest
  const url = new URL(`http://test.local/api${path}`)
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)
  Object.assign(req, { searchParams: url.searchParams, routeParams: {}, json: async () => opts.body ?? {} })
  const res = await endpoint(method, path).handler(req)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const storedFeatures = async (orgId: number) =>
  ((await db.execute(sql.raw(`SELECT features FROM organizations WHERE id = ${orgId}`))) as unknown as {
    rows: Array<{ features: unknown }>
  }).rows[0]?.features ?? null

const flip = (as: number, organization: number, features: Record<string, unknown>) =>
  call('patch', '/funciones', as, { body: { organization, features } })

describe.skipIf(!dockerOk)('/api/funciones and /api/plataforma on a real Postgres', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)

    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'funciones-test-secret'
    for (const v of [
      'TRANSCRIPTION_JANITOR_ENABLED',
      'PUBLISH_JANITOR_ENABLED',
      'EMBEDDING_JANITOR_ENABLED',
      'INGEST_RECOVERY_JANITOR_ENABLED',
    ]) {
      process.env[v] = 'false'
    }
    const { getPayload } = await import('payload')
    const { default: config } = await import('@payload-config')
    payload = await getPayload({ config })
  }, 90_000)

  beforeEach(async () => {
    invalidateFeatures()
    invalidatePlatformSettings()
    delete process.env.ANONYMISE_DETECT_FALLBACK
    await db.execute(sql.raw(`
      TRUNCATE memberships, organizations, users, platform_settings RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, display_name, is_platform_admin) VALUES
        (1, 'root@example.invalid', 'Root', true),
        (2, 'olga@example.invalid', 'Olga', false),
        (3, 'adan@example.invalid', 'Adán', false),
        (4, 'memo@example.invalid', 'Memo', false),
        (5, 'bea@example.invalid', 'Bea', false),
        (6, 'ines@example.invalid', 'Inés', false);
      SELECT setval('users_id_seq', 6);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Eco A', 'eco-a'), (2, 'Eco B', 'eco-b');
      SELECT setval('organizations_id_seq', 2);
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES
        (1, 2, 1, 'owner'), (2, 3, 1, 'admin'), (3, 4, 1, 'member'), (4, 5, 2, 'owner'),
        (5, 6, 1, 'investigador');
      SELECT setval('memberships_id_seq', 5);
    `))
  })

  afterAll(async () => {
    const pool = (payload?.db as unknown as {
      pool?: { on(e: 'error', f: () => void): void; _clients?: Array<{ on(e: 'error', f: () => void): void }> }
    })?.pool
    pool?.on('error', () => {})
    for (const client of pool?._clients ?? []) client.on('error', () => {})
    await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    stopContainer()
  })

  it('an untouched ecosistema reads as the defaults; members may read, outsiders may not', async () => {
    const memo = await call('get', '/funciones', MEMO, { query: { organization: String(ECO_A) } })
    expect(memo.status).toBe(200)
    expect(memo.body.features).toEqual(FEATURE_DEFAULTS)
    expect((await call('get', '/funciones', BEA, { query: { organization: String(ECO_A) } })).status).toBe(403)
  })

  it('the responsable flips their own ecosistema, and the switch takes effect', async () => {
    const res = await flip(OLGA, ECO_A, { liveMic: false, studentView: true })
    expect(res.status).toBe(200)
    expect(res.body.features).toMatchObject({ liveMic: false, studentView: true, graph: true })
    expect(await storedFeatures(ECO_A)).toEqual({ liveMic: false, studentView: true })
    expect(await featureEnabled(payload, ECO_A, 'liveMic')).toBe(false)
    // A second save merges, it does not replace.
    await flip(OLGA, ECO_A, { graph: false })
    expect(await storedFeatures(ECO_A)).toEqual({ liveMic: false, studentView: true, graph: false })
  })

  it('🔴 a responsable cannot flip another ecosistema', async () => {
    expect((await flip(BEA, ECO_A, { graph: false })).status).toBe(403)
    expect(await storedFeatures(ECO_A)).toBeNull()
  })

  it('🔴 an admin or a member of the ecosistema cannot flip anything', async () => {
    expect((await flip(ADAN, ECO_A, { graph: false })).status).toBe(403)
    expect((await flip(MEMO, ECO_A, { graph: false })).status).toBe(403)
    expect(await storedFeatures(ECO_A)).toBeNull()
  })

  it('🔴 the plain collection API holds the same line', async () => {
    for (const [as, org] of [[MEMO, ECO_A], [ADAN, ECO_A], [BEA, ECO_A]] as const) {
      await expect(
        payload.update({
          collection: 'organizations',
          id: org,
          data: { features: { graph: false } } as never,
          overrideAccess: false,
          user: await userDoc(as),
        }),
      ).rejects.toBeTruthy()
    }
    expect(await storedFeatures(ECO_A)).toBeNull()
  })

  it('refuses unknown keys and non-booleans', async () => {
    expect((await flip(OLGA, ECO_A, { grafo: false })).status).toBe(400)
    expect((await flip(OLGA, ECO_A, { graph: 'no' })).status).toBe(400)
  })

  it('a platform admin flips any ecosistema', async () => {
    expect((await flip(ROOT, ECO_B, { audioUpload: false })).status).toBe(200)
    expect(await featureEnabled(payload, ECO_B, 'audioUpload')).toBe(false)
  })

  it('editables: admin sees every ecosistema and the platform; a responsable only theirs; others 403', async () => {
    const root = await call('get', '/funciones/editables', ROOT)
    expect((root.body.ecosistemas as Array<{ id: string }>).map((e) => e.id)).toEqual(['1', '2'])
    expect(root.body.plataforma).toMatchObject({ detectorFallback: null, detectorFallbackEffective: 'hosted' })
    const olga = await call('get', '/funciones/editables', OLGA)
    expect((olga.body.ecosistemas as Array<{ id: string }>).map((e) => e.id)).toEqual(['1'])
    expect(olga.body.plataforma).toBeNull()
    expect((await call('get', '/funciones/editables', ADAN)).status).toBe(403)
    expect((await call('get', '/funciones/editables', MEMO)).status).toBe(403)
  })

  it('🔴 only a platform admin flips the detector fallback; env stays the default until then', async () => {
    process.env.ANONYMISE_DETECT_FALLBACK = 'hosted'
    expect(await detectorFallbackMode()).toBe('hosted')
    for (const as of [OLGA, ADAN, MEMO]) {
      expect((await call('patch', '/plataforma', as, { body: { detectorFallback: 'none' } })).status).toBe(403)
    }
    await expect(
      payload.updateGlobal({
        slug: 'platform-settings',
        data: { detectorFallback: 'none' } as never,
        overrideAccess: false,
        user: await userDoc(OLGA),
      }),
    ).rejects.toBeTruthy()
    expect(await detectorFallbackMode()).toBe('hosted')

    const res = await call('patch', '/plataforma', ROOT, { body: { detectorFallback: 'none' } })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ detectorFallback: 'none', detectorFallbackEnv: 'hosted', detectorFallbackEffective: 'none' })
    expect(await detectorFallbackMode()).toBe('none')

    // `null` hands it back to env.
    await call('patch', '/plataforma', ROOT, { body: { detectorFallback: null } })
    expect(await detectorFallbackMode()).toBe('hosted')
    expect((await call('patch', '/plataforma', ROOT, { body: { detectorFallback: 'maybe' } })).status).toBe(400)
  })
  describe('🔴 keepPublicFigures is the platform admin\'s alone (owner ruling Q16 A)', () => {
    const LOCKED = 'Solo administración de la plataforma puede cambiar «Conservar nombres de figuras públicas».'
    const setStored = (orgId: number, features: Record<string, boolean>) =>
      db.execute(sql.raw(`UPDATE organizations SET features = '${JSON.stringify(features)}'::jsonb WHERE id = ${orgId}`))
    const status = async (p: Promise<unknown>): Promise<number | 'ok'> => {
      try {
        await p
        return 'ok'
      } catch (err) {
        return ((err as { status?: number }).status ?? -1) as number
      }
    }
    const localUpdate = async (as: number | null, features: Record<string, unknown>) =>
      payload.update({
        collection: 'organizations',
        id: ECO_A,
        data: { features } as never,
        overrideAccess: as === null,
        ...(as === null ? {} : { user: await userDoc(as) }),
      })

    it('/api/funciones: the responsable and the investigador get 403, and nothing moves', async () => {
      for (const as of [OLGA, INES]) {
        const res = await flip(as, ECO_A, { keepPublicFigures: true })
        expect([as, res.status]).toEqual([as, 403])
        expect((res.body.errors as Array<{ message: string }>)[0]?.message).toBe(LOCKED)
      }
      expect(await storedFeatures(ECO_A)).toBeNull()

      await setStored(ECO_A, { keepPublicFigures: true })
      invalidateFeatures()
      expect((await flip(OLGA, ECO_A, { keepPublicFigures: false, graph: false })).status).toBe(403)
      expect(await storedFeatures(ECO_A)).toEqual({ keepPublicFigures: true })
    })

    it('/api/funciones: the responsable still flips every other switch, even sending the locked one unchanged', async () => {
      await setStored(ECO_A, { keepPublicFigures: true })
      invalidateFeatures()
      // The web page sends every key; an unchanged locked key is not a change.
      expect((await flip(OLGA, ECO_A, { keepPublicFigures: true, graph: false })).status).toBe(200)
      expect((await flip(INES, ECO_A, { liveMic: false })).status).toBe(200)
      expect(await storedFeatures(ECO_A)).toEqual({ keepPublicFigures: true, graph: false, liveMic: false })
    })

    it('/api/funciones: a platform admin flips it', async () => {
      expect((await flip(ROOT, ECO_A, { keepPublicFigures: true })).status).toBe(200)
      expect(await featureEnabled(payload, ECO_A, 'keepPublicFigures')).toBe(true)
      expect((await flip(ROOT, ECO_A, { keepPublicFigures: false })).status).toBe(200)
      expect(await storedFeatures(ECO_A)).toEqual({ keepPublicFigures: false })
    })

    it('collection API (REST/GraphQL go through it): owner and investigador refused with 403, other keys pass', async () => {
      for (const as of [OLGA, INES]) {
        expect([as, await status(localUpdate(as, { keepPublicFigures: true }))]).toEqual([as, 403])
      }
      expect(await storedFeatures(ECO_A)).toBeNull()
      expect(await status(localUpdate(OLGA, { graph: false }))).toBe('ok')
      expect(await storedFeatures(ECO_A)).toEqual({ graph: false })

      // A whole-object write that drops the key turns it off: that is a change too.
      await setStored(ECO_A, { keepPublicFigures: true })
      expect(await status(localUpdate(OLGA, { graph: true }))).toBe(403)
      expect(await storedFeatures(ECO_A)).toEqual({ keepPublicFigures: true })
    })

    it('collection API: a bulk update by the owner is refused for the row', async () => {
      const out = await payload.update({
        collection: 'organizations',
        where: { id: { equals: ECO_A } },
        data: { features: { keepPublicFigures: true } } as never,
        overrideAccess: false,
        user: await userDoc(OLGA),
      })
      expect(out.docs).toHaveLength(0)
      expect(out.errors).toHaveLength(1)
      expect(await storedFeatures(ECO_A)).toBeNull()
    })

    it('collection API: fails closed when the caller is unknown, even with access overridden', async () => {
      expect(await status(localUpdate(null, { keepPublicFigures: true }))).toBe(403)
      expect(await storedFeatures(ECO_A)).toBeNull()
      // Other keys still go through on a trusted server-side write.
      expect(await status(localUpdate(null, { graph: false }))).toBe('ok')
    })

    it('collection API: a platform admin changes it', async () => {
      expect(await status(localUpdate(ROOT, { keepPublicFigures: true }))).toBe('ok')
      expect(await storedFeatures(ECO_A)).toEqual({ keepPublicFigures: true })
    })

    it('REST PATCH /api/organizations/:id (the real route handler): owner 403, other keys OK, admin OK', async () => {
      const { REST_PATCH } = await import('@payloadcms/next/routes')
      const { default: config } = await import('@payload-config')
      const patch = REST_PATCH(config)
      const tokenFor = async (id: number, email: string) => {
        await payload.update({ collection: 'users', id, data: { password: 'Rest-test-1234' } as never, overrideAccess: true })
        const out = await payload.login({ collection: 'users', data: { email, password: 'Rest-test-1234' } })
        return out.token as string
      }
      const rest = async (token: string, features: Record<string, boolean>) => {
        const res = await patch(
          new Request(`http://localhost:3000/api/organizations/${ECO_A}`, {
            method: 'PATCH',
            headers: { Authorization: `JWT ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ features }),
          }),
          { params: Promise.resolve({ slug: ['organizations', String(ECO_A)] }) },
        )
        return { status: res.status, body: (await res.json()) as { errors?: Array<{ message: string }> } }
      }
      const olga = await tokenFor(OLGA, 'olga@example.invalid')
      const refused = await rest(olga, { keepPublicFigures: true })
      expect(refused.status).toBe(403)
      expect(refused.body.errors?.[0]?.message).toBe(LOCKED)
      expect(await storedFeatures(ECO_A)).toBeNull()
      expect((await rest(olga, { graph: false })).status).toBe(200)
      expect(await storedFeatures(ECO_A)).toEqual({ graph: false })
      const root = await tokenFor(ROOT, 'root@example.invalid')
      expect((await rest(root, { keepPublicFigures: true })).status).toBe(200)
      expect(await storedFeatures(ECO_A)).toEqual({ keepPublicFigures: true })
    }, 30_000)

    it('editables tells the page which switches this caller cannot change', async () => {
      expect((await call('get', '/funciones/editables', OLGA)).body.lockedFeatures).toEqual(['keepPublicFigures'])
      expect((await call('get', '/funciones/editables', ROOT)).body.lockedFeatures).toEqual([])
    })
  })
})
