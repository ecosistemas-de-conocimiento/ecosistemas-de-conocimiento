/**
 * THE GATE'S ROW WRITES, AGAINST A REAL POSTGRES (audit 2026-10-27).
 *
 * 🔴 THE BUG THIS PINS. `publicFiguresKept` was written by every gate run but
 * was missing from `documentColumns.ts`'s allowlist, so EVERY write threw
 * `no column for field "publicFiguresKept"` and rows stayed `pending`. The
 * unit tests used the fake writer and never saw it. Here the REAL writer runs
 * the whole gate write for a testimonio and a documento, on every migration.
 *
 * Throwaway `postgres:16-alpine`, `--rm --tmpfs`. No docker → SKIP, with a
 * warning.
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { migrations } from '../migrations'
import { staticDetector } from './anonymise'
import type { DetectorFinding } from './anonymise/types'
import { anonymiseDocumentText } from './anonymiseDocument'
import type { DocumentColumnsPayload } from './documentColumns'

const CONTAINER = `edc-backend-gate-write-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'

const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
if (!dockerOk) console.warn('[anonymiseDocument.pg.test] docker is not usable — the real-Postgres tests SKIP.')

type Db = ReturnType<typeof drizzle>
let db: Db
let payload: DocumentColumnsPayload

const stopContainer = () => spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })

async function startPostgres(): Promise<string> {
  stopContainer()
  const run = spawnSync(
    'docker',
    [
      'run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data', '--name', CONTAINER, '-p', '0:5432',
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=gate_write_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/gate_write_test`
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

const DOC = 401
const TEXT = 'El senador Ramiro Saldaña habló. Tadeo Villaseñor, vecino, lo escuchó.'
const FINDINGS: DetectorFinding[] = [
  { text: 'Ramiro Saldaña', type: 'persona', public: { motivo: 'senador' } },
  { text: 'Tadeo Villaseñor', type: 'persona' },
]

async function row(): Promise<Record<string, unknown>> {
  const res = (await db.execute(
    sql`SELECT anonymisation_status, redacted_text, held_text, public_figures_kept FROM documents WHERE id = ${DOC}`,
  )) as unknown as { rows: Record<string, unknown>[] }
  return res.rows[0]!
}

async function seed(contentKind: string): Promise<void> {
  await db.execute(sql`DELETE FROM documents`)
  await db.execute(sql`
    INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, content_kind, anonymise, ingest_status)
    VALUES (${DOC}, 1, 1, 'notas.pdf', 'pdf', ${contentKind}, true, 'extracting')
  `)
}

const gate = (contentKind: string, opts: { keep?: boolean; detector?: ReturnType<typeof staticDetector> } = {}) =>
  anonymiseDocumentText({
    payload: payload as never,
    docId: DOC,
    contentKind,
    anonymise: true,
    text: TEXT,
    detector: opts.detector ?? staticDetector(FINDINGS),
    ...(opts.keep ? { keepPublicFigures: true } : {}),
  })

describe.skipIf(!dockerOk)('the gate writes its row through the REAL column writer', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)
    await db.execute(sql`
      INSERT INTO users (id, email) VALUES (1, 'gate-write@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Org uno', 'uno');
    `)
    payload = { db: { drizzle: db } } as unknown as DocumentColumnsPayload
  }, 120_000)

  beforeEach(() => undefined)

  afterAll(async () => {
    await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    stopContainer()
  })

  it('🔴 testimonio: ready, redacted, no public-figure log', async () => {
    await seed('testimonio')
    const out = await gate('testimonio', { keep: true })
    expect(out.ok).toBe(true)
    const r = await row()
    expect(r.anonymisation_status).toBe('ready')
    expect(r.redacted_text).not.toContain('Saldaña')
    expect(r.public_figures_kept).toBeNull()
  })

  it('🔴 documento, option off: ready, log NULL', async () => {
    await seed('documento')
    expect((await gate('documento')).ok).toBe(true)
    const r = await row()
    expect(r.anonymisation_status).toBe('ready')
    expect(r.public_figures_kept).toBeNull()
  })

  it('🔴 documento, option on: ready, the kept name logged in the jsonb column', async () => {
    await seed('documento')
    expect((await gate('documento', { keep: true })).ok).toBe(true)
    const r = await row()
    expect(r.anonymisation_status).toBe('ready')
    expect(r.redacted_text).toContain('Ramiro Saldaña')
    expect(r.public_figures_kept).toEqual([
      expect.objectContaining({ name: 'Ramiro Saldaña', motivo: 'senador', model: 'static' }),
    ])
  })

  it('🔴 documento held at verify: held, the option-off held text, no log', async () => {
    await seed('documento')
    let n = 0
    const detector = {
      name: 'static',
      async detect({ text }: { text: string }) {
        // Stage 3 finds both; verify reports something still standing → hold.
        return n++ === 0
          ? FINDINGS.filter((f) => text.includes(f.text))
          : [{ text: 'vecino', type: 'otro' as const }]
      },
    }
    const out = await gate('documento', { keep: true, detector: detector as never })
    expect(out.ok).toBe(false)
    const r = await row()
    expect(r.anonymisation_status).toBe('held')
    // 🔴 A hold is the option-off hold: nothing is restored in it.
    expect(r.held_text).not.toContain('Saldaña')
    expect(r.public_figures_kept).toBeNull()
  })

  it('🔴 a detector that could not run: n/a, retryable, log NULL', async () => {
    await seed('documento')
    const failing = {
      name: 'static',
      async detect(): Promise<never> {
        throw Object.assign(new Error('down'), { infrastructure: true })
      },
    }
    const out = await gate('documento', { keep: true, detector: failing as never })
    expect(out.ok).toBe(false)
    const r = await row()
    expect(r.anonymisation_status).toBe('n/a')
    expect(r.public_figures_kept).toBeNull()
  })
})
