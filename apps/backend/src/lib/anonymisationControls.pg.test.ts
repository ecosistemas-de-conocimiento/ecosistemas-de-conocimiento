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
import {
  anonimizacionEndpoints,
  ecosystemRegate,
  organizationAnonimizacionEndpoints,
  type ControlDeps,
} from './anonymisationControls'
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

let depsOverride: Partial<ControlDeps> = {}
const endpoint = (method: string, retry = false): Endpoint => {
  const found = anonimizacionEndpoints({ ...deps(), ...depsOverride }).find(
    (e) => e.method === method && e.path.endsWith('/reintentar') === retry,
  )
  if (!found) throw new Error(`no ${method}`)
  return found
}

const userDoc = async (id: number) =>
  ({ ...(await payload.findByID({ collection: 'users', id, overrideAccess: true })), collection: 'users' }) as never

async function call(
  method: 'get' | 'patch' | 'post',
  as: number | null,
  opts: { id?: number; body?: unknown; org?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const { createLocalReq } = await import('payload')
  const req = (await createLocalReq(as === null ? {} : { user: await userDoc(as) }, payload)) as PayloadRequest
  if (as === null) (req as { user: unknown }).user = null
  Object.assign(req, { routeParams: { id: String(opts.id ?? (opts.org ? ECO_A : DOC)) }, json: async () => opts.body ?? {} })
  const handler = opts.org
    ? organizationAnonimizacionEndpoints().find((e) => e.method === method)!.handler
    : endpoint(method, method === 'post').handler
  const res = await handler(req)
  const raw = await res.text()
  return { status: res.status, body: JSON.parse(raw) as Record<string, unknown>, raw }
}

const errorOf = (body: Record<string, unknown>) => (body.errors as Array<{ message: string }> | undefined)?.[0]?.message ?? ''

const docCol = async (id: number, cols: string) =>
  ((await db.execute(sql.raw(`SELECT ${cols} FROM documents WHERE id = ${id}`))) as unknown as { rows: Array<Record<string, unknown>> })
    .rows[0]

/** Another gated document of ecosistema A, copied from DOC with these columns overridden (raw SQL values). */
const cloneDoc = async (id: number, over: Record<string, string> = {}) => {
  const cols = {
    organization_id: 'organization_id', uploaded_by_id: 'uploaded_by_id', name: `'doc-${id}.pdf'`, kind: 'kind',
    content_kind: 'content_kind', anonymise: 'anonymise', ingest_status: 'ingest_status',
    anonymisation_status: 'anonymisation_status', publication_status: 'publication_status', extracted_text: 'extracted_text',
    redacted_text: 'redacted_text', anonymisation_report: 'anonymisation_report', authors_kept: 'authors_kept',
    cited_authors_kept: 'cited_authors_kept', ...over,
  }
  await db.execute(sql.raw(`INSERT INTO documents (id, ${Object.keys(cols).join(', ')})
    SELECT ${id}, ${Object.values(cols).join(', ')} FROM documents WHERE id = ${DOC}`))
}

const setFeatures = async (features: Record<string, boolean>) => {
  await db.execute(sql.raw(`UPDATE organizations SET features = '${JSON.stringify(features)}'::jsonb WHERE id = ${ECO_A}`))
  invalidateFeatures()
}

/** The ecosistema switch changed through Payload, as Ajustes does; the job awaited. */
const changeEcosystem = async (features: Record<string, boolean>, as = INES, wait = true) => {
  await payload.update({
    collection: 'organizations',
    id: ECO_A,
    data: { features } as never,
    overrideAccess: true,
    user: await userDoc(as),
  })
  invalidateFeatures()
  if (wait) await ecosystemRegate.last
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
    // The ecosistema job's backoff and pending poll, shortened for the test.
    process.env.ANONYMISE_REGATE_RETRY_MS = '1'
    process.env.ANONYMISE_REGATE_PENDING_POLL_MS = '20'
    process.env.ANONYMISE_REGATE_PENDING_WAIT_MS = '5000'
    process.env.ANONYMISE_REGATE_CONCURRENCY = '2'
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
    ecosystemRegate.deps = null
    depsOverride = {}
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
          keepPublicFigures: { value: false, origin: 'ecosistema' },
        },
        pendingRegate: false,
        retryable: false,
        unpublishedByRegate: false,
      })
      for (const leak of ['redactedText', 'heldText', 'extractedText', 'Pedro', 'Gómez', 'Ruiz', '[Persona']) {
        expect(res.raw).not.toContain(leak)
      }
    })

    it.each([
      ['🔴 a colleague member', MEMO, 403],
      ['🔴 another ecosistema\'s owner: as if it did not exist', BEA, 404],
      ['🔴 nobody', null, 401],
    ])('%s → %s', async (_who, as, status) => {
      await seedDoc()
      expect((await call('get', as)).status).toBe(status)
    })

    it.each([
      ['🔴 the uploader, membership inactive', `UPDATE memberships SET is_active = false WHERE user_id = ${ANA}`, ANA],
      ['🔴 the uploader, account inactive', `UPDATE users SET is_active = false WHERE id = ${ANA}`, ANA],
      ['🔴 a reviewer, membership inactive', `UPDATE memberships SET is_active = false WHERE user_id = ${INES}`, INES],
      ['🔴 a platform admin, account inactive', `UPDATE users SET is_active = false WHERE id = ${ROOT}`, ROOT],
    ])('%s → 404 on GET and PATCH, nothing saved or erased', async (_who, deactivate, as) => {
      await seedDoc()
      await db.execute(sql.raw(deactivate))
      expect((await call('get', as)).status).toBe(404)
      expect((await call('patch', as, { body: { keepDocumentAuthor: true } })).status).toBe(404)
      expect((await row())?.keep_document_author).toBeNull()
      expect(await audits()).toEqual([])
      expect(fake.calls).toEqual([])
    })

    it('🔴 a testimonio\'s file name: shown to its uploader, the neutral title to a reviewer', async () => {
      await seedDoc({ contentKind: 'testimonio' })
      await db.execute(sql.raw(`UPDATE documents SET name = 'Entrevista con Rosa Ulloa.m4a' WHERE id = ${DOC}`))
      const reviewer = await call('get', INES)
      expect(reviewer.status).toBe(200)
      expect(reviewer.body.name).toBe('Testimonio')
      expect(reviewer.raw).not.toContain('Ulloa')
      expect((await call('get', ANA)).body.name).toBe('Entrevista con Rosa Ulloa.m4a')
      const patched = await call('patch', INES, { body: { keepCitedAuthors: false } })
      expect(patched.body.name).toBe('Testimonio')
    })

    it('a missing document → 404', async () => {
      expect((await call('get', ANA, { id: 999 })).status).toBe(404)
    })
  })

  describe('PATCH: who may change it', () => {
    it.each([
      ['🔴 a colleague member', MEMO, 403],
      ['🔴 another ecosistema\'s owner', BEA, 404],
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
        keepPublicFigures: { value: false, origin: 'ecosistema' },
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

    it('🔴 an old copy that cannot be erased stops the re-gate BEFORE the reset; the 502 says what changed; Reintentar retries (I-05, P-03 B)', async () => {
      fake = fakeAiService({ failDelete: true })
      await seedDoc({ publication: 'published' })
      const res = await call('patch', ANA, { body: { keepCitedAuthors: true } })
      expect(res.status).toBe(502)
      // 🔴 The copies are retired by now: "nothing was saved" would be false.
      expect(errorOf(res.body)).not.toMatch(/No se guardó nada/)
      expect(errorOf(res.body)).toBe(
        'Se guardó el cambio, pero no se pudieron borrar las copias anteriores. El documento ya no aparece en el chat. Reintenta.',
      )
      expect(startGate).not.toHaveBeenCalled()
      // Not reset (no sweep can re-drive it next to the old copy); the switch is saved, the failure stamped.
      expect(await row()).toMatchObject({ anonymisation_status: 'ready', publication_status: 'published', keep_cited_authors: true })
      expect((await call('get', ANA)).body).toMatchObject({ retryable: true })
      // Still failing: 502 again, still retryable.
      const stillDown = await call('post', ANA)
      expect(stillDown.status).toBe(502)
      expect(errorOf(stillDown.body)).toBe('No se pudieron borrar las copias anteriores. El documento ya no aparece en el chat. Reintenta.')

      fake = fakeAiService()
      const pub = `${publishedCorpus(ECO_A)}/${DOC}`
      fake.store.set(pub, { text: 'Como mostró López (2020).', retired: true })
      const again = await call('post', ANA)
      expect(again.status).toBe(200)
      expect(again.body.regate).toBe('started')
      expect(fake.store.has(pub)).toBe(false)
      expect(startGate).toHaveBeenCalledTimes(1)
      expect(await row()).toMatchObject({ anonymisation_status: 'n/a', keep_cited_authors: true })
      // A re-gated, not-yet-gated row: nothing left to retry.
      expect((await call('post', ANA)).status).toBe(400)
    })

    it('POST reintentar: 400 with nothing pending, 403 for a colleague, 409 mid-gate', async () => {
      await seedDoc()
      expect((await call('post', ANA)).status).toBe(400)
      expect(errorOf((await call('post', ANA)).body)).toBe('No hay nada pendiente.')
      expect((await call('post', MEMO)).status).toBe(403)
      await db.execute(sql.raw(`UPDATE documents SET anonymisation_status = 'pending' WHERE id = ${DOC}`))
      expect((await call('post', ANA)).status).toBe(409)
    })

    it('🔴 P-02: the re-gate purges the old text\'s graph rows before the reset', async () => {
      await seedDoc({ publication: 'published' })
      await db.execute(sql.raw(`
        INSERT INTO graph_entities (id, organization_id, type, label, canonical_key) VALUES (1, ${ECO_A}, 'persona', 'López', 'lopez');
        INSERT INTO graph_mentions (organization_id, document_id, entity_id, snippet) VALUES (${ECO_A}, ${DOC}, 1, 'Como mostró López (2020)');`))
      const res = await call('patch', ANA, { body: { keepCitedAuthors: true } })
      expect(res.body.regate).toBe('started')
      const left = (await db.execute(sql.raw(`SELECT count(*)::int AS n FROM graph_mentions WHERE document_id = ${DOC}`))) as unknown as {
        rows: Array<{ n: number }>
      }
      expect(left.rows[0]?.n).toBe(0)
      expect(await docCol(DOC, 'graph_status')).toEqual({ graph_status: 'pending' })
    })

    it('🔴 P-02: a purge that throws is erase-failed: 502, not reset', async () => {
      depsOverride = { purgeGraph: async () => Promise.reject(new Error('graph down')) }
      await seedDoc({ publication: 'published' })
      const res = await call('patch', ANA, { body: { keepCitedAuthors: true } })
      expect(res.status).toBe(502)
      expect(startGate).not.toHaveBeenCalled()
      expect(await row()).toMatchObject({ anonymisation_status: 'ready', publication_status: 'published' })
    })

    it('🔴 P-04: keepPublicFigures is a platform admin\'s, a documento\'s only, audited and re-gated', async () => {
      await seedDoc({ publication: 'published' })
      expect((await call('patch', INES, { body: { keepPublicFigures: true } })).status).toBe(403)
      expect((await call('patch', ANA, { body: { keepPublicFigures: false } })).status).toBe(403)
      const res = await call('patch', ROOT, { body: { keepPublicFigures: true } })
      expect(res.body.regate).toBe('started')
      expect(await audits()).toEqual([
        { organization_id: ECO_A, document_id: DOC, actor_id: ROOT, scope: 'documento', key: 'keepPublicFigures', before: null, after: true },
      ])
      await db.execute(sql.raw(`UPDATE documents SET content_kind = 'testimonio', anonymisation_status = 'ready' WHERE id = ${DOC}`))
      expect((await call('patch', ROOT, { body: { keepPublicFigures: false } })).status).toBe(400)
    })

    it('🔴 I-02: turning a switch off on a ready verdict that kept nobody saves it and updates the verdict, nothing unpublished', async () => {
      await seedDoc({ publication: 'published' })
      await db.execute(sql.raw(`UPDATE documents SET cited_authors_kept = NULL,
        anonymisation_report = jsonb_set(anonymisation_report, '{settings,keepCitedAuthors}', 'true') WHERE id = ${DOC}`))
      expect((await call('get', ANA)).body.pendingRegate).toBe(false)
      const res = await call('patch', ANA, { body: { keepCitedAuthors: false } })
      expect(res.body.regate).toBe('not-needed')
      expect(fake.calls).toEqual([])
      expect(await row()).toMatchObject({ anonymisation_status: 'ready', publication_status: 'published', keep_cited_authors: false })
      expect(await docCol(DOC, `anonymisation_report->'settings'->'keepCitedAuthors' AS k`)).toEqual({ k: false })
    })

    it('🔴 a row gated before the switches existed that kept its author counts as author ON (X8)', async () => {
      await seedDoc({ redacted: 'Autora: Ana Ruiz. [Persona B] habló.' })
      await db.execute(sql.raw(`UPDATE documents SET anonymisation_report = anonymisation_report - 'settings' WHERE id = ${DOC}`))
      expect((await call('get', ANA)).body.pendingRegate).toBe(true)
      const res = await call('patch', ANA, { body: { keepDocumentAuthor: false } })
      expect(res.body.regate).toBe('started')
      expect((await row())?.redacted_text).toBeNull()
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

  describe('🔴 an ecosistema default turned OFF re-gates what inherits it (X7)', () => {
    const withAuthor = 'Autora: Ana Ruiz. Como mostró López (2020), [Persona B] habló.'
    const madeWithAuthor = async (id: number) =>
      db.execute(
        sql.raw(
          `UPDATE documents SET anonymisation_report = jsonb_set(anonymisation_report, '{settings}', '{"keepDocumentAuthor":true,"keepCitedAuthors":false}') WHERE id = ${id}`,
        ),
      )

    it('ON→OFF: an inheriting ready row is withdrawn, erased and re-gated; an override is left alone', async () => {
      ecosystemRegate.deps = deps()
      await db.execute(sql.raw(`UPDATE organizations SET features = '{"keepDocumentAuthor": true}'::jsonb WHERE id = ${ECO_A}`))
      invalidateFeatures()
      await seedDoc({ publication: 'published', redacted: withAuthor })
      await madeWithAuthor(DOC)
      const pub = `${publishedCorpus(ECO_A)}/${DOC}`
      fake.store.set(pub, { text: 'Autora: Ana Ruiz.', retired: false })
      // A second document keeps its own ON: not touched.
      await db.execute(sql.raw(`
        INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, content_kind, anonymise, ingest_status,
          anonymisation_status, publication_status, extracted_text, redacted_text, anonymisation_report, keep_document_author)
        SELECT 11, organization_id, uploaded_by_id, 'otro.pdf', kind, content_kind, anonymise, ingest_status, anonymisation_status,
          'draft', extracted_text, redacted_text, anonymisation_report, true FROM documents WHERE id = ${DOC}`))
      // A third inherits too, but its verdict was made with the switch OFF: it kept no name.
      await db.execute(sql.raw(`
        INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, content_kind, anonymise, ingest_status,
          anonymisation_status, publication_status, extracted_text, redacted_text, anonymisation_report)
        SELECT 12, organization_id, uploaded_by_id, 'tercero.pdf', kind, content_kind, anonymise, ingest_status, anonymisation_status,
          'draft', extracted_text, 'Autora: [Persona A].', '${REPORT_OFF}'::jsonb FROM documents WHERE id = ${DOC}`))

      await payload.update({
        collection: 'organizations',
        id: ECO_A,
        data: { features: { keepDocumentAuthor: false } } as never,
        overrideAccess: true,
        user: await userDoc(INES),
      })
      invalidateFeatures()
      await ecosystemRegate.last
      expect(fake.store.has(pub)).toBe(false)
      expect(startGate).toHaveBeenCalledTimes(1)
      expect(await row()).toMatchObject({ anonymisation_status: 'n/a', publication_status: 'draft', redacted_text: null })
      const other = (await db.execute(sql.raw('SELECT anonymisation_status FROM documents WHERE id = 11'))) as unknown as {
        rows: Array<{ anonymisation_status: string }>
      }
      expect(other.rows[0]?.anonymisation_status).toBe('ready')
      const third = (await db.execute(sql.raw('SELECT anonymisation_status FROM documents WHERE id = 12'))) as unknown as {
        rows: Array<{ anonymisation_status: string }>
      }
      expect(third.rows[0]?.anonymisation_status).toBe('ready')
      expect(await audits()).toMatchObject([{ scope: 'ecosistema', key: 'keepDocumentAuthor', before: true, after: false }])
    })

    it('while the job has not reset a row, its view says pendingRegate', async () => {
      await seedDoc({ redacted: withAuthor })
      await madeWithAuthor(DOC)
      // The default is OFF (never set) and the verdict was made with it ON.
      const view = await call('get', ANA)
      expect(view.body.pendingRegate).toBe(true)
      expect(view.body.kept).toMatchObject({ authors: ['Ana Ruiz'] })
    })

    it('OFF→ON reprocesses nothing', async () => {
      ecosystemRegate.deps = deps()
      await seedDoc()
      await payload.update({
        collection: 'organizations',
        id: ECO_A,
        data: { features: { keepDocumentAuthor: true } } as never,
        overrideAccess: true,
        user: await userDoc(INES),
      })
      await ecosystemRegate.last
      expect(fake.calls).toEqual([])
      expect(startGate).not.toHaveBeenCalled()
      expect((await row())?.anonymisation_status).toBe('ready')
    })
  })

  describe('🔴 the ecosistema job, audit 2026-11-10 (I-01, I-02, I-03, I-14, P-04)', () => {
    const withAuthor = 'Autora: Ana Ruiz. Como mostró López (2020), [Persona B] habló.'
    const settingsOn = (k: string) =>
      `jsonb_set(anonymisation_report, '{settings,${k}}', 'true')`

    it('🔴 I-01: an erase that keeps failing is tried 3 times, stamped, counted, and retried from the ecosistema', async () => {
      ecosystemRegate.deps = deps()
      fake = fakeAiService({ failDelete: true })
      await setFeatures({ keepDocumentAuthor: true })
      await seedDoc({ publication: 'published', redacted: withAuthor })
      await db.execute(sql.raw(`UPDATE documents SET anonymisation_report = ${settingsOn('keepDocumentAuthor')} WHERE id = ${DOC}`))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await changeEcosystem({ keepDocumentAuthor: false })
      expect(fake.calls.filter((c) => c === `delete ${publishedCorpus(ECO_A)}`)).toHaveLength(3)
      expect(startGate).not.toHaveBeenCalled()
      expect(await row()).toMatchObject({ anonymisation_status: 'ready', publication_status: 'published' })
      expect((await call('get', ANA)).body).toMatchObject({ pendingRegate: true, retryable: true })
      expect(await docCol(DOC, `anonymisation_report->'regate'->>'reason' AS r`)).toEqual({ r: 'erase-failed' })

      const view = await call('get', INES, { org: true })
      expect(view).toMatchObject({ status: 200, body: { pendingRegate: 1, regating: false, unpublishedByRegate: 0 } })
      expect((await call('get', MEMO, { org: true })).status).toBe(403)
      expect((await call('get', BEA, { org: true })).status).toBe(404)

      fake = fakeAiService()
      const retry = await call('post', INES, { org: true })
      expect(retry).toMatchObject({ status: 202, body: { started: true, pendingRegate: 1 } })
      await ecosystemRegate.last
      expect(startGate).toHaveBeenCalledTimes(1)
      expect(await row()).toMatchObject({ anonymisation_status: 'n/a', publication_status: 'draft' })
      // A staff row the re-gate took out of the shared corpus: still a draft, flagged.
      expect((await call('get', INES, { org: true })).body).toEqual({ pendingRegate: 0, regating: false, unpublishedByRegate: 1 })
      expect((await call('get', ANA)).body.unpublishedByRegate).toBe(true)
      expect((await call('post', INES, { org: true })).body).toEqual({ started: false, pendingRegate: 0 })
    })

    it('🔴 I-02: a verdict that kept nobody is NOT unpublished; one that kept a name is, and stays flagged after its gate', async () => {
      ecosystemRegate.deps = deps()
      await setFeatures({ keepCitedAuthors: true })
      // DOC kept "López" under the switch; 11 ran with it on and kept nobody.
      await seedDoc({ publication: 'published' })
      await db.execute(sql.raw(`UPDATE documents SET anonymisation_report = ${settingsOn('keepCitedAuthors')} WHERE id = ${DOC}`))
      await cloneDoc(11, { cited_authors_kept: 'NULL', redacted_text: `'Autora: [Persona A].'` })
      // The gate, simulated: a fresh report without the re-gate's marks.
      startGate.mockImplementation(async (_p, r) => {
        await db.execute(sql.raw(`UPDATE documents SET anonymisation_status = 'ready', redacted_text = 'Autora: [Persona A].',
          anonymisation_report = '${REPORT_OFF}'::jsonb WHERE id = ${String(r.id)}`))
      })
      await changeEcosystem({ keepCitedAuthors: false })
      expect(startGate).toHaveBeenCalledTimes(1)
      expect(await docCol(11, `publication_status, anonymisation_status, anonymisation_report->'settings'->'keepCitedAuthors' AS k`)).toEqual({
        publication_status: 'published',
        anonymisation_status: 'ready',
        k: false,
      })
      expect(fake.calls.some((c) => c.includes('11'))).toBe(false)
      expect(await row()).toMatchObject({ anonymisation_status: 'ready', publication_status: 'draft' })
      expect((await call('get', ANA)).body).toMatchObject({ unpublishedByRegate: true, pendingRegate: false })
      expect((await call('get', ANA, { id: 11 })).body).toMatchObject({ unpublishedByRegate: false, pendingRegate: false })
    })

    it('🔴 I-03: a row mid-gate is waited for and re-gated when its verdict lands under the old value', async () => {
      ecosystemRegate.deps = deps()
      await setFeatures({ keepCitedAuthors: true })
      await seedDoc({ status: 'pending', redacted: null })
      await changeEcosystem({ keepCitedAuthors: false }, INES, false)
      await delay(150)
      expect(startGate).not.toHaveBeenCalled()
      // The gate that started under the old default ends, keeping López, and was auto-published.
      await db.execute(sql.raw(`UPDATE documents SET anonymisation_status = 'ready', publication_status = 'published',
        redacted_text = 'Como mostró López (2020), [Persona B] habló.', anonymisation_report = ${settingsOn('keepCitedAuthors')}
        WHERE id = ${DOC}`))
      await ecosystemRegate.last
      expect(startGate).toHaveBeenCalledTimes(1)
      expect(fake.calls).toContain(`retire ${publishedCorpus(ECO_A)}`)
      expect(await row()).toMatchObject({ anonymisation_status: 'n/a', publication_status: 'draft', redacted_text: null })
    })

    it('🔴 I-03: a row mid-gate whose gate already read the new value needs nothing', async () => {
      ecosystemRegate.deps = deps()
      await setFeatures({ keepCitedAuthors: true })
      await seedDoc({ status: 'pending', redacted: null })
      await changeEcosystem({ keepCitedAuthors: false }, INES, false)
      await delay(100)
      await db.execute(sql.raw(`UPDATE documents SET anonymisation_status = 'ready', cited_authors_kept = NULL WHERE id = ${DOC}`))
      await ecosystemRegate.last
      expect(startGate).not.toHaveBeenCalled()
      expect(fake.calls).toEqual([])
    })

    it('🔴 I-14: no more than ANONYMISE_REGATE_CONCURRENCY (2) gates at once', async () => {
      ecosystemRegate.deps = deps()
      await setFeatures({ keepDocumentAuthor: true })
      // Published: a draft the re-gate did not unpublish is not the job's (taller, 2026-11-10).
      await seedDoc({ publication: 'published', redacted: withAuthor })
      await db.execute(sql.raw(`UPDATE documents SET anonymisation_report = ${settingsOn('keepDocumentAuthor')} WHERE id = ${DOC}`))
      for (const id of [11, 12, 13]) await cloneDoc(id)
      let live = 0
      let max = 0
      startGate.mockImplementation(async () => {
        live++
        max = Math.max(max, live)
        await delay(400)
        live--
      })
      await changeEcosystem({ keepDocumentAuthor: false })
      expect(startGate).toHaveBeenCalledTimes(4)
      expect(max).toBe(2)
    })

    it('🔴 P-04: the platform admin turning keepPublicFigures off audits it and re-gates what kept a public name', async () => {
      ecosystemRegate.deps = deps()
      await setFeatures({ keepPublicFigures: true })
      await seedDoc({ publication: 'published' })
      await db.execute(sql.raw(`UPDATE documents SET cited_authors_kept = NULL,
        public_figures_kept = '[{"name":"López","motivo":"autor citado"}]'::jsonb WHERE id = ${DOC}`))
      // Kept nobody public: untouched.
      await cloneDoc(11, { cited_authors_kept: 'NULL' })
      await changeEcosystem({ keepPublicFigures: false }, ROOT)
      expect(await audits()).toMatchObject([{ scope: 'ecosistema', key: 'keepPublicFigures', before: true, after: false, actor_id: ROOT }])
      expect(startGate).toHaveBeenCalledTimes(1)
      expect(await row()).toMatchObject({ anonymisation_status: 'n/a' })
      expect(await docCol(11, 'anonymisation_status, publication_status')).toEqual({ anonymisation_status: 'ready', publication_status: 'published' })
    })
  })

  /**
   * 🔴 THE SEMIOSIS WORKSHOP DRAFTS (owner rule 2026-11-04; audit
   * `taller-2026-11-10/rutas.md` #1-#3): a draft of org 8 whose verdict was
   * made with a switch ON gets no call to the detector, embeddings or graph
   * from any ecosistema trigger. `startGate` (the only way to the detector,
   * the embeddings and `rebuildDocumentGraph`, `liveDeps`), `clientFor` (the
   * corpus deletes) and `purgeGraph` are spies. Each test has the positive
   * controls: the same verdict PUBLISHED is re-gated, and a draft the re-gate
   * itself unpublished still is.
   */
  describe('🔴 the ecosistema re-gate never reprocesses a draft it did not unpublish (taller, 2026-11-10)', () => {
    const TALLER = 8
    const DRAFT = 80
    const PUBLISHED = 81
    const UNPUBLISHED_BY_REGATE = 82
    const withNames = 'Autora: Ana Ruiz. Como mostró López (2020), [Persona B] habló.'
    const REPORT_ON = JSON.stringify({
      ...(JSON.parse(REPORT_OFF) as Record<string, unknown>),
      settings: { keepDocumentAuthor: true, keepCitedAuthors: true, keepPublicFigures: true },
    })
    const clientFor = vi.fn<ControlDeps['clientFor']>()
    const purgeGraph = vi.fn<NonNullable<ControlDeps['purgeGraph']>>()
    const spied = (): ControlDeps => ({ clientFor, startGate, purgeGraph })

    const seedTaller = async (features: Record<string, boolean>) => {
      clientFor.mockReset().mockImplementation(() => fake.client as never)
      purgeGraph.mockReset().mockResolvedValue(undefined)
      await db.execute(sql.raw(`
        INSERT INTO organizations (id, name, slug, features) VALUES (${TALLER}, 'Taller', 'taller', '${JSON.stringify(features)}'::jsonb);
        INSERT INTO memberships (id, user_id, organization_id, role, person_name) VALUES (5, ${INES}, ${TALLER}, 'investigador', null);`))
      invalidateFeatures()
      // The same verdict three times, made with every switch ON and keeping a name under each.
      const kept = (name: string) => `'${JSON.stringify([{ name, model: 'static', at: '2026-11-04T00:00:00.000Z' }])}'::jsonb`
      for (const [id, publication, report] of [
        [DRAFT, 'draft', REPORT_ON],
        [PUBLISHED, 'published', REPORT_ON],
        [UNPUBLISHED_BY_REGATE, 'draft', JSON.stringify({ ...(JSON.parse(REPORT_ON) as Record<string, unknown>), regate: { unpublished: true } })],
      ] as const) {
        await db.execute(sql.raw(`
          INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, content_kind, anonymise, ingest_status,
            anonymisation_status, publication_status, extracted_text, redacted_text, anonymisation_report,
            authors_kept, cited_authors_kept, public_figures_kept)
          VALUES (${id}, ${TALLER}, ${ROOT}, 'caso-${id}.pdf', 'pdf', 'documento', true, 'ready', 'ready', '${publication}',
            'Autora: Ana Ruiz. Como mostró López (2020), Pedro Gómez habló.', '${withNames}', '${report}'::jsonb,
            ${kept('Ana Ruiz')}, ${kept('López')}, '[{"name":"López","motivo":"autor citado"}]'::jsonb)`))
      }
    }

    const changeTaller = async (features: Record<string, boolean>, as: number) => {
      await payload.update({
        collection: 'organizations',
        id: TALLER,
        data: { features } as never,
        overrideAccess: true,
        user: await userDoc(as),
      })
      invalidateFeatures()
      await ecosystemRegate.last
    }

    const gatedIds = () => startGate.mock.calls.map((c) => Number((c[1] as { id: unknown }).id)).sort()
    const purgedIds = () => purgeGraph.mock.calls.map((c) => Number(c[1])).sort()
    const corpusIds = () =>
      [...fake.client.admin.setDocumentValidity.mock.calls, ...fake.client.admin.deleteDocument.mock.calls].map((c) => String(c[1]))

    /** The draft: untouched, and nothing reached for it. Positive controls: 81 and 82 were re-gated. */
    const expectOnlyControlsRegated = async () => {
      expect(gatedIds()).toEqual([PUBLISHED, UNPUBLISHED_BY_REGATE])
      expect(purgedIds()).toEqual([PUBLISHED, UNPUBLISHED_BY_REGATE])
      expect(clientFor).toHaveBeenCalledTimes(2)
      expect(corpusIds()).not.toContain(String(DRAFT))
      expect(corpusIds()).toContain(String(PUBLISHED))
      expect(await docCol(DRAFT, `anonymisation_status, publication_status, redacted_text, anonymisation_report->'regate' AS mark`)).toEqual({
        anonymisation_status: 'ready',
        publication_status: 'draft',
        redacted_text: withNames,
        mark: null,
      })
      for (const id of [PUBLISHED, UNPUBLISHED_BY_REGATE]) {
        expect(await docCol(id, 'anonymisation_status, publication_status')).toEqual({ anonymisation_status: 'n/a', publication_status: 'draft' })
      }
    }

    it('(a) keepDocumentAuthor / keepCitedAuthors ON→OFF in Ajustes', async () => {
      ecosystemRegate.deps = spied()
      const on = { studentView: true, keepPublicFigures: true, keepDocumentAuthor: true, keepCitedAuthors: true }
      await seedTaller(on)
      await changeTaller({ ...on, keepDocumentAuthor: false }, INES)
      await expectOnlyControlsRegated()

      // keepCitedAuthors too: the draft is still untouched (the controls are mid-gate now, `n/a`).
      startGate.mockClear()
      purgeGraph.mockClear()
      await changeTaller({ ...on, keepDocumentAuthor: false, keepCitedAuthors: false }, INES)
      expect(gatedIds()).not.toContain(DRAFT)
      expect(purgedIds()).not.toContain(DRAFT)
      expect(await docCol(DRAFT, 'anonymisation_status')).toEqual({ anonymisation_status: 'ready' })
    })

    it('(b) a platform admin turns keepPublicFigures OFF', async () => {
      ecosystemRegate.deps = spied()
      const on = { studentView: true, keepPublicFigures: true, keepDocumentAuthor: true, keepCitedAuthors: true }
      await seedTaller(on)
      await changeTaller({ ...on, keepPublicFigures: false }, ROOT)
      await expectOnlyControlsRegated()
    })

    it('(c) the ecosistema "Reintentar": the draft is not counted and not re-gated', async () => {
      ecosystemRegate.deps = spied()
      // The author/cited defaults are OFF (unset) and every verdict kept names under them.
      await seedTaller({ studentView: true, keepPublicFigures: true })
      expect((await call('get', INES, { org: true, id: TALLER })).body).toEqual({ pendingRegate: 2, regating: false, unpublishedByRegate: 1 })
      const res = await call('post', INES, { org: true, id: TALLER })
      expect(res).toMatchObject({ status: 202, body: { started: true, pendingRegate: 2 } })
      await ecosystemRegate.last
      await expectOnlyControlsRegated()
    })

    it('(c) the document\'s "Reintentar": not on a draft the re-gate did not unpublish, unless its own re-gate failed', async () => {
      await seedTaller({ studentView: true, keepPublicFigures: true })
      // The screen still says the names are there, but offers no retry.
      expect((await call('get', ROOT, { id: DRAFT })).body).toMatchObject({ pendingRegate: true, retryable: false })
      const refused = await call('post', ROOT, { id: DRAFT })
      expect(refused.status).toBe(400)
      expect(startGate).not.toHaveBeenCalled()
      expect(clientFor).not.toHaveBeenCalled()
      expect(purgeGraph).not.toHaveBeenCalled()
      // Positive controls: the published row and the one the re-gate unpublished are retried.
      expect((await call('get', ROOT, { id: PUBLISHED })).body).toMatchObject({ retryable: true })
      expect((await call('post', ROOT, { id: PUBLISHED })).body.regate).toBe('started')
      expect((await call('post', ROOT, { id: UNPUBLISHED_BY_REGATE })).body.regate).toBe('started')
      expect(gatedIds()).toEqual([PUBLISHED, UNPUBLISHED_BY_REGATE])
      // An explicit re-gate on the draft itself that failed stays retryable.
      await db.execute(sql.raw(`UPDATE documents SET anonymisation_report = jsonb_set(anonymisation_report, '{regate}',
        '{"failedAt":"2026-11-10T00:00:00.000Z","reason":"erase-failed"}') WHERE id = ${DRAFT}`))
      expect((await call('get', ROOT, { id: DRAFT })).body).toMatchObject({ retryable: true })
      expect((await call('post', ROOT, { id: DRAFT })).body.regate).toBe('started')
    })
  })

  describe('🔴 a detectorFallback change is audited (P-04)', () => {
    it('one row, scope plataforma, no ecosistema, hosted = true', async () => {
      const root = await userDoc(ROOT)
      await payload.updateGlobal({ slug: 'platform-settings', data: { detectorFallback: 'none' } as never, overrideAccess: true, user: root })
      await payload.updateGlobal({ slug: 'platform-settings', data: { detectorFallback: 'hosted' } as never, overrideAccess: true, user: root })
      expect((await audits()).slice(-1)).toEqual([
        { organization_id: null, document_id: null, actor_id: ROOT, scope: 'plataforma', key: 'detectorFallback', before: false, after: true },
      ])
      await payload.updateGlobal({ slug: 'platform-settings', data: { detectorFallback: null } as never, overrideAccess: true, user: root })
    })
  })

  describe('🔴 the audit log is append-only, even for a platform admin', () => {
    it('no API create, update or delete; a colleague member reads nothing', async () => {
      await seedDoc()
      await call('patch', ANA, { body: { keepCitedAuthors: true } })
      const [first] = await audits()
      expect(first).toBeDefined()
      const ids = (await db.execute(sql.raw('SELECT id FROM anonymisation_setting_changes'))) as unknown as { rows: Array<{ id: number }> }
      const id = ids.rows[0]!.id
      const root = await userDoc(ROOT)
      const refused = (p: Promise<unknown>) => p.then(() => 'done', () => 'refused')
      expect(
        await refused(
          payload.create({
            collection: 'anonymisation-setting-changes',
            data: { organization: ECO_A, scope: 'documento', key: 'keepCitedAuthors', before: true, after: false } as never,
            overrideAccess: false,
            user: root,
          }),
        ),
      ).toBe('refused')
      expect(
        await refused(payload.update({ collection: 'anonymisation-setting-changes', id, data: { after: false } as never, overrideAccess: false, user: root })),
      ).toBe('refused')
      expect(await refused(payload.delete({ collection: 'anonymisation-setting-changes', id, overrideAccess: false, user: root }))).toBe('refused')
      expect(await audits()).toEqual([first])
      expect(
        await refused(payload.find({ collection: 'anonymisation-setting-changes', overrideAccess: false, user: await userDoc(MEMO) })),
      ).toBe('refused')
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
