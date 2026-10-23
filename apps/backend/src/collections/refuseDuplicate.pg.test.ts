/**
 * 🔴 DUPLICATE MUST NOT COPY A TESTIMONIO'S UNREDACTED ORIGINAL — BY ANY ROUTE.
 *
 * The leak (auditor probe, real Postgres, 2026-10-23): a member of ecosistema 1
 * duplicated a published testimonio another person uploaded, sending
 * `{ contentKind: 'documento' }`. Payload filled every omitted field from the
 * source row, field read access skipped, so the member owned a new ungated
 * draft holding `extracted_text = 'ORIGINAL …'`.
 *
 * Each route into `createOperation` with `duplicateFromID` is exercised:
 * the REST route through Payload's real router (`handleEndpoints`, signed in
 * with a real JWT), the local `payload.duplicate`, and `payload.create` with
 * `duplicateFromID` (which skips the `disableDuplicate` check entirely).
 * Every case asserts the status AND that no row was written.
 *
 * Harness: same as `Sessions.ownerGuard.pg.test.ts` — throwaway
 * `postgres:16-alpine` on tmpfs, every migration, ai-service stubbed.
 *
 * ⚠ No docker → the suite SKIPS, with a console warning naming the reason.
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { migrations } from '../migrations'
import { refuseDuplicate } from './hooks/refuseDuplicate'

const CONTAINER = `edc-refuse-duplicate-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'
const PASSWORD = 'refuse-duplicate-test-pw'

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const dockerOk = hasDocker()
if (!dockerOk) {
  console.warn('[refuseDuplicate.pg.test] docker is not usable — the real-Postgres tests SKIP.')
}

type Db = ReturnType<typeof drizzle>
let db: Db
let payload: Payload
let config: SanitizedConfig

function stopContainer(): void {
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
}

async function startPostgres(): Promise<string> {
  stopContainer()
  const run = spawnSync(
    'docker',
    [
      'run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data', '--name', CONTAINER, '-p', '0:5432',
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=refuse_duplicate_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/refuse_duplicate_test`
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

const DUAL = 1 // member of ecosistemas 1 and 2
const MEMBER = 2 // member of ecosistema 1 only — the probe's duplicator on main
const ADMIN = 3 // platform admin
const UPLOADER = 4 // uploaded the testimonio

const count = async (table: string): Promise<number> =>
  Number(
    ((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))) as unknown as {
      rows: Array<{ n: number }>
    }).rows[0]?.n,
  )

const leakedRows = async (): Promise<number> =>
  Number(
    ((await db.execute(
      sql.raw(`SELECT count(*)::int AS n FROM documents WHERE extracted_text LIKE 'ORIGINAL%' AND uploaded_by_id <> ${UPLOADER}`),
    )) as unknown as { rows: Array<{ n: number }> }).rows[0]?.n,
  )

const asUser = async (id: number) => payload.findByID({ collection: 'users', id, overrideAccess: true })

async function tokenFor(id: number): Promise<string> {
  const user = await asUser(id)
  const { token } = await payload.login({
    collection: 'users',
    data: { email: user.email as string, password: PASSWORD },
  })
  if (!token) throw new Error('login returned no token')
  return token
}

async function rest(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  const { handleEndpoints } = await import('payload')
  return handleEndpoints({
    config,
    request: new Request(`http://localhost${path}`, {
      method,
      headers: { Authorization: `JWT ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  })
}

/** A published, approved testimonio by UPLOADER in ecosistema 1, as the probe seeded it. */
async function seedTestimonio(): Promise<number> {
  const t = await payload.create({
    collection: 'documents',
    overrideAccess: true,
    data: { organization: 1, uploadedBy: UPLOADER, name: 'voz', kind: 'markdown', contentKind: 'testimonio', bodyMarkdown: 'x' } as never,
    context: { __skipDocsExtract: true } as never,
  })
  await db.execute(sql.raw(`
    UPDATE documents SET content_kind = 'testimonio', publication_status = 'published', ingest_status = 'ready',
      extracted_text = 'ORIGINAL Juan Perez calle 5', redacted_text = 'REDACTED [NOMBRE]', anonymisation_status = 'approved'
    WHERE id = ${t.id}`))
  return Number(t.id)
}

describe.skipIf(!dockerOk)('duplicating a row, on a real Postgres', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)

    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'refuse-duplicate-test-secret'
    for (const v of [
      'TRANSCRIPTION_JANITOR_ENABLED',
      'PUBLISH_JANITOR_ENABLED',
      'EMBEDDING_JANITOR_ENABLED',
      'INGEST_RECOVERY_JANITOR_ENABLED',
    ]) {
      process.env[v] = 'false'
    }
    const { getPayload } = await import('payload')
    config = await (await import('@payload-config')).default
    payload = await getPayload({ config })
  }, 90_000)

  let voz: number

  beforeEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE documents, memberships, organizations, users, sessions RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, 'member@example.invalid'), (2, 'solo@example.invalid');
      INSERT INTO users (id, email, is_platform_admin) VALUES (3, 'admin@example.invalid', true), (4, 'uploader@example.invalid', false);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno'), (2, 'Dos', 'dos');
      INSERT INTO memberships (user_id, organization_id, role) VALUES (1, 1, 'member'), (1, 2, 'member'), (2, 1, 'member'), (3, 1, 'member'), (4, 1, 'member');
      INSERT INTO sessions (id, user_id, organization_id) VALUES (10, 1, 1);
    `))
    for (const id of [DUAL, MEMBER, ADMIN]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
    voz = await seedTestimonio()
  }, 30_000)

  afterAll(async () => {
    // ⚠ Payload's pool cannot be ended (see Sessions.ownerGuard.pg.test.ts).
    const pool = (payload?.db as unknown as {
      pool?: { on(e: 'error', f: () => void): void; _clients?: Array<{ on(e: 'error', f: () => void): void }> }
    })?.pool
    pool?.on('error', () => {})
    for (const client of pool?._clients ?? []) client.on('error', () => {})
    await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    stopContainer()
  })

  it('the member cannot read the original — the premise of the leak', async () => {
    const seen = await payload.findByID({ collection: 'documents', id: voz, user: await asUser(MEMBER), overrideAccess: false })
    expect((seen as unknown as Record<string, unknown>).extractedText).toBeUndefined()
  }, 15_000)

  it('REST POST /api/documents/:id/duplicate is refused and writes nothing (the probe)', async () => {
    // DUAL + `organization: 2` is the multi-ecosistema upload branch's shape.
    for (const [uid, body] of [
      [MEMBER, { contentKind: 'documento' }],
      [MEMBER, {}],
      [DUAL, { contentKind: 'documento', organization: 2 }],
    ] as const) {
      const res = await rest('POST', `/api/documents/${voz}/duplicate`, await tokenFor(uid), body)
      expect(res.status, `${uid} ${JSON.stringify(body)}`).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      expect(await res.text()).not.toContain('ORIGINAL')
    }
    expect(await count('documents')).toBe(1)
    expect(await leakedRows()).toBe(0)
  }, 20_000)

  it('local payload.duplicate is refused and writes nothing', async () => {
    const user = await asUser(MEMBER)
    await expect(
      payload.duplicate({ collection: 'documents', id: voz, user, overrideAccess: false, data: { contentKind: 'documento' } as never }),
    ).rejects.toMatchObject({ status: expect.any(Number) })
    expect(await count('documents')).toBe(1)
  }, 15_000)

  it('payload.create with duplicateFromID — which skips the disableDuplicate check — is refused too', async () => {
    const user = await asUser(MEMBER)
    await expect(
      payload.create({ collection: 'documents', duplicateFromID: voz, user, overrideAccess: false, data: { contentKind: 'documento' } as never }),
    ).rejects.toMatchObject({ status: 405 })
    expect(await count('documents')).toBe(1)
    expect(await leakedRows()).toBe(0)
  }, 15_000)

  it('a platform admin cannot REST-duplicate any seeded row in any collection', async () => {
    const token = await tokenFor(ADMIN)
    const membership = Number(
      ((await db.execute(sql.raw('SELECT min(id) AS id FROM memberships'))) as unknown as { rows: Array<{ id: number }> }).rows[0]?.id,
    )
    const targets: Array<[string, string, number]> = [
      ['documents', 'documents', voz],
      ['users', 'users', DUAL],
      ['organizations', 'organizations', 1],
      ['memberships', 'memberships', membership],
      ['sessions', 'sessions', 10],
    ]
    for (const [slug, table, id] of targets) {
      const before = await count(table)
      const res = await rest('POST', `/api/${slug}/${id}/duplicate`, token, {})
      expect(res.status, slug).toBeGreaterThanOrEqual(400)
      expect(res.status, slug).toBeLessThan(500)
      expect(await count(table), slug).toBe(before)
    }
  }, 30_000)

  // ⚠ Payload's own `payload-*` collections are added after `collections` is
  // read, so `withoutDuplicate` cannot reach them. None holds corpus text:
  // `payload-kv` and `payload-preferences` refuse a member (403, measured) and
  // `payload-migrations` has no REST routes (501, measured).
  it('every app collection is built with disableDuplicate and refuseDuplicate first', () => {
    const app = config.collections.filter((c) => !c.slug.startsWith('payload-'))
    expect(app.length).toBeGreaterThanOrEqual(14)
    for (const c of app) {
      expect(c.disableDuplicate, c.slug).toBe(true)
      expect(c.hooks.beforeOperation[0], c.slug).toBe(refuseDuplicate)
    }
  })

  it('the versions routes expose nothing — no collection has versions', async () => {
    expect(config.collections.filter((c) => c.versions).map((c) => c.slug)).toEqual([])
    const token = await tokenFor(MEMBER)
    for (const [method, path] of [
      ['GET', '/api/documents/versions'],
      ['GET', `/api/documents/versions/${voz}`],
      ['POST', `/api/documents/versions/${voz}`],
    ] as const) {
      const res = await rest(method, path, token)
      expect(res.status, `${method} ${path}`).not.toBe(200)
      expect(await res.text()).not.toContain('ORIGINAL')
    }
    expect(await count('documents')).toBe(1)
  }, 20_000)
})
