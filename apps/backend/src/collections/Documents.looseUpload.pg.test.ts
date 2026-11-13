/**
 * 🔴 A CONVERSATION-LESS UPLOAD LANDS IN THE NAMED ECOSISTEMA — ONLY IF YOU ARE
 * A MEMBER. Against a real Postgres and the real Payload config, so the access
 * rules, hook order and error mapping are the production ones.
 *
 * Mis documentos sends the ecosistema selected in the web switcher.
 * `bindDocumentToEcosystem` must file the row there for a member of several,
 * refuse a non-member with 403 before anything is written, and leave a
 * single-membership person exactly as before.
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
import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { migrations } from '../migrations'
import { UPLOAD_CONSENT_VERSION } from '@/lib/uploadConsent'

const CONTAINER = `edc-backend-loose-upload-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const dockerOk = hasDocker()
if (!dockerOk) {
  console.warn('[Documents.looseUpload.pg.test] docker is not usable — the real-Postgres tests SKIP.')
}

type Db = ReturnType<typeof drizzle>
let db: Db
let payload: Payload

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
      '-e', 'POSTGRES_DB=loose_upload_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/loose_upload_test`
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

const docRows = async (): Promise<Array<{ org: number; by: number }>> =>
  ((await db.execute(
    sql.raw('SELECT organization_id AS org, uploaded_by_id AS by FROM documents ORDER BY id'),
  )) as unknown as { rows: Array<{ org: number; by: number }> }).rows.map((r) => ({
    org: Number(r.org),
    by: Number(r.by),
  }))

const DUAL = 1 // member of ecosistemas 1 and 2
const SOLO = 2 // member of ecosistema 1 only

async function createAs(userId: number, data: Record<string, unknown>) {
  const user = await payload.findByID({ collection: 'users', id: userId, overrideAccess: true })
  return payload.create({
    collection: 'documents',
    overrideAccess: false,
    user,
    data: { uploadConsentVersion: UPLOAD_CONSENT_VERSION, kind: 'markdown', name: 'nota', bodyMarkdown: 'hola', session: [], ...data } as never,
  })
}

describe.skipIf(!dockerOk)('uploading with no conversation, on a real Postgres', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)

    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'loose-upload-test-secret'
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
    await db.execute(sql.raw(`
      TRUNCATE documents, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, 'dual@example.invalid'), (2, 'solo@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno'), (2, 'Dos', 'dos'), (3, 'Tres', 'tres');
      INSERT INTO memberships (user_id, organization_id, role) VALUES (1, 1, 'member'), (1, 2, 'member'), (2, 1, 'member');
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

  it('files it in the named ecosistema for a member of several', async () => {
    await createAs(DUAL, { organization: 2 })
    await createAs(DUAL, { organization: '1' })
    expect(await docRows()).toEqual([
      { org: 2, by: DUAL },
      { org: 1, by: DUAL },
    ])
  }, 30_000)

  it('🔴 refuses a non-member ecosistema with 403 and writes nothing', async () => {
    await expect(createAs(DUAL, { organization: 3 })).rejects.toMatchObject({ status: 403 })
    await expect(createAs(SOLO, { organization: 2 })).rejects.toMatchObject({ status: 403 })
    expect(await docRows()).toEqual([])
  }, 30_000)

  it('still refuses a member of several who names none', async () => {
    await expect(createAs(DUAL, {})).rejects.toMatchObject({ status: 400 })
    expect(await docRows()).toEqual([])
  }, 30_000)

  it('a single-membership person is unchanged: no ecosistema named, derived as before', async () => {
    await createAs(SOLO, {})
    await createAs(SOLO, { organization: 1 })
    expect(await docRows()).toEqual([
      { org: 1, by: SOLO },
      { org: 1, by: SOLO },
    ])
  }, 30_000)
})
