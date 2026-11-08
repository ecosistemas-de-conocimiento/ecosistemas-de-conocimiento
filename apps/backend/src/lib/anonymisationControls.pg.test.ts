/**
 * 🔴 `/api/documents/:id/anonimizacion` against a real Postgres (every
 * migration) and the real Payload config: who may see and change a document's
 * switches, what a change re-gates, that old corpus copies are ERASED before a
 * re-gate, the audit rows, and that the plain collection API never writes the
 * switch columns. ai-service is an in-memory fake; the gate itself is a spy
 * (no model call).
 *
 * ⚠ No docker → the suite SKIPS, with a console warning naming the reason.
 */

import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import type { Endpoint, Payload, PayloadRequest } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { migrations } from '../migrations'
import { anonimizacionEndpoints, type ControlDeps } from './anonymisationControls'
import { draftCorpus, publishedCorpus } from './corpus'
import { invalidateFeatures } from './features'
import { HoldSettingsChangedError, decideOnHold, holdSettingsChanged } from './holdReview'

const CONTAINER = `edc-backend-anonimizacion-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'
const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
if (!dockerOk) console.warn('[anonymisationControls.pg.test] docker is not usable — the real-Postgres tests SKIP.')

type Db = ReturnType<typeof drizzle>
let db: Db
let payload: Payload

const stopContainer = () => spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })

async function startPostgres(): Promise<string> {
  stopContainer()
  const run = spawnSync(
    'docker',
    [
      'run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data', '--name', CONTAINER, '-p', '0:5432',
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=anon_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/anon_test`
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

// 1 root (platform admin) · 2 ana, member of A, the uploader · 3 memo, member of A ·
// 4 ines, investigador of A (holds:review) · 5 bea, owner of B.
const ROOT = 1
const ANA = 2
const MEMO = 3
const INES = 4
const BEA = 5
const ECO_A = 1
const DOC = 10

/** ai-service's corpora, in memory: `retired` is hidden, `delete` is gone. */
function fakeAiService(opts: { failDelete?: boolean } = {}) {
  const store = new Map<string, { text: string; retired: boolean }>()
  const calls: string[] = []
  const client = {
    ingest: { enqueue: vi.fn() },
    admin: {
      setDocumentValidity: vi.fn(async (corpus: string, id: string) => {
        calls.push(`retire ${corpus}`)
        const k = `${corpus}/${id}`
        const hit = store.get(k)
        if (hit) hit.retired = true
      }),
      deleteDocument: vi.fn(async (corpus: string, id: string) => {
        calls.push(`delete ${corpus}`)
        if (opts.failDelete) throw Object.assign(new Error('ai-service down'), { status: 503 })
        store.delete(`${corpus}/${id}`)
      }),
    },
  }
  return { store, calls, client }
}

let fake = fakeAiService()
const startGate = vi.fn<ControlDeps['startGate']>()
const deps = (): ControlDeps => ({ clientFor: () => fake.client as never, startGate })

const endpoint = (method: string): Endpoint => {
  const found = anonimizacionEndpoints(deps()).find((e) => e.method === method)
  if (!found) throw new Error(`no ${method}`)
  return found
}

const userDoc = async (id: number) =>
  ({ ...(await payload.findByID({ collection: 'users', id, overrideAccess: true })), collection: 'users' }) as never

async function call(
  method: 'get' | 'patch',
  as: number | null,
  opts: { id?: number; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const { createLocalReq } = await import('payload')
  const req = (await createLocalReq(as === null ? {} : { user: await userDoc(as) }, payload)) as PayloadRequest
  if (as === null) (req as { user: unknown }).user = null
  Object.assign(req, { routeParams: { id: String(opts.id ?? DOC) }, json: async () => opts.body ?? {} })
  const res = await endpoint(method).handler(req)
  const raw = await res.text()
  return { status: res.status, body: JSON.parse(raw) as Record<string, unknown>, raw }
}

const row = async () =>
  ((await db.execute(sql.raw(`
    SELECT anonymisation_status, publication_status, keep_document_author, keep_cited_authors, redacted_text, held_text
    FROM documents WHERE id = ${DOC}`))) as unknown as { rows: Array<Record<string, unknown>> }).rows[0]

const audits = async () =>
  ((await db.execute(sql.raw(`
    SELECT organization_id, document_id, actor_id, scope, key, before, after
    FROM anonymisation_setting_changes ORDER BY id`))) as unknown as { rows: Array<Record<string, unknown>> }).rows

const REPORT_OFF = JSON.stringify({
  stages: [{ stage: 'structural', removed: [{ label: 'persona', count: 1 }] }, { stage: 'content', removed: [{ label: 'persona', count: 2 }] }],
  pseudonyms: 2,
  addresses: 0,
  model: 'static',
  settings: { keepDocumentAuthor: false, keepCitedAuthors: false },
})

async function seedDoc(over: { status?: string; publication?: string; contentKind?: string; redacted?: string | null; held?: string | null } = {}) {
  const redacted = over.redacted === undefined ? 'Autora: [Persona A]. Como mostró López (2020), [Persona B] habló.' : over.redacted
  await db.execute(sql`
    INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, content_kind, anonymise, ingest_status,
      anonymisation_status, publication_status, extracted_text, redacted_text, held_text, anonymisation_report,
      cited_authors_kept, authors_kept)
    VALUES (${DOC}, 1, ${ANA}, 'notas.pdf', 'pdf', ${over.contentKind ?? 'documento'}, true, 'ready',
      ${over.status ?? 'ready'}, ${over.publication ?? 'draft'},
      'Autora: Ana Ruiz. Como mostró López (2020), Pedro Gómez habló.', ${redacted}, ${over.held ?? null},
      ${REPORT_OFF}::jsonb,
      ${JSON.stringify([{ name: 'López', model: 'static', at: '2026-11-07T00:00:00.000Z' }])}::jsonb,
      ${JSON.stringify([{ name: 'Ana Ruiz', model: 'static', at: '2026-11-07T00:00:00.000Z' }])}::jsonb)
  `)
}

describe.skipIf(!dockerOk)('/api/documents/:id/anonimizacion on a real Postgres', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)
    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'anonimizacion-test-secret'
    for (const v of ['TRANSCRIPTION_JANITOR_ENABLED', 'PUBLISH_JANITOR_ENABLED', 'EMBEDDING_JANITOR_ENABLED', 'INGEST_RECOVERY_JANITOR_ENABLED']) {
      process.env[v] = 'false'
    }
    const { getPayload } = await import('payload')
    const { default: config } = await import('@payload-config')
    payload = await getPayload({ config })
  }, 90_000)

  beforeEach(async () => {
    invalidateFeatures()
    fake = fakeAiService()
    startGate.mockReset()
    await db.execute(sql.raw(`
      TRUNCATE anonymisation_setting_changes, anonymisation_reviews, documents, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, display_name, is_platform_admin) VALUES
        (1, 'root@example.invalid', 'Root', true), (2, 'ana@example.invalid', 'Ana', false),
        (3, 'memo@example.invalid', 'Memo', false), (4, 'ines@example.invalid', 'Inés', false),
        (5, 'bea@example.invalid', 'Bea', false);
      SELECT setval('users_id_seq', 5);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Eco A', 'eco-a'), (2, 'Eco B', 'eco-b');
      SELECT setval('organizations_id_seq', 2);
      INSERT INTO memberships (id, user_id, organization_id, role, person_name) VALUES
        (1, 2, 1, 'member', 'Ana Ruiz'), (2, 3, 1, 'member', null), (3, 4, 1, 'investigador', null), (4, 5, 2, 'owner', null);
      SELECT setval('memberships_id_seq', 4);
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

  describe('GET: who may see it', () => {
    it.each([
      ['the uploader', ANA],
      ['a holds:review holder of the ecosistema', INES],
      ['a platform admin', ROOT],
    ])('%s → 200, the view, no text and no removed names', async (_who, as) => {
      await seedDoc()
      const res = await call('get', as)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        id: DOC,
        name: 'notas.pdf',
        contentKind: 'documento',
        gated: true,
        publicationStatus: 'draft',
        status: 'ready',
        // "Ana Ruiz" is on the log but not in the text: not shown.
        kept: { authors: [], publicFigures: [], citedAuthors: ['López'] },
        counts: { stages: [{ stage: 'structural', removed: 1 }, { stage: 'content', removed: 2 }], pseudonyms: 2, addresses: 0 },
        switches: {
          keepDocumentAuthor: { value: false, origin: 'ecosistema' },
          keepCitedAuthors: { value: false, origin: 'ecosistema' },
        },
      })
      for (const leak of ['redactedText', 'heldText', 'extractedText', 'Pedro', 'Gómez', 'Ruiz', '[Persona']) {
        expect(res.raw).not.toContain(leak)
      }
    })

    it.each([
      ['🔴 a colleague member', MEMO, 403],
      ['🔴 another ecosistema\'s owner', BEA, 403],
      ['🔴 nobody', null, 401],
    ])('%s → %s', async (_who, as, status) => {
      await seedDoc()
      expect((await call('get', as)).status).toBe(status)
    })

    it('a missing document → 404', async () => {
      expect((await call('get', ANA, { id: 999 })).status).toBe(404)
    })
  })

  describe('PATCH: who may change it', () => {
    it.each([
      ['🔴 a colleague member', MEMO, 403],
      ['🔴 another ecosistema\'s owner', BEA, 403],
      ['🔴 nobody', null, 401],
    ])('%s → %s, nothing saved, nothing audited', async (_who, as, status) => {
      await seedDoc()
      expect((await call('patch', as, { body: { keepCitedAuthors: true } })).status).toBe(status)
      expect((await row())?.keep_cited_authors).toBeNull()
      expect(await audits()).toEqual([])
      expect(fake.calls).toEqual([])
    })

    it.each([
      [{ keepCited: true }],
      [{ keepCitedAuthors: 'sí' }],
      [{}],
      [[true]],
    ])('a bad body %j → 400', async (body) => {
      await seedDoc()
      expect((await call('patch', ANA, { body })).status).toBe(400)
      expect((await row())?.keep_cited_authors).toBeNull()
    })

    it('🔴 the gate is running → 409, nothing saved', async () => {
      await seedDoc({ status: 'pending', redacted: null })
      expect((await call('patch', ANA, { body: { keepCitedAuthors: true } })).status).toBe(409)
      expect((await row())?.keep_cited_authors).toBeNull()
    })

    it.each(['publishing', 'unpublishing'])('🔴 a %s row → 409', async (publication) => {
      await seedDoc({ publication })
      expect((await call('patch', INES, { body: { keepCitedAuthors: true } })).status).toBe(409)
    })

    it('a conversation → 400: the switches never apply', async () => {
      await seedDoc({ contentKind: 'conversacion' })
      expect((await call('patch', ANA, { body: { keepCitedAuthors: true } })).status).toBe(400)
    })
  })

  describe('PATCH: what a change does', () => {
    it('🔴 ready → withdrawn, BOTH old copies erased, reset with the switch, re-gated detached; audited', async () => {
      await seedDoc({ publication: 'published' })
      const pub = `${publishedCorpus(ECO_A)}/${DOC}`
      const draft = `${draftCorpus(ECO_A, ANA)}/${DOC}`
      fake.store.set(pub, { text: 'Ana Ruiz habló.', retired: false })
      fake.store.set(draft, { text: 'Ana Ruiz habló.', retired: false })

      const res = await call('patch', ANA, { body: { keepDocumentAuthor: true } })
      expect(res.status).toBe(200)
      expect(res.body.regate).toBe('started')
      expect(res.body.switches).toEqual({
        keepDocumentAuthor: { value: true, origin: 'documento' },
        keepCitedAuthors: { value: false, origin: 'ecosistema' },
      })
      // 🔴 Gone, not hidden: the chunk holding the name is no longer stored.
      expect(fake.store.has(pub)).toBe(false)
      expect(fake.store.has(draft)).toBe(false)
      expect(fake.calls).toEqual([
        `retire ${publishedCorpus(ECO_A)}`,
        `retire ${draftCorpus(ECO_A, ANA)}`,
        `delete ${publishedCorpus(ECO_A)}`,
        `delete ${draftCorpus(ECO_A, ANA)}`,
      ])
      expect(startGate).toHaveBeenCalledTimes(1)
      expect(await row()).toMatchObject({
        anonymisation_status: 'n/a',
        publication_status: 'draft',
        keep_document_author: true,
        redacted_text: null,
      })
      expect(await audits()).toEqual([
        { organization_id: ECO_A, document_id: DOC, actor_id: ANA, scope: 'documento', key: 'keepDocumentAuthor', before: null, after: true },
      ])
    })

    it('🔴 an old copy that cannot be erased stops the re-gate (502)', async () => {
      fake = fakeAiService({ failDelete: true })
      await seedDoc()
      const res = await call('patch', ANA, { body: { keepCitedAuthors: true } })
      expect(res.status).toBe(502)
      expect(startGate).not.toHaveBeenCalled()
      expect((await row())?.anonymisation_status).toBe('n/a')
    })

    it('ready, the effective value unchanged → saved, not re-gated', async () => {
      await seedDoc()
      const res = await call('patch', ANA, { body: { keepCitedAuthors: false } })
      expect(res.body.regate).toBe('not-needed')
      expect(res.body.switches).toMatchObject({ keepCitedAuthors: { value: false, origin: 'documento' } })
      expect(fake.calls).toEqual([])
      expect((await row())?.keep_cited_authors).toBe(false)
    })

    it('null goes back to the ecosistema\'s value', async () => {
      await seedDoc()
      await db.execute(sql.raw(`UPDATE documents SET keep_cited_authors = false WHERE id = ${DOC}`))
      const res = await call('patch', ANA, { body: { keepCitedAuthors: null } })
      expect(res.body.switches).toMatchObject({ keepCitedAuthors: { value: false, origin: 'ecosistema' } })
      expect((await row())?.keep_cited_authors).toBeNull()
      expect(await audits()).toMatchObject([{ key: 'keepCitedAuthors', before: false, after: null }])
    })

    it('🔴 held + a change → the hold is reset and re-gated, never published', async () => {
      await seedDoc({ status: 'held', redacted: null, held: 'Autora: [Persona A].' })
      const res = await call('patch', INES, { body: { keepCitedAuthors: true } })
      expect(res.body.regate).toBe('started')
      expect(await row()).toMatchObject({ anonymisation_status: 'n/a', publication_status: 'draft', held_text: null })
      expect(startGate).toHaveBeenCalledTimes(1)
    })

    it('🔴 approved + a change → re-gated too: the approval was made under other settings', async () => {
      await seedDoc({ status: 'approved' })
      expect((await call('patch', ROOT, { body: { keepDocumentAuthor: true } })).body.regate).toBe('started')
      expect((await row())?.anonymisation_status).toBe('n/a')
    })

    it('rejected + a change → saved only, stays rejected', async () => {
      await seedDoc({ status: 'rejected', redacted: null })
      const res = await call('patch', ANA, { body: { keepCitedAuthors: true } })
      expect(res.body.regate).toBe('saved-only')
      expect(await row()).toMatchObject({ anonymisation_status: 'rejected', keep_cited_authors: true })
      expect(startGate).not.toHaveBeenCalled()
    })
  })

  describe('🔴 the plain collection API never writes the switches or the log', () => {
    it.each([ANA, ROOT])('user %s: ignored', async (as) => {
      await seedDoc()
      await payload
        .update({
          collection: 'documents',
          id: DOC,
          data: { keepDocumentAuthor: true, keepCitedAuthors: true, citedAuthorsKept: [{ name: 'Pedro Gómez' }] } as never,
          overrideAccess: false,
          user: await userDoc(as),
          context: { __skipDocsExtract: true },
        })
        .catch(() => null)
      const r = (await db.execute(sql.raw(`SELECT keep_document_author, keep_cited_authors, cited_authors_kept FROM documents WHERE id = ${DOC}`))) as unknown as {
        rows: Array<Record<string, unknown>>
      }
      expect(r.rows[0]?.keep_document_author).toBeNull()
      expect(r.rows[0]?.keep_cited_authors).toBeNull()
      expect(JSON.stringify(r.rows[0]?.cited_authors_kept)).not.toContain('Pedro')
    })
  })

  describe('🔴 an ecosistema switch change is audited on every path', () => {
    it('writes one row per changed key, with the actor', async () => {
      await payload.update({
        collection: 'organizations',
        id: ECO_A,
        data: { features: { keepCitedAuthors: true } } as never,
        overrideAccess: true,
        user: await userDoc(INES),
      })
      expect(await audits()).toEqual([
        { organization_id: ECO_A, document_id: null, actor_id: INES, scope: 'ecosistema', key: 'keepCitedAuthors', before: null, after: true },
      ])
    })
  })

  describe('🔴 a hold made under other settings cannot be approved', () => {
    it('refused after the ecosistema switch changed; allowed check when unchanged', async () => {
      await seedDoc({ status: 'held', redacted: null, held: 'Autora: [Persona A].' })
      const fresh = (await payload.findByID({ collection: 'documents', id: DOC, depth: 0, overrideAccess: true })) as never
      expect(await holdSettingsChanged(payload, fresh)).toBe(false)
      await db.execute(sql.raw(`UPDATE organizations SET features = '{"keepDocumentAuthor": true}'::jsonb WHERE id = ${ECO_A}`))
      invalidateFeatures()
      await expect(
        decideOnHold({ payload, documentId: DOC, user: await userDoc(INES), decision: 'approve' }),
      ).rejects.toBeInstanceOf(HoldSettingsChangedError)
      expect((await row())?.anonymisation_status).toBe('held')
    })
  })
})
