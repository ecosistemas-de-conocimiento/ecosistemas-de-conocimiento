/**
 * 🔴 A WHOLE DOCUMENT FITS IN THE COLUMNS THAT HOLD A WHOLE DOCUMENT.
 *
 * Payload validates every `text`/`textarea` against `defaultMaxTextLength`
 * (40,000) unless the field says otherwise. Measured on dev 2026-10-26: a PDF
 * whose extracted text passed that cap failed its `extractedText` save with a
 * 400, and the real corpus has PDFs of ~750k characters. Against a real
 * Postgres and the real Payload config, so the validation is the production one.
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
import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { migrations } from '../migrations'
import { UPLOAD_CONSENT_VERSION } from '@/lib/uploadConsent'

const CONTAINER = `edc-backend-long-text-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const dockerOk = hasDocker()
if (!dockerOk) {
  console.warn('[Documents.longText.pg.test] docker is not usable — the real-Postgres tests SKIP.')
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
      '-e', 'POSTGRES_DB=long_text_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/long_text_test`
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

const LONG = 800_000

/** Spanish prose of exactly `n` characters. */
const longText = (n: number): string =>
  'La comunidad se reunió en la plaza. '.repeat(Math.ceil(n / 36) + 1).slice(0, n)

const lengths = async (id: number): Promise<Record<string, number>> => {
  const { rows } = (await db.execute(
    sql.raw(`SELECT length(body_markdown) AS body, length(extracted_text) AS extracted,
      length(redacted_text) AS redacted, length(held_text) AS held FROM documents WHERE id = ${Number(id)}`),
  )) as unknown as { rows: Array<Record<string, unknown>> }
  return Object.fromEntries(Object.entries(rows[0] ?? {}).map(([k, v]) => [k, Number(v)]))
}

describe.skipIf(!dockerOk)('an ~800k-character document, on a real Postgres', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)

    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'long-text-test-secret'
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

    await db.execute(sql.raw(`
      INSERT INTO users (id, email) VALUES (1, 'uploader@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (user_id, organization_id, role) VALUES (1, 1, 'member');
    `))
  }, 90_000)

  afterAll(async () => {
    const pool = (payload?.db as unknown as {
      pool?: { on(e: 'error', f: () => void): void; _clients?: Array<{ on(e: 'error', f: () => void): void }> }
    })?.pool
    pool?.on('error', () => {})
    for (const client of pool?._clients ?? []) client.on('error', () => {})
    await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    stopContainer()
  })

  it('validates and saves it in bodyMarkdown, extractedText, redactedText and heldText', async () => {
    const user = await payload.findByID({ collection: 'users', id: 1, overrideAccess: true })
    // A member's own create: the access rules and validation a client hits.
    const doc = await payload.create({
      collection: 'documents',
      overrideAccess: false,
      user,
      data: { uploadConsentVersion: UPLOAD_CONSENT_VERSION, kind: 'markdown', name: 'largo', bodyMarkdown: longText(LONG), session: [] } as never,
    })
    // The pipeline's writes: server-side, like `runExtractAndIngest` and the gate.
    await payload.update({
      collection: 'documents',
      id: doc.id,
      data: {
        extractedText: longText(LONG),
        redactedText: longText(LONG),
        heldText: longText(LONG),
      } as never,
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
    expect(await lengths(Number(doc.id))).toEqual({
      body: LONG,
      extracted: LONG,
      redacted: LONG,
      held: LONG,
    })
  }, 60_000)

  it('still refuses text past the 2,000,000-character cap', async () => {
    const user = await payload.findByID({ collection: 'users', id: 1, overrideAccess: true })
    const doc = await payload.create({
      collection: 'documents',
      overrideAccess: false,
      user,
      data: { uploadConsentVersion: UPLOAD_CONSENT_VERSION, kind: 'markdown', name: 'tope', bodyMarkdown: 'hola', session: [] } as never,
    })
    await expect(
      payload.update({
        collection: 'documents',
        id: doc.id,
        data: { extractedText: longText(2_000_001) } as never,
        overrideAccess: true,
        context: { __skipDocsExtract: true },
      }),
    ).rejects.toMatchObject({ status: 400 })
  }, 60_000)

  it('🔴 stores a 100,000-character callback body, the size the callback route slices to', async () => {
    // A `transcribe.completed` body carries the whole transcript. Over the
    // 40,000 default its dedupe insert failed with a 400, which the route
    // answers with a 500, so the callback was never applied.
    const row = await payload.create({
      collection: 'aiServiceCallbacks',
      overrideAccess: true,
      data: {
        correlationKey: 'tr_1',
        eventKey: '1',
        event: 'transcribe.completed',
        receivedAt: new Date().toISOString(),
        rawBody: longText(100_000),
      },
    })
    const { rows } = (await db.execute(
      sql.raw(`SELECT length(raw_body) AS n FROM ai_service_callbacks WHERE id = ${Number(row.id)}`),
    )) as unknown as { rows: Array<{ n: unknown }> }
    expect(Number(rows[0]?.n)).toBe(100_000)
  }, 60_000)
})
