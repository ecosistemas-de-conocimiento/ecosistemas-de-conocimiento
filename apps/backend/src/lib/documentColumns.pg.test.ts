/**
 * NARROW STATUS WRITES, AGAINST A REAL POSTGRES.
 *
 * 🔴 THE BUG THIS PINS. The ai-service callback wrote `ingest_status = 'ready'`;
 * a corpus-graph status write that had read the row a moment earlier then wrote
 * the WHOLE row back (that is what `payload.update` does), carrying the stale
 * `embedding`. The upload stuck at `embedding` forever. Measured on the
 * fake-provider e2e stack with Postgres statement logs.
 *
 * Same harness as `graph/queries.pg.test.ts`: a throwaway `postgres:16-alpine`
 * on a kernel-assigned port, the production baseline migration, plain SQL.
 *
 * ⚠ No docker → the suite SKIPS, with a console warning naming the reason.
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import type { Where } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { up as baselineUp } from '../migrations/20260908_092211_baseline'
import { updateDocumentColumns, type DocumentColumnsPayload } from './documentColumns'
import { runGraphExtraction, type GraphSchedulerPayload } from './graph/schedule'

const CONTAINER = `edc-backend-doc-columns-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const dockerOk = hasDocker()
if (!dockerOk) {
  console.warn('[documentColumns.pg.test] docker is not usable — the real-Postgres tests SKIP.')
}

type Db = ReturnType<typeof drizzle>
let db: Db
let payload: DocumentColumnsPayload

function stopContainer(): void {
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
}

async function startPostgres(): Promise<string> {
  stopContainer()
  const run = spawnSync(
    'docker',
    [
      'run', '-d', '--rm', '--name', CONTAINER, '-p', '0:5432',
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=doc_columns_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/doc_columns_test`
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

const DOC = 301
const OLD = '2026-10-17T08:00:00.000Z'

async function row(): Promise<Record<string, unknown>> {
  const res = (await db.execute(
    sql`SELECT ingest_status, ingest_error, ingest_id, graph_status, graph_error,
               anonymisation_status, anonymisation_report, anonymisation_survivors,
               updated_at
          FROM documents WHERE id = ${DOC}`,
  )) as unknown as { rows: Record<string, unknown>[] }
  return res.rows[0]!
}

/** What the ai-service callback does to the row: its own two columns. */
const callbackWritesReady = (exec: { execute: Db['execute'] }) =>
  exec.execute(sql`UPDATE documents SET ingest_status = 'ready', ingest_error = NULL WHERE id = ${DOC}`)

describe.skipIf(!dockerOk)('updateDocumentColumns on a real Postgres', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    await baselineUp({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)
    await db.execute(sql`
      INSERT INTO users (id, email) VALUES (1, 'columns-test@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Org uno', 'uno');
    `)
    payload = { db: { drizzle: db } } as unknown as DocumentColumnsPayload
  }, 60_000)

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM documents`)
    await db.execute(sql`
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, ingest_status, graph_status, updated_at)
      VALUES (${DOC}, 1, 1, 'informe.pdf', 'pdf', 'embedding', 'pending', ${OLD})
    `)
  })

  afterAll(async () => {
    await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    stopContainer()
  })

  it('the bug, for the record: a whole-row write-back erases the callback’s `ready`', async () => {
    // Read, callback, write everything back — the `payload.update` shape.
    const stale = await row()
    await callbackWritesReady(db)
    await db.execute(
      sql`UPDATE documents SET ingest_status = ${stale.ingest_status}, graph_status = 'extracting' WHERE id = ${DOC}`,
    )
    expect((await row()).ingest_status).toBe('embedding')
  })

  it('🔴 a graph status write after the callback leaves `ready` standing', async () => {
    await callbackWritesReady(db)
    await updateDocumentColumns(payload, { id: DOC, data: { graphStatus: 'extracting', graphError: null } })
    const r = await row()
    expect(r.ingest_status).toBe('ready')
    expect(r.graph_status).toBe('extracting')
  })

  it('🔴 interleaved: the callback holds the row lock, the graph write waits, both survive', async () => {
    let callbackWrote!: () => void
    const wrote = new Promise<void>((r) => (callbackWrote = r))
    let commit!: () => void
    const committed = new Promise<void>((r) => (commit = r))

    const callback = db.transaction(async (tx) => {
      await callbackWritesReady(tx)
      callbackWrote()
      await committed
    })
    await wrote
    // Blocks on the callback's row lock until it commits.
    const graph = updateDocumentColumns(payload, {
      id: DOC,
      data: { graphStatus: 'failed', graphError: 'graph_extract_failed: x' },
    })
    await delay(150)
    commit()
    await Promise.all([callback, graph])

    const r = await row()
    expect(r.ingest_status).toBe('ready')
    expect(r.graph_status).toBe('failed')
  })

  it('🔴 runGraphExtraction’s status writes go through the narrow path', async () => {
    // Short text → `skipped`, the cheapest run that still writes the status.
    const graphPayload = {
      db: { drizzle: db },
      async find() {
        return { docs: [] }
      },
      async create() {
        return {}
      },
      async delete() {
        return {}
      },
    } as unknown as GraphSchedulerPayload
    await callbackWritesReady(db)
    const status = await runGraphExtraction({
      payload: graphPayload,
      docId: DOC,
      organizationId: 1,
      contentKind: 'documento',
      text: 'corto',
    })
    expect(status).toBe('skipped')
    const r = await row()
    expect(r.ingest_status).toBe('ready')
    expect(r.graph_status).toBe('skipped')
  })

  it('bumps `updated_at` in milliseconds, like Payload', async () => {
    await updateDocumentColumns(payload, { id: DOC, data: { graphStatus: 'ready' } })
    const at = new Date(String((await row()).updated_at))
    expect(at.getTime()).toBeGreaterThan(Date.parse(OLD))
  })

  it('writes JSON values and nulls, and accepts a numeric-string id', async () => {
    await updateDocumentColumns(payload, {
      id: String(DOC),
      data: {
        anonymisationStatus: 'held',
        anonymisationReport: { stage: 'detector', counts: { persona: 2 } },
        anonymisationSurvivors: ['a', 'b'],
        ingestError: null,
      },
    })
    const r = await row()
    expect(r.anonymisation_status).toBe('held')
    expect(r.anonymisation_report).toEqual({ stage: 'detector', counts: { persona: 2 } })
    expect(r.anonymisation_survivors).toEqual(['a', 'b'])
    expect(r.ingest_error).toBeNull()
  })

  describe('guards, checked by the UPDATE itself', () => {
    const cutoff = '2026-10-17T09:00:00.000Z'
    const stalled: Where[] = [
      { ingestStatus: { equals: 'embedding' } },
      { ingestId: { exists: false } },
      { anonymisationStatus: { in: ['n/a', 'ready'] } },
      { updatedAt: { less_than: cutoff } },
    ]

    it('writes when every clause still holds', async () => {
      const n = await updateDocumentColumns(payload, {
        id: DOC,
        where: stalled,
        data: { ingestStatus: 'failed', ingestError: 'embedding_stalled: x' },
      })
      expect(n).toBe(1)
      expect((await row()).ingest_status).toBe('failed')
    })

    it('🔴 changes nothing when a late callback already moved the row', async () => {
      await callbackWritesReady(db)
      const n = await updateDocumentColumns(payload, {
        id: DOC,
        where: stalled,
        data: { ingestStatus: 'failed', ingestError: 'embedding_stalled: x' },
      })
      expect(n).toBe(0)
      expect((await row()).ingest_status).toBe('ready')
    })

    it('honours `exists`, `in` and `less_than` one by one', async () => {
      await db.execute(sql`UPDATE documents SET ingest_id = 'job-1' WHERE id = ${DOC}`)
      expect(
        await updateDocumentColumns(payload, { id: DOC, where: [{ ingestId: { exists: false } }], data: { graphStatus: 'ready' } }),
      ).toBe(0)
      expect(
        await updateDocumentColumns(payload, { id: DOC, where: [{ ingestId: { exists: true } }], data: { graphStatus: 'ready' } }),
      ).toBe(1)
      expect(
        await updateDocumentColumns(payload, {
          id: DOC,
          where: [{ anonymisationStatus: { in: ['held', 'pending'] } }],
          data: { graphStatus: 'failed' },
        }),
      ).toBe(0)
      // The write just above bumped `updated_at` to now, past the cutoff.
      expect(
        await updateDocumentColumns(payload, {
          id: DOC,
          where: [{ updatedAt: { less_than: cutoff } }],
          data: { graphStatus: 'failed' },
        }),
      ).toBe(0)
    })

    it('refuses a field outside the allowlist rather than guessing a column', async () => {
      await expect(
        updateDocumentColumns(payload, { id: DOC, data: { extractedText: 'x' } as never }),
      ).rejects.toThrow(/no column for field "extractedText"/)
    })
  })
})
