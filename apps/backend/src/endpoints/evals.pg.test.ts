/**
 * `/api/evals/*` and the eval collections against a REAL Postgres and the
 * real Payload config: a platform admin who is a member of nothing gets a
 * conversation in the ecosistema (the REST create would refuse it), the
 * backend resolves that conversation's corpora for them, and the eval rows
 * are platform-admin only. ⚠ No docker → SKIPS.
 */
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PayloadRequest } from 'payload'


// Every migration, not the baseline alone: the booted config expects the
// columns later ones add (`documents.uploaded_in_session_id`).
import { migrations } from '../migrations'
import { makeEvalEndpoints } from './evals'

const CONTAINER = `edc-backend-evals-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const dockerOk = hasDocker()
if (!dockerOk) {
  console.warn('[evals.pg.test] docker is not usable — the real-Postgres tests SKIP.')
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
      '-e', 'POSTGRES_DB=evals_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/evals_test`
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


describe.skipIf(!dockerOk)('evals on a real Postgres', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)
    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'evals-test-secret'
    for (const v of ['TRANSCRIPTION_JANITOR_ENABLED', 'PUBLISH_JANITOR_ENABLED', 'EMBEDDING_JANITOR_ENABLED', 'INGEST_RECOVERY_JANITOR_ENABLED']) {
      process.env[v] = 'false'
    }
    const { getPayload } = await import('payload')
    const { default: config } = await import('@payload-config')
    payload = await getPayload({ config })
  }, 90_000)

  beforeEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE documents, memberships, sessions, eval_items, eval_runs, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin, is_active) VALUES (1, 'admin@example.invalid', true, true), (2, 'owner@example.invalid', false, true);
      INSERT INTO organizations (id, name, slug) VALUES (7, 'Discapacidad', 'discapacidad');
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

  const [sessionRoute] = makeEvalEndpoints()

  it('🔴 a non-member platform admin gets an eval conversation the REST path would refuse', async () => {
    const admin = await payload.findByID({ collection: 'users', id: 1, overrideAccess: true })
    await expect(
      payload.create({ collection: 'sessions', data: { organization: 7, kind: 'generales' } as never, overrideAccess: false, user: admin }),
    ).rejects.toThrow()

    await db.execute(sql.raw(`INSERT INTO eval_runs (id, organization_id, status, triggered_by_id) VALUES (40, 7, 'running', 1)`))
    const req = { user: admin, payload, json: async () => ({ run: 40 }) } as unknown as PayloadRequest
    const res = (await sessionRoute!.handler(req)) as Response
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: number }
    const row = (await db.execute(sql.raw(`SELECT user_id, organization_id, kind, eval_run FROM sessions WHERE id = ${Number(id)}`))) as unknown as {
      rows: Array<{ user_id: number; organization_id: number; kind: string; eval_run: string }>
    }
    expect(row.rows[0]).toEqual({ user_id: 1, organization_id: 7, kind: 'generales', eval_run: '40' })
    const bound = (await db.execute(sql.raw('SELECT session_id FROM eval_runs WHERE id = 40'))) as unknown as { rows: Array<{ session_id: string }> }
    expect(bound.rows[0]!.session_id).toBe(String(id))

    // 🔴 R77: the admin cannot unbind it through REST to chat there freely.
    await payload.update({ collection: 'sessions', id, data: { evalRun: null } as never, overrideAccess: false, user: admin })
    const still = (await db.execute(sql.raw(`SELECT eval_run FROM sessions WHERE id = ${Number(id)}`))) as unknown as { rows: Array<{ eval_run: string }> }
    expect(still.rows[0]!.eval_run).toBe('40')

    const { corporaForSession } = await import('../lib/corpus')
    const corpora = await corporaForSession(payload, id, 1)
    expect(corpora.organizationId).toBe(7)
  }, 30_000)

  it('🔴 R77: a direct call without a running run gets no conversation', async () => {
    const admin = await payload.findByID({ collection: 'users', id: 1, overrideAccess: true })
    await db.execute(sql.raw(`INSERT INTO eval_runs (id, organization_id, status, triggered_by_id) VALUES (41, 7, 'done', 1), (42, 7, 'queued', 1)`))
    for (const body of [{ organization: 7 }, { run: 41 }, { run: 42 }, { run: 999 }]) {
      const req = { user: admin, payload, json: async () => body } as unknown as PayloadRequest
      const res = (await sessionRoute!.handler(req)) as Response
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400)
    }
    const n = (await db.execute(sql.raw('SELECT count(*) AS n FROM sessions'))) as unknown as { rows: Array<{ n: string }> }
    expect(Number(n.rows[0]!.n)).toBe(0)
  }, 30_000)

  it('🔴 R77: an eval conversation never carries a document', async () => {
    const admin = await payload.findByID({ collection: 'users', id: 1, overrideAccess: true })
    await db.execute(sql.raw(`INSERT INTO eval_runs (id, organization_id, status, triggered_by_id) VALUES (43, 7, 'running', 1)`))
    const req = { user: admin, payload, json: async () => ({ run: 43 }) } as unknown as PayloadRequest
    const { id } = (await ((await sessionRoute!.handler(req)) as Response).json()) as { id: number }
    const reason = await payload
      .create({
        collection: 'documents',
        overrideAccess: false,
        user: admin,
        data: { kind: 'markdown', name: 'nota', bodyMarkdown: 'hola', session: [id] } as never,
      })
      .then(
        () => 'created',
        (err: { data?: { errors?: Array<{ message?: string }> }; message?: string }) => err.data?.errors?.[0]?.message ?? err.message ?? '',
      )
    expect(reason).toMatch(/evaluación/)
    const n = (await db.execute(sql.raw('SELECT count(*) AS n FROM documents'))) as unknown as { rows: Array<{ n: string }> }
    expect(Number(n.rows[0]!.n)).toBe(0)
  }, 30_000)

  it('🔴 R77: a REST create cannot forge evalRun (an ordinary conversation stays ordinary)', async () => {
    await db.execute(sql.raw(`
      INSERT INTO memberships (user_id, organization_id, role) VALUES (2, 7, 'owner');
      INSERT INTO eval_runs (id, organization_id, status, triggered_by_id) VALUES (44, 7, 'running', 1);
    `))
    const owner = await payload.findByID({ collection: 'users', id: 2, overrideAccess: true })
    const created = (await payload.create({
      collection: 'sessions',
      data: { organization: 7, kind: 'generales', evalRun: 44 } as never,
      overrideAccess: false,
      user: owner,
    })) as { id: number }
    const row = (await db.execute(sql.raw(`SELECT eval_run FROM sessions WHERE id = ${Number(created.id)}`))) as unknown as { rows: Array<{ eval_run: string | null }> }
    expect(row.rows[0]!.eval_run).toBeNull()
  }, 30_000)

  it('🔴 eval rows: a platform admin reads and writes them, an owner sees nothing and cannot create', async () => {
    const admin = await payload.findByID({ collection: 'users', id: 1, overrideAccess: true })
    const owner = await payload.findByID({ collection: 'users', id: 2, overrideAccess: true })
    const created = await payload.create({
      collection: 'eval-items',
      data: { organization: 7, kind: 'privacidad', text: 'sintético', privateNames: 'Ana, Luis\nAna' } as never,
      overrideAccess: false,
      user: admin,
    })
    expect((created as { privateNames: unknown }).privateNames).toEqual(['Ana', 'Luis'])
    await expect(
      payload.find({ collection: 'eval-items', overrideAccess: false, user: owner }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      payload.create({ collection: 'eval-runs', data: { organization: 7 } as never, overrideAccess: false, user: owner }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      payload.create({ collection: 'eval-items', data: { organization: 7, kind: 'pregunta' } as never, overrideAccess: false, user: admin }),
    ).rejects.toThrow(/question/)
  }, 30_000)

  it('deleting the ecosistema takes its eval rows with it (ON DELETE cascade)', async () => {
    await db.execute(sql.raw(`
      INSERT INTO eval_items (organization_id, kind, question) VALUES (7, 'pregunta', '¿?');
      INSERT INTO eval_runs (organization_id) VALUES (7);
      DELETE FROM organizations WHERE id = 7;
    `))
    const left = (await db.execute(sql.raw('SELECT (SELECT count(*) FROM eval_items) + (SELECT count(*) FROM eval_runs) AS n'))) as unknown as { rows: Array<{ n: string }> }
    expect(Number(left.rows[0]!.n)).toBe(0)
  }, 30_000)
})
