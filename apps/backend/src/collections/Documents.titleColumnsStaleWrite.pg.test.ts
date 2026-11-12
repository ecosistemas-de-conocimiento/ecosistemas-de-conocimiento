/**
 * 🔴 A WHOLE-ROW `payload.update` NEVER WRITES `testimonioTitle`,
 * `anonymisationReport`, `anonymisationSurvivors` OR `ingestId` BACK FROM A
 * STALE READ, and `POST /:id/retry` never undoes a newer verdict, on a real
 * Payload + Postgres (audit 2026-11-12, P1-P4).
 *
 * P1: a rename racing an approval put back the title made from the cleared
 * `heldText`; on the published row every member read it. P2: a rename racing
 * the gate's final write put back the report made with `keepDocumentAuthor`
 * on, and the next publish sent its `redactedTitle` (the author's name) to the
 * shared corpus. P3: a rename racing `regateMemberDocumentos` put back an old
 * `ingestId`, and the row sat in `extracting`. P4: the retry read `held`, a
 * reviewer rejected, and the retry wrote `n/a` over `rejected`.
 * `hooks/writtenOnlyWhenSent.ts`, `applyStatusReset` in `Documents.ts`. The
 * narrow write lands from another connection inside `payload.db.updateOne`:
 * after Payload read the row, before its UPDATE. No docker → SKIP.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Endpoint, Payload, PayloadRequest } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { beginPublish } from '../lib/publishDocument'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '../lib/testing/realPostgres'

if (!dockerOk) console.warn('[Documents.titleColumnsStaleWrite.pg.test] docker is not usable — these tests SKIP.')

let pg: RealPostgres
let payload: Payload
const DOC = 61

const row = async () =>
  (await rowsOf(pg.db, sql`SELECT publication_status p, anonymisation_status a, redacted_text r, held_text h,
    name n, testimonio_title tt, anonymisation_report rep, anonymisation_survivors sv, ingest_id iid,
    ingest_status i, anonymise an, extracted_text x FROM documents WHERE id = ${DOC}`))[0]!

const seed = (overrides: Record<string, string> = {}) => {
  const cols: Record<string, string> = {
    content_kind: `'testimonio'`,
    anonymise: 'true',
    publication_status: `'draft'`,
    anonymisation_status: `'ready'`,
    extracted_text: `'ORIGINAL'`,
    redacted_text: `'R'`,
    held_text: 'NULL',
    held_text_hash: 'NULL',
    ingest_status: `'ready'`,
    keep_public_figures: 'false',
    keep_document_author: 'false',
    keep_cited_authors: 'false',
    ...overrides,
  }
  return pg.db.execute(sql.raw(`
    TRUNCATE documents, memberships, organizations, users RESTART IDENTITY CASCADE;
    INSERT INTO users (id, email) VALUES (1, 'u@example.invalid'), (2, 'b@example.invalid');
    INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
    INSERT INTO memberships (user_id, organization_id, role) VALUES (1, 1, 'member'), (2, 1, 'member');
    INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, consent_held, ${Object.keys(cols).join(', ')})
    VALUES (${DOC}, 1, 1, 'antes', 'pdf', false, ${Object.values(cols).join(', ')});
  `))
}

/** `fn` with `narrow` committed from another connection between Payload's read and its write. */
async function raced<T>(narrow: string, fn: () => Promise<T>): Promise<T> {
  const db = payload.db as unknown as { updateOne: (a: { collection: string }) => Promise<unknown> }
  const real = db.updateOne.bind(db)
  const spy = vi.spyOn(db, 'updateOne').mockImplementation((async (a: { collection: string }) => {
    if (a.collection === 'documents') await pg.db.execute(sql.raw(`UPDATE documents SET ${narrow} WHERE id = ${DOC}`))
    return real(a as never)
  }) as never)
  try {
    return await fn()
  } finally {
    spy.mockRestore()
  }
}

const userDoc = async (id: number) => ({ ...(await payload.findByID({ collection: 'users', id, overrideAccess: true })), collection: 'users' })

const serverWrite = (data: Record<string, unknown>) =>
  payload.update({ collection: 'documents', id: DOC, data: data as never, overrideAccess: true, context: { __skipDocsExtract: true } })

const userWrite = async (data: Record<string, unknown>, context: Record<string, unknown> = { __skipDocsExtract: true }) =>
  payload.update({ collection: 'documents', id: DOC, data: data as never, overrideAccess: false, user: (await userDoc(1)) as never, context })

function retryEndpoint(): Endpoint {
  const found = payload.config.collections.find((c) => c.slug === 'documents')?.endpoints
  const endpoint = found ? found.find((e) => e.path === '/:id/retry') : undefined
  if (!endpoint) throw new Error('no POST /:id/retry')
  return endpoint
}

/** The retry as its uploader. Its write fires the ingest hook; `setImmediate` is held so no pipeline run outlives the test. */
async function retry(): Promise<{ status: number; body: unknown }> {
  const { createLocalReq } = await import('payload')
  const req = (await createLocalReq({ user: (await userDoc(1)) as never }, payload)) as PayloadRequest
  Object.assign(req, { routeParams: { id: String(DOC) } })
  const held = vi.spyOn(globalThis, 'setImmediate').mockImplementation((() => undefined) as never)
  try {
    const res = await retryEndpoint().handler(req)
    return { status: res.status, body: await res.json() }
  } finally {
    held.mockRestore()
  }
}

const recorder = () => {
  const sent: Array<{ corpus: string; title: string }> = []
  const client = {
    ingest: {
      enqueue: async (req: { corpus: string; documents: Array<{ title?: string }> }) => {
        sent.push({ corpus: req.corpus, title: req.documents[0]?.title ?? '' })
        return { ingestId: `i${sent.length}` }
      },
    },
    admin: { setDocumentValidity: async () => ({}) },
  }
  return { sent, client: client as never }
}

describe.skipIf(!dockerOk)('🔴 title, report and pipeline columns vs a stale whole-row write (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-title-stale-${process.pid}`, 'title_stale')
    payload = await bootPayload(pg.url, 'title-stale-secret')
  }, 120_000)
  afterEach(() => {
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await shutdown(pg, payload)
  })
  beforeEach(async () => {
    await seed({
      testimonio_title: `'TITULO-VIEJO'`,
      anonymisation_report: `'{"redactedTitle":"VIEJO","stages":[]}'::jsonb`,
      anonymisation_survivors: `'[{"start":0,"end":3,"type":"persona"}]'::jsonb`,
      ingest_id: `'ingest-viejo'`,
    })
  })

  // One per column: the concurrent narrow write stands, the rename lands.
  it.each([
    ['testimonio_title', `testimonio_title = 'TITULO-NUEVO'`, { tt: 'TITULO-NUEVO' }],
    ['anonymisation_report', `anonymisation_report = '{"redactedTitle":"NUEVO"}'::jsonb`, { rep: { redactedTitle: 'NUEVO' } }],
    ['anonymisation_survivors', `anonymisation_survivors = '[{"start":5,"end":9,"type":"lugar"}]'::jsonb`, { sv: [{ start: 5, end: 9, type: 'lugar' }] }],
    ['ingest_id', `ingest_id = 'ingest-nuevo'`, { iid: 'ingest-nuevo' }],
  ])('🔴 %s written concurrently is not written back by a rename', async (_col, narrow, expected) => {
    await raced(narrow, () => serverWrite({ name: 'despues' }))
    expect(await row()).toMatchObject({ ...expected, n: 'despues' })
  })

  // One per column: a server write that SENDS the column still writes it, over the concurrent value.
  it.each([
    ['testimonio_title', `testimonio_title = 'TITULO-NUEVO'`, { testimonioTitle: 'ENVIADO' }, { tt: 'ENVIADO' }],
    ['anonymisation_report', `anonymisation_report = '{"redactedTitle":"NUEVO"}'::jsonb`, { anonymisationReport: { redactedTitle: 'VIEJO', stages: [] } }, { rep: { redactedTitle: 'VIEJO', stages: [] } }],
    ['anonymisation_survivors', `anonymisation_survivors = '[]'::jsonb`, { anonymisationSurvivors: null }, { sv: null }],
    ['ingest_id', `ingest_id = 'ingest-nuevo'`, { ingestId: null }, { iid: null }],
  ])('control: %s sent explicitly by a server write is written', async (_col, narrow, data, expected) => {
    await raced(narrow, () => serverWrite(data))
    expect(await row()).toMatchObject(expected)
  })

  it('control: no race, a rename leaves the json columns as stored', async () => {
    await serverWrite({ name: 'despues' })
    expect(await row()).toMatchObject({
      n: 'despues',
      rep: { redactedTitle: 'VIEJO', stages: [] },
      sv: [{ start: 0, end: 3, type: 'persona' }],
    })
  })

  it('🔴 P1: a rename racing an approval does not put back the held run’s title, and no member reads it', async () => {
    await seed({ anonymisation_status: `'held'`, redacted_text: 'NULL', held_text: `'HELD'`, held_text_hash: `'hash1'`, testimonio_title: `'TITULO-DEL-RETENIDO'` })
    await raced(`anonymisation_status = 'approved', redacted_text = 'APROBADA', held_text = NULL, testimonio_title = NULL`, () =>
      userWrite({ name: 'despues' }),
    )
    await pg.db.execute(sql.raw(`UPDATE documents SET publication_status = 'published' WHERE id = ${DOC}`))
    expect(await row()).toMatchObject({ a: 'approved', tt: null, n: 'despues' })
    const seen = (await payload.findByID({ collection: 'documents', id: DOC, depth: 0, overrideAccess: false, user: (await userDoc(2)) as never })) as {
      testimonioTitle?: unknown
    }
    expect(seen.testimonioTitle ?? null).toBeNull()
  })

  it('🔴 P2: a rename racing the gate’s final write does not put back the report, and publish sends the new title', async () => {
    await seed({
      content_kind: `'documento'`,
      anonymisation_status: `'pending'`,
      redacted_text: 'NULL',
      anonymisation_report: `'{"redactedTitle":"TITULO-CON-AUTORA"}'::jsonb`,
    })
    await raced(`anonymisation_status = 'ready', redacted_text = 'REDACTADA', anonymisation_report = '{"redactedTitle":"TITULO-NUEVO"}'::jsonb`, () =>
      userWrite({ name: 'despues' }),
    )
    expect(await row()).toMatchObject({ a: 'ready', r: 'REDACTADA', rep: { redactedTitle: 'TITULO-NUEVO' } })
    const { sent, client } = recorder()
    await beginPublish((await payload.findByID({ collection: 'documents', id: DOC, depth: 0, overrideAccess: true })) as never, { payload, client })
    expect(sent.filter((s) => s.corpus === 'eco-1').map((s) => s.title)).toEqual(['TITULO-NUEVO'])
    expect(sent.some((s) => s.title.includes('CON-AUTORA'))).toBe(false)
  })

  it('P3: a rename racing regateMemberDocumentos does not put back the old ingestId', async () => {
    await seed({ content_kind: `'documento'`, anonymise: 'false', publication_status: `'published'`, anonymisation_status: `'n/a'`, redacted_text: 'NULL', ingest_id: `'OLD-INGEST'` })
    await raced(`anonymise = true, publication_status = 'draft', publish_ingest_id = NULL, ingest_id = NULL, ingest_status = 'extracting'`, () =>
      serverWrite({ name: 'despues' }),
    )
    expect(await row()).toMatchObject({ iid: null, i: 'extracting', an: true, p: 'draft' })
  })

  it("control: a USER's transcript edit that sends ingestId null writes it, over a concurrent value", async () => {
    await seed({ content_kind: `'documento'`, anonymise: 'false', anonymisation_status: `'n/a'`, redacted_text: 'NULL', ingest_id: `'OLD-INGEST'` })
    await raced(`ingest_id = 'OTRO'`, () => userWrite({ extractedText: 'TEXTO CORREGIDO', ingestId: null, ingestStatus: 'pending' }))
    expect(await row()).toMatchObject({ x: 'TEXTO CORREGIDO', iid: null, i: 'pending' })
  })

  it('🔴 a USER ingestId without a text edit (refused by field access) does not write the stale value back', async () => {
    await raced(`ingest_id = 'ingest-nuevo'`, () => userWrite({ name: 'x', ingestId: 'PUESTO-POR-USUARIO' }))
    expect(await row()).toMatchObject({ n: 'x', iid: 'ingest-nuevo' })
  })

  describe('🔴 P4: POST /:id/retry vs a newer verdict', () => {
    const HELD = { anonymisation_status: `'held'`, redacted_text: 'NULL', held_text: `'HELD'`, held_text_hash: `'hash1'`, ingest_status: `'failed'`, extracted_text: `'NUEVO'` }

    it('racing a reject: 409, the reject stands', async () => {
      await seed(HELD)
      const res = await raced(`anonymisation_status = 'rejected', held_text = NULL, redacted_text = NULL`, retry)
      expect(res.status).toBe(409)
      expect(await row()).toMatchObject({ a: 'rejected', h: null, i: 'failed' })
    })

    it('racing an approval: 409, the approval and its redaction stand', async () => {
      await seed(HELD)
      const res = await raced(`anonymisation_status = 'approved', redacted_text = 'APROBADA', held_text = NULL, held_text_hash = NULL`, retry)
      expect(res.status).toBe(409)
      expect(await row()).toMatchObject({ a: 'approved', r: 'APROBADA', i: 'failed' })
    })

    it('control: no race, the hold is cleared and the row is queued', async () => {
      await seed(HELD)
      const res = await retry()
      expect(res.status).toBe(202)
      expect(await row()).toMatchObject({ a: 'n/a', h: null, sv: null, i: 'pending', iid: null })
    })

    it('control: an approved row keeps its approval on retry', async () => {
      await seed({ ...HELD, anonymisation_status: `'approved'`, held_text: 'NULL', held_text_hash: 'NULL', redacted_text: `'APROBADA'` })
      const res = await retry()
      expect(res.status).toBe(202)
      expect(await row()).toMatchObject({ a: 'approved', r: 'APROBADA', i: 'pending' })
    })
  })

  it('🔴 M15: a text edit refused by the guarded status write (409) never starts the pipeline', async () => {
    await seed({ anonymisation_status: `'held'`, redacted_text: 'NULL', held_text: `'HELD'`, held_text_hash: `'hash1'` })
    const reads = vi.spyOn(payload, 'findByID')
    const err = await raced(`anonymisation_status = 'rejected', held_text = NULL`, () =>
      userWrite({ extractedText: 'UN TEXTO COMPLETAMENTE NUEVO Y DISTINTO' }, {}).then(() => null, (e: unknown) => e),
    )
    expect((err as { status?: number } | null)?.status).toBe(409)
    await new Promise((r) => setTimeout(r, 400))
    const pipelineReads = reads.mock.calls.filter(([a]) => (a as { collection?: string; depth?: number }).collection === 'documents' && (a as { depth?: number }).depth === 1)
    expect(pipelineReads).toEqual([])
    expect(await row()).toMatchObject({ a: 'rejected', x: 'ORIGINAL' })
  })
})
