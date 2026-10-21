/**
 * THE TURN CLAIM AND TOKEN, AGAINST A REAL POSTGRES (`lib/messageColumns.ts`).
 *
 * Same harness as `documentColumns.pg.test.ts`: a throwaway
 * `postgres:16-alpine` on a kernel-assigned port, the production baseline
 * migration, plain SQL. ⚠ No docker → the suite SKIPS, with a warning.
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { up as baselineUp } from '../migrations/20260908_092211_baseline'
import { claimTurn, finishTurn, type MessageColumnsPayload } from './messageColumns'

const CONTAINER = `edc-backend-msg-columns-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'
const RUNNABLE = ['pending', 'held-drafts', 'failed']
const MSG = 41

const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
if (!dockerOk) console.warn('[messageColumns.pg.test] docker is not usable — the real-Postgres tests SKIP.')

type Db = ReturnType<typeof drizzle>
let db: Db
let payload: MessageColumnsPayload

const stop = () => spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })

async function start(): Promise<string> {
  stop()
  const run = spawnSync(
    'docker',
    [
      'run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data', '--name', CONTAINER, '-p', '0:5432',
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=msg_columns_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/msg_columns_test`
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

async function row(): Promise<Record<string, unknown>> {
  const res = (await db.execute(
    sql`SELECT corpus_status, corpus_error, corpus_ingest_id, redacted_text, anonymisation_report FROM messages WHERE id = ${MSG}`,
  )) as unknown as { rows: Record<string, unknown>[] }
  return res.rows[0]!
}

describe.skipIf(!dockerOk)('turn claim + token on a real Postgres', () => {
  beforeAll(async () => {
    db = drizzle(await start())
    await waitForQueries(db)
    await baselineUp({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)
    await db.execute(sql`
      INSERT INTO users (id, email) VALUES (1, 'msg-columns@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Org uno', 'uno');
      INSERT INTO sessions (id, user_id, organization_id) VALUES (500, 1, 1);
    `)
    payload = { db: { drizzle: db } } as unknown as MessageColumnsPayload
  }, 60_000)

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM messages`)
    await db.execute(sql`INSERT INTO messages (id, session_id, role, content) VALUES (${MSG}, 500, 'user', 'hola')`)
  })

  afterAll(async () => {
    await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    stop()
  })

  it('🔴 two runs race for one turn: exactly one claims it', async () => {
    const [a, b] = await Promise.all([
      claimTurn(payload, MSG, 'gate_running: a', RUNNABLE),
      claimTurn(payload, MSG, 'gate_running: b', RUNNABLE),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect((await row()).corpus_status).toBe('embedding')
  })

  it('a held-gate or ingested turn is never claimed', async () => {
    for (const status of ['held-gate', 'ingested', 'skipped']) {
      await db.execute(sql`UPDATE messages SET corpus_status = ${status} WHERE id = ${MSG}`)
      expect(await claimTurn(payload, MSG, 'gate_running: x', RUNNABLE)).toBe(false)
    }
  })

  it('🔴 a run whose turn the sweep moved on writes nothing', async () => {
    expect(await claimTurn(payload, MSG, 'gate_running: a', RUNNABLE)).toBe(true)
    await db.execute(sql`UPDATE messages SET corpus_status = 'failed', corpus_error = 'stalled' WHERE id = ${MSG}`)

    expect(await finishTurn(payload, MSG, 'gate_running: a', { corpusStatus: 'held-gate', redactedText: 'x' })).toBe(false)
    expect(await row()).toMatchObject({ corpus_status: 'failed', corpus_error: 'stalled', redacted_text: null })
  })

  it('the owning run writes its columns, JSON included', async () => {
    expect(await claimTurn(payload, MSG, 'gate_running: a', RUNNABLE)).toBe(true)
    expect(
      await finishTurn(payload, MSG, 'gate_running: a', { redactedText: 'hola [Persona A]', anonymisationReport: { n: 1 } }),
    ).toBe(true)
    expect(
      await finishTurn(payload, MSG, 'gate_running: a', { corpusStatus: 'embedding', corpusIngestId: 'ing-1', corpusError: null }),
    ).toBe(true)
    expect(await row()).toMatchObject({
      corpus_status: 'embedding',
      corpus_ingest_id: 'ing-1',
      corpus_error: null,
      redacted_text: 'hola [Persona A]',
      anonymisation_report: { n: 1 },
    })
  })
})
