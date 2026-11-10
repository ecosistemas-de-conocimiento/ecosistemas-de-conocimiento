/**
 * A throwaway Postgres for `*.pg.test.ts` suites, the same harness as
 * `conversationUploads.pg.test.ts`: `postgres:16-alpine`, a kernel-assigned
 * port, `--tmpfs` data and `--rm` (nothing left behind), every migration, then
 * the real Payload config booted against it.
 *
 * ⚠ No docker → `dockerOk` is false and the suite should `describe.skipIf`.
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'

import { migrations } from '../../migrations'

export type Db = ReturnType<typeof drizzle>

export const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0

export interface RealPostgres {
  db: Db
  url: string
  /** Same server, another database: for tables that are not the backend's. */
  urlFor(database: string): string
  stop(): void
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

/** Start the container and run every migration's `up`. */
export async function startRealPostgres(container: string, database: string): Promise<RealPostgres> {
  const stop = () => {
    spawnSync('docker', ['rm', '-f', '-v', container], { stdio: 'ignore' })
  }
  stop()
  const run = spawnSync(
    'docker',
    [
      'run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data', '--name', container, '-p', '0:5432',
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', `POSTGRES_DB=${database}`, 'postgres:16-alpine',
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  const urlFor = (name: string) => `postgres://postgres:postgres@127.0.0.1:${port}/${name}`
  const url = urlFor(database)
  const db = drizzle(url)
  await waitForQueries(db)
  for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)
  return { db, url, urlFor, stop }
}

/** Boot the real Payload config against `url`, with the boot sweeps off. */
export async function bootPayload(url: string, secret: string): Promise<Payload> {
  process.env.DATABASE_URI = url
  process.env.PAYLOAD_SECRET = secret
  for (const v of [
    'TRANSCRIPTION_JANITOR_ENABLED',
    'PUBLISH_JANITOR_ENABLED',
    'EMBEDDING_JANITOR_ENABLED',
    'INGEST_RECOVERY_JANITOR_ENABLED',
    'GRAPH_ORPHAN_JANITOR_ENABLED',
    'CALLBACK_RETENTION_JANITOR_ENABLED',
  ]) {
    process.env[v] = 'false'
  }
  const { getPayload } = await import('payload')
  const { default: config } = await import('@payload-config')
  return getPayload({ config })
}

/**
 * Tear down. ⚠ Payload's pool cannot be ended (`@payloadcms/db-postgres`
 * 3.88.0 `connect.js` never releases its boot client), so its clients' errors
 * are swallowed when the container goes.
 */
export async function shutdown(pg: RealPostgres | undefined, payload: Payload | undefined): Promise<void> {
  const pool = (payload?.db as unknown as {
    pool?: { on(e: 'error', f: () => void): void; _clients?: Array<{ on(e: 'error', f: () => void): void }> }
  })?.pool
  pool?.on('error', () => {})
  for (const client of pool?._clients ?? []) client.on('error', () => {})
  await (pg?.db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
  pg?.stop()
}

export const rowsOf = async (db: Db, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
  ((await db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows

/** Poll until `check` holds; after-commit work runs asynchronously. */
export async function eventually(check: () => Promise<boolean>, ms = 8_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await delay(100)
  }
  return false
}
