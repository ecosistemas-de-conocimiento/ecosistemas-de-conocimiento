/**
 * `sessions.kind` — `generales` | `resonancias` — AGAINST A REAL POSTGRES.
 *
 * Chosen by the client on create, immutable afterwards (`assertKindUnchanged`
 * in `Sessions.ts`): a conversation's history was produced under one mode.
 * Runs every migration, so the column default the migration gives existing
 * rows is exercised too.
 *
 * Harness copied from `Sessions.ownerGuard.pg.test.ts`: a throwaway
 * `postgres:16-alpine` with `--tmpfs`, the real Payload config.
 *
 * ⚠ No docker → the suite SKIPS, with a console warning naming the reason.
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import type { Payload, RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { migrations } from '../migrations'

const CONTAINER = `edc-backend-sessions-kind-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const dockerOk = hasDocker()
if (!dockerOk) {
  console.warn('[Sessions.kind.pg.test] docker is not usable — the real-Postgres tests SKIP.')
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
      '-e', 'POSTGRES_DB=sessions_kind_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/sessions_kind_test`
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

describe.skipIf(!dockerOk)('sessions.kind, on a real Postgres', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)

    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'sessions-kind-test-secret'
    // The boot sweeps are not under test, and would poll this database.
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
    // `sql.raw`: several statements in one call need the simple query protocol.
    await db.execute(sql.raw(`
      TRUNCATE sessions, messages, ratings, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, 'kind-owner@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Org uno', 'uno');
      INSERT INTO memberships (user_id, organization_id, role) VALUES (1, 1, 'member');
    `))
  })

  afterAll(async () => {
    // ⚠ Payload's pool cannot be ended — see `Sessions.ownerGuard.pg.test.ts`.
    const pool = (payload?.db as unknown as {
      pool?: { on(e: 'error', f: () => void): void; _clients?: Array<{ on(e: 'error', f: () => void): void }> }
    })?.pool
    pool?.on('error', () => {})
    for (const client of pool?._clients ?? []) client.on('error', () => {})
    await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    stopContainer()
  })

  const owner = () => payload.findByID({ collection: 'users', id: 1, overrideAccess: true })

  const createAs = async (data: { kind?: 'generales' | 'resonancias' }) =>
    payload.create({
      collection: 'sessions',
      // `user` and `organization` are required in the type but stamped by the server.
      data: data as RequiredDataFromCollectionSlug<'sessions'>,
      overrideAccess: false,
      user: await owner(),
    })

  it('a row written without a kind (an existing row) reads generales', async () => {
    await db.execute(sql.raw(`INSERT INTO sessions (id, user_id, organization_id) VALUES (10, 1, 1)`))
    const res = (await db.execute(sql.raw(`SELECT kind FROM sessions WHERE id = 10`))) as unknown as {
      rows: Array<{ kind: string }>
    }
    expect(res.rows[0]?.kind).toBe('generales')
  }, 30_000)

  it('create without a kind defaults to generales', async () => {
    expect((await createAs({})).kind).toBe('generales')
  }, 30_000)

  it('create with resonancias keeps it', async () => {
    expect((await createAs({ kind: 'resonancias' })).kind).toBe('resonancias')
  }, 30_000)

  it('🔴 an update that changes kind is refused and the row keeps its kind', async () => {
    const s = await createAs({ kind: 'resonancias' })
    await expect(
      payload.update({
        collection: 'sessions',
        id: s.id,
        data: { kind: 'generales' },
        overrideAccess: false,
        user: await owner(),
      }),
    ).rejects.toMatchObject({ status: 400 })
    const after = await payload.findByID({ collection: 'sessions', id: s.id, overrideAccess: true })
    expect(after.kind).toBe('resonancias')
  }, 30_000)

  it('🔴 a local-API update with no user cannot change kind either', async () => {
    const s = await createAs({ kind: 'resonancias' })
    await expect(
      payload.update({ collection: 'sessions', id: s.id, data: { kind: 'generales' }, overrideAccess: true }),
    ).rejects.toMatchObject({ status: 400 })
    const after = await payload.findByID({ collection: 'sessions', id: s.id, overrideAccess: true })
    expect(after.kind).toBe('resonancias')
  }, 30_000)

  it('an update that leaves kind alone, or resends it unchanged, still works', async () => {
    const s = await createAs({ kind: 'resonancias' })
    const user = await owner()
    const renamed = await payload.update({
      collection: 'sessions',
      id: s.id,
      data: { title: 'Renamed' },
      overrideAccess: false,
      user,
    })
    expect(renamed).toMatchObject({ title: 'Renamed', kind: 'resonancias' })
    const resent = await payload.update({
      collection: 'sessions',
      id: s.id,
      data: { title: 'Again', kind: 'resonancias' },
      overrideAccess: false,
      user,
    })
    expect(resent).toMatchObject({ title: 'Again', kind: 'resonancias' })
  }, 30_000)
})
