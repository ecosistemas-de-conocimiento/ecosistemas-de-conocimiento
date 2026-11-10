/**
 * 🔴 `scripts/refresh-ai-titles.ts` — AGAINST A REAL POSTGRES, with a fake
 * ai-service that holds titles per (corpus, externalId).
 *
 *   · selection: published gated documentos and testimonios only; never a
 *     consent-held row, never a draft (ecosistema 8's included), never an
 *     ungated documento or a revision;
 *   · a dry run writes nothing; apply rewrites only the stale copies, shared
 *     and draft; a second apply writes nothing.
 *
 * Harness: `lib/testing/realPostgres` (migrations only, no Payload boot).
 */

import { sql } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { refreshAiTitles, selectTitleRows, type TitlesClient } from './refreshAiTitles'
import { dockerOk, startRealPostgres, type RealPostgres } from './testing/realPostgres'

let pg: RealPostgres
const run = (s: string) => pg.db.execute(sql.raw(s))

/** ai-service as far as titles go: corpus → externalId → title. */
function fakeAi(seed: Record<string, Record<string, string>>) {
  const store = new Map(Object.entries(seed).map(([c, docs]) => [c, new Map(Object.entries(docs))]))
  const calls: Array<{ corpus: string; ids: string[]; dryRun: boolean }> = []
  const client: TitlesClient = {
    async setDocumentTitles(corpus, documents, opts) {
      const dryRun = opts?.dryRun === true
      calls.push({ corpus, ids: documents.map((d) => d.externalId), dryRun })
      const docs = store.get(corpus)
      if (!docs) throw Object.assign(new Error('corpus not found'), { status: 404 })
      const out = { documents: [] as Array<{ externalId: string; changed: boolean; chunksChanged: number }>, notFound: [] as string[] }
      for (const d of documents) {
        if (!docs.has(d.externalId)) {
          out.notFound.push(d.externalId)
          continue
        }
        const changed = docs.get(d.externalId) !== d.title
        if (changed && !dryRun) docs.set(d.externalId, d.title)
        out.documents.push({ externalId: d.externalId, changed, chunksChanged: changed ? 2 : 0 })
      }
      return out
    },
  }
  return { client, store, calls }
}

describe.skipIf(!dockerOk)('refresh ai-service titles', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-refresh-titles-${process.pid}`, 'refresh_titles')
  }, 120_000)

  afterAll(async () => {
    await (pg?.db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    pg?.stop()
  })

  beforeEach(async () => {
    await run(`
      TRUNCATE documents, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES (1, 'a@example.invalid', false), (2, 'b@example.invalid', false);
      INSERT INTO organizations (id, name, slug) VALUES (6, 'Seis', 'seis'), (8, 'Ocho', 'ocho');
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, content_kind, anonymise, publication_status, consent_held, anonymisation_report) VALUES
        (101, 6, 1, 'Entrevista Persona Real.pdf', 'pdf', 'documento', true,  'published', false, NULL),
        (102, 6, 1, 'Otra Persona.pdf',            'pdf', 'documento', true,  'published', false, '{"redactedTitle":"Entrevista a [Persona A].pdf"}'),
        (103, 6, 2, 'Libro abierto.pdf',           'pdf', 'documento', false, 'published', false, NULL),
        (104, 6, 2, 'Voz de alguien.mp3',          'audio', 'testimonio', false, 'published', false, NULL),
        (105, 6, 1, 'Retenido.pdf',                'pdf', 'documento', true,  'published', true,  NULL),
        (106, 6, 1, 'Borrador.pdf',                'pdf', 'documento', true,  'draft',     false, NULL),
        (801, 8, 1, 'Taller borrador.pdf',         'pdf', 'documento', true,  'draft',     false, NULL),
        (802, 8, 1, 'Taller publicado.pdf',        'pdf', 'documento', true,  'published', false, NULL);
    `)
  }, 60_000)

  it('selects published gated documentos and testimonios; never consent-held rows or drafts', async () => {
    const rows = await selectTitleRows(pg.db)
    expect(rows.map((r) => r.id)).toEqual([101, 102, 104, 802])
    expect((await selectTitleRows(pg.db, 8)).map((r) => r.id)).toEqual([802])
  })

  it('dry run writes nothing; apply rewrites only stale copies; a second apply writes nothing', async () => {
    const ai = fakeAi({
      'eco-6': {
        '101': 'Entrevista Persona Real.pdf', // stale
        '102': 'Entrevista a [Persona A].pdf', // already right
        '104': 'Testimonio', // already right
        '105': 'Retenido.pdf', // held: must stay as is
      },
      'eco-6-draft-1': { '101': 'Entrevista Persona Real.pdf', '102': 'Otra Persona.pdf', '106': 'Borrador.pdf' },
      // no eco-6-draft-2: that uploader's draft corpus was never created
      'eco-8': { '802': 'Taller publicado.pdf' },
      'eco-8-draft-1': { '801': 'Taller borrador.pdf', '802': 'Taller publicado.pdf' },
    })
    const before = JSON.stringify([...ai.store].map(([c, d]) => [c, [...d]]))
    const opts = { clientFor: () => ai.client, sleep: async () => undefined }

    const dry = await refreshAiTitles(pg.db, { ...opts, apply: false })
    expect(JSON.stringify([...ai.store].map(([c, d]) => [c, [...d]]))).toBe(before)
    expect(ai.calls.every((c) => c.dryRun)).toBe(true)
    expect(dry.written).toEqual([])
    expect(dry.corpora.flatMap((c) => c.changed).sort()).toEqual([101, 101, 102, 802, 802])
    expect(dry.corpora.find((c) => c.organizationId === 6 && c.copy === 'draft' && c.missingCorpus)).toBeTruthy()
    // Held and draft rows are never even sent.
    expect(ai.calls.flatMap((c) => c.ids)).not.toContain('105')
    expect(ai.calls.flatMap((c) => c.ids)).not.toContain('106')
    expect(ai.calls.flatMap((c) => c.ids)).not.toContain('801')

    ai.calls.length = 0
    const applied = await refreshAiTitles(pg.db, { ...opts, apply: true })
    expect(applied.written.sort()).toEqual([101, 101, 102, 802, 802])
    // Only the stale ids go in a write call.
    for (const c of ai.calls.filter((x) => !x.dryRun)) {
      for (const id of c.ids) expect(['101', '102', '802']).toContain(id)
    }
    expect(ai.calls.find((c) => !c.dryRun && c.corpus === 'eco-6')?.ids).toEqual(['101'])
    expect(ai.store.get('eco-6')!.get('101')).toBe('Documento')
    expect(ai.store.get('eco-6-draft-1')!.get('102')).toBe('Entrevista a [Persona A].pdf')
    expect(ai.store.get('eco-6')!.get('105')).toBe('Retenido.pdf')
    expect(ai.store.get('eco-6-draft-1')!.get('106')).toBe('Borrador.pdf')
    expect(ai.store.get('eco-8-draft-1')!.get('801')).toBe('Taller borrador.pdf')
    expect(ai.store.get('eco-8')!.get('802')).toBe('Documento')

    ai.calls.length = 0
    const again = await refreshAiTitles(pg.db, { ...opts, apply: true })
    expect(again.written).toEqual([])
    expect(ai.calls.every((c) => c.dryRun)).toBe(true)
  })

  it('batches and paces: one pause per call', async () => {
    const ai = fakeAi({ 'eco-6': { '101': 'x', '102': 'x', '104': 'x' }, 'eco-6-draft-1': {}, 'eco-6-draft-2': {}, 'eco-8': {}, 'eco-8-draft-1': {} })
    let pauses = 0
    await refreshAiTitles(pg.db, {
      apply: false,
      batchSize: 1,
      delayMs: 5,
      clientFor: () => ai.client,
      sleep: async () => void pauses++,
    })
    expect(ai.calls.filter((c) => c.corpus === 'eco-6').map((c) => c.ids)).toEqual([['101'], ['102'], ['104']])
    expect(pauses).toBe(ai.calls.length)
  })
})
