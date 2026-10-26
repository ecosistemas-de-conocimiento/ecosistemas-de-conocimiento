/**
 * 🔴 AN EXCLUDE-MODE `select` MUST NOT OPEN A GATED DOCUMENTO'S ORIGINAL.
 *
 * Found by the 2026-10-26 audit. `payload@3.88.0` skips `forceSelect` when the
 * `select` is exclude-mode (every value `false`), so `select: { anonymise: false }`
 * — REST `?select[anonymise]=false` — handed `mayReadGatedOriginal` a row with
 * no `anonymise` on it. Absent read as "not gated", and any member of the
 * ecosistema got the raw `extractedText` / `bodyMarkdown` of a published
 * documento filed for anonymisation.
 *
 * The rule under test: every field-access check on `documents` fails CLOSED on a
 * column the projection removed.
 *
 * Harness: same as `Documents.looseUpload.pg.test.ts` — throwaway
 * `postgres:16-alpine` on tmpfs, every migration, ai-service stubbed.
 *
 * ⚠ No docker → the suite SKIPS, with a console warning naming the reason.
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import { sanitizeSelectParam, type Payload, type SelectType } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { migrations } from '../migrations'

const CONTAINER = `edc-backend-select-projection-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const dockerOk = hasDocker()
if (!dockerOk) {
  console.warn('[Documents.selectProjection.pg.test] docker is not usable — the real-Postgres tests SKIP.')
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
      '-e', 'POSTGRES_DB=select_projection_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/select_projection_test`
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

const ANA = 1 // uploader
const BEN = 2 // colleague in the same ecosistema
const GATED = 10 // published documento, anonymise = true
const TESTIMONIO = 11
const PLAIN = 12 // published documento, anonymise = false

const asUser = (id: number) => payload.findByID({ collection: 'users', id, overrideAccess: true })

type Row = Record<string, unknown>
const ORIGINAL_FIELDS = ['extractedText', 'bodyMarkdown'] as const

async function readAs(user: number, id: number, select?: SelectType): Promise<Row> {
  return (await payload.findByID({
    collection: 'documents',
    id,
    overrideAccess: false,
    user: await asUser(user),
    ...(select ? { select } : {}),
  })) as unknown as Row
}

/** Every exclude-mode projection that drops a column a field-access check reads. */
const EXCLUDES: Record<string, SelectType> = {
  anonymise: { anonymise: false },
  contentKind: { contentKind: false },
  uploadedBy: { uploadedBy: false },
  anonymisationStatus: { anonymisationStatus: false },
  all: { anonymise: false, contentKind: false, uploadedBy: false, anonymisationStatus: false },
}

describe.skipIf(!dockerOk)('documents: select projections vs gated originals (real Postgres)', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)
    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'select-projection-secret'
    for (const v of [
      'TRANSCRIPTION_JANITOR_ENABLED',
      'PUBLISH_JANITOR_ENABLED',
      'EMBEDDING_JANITOR_ENABLED',
      'INGEST_RECOVERY_JANITOR_ENABLED',
    ]) process.env[v] = 'false'
    const { getPayload } = await import('payload')
    const { default: config } = await import('@payload-config')
    payload = await getPayload({ config })
    await db.execute(sql.raw(`
      INSERT INTO users (id, email) VALUES (${ANA}, 'ana@example.invalid'), (${BEN}, 'ben@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (user_id, organization_id, role) VALUES (${ANA}, 1, 'member'), (${BEN}, 1, 'member');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise, anonymisation_status, redacted_text, extracted_text, body_markdown, name)
        VALUES (${GATED}, 1, ${ANA}, 'published', 'pdf', 'documento', true, 'ready', 'REDACTED [PERSONA]', 'RAW Maria Lopez', 'RAWMD Maria', 'doc'),
               (${TESTIMONIO}, 1, ${ANA}, 'published', 'audio', 'testimonio', false, 'ready', 'REDACTED', 'RAW testimonio', 'RAWMD t', 't'),
               (${PLAIN}, 1, ${ANA}, 'published', 'pdf', 'documento', false, 'n/a', NULL, 'PLAIN text', 'PLAINMD', 'plain');
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

  it('control: a full read hides the gated original from a colleague', async () => {
    const d = await readAs(BEN, GATED)
    expect(d.redactedText).toBe('REDACTED [PERSONA]')
    for (const f of ORIGINAL_FIELDS) expect(d[f]).toBeUndefined()
  })

  it('control: an include-mode select without `anonymise` still hides it (forceSelect)', async () => {
    const d = await readAs(BEN, GATED, { extractedText: true, bodyMarkdown: true, contentKind: true, uploadedBy: true })
    for (const f of ORIGINAL_FIELDS) expect(d[f]).toBeUndefined()
  })

  it('control: an ungated documento stays readable in full to a colleague', async () => {
    const d = await readAs(BEN, PLAIN)
    expect(d.extractedText).toBe('PLAIN text')
    expect(d.bodyMarkdown).toBe('PLAINMD')
  })

  for (const [label, select] of Object.entries(EXCLUDES)) {
    it(`findByID, exclude ${label}: the gated documento original stays hidden`, async () => {
      const d = await readAs(BEN, GATED, select)
      for (const f of ORIGINAL_FIELDS) expect(d[f]).toBeUndefined()
    })

    it(`findByID, exclude ${label}: the testimonio original stays hidden`, async () => {
      const d = await readAs(BEN, TESTIMONIO, select)
      for (const f of ORIGINAL_FIELDS) expect(d[f]).toBeUndefined()
    })

    it(`find, exclude ${label}: no gated original in the list`, async () => {
      const r = await payload.find({
        collection: 'documents',
        overrideAccess: false,
        user: await asUser(BEN),
        select,
        pagination: false,
      })
      const byId = new Map((r.docs as unknown as Row[]).map((d) => [d.id, d]))
      expect(byId.has(GATED)).toBe(true)
      for (const id of [GATED, TESTIMONIO]) {
        for (const f of ORIGINAL_FIELDS) expect(byId.get(id)?.[f]).toBeUndefined()
      }
    })
  }

  it('REST-style `?select[anonymise]=false` (sanitizeSelectParam) keeps the original hidden', async () => {
    const select = sanitizeSelectParam({ anonymise: 'false' } as unknown as SelectType) as SelectType
    expect(select).toEqual({ anonymise: false })
    const one = await readAs(BEN, GATED, select)
    for (const f of ORIGINAL_FIELDS) expect(one[f]).toBeUndefined()
    const list = await payload.find({
      collection: 'documents',
      overrideAccess: false,
      user: await asUser(BEN),
      select,
      where: { id: { equals: GATED } },
    })
    expect(list.docs).toHaveLength(1)
    for (const f of ORIGINAL_FIELDS) expect((list.docs[0] as unknown as Row)[f]).toBeUndefined()
  })

  it('the uploader still reads her own original under an exclude select', async () => {
    const d = await readAs(ANA, GATED, { anonymise: false })
    expect(d.extractedText).toBe('RAW Maria Lopez')
  })
})
