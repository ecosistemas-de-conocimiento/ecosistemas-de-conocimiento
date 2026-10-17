/**
 * 🔴 A NON-OWNER'S DELETE MUST TOUCH NOTHING — AGAINST A REAL POSTGRES.
 *
 * Payload 3.88.0 `collections/operations/deleteByID.js` runs `beforeDelete`
 * (lines 44-52) BEFORE it matches the row against the `ownOnly` where-filter
 * (lines 56-72). So user A sending `DELETE /api/sessions/<B's id>` (ids are
 * sequential) ran B's whole cascade — retiring B's turns from the shared
 * corpus — and got its 403 only afterwards, with the rows rolled back and the
 * ai-service change kept. `assertMayDeleteConversation` closes it; this file
 * proves it through the real Payload config and access rules.
 *
 * Harness: a throwaway `postgres:16-alpine` with `--tmpfs` (no volume is left
 * behind), the production baseline migration, the real Payload config. ai-service
 * is a spy.
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

const setDocumentValidity = vi.fn(async () => ({ ok: true }))
const deleteDocument = vi.fn(async () => ({ deleted: true }))
vi.mock('@/lib/aiClient', () => ({
  getAdminAIClient: () => ({ admin: { setDocumentValidity, deleteDocument } }),
}))

import { up as baselineUp } from '../migrations/20260908_092211_baseline'

const CONTAINER = `edc-backend-owner-guard-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const dockerOk = hasDocker()
if (!dockerOk) {
  console.warn('[Sessions.ownerGuard.pg.test] docker is not usable — the real-Postgres tests SKIP.')
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
      '-e', 'POSTGRES_DB=owner_guard_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/owner_guard_test`
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

const ids = async (table: 'sessions' | 'messages'): Promise<number[]> =>
  ((await db.execute(sql.raw(`SELECT id FROM ${table} ORDER BY id`))) as unknown as {
    rows: Array<{ id: number }>
  }).rows.map((r) => Number(r.id))

describe.skipIf(!dockerOk)('deleting someone else’s conversation, on a real Postgres', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    await baselineUp({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)

    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'owner-guard-test-secret'
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
    setDocumentValidity.mockClear()
    // `sql.raw`: several statements in one call need the simple query protocol.
    await db.execute(sql.raw(`
      TRUNCATE sessions, messages, ratings, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, 'guard-owner@example.invalid'), (2, 'guard-other@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Org uno', 'uno');
      INSERT INTO sessions (id, user_id, organization_id) VALUES (10, 1, 1);
      INSERT INTO messages (id, session_id, role, content, corpus_status)
        VALUES (91, 10, 'assistant', 'x', 'ingested');
    `))
  })

  afterAll(async () => {
    // ⚠ Payload's pool cannot be ended: `@payloadcms/db-postgres` 3.88.0
    // `connect.js` checks out a client at boot and never releases it, so
    // `pool.end()` waits forever. Swallow the "Connection terminated" its
    // clients emit when the container goes instead.
    const pool = (payload?.db as unknown as {
      pool?: { on(e: 'error', f: () => void): void; _clients?: Array<{ on(e: 'error', f: () => void): void }> }
    })?.pool
    pool?.on('error', () => {})
    for (const client of pool?._clients ?? []) client.on('error', () => {})
    await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    stopContainer()
  })

  it('🔴 a non-owner gets 403 and the owner’s turns are neither deleted nor retired', async () => {
    const other = await payload.findByID({ collection: 'users', id: 2, overrideAccess: true })

    await expect(
      payload.delete({ collection: 'sessions', id: 10, overrideAccess: false, user: other }),
    ).rejects.toMatchObject({ status: 403 })

    expect(await ids('sessions')).toEqual([10])
    expect(await ids('messages')).toEqual([91])
    expect(setDocumentValidity).not.toHaveBeenCalled()
  }, 30_000)

  it('the owner’s delete still cascades and retires the turn', async () => {
    const owner = await payload.findByID({ collection: 'users', id: 1, overrideAccess: true })

    await payload.delete({ collection: 'sessions', id: 10, overrideAccess: false, user: owner })

    expect(await ids('sessions')).toEqual([])
    expect(await ids('messages')).toEqual([])
    expect(setDocumentValidity).toHaveBeenCalledTimes(1)
  }, 30_000)
})
