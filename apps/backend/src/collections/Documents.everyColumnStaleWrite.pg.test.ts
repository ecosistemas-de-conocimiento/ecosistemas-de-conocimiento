/**
 * 🔴 A WHOLE-ROW `payload.update` NEVER WRITES ANY `documents` FIELD BACK FROM
 * A STALE READ, on a real Payload + Postgres (audit 2026-11-12, sweep).
 *
 * C1c: a rename that read gate run A's claim put A's token back in
 * `anonymisationError` after run B claimed on an edited text; A's final write
 * landed, B's missed, and the next publish sent A's verdict on the text the
 * author had removed. C3: a rename racing a text edit put the old
 * `extractedText` back, and the next publish sent it. The sweep found the same
 * on every column without the rule, and on the `session` attachments.
 * `everyFieldWrittenOnlyWhenSent` in `hooks/writtenOnlyWhenSent.ts`. The narrow
 * write lands from another connection inside `payload.db.updateOne`: after
 * Payload read the row, before its UPDATE. No docker → SKIP.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { Documents } from './Documents'
import { updateDocumentColumns } from '../lib/documentColumns'
import { beginPublish } from '../lib/publishDocument'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '../lib/testing/realPostgres'

if (!dockerOk) console.warn('[Documents.everyColumnStaleWrite.pg.test] docker is not usable — these tests SKIP.')

let pg: RealPostgres
let payload: Payload
const DOC = 61

const seed = (overrides: Record<string, string> = {}) => {
  const cols: Record<string, string> = {
    content_kind: `'documento'`,
    anonymise: 'true',
    publication_status: `'draft'`,
    anonymisation_status: `'ready'`,
    extracted_text: `'ORIGINAL'`,
    redacted_text: `'R'`,
    ingest_status: `'ready'`,
    keep_public_figures: 'false',
    keep_document_author: 'false',
    keep_cited_authors: 'false',
    is_pinned: 'true',
    mode: `'full-text'`,
    graph_status: `'ready'`,
    transcribe_attempt: '0',
    ...overrides,
  }
  return pg.db.execute(sql.raw(`
    TRUNCATE documents, documents_rels, memberships, sessions, media, organizations, users RESTART IDENTITY CASCADE;
    INSERT INTO users (id, email) VALUES (1, 'u@example.invalid'), (2, 'b@example.invalid');
    INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno'), (2, 'Dos', 'dos');
    INSERT INTO memberships (user_id, organization_id, role) VALUES (1, 1, 'member'), (2, 1, 'member');
    INSERT INTO sessions (id, user_id, organization_id) VALUES (1, 1, 1), (2, 1, 1), (3, 1, 1);
    INSERT INTO media (id) VALUES (1);
    INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, consent_held, ${Object.keys(cols).join(', ')})
    VALUES (${DOC}, 1, 1, 'antes', 'pdf', false, ${Object.values(cols).join(', ')});
    INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, consent_held) VALUES (62, 1, 1, 'otro', 'markdown', false);
    INSERT INTO documents_rels ("order", parent_id, path, sessions_id) VALUES (1, ${DOC}, 'session', 1);
  `))
}

/** `fn` with `narrow` (whole statements) committed from another connection between Payload's read and its write. */
async function raced<T>(narrow: string, fn: () => Promise<T>): Promise<T> {
  const db = payload.db as unknown as { updateOne: (a: { collection: string }) => Promise<unknown> }
  const real = db.updateOne.bind(db)
  const spy = vi.spyOn(db, 'updateOne').mockImplementation((async (a: { collection: string }) => {
    if (a.collection === 'documents') await pg.db.execute(sql.raw(narrow))
    return real(a as never)
  }) as never)
  try {
    return await fn()
  } finally {
    spy.mockRestore()
  }
}

const set = (assignments: string) => `UPDATE documents SET ${assignments} WHERE id = ${DOC}`

const userDoc = async (id: number) => ({ ...(await payload.findByID({ collection: 'users', id, overrideAccess: true })), collection: 'users' })
const serverWrite = (data: Record<string, unknown>) =>
  payload.update({ collection: 'documents', id: DOC, data: data as never, overrideAccess: true, context: { __skipDocsExtract: true } })
const userWrite = async (data: Record<string, unknown>) =>
  payload.update({ collection: 'documents', id: DOC, data: data as never, overrideAccess: false, user: (await userDoc(1)) as never, context: { __skipDocsExtract: true } })

const val = async (expr: string) => (await rowsOf(pg.db, sql.raw(`SELECT (${expr})::text v FROM documents WHERE id = ${DOC}`)))[0]?.v ?? null
const sessions = async () =>
  (await rowsOf(pg.db, sql.raw(`SELECT coalesce(string_agg(sessions_id::text, ',' ORDER BY sessions_id), '') s FROM documents_rels WHERE parent_id = ${DOC} AND path = 'session'`)))[0]?.s

const publish = async () => {
  const sent: Array<{ corpus: string; text: string; title: string }> = []
  const client = {
    ingest: {
      enqueue: async (req: { corpus: string; documents: Array<{ title?: string; text?: string }> }) => {
        sent.push({ corpus: req.corpus, text: req.documents[0]?.text ?? '', title: req.documents[0]?.title ?? '' })
        return { ingestId: `i${sent.length}` }
      },
    },
    admin: { setDocumentValidity: async () => ({}), deleteDocument: async () => ({}) },
  }
  await beginPublish((await payload.findByID({ collection: 'documents', id: DOC, depth: 0, overrideAccess: true })) as never, { payload, client: client as never })
  return sent
}

/**
 * Per field: [seed overrides, the concurrent narrow write, a SQL expression, its
 * expected value: the concurrent write's, but for the two excluded columns]. Each is raced against a rename (and
 * `name` against an `isPinned` toggle, `session` in its own test).
 */
const COLUMNS: Record<string, [Record<string, string>, string, string, string]> = {
  // Excluded (immutable, NOT NULL without a default): a stale write puts the value read back.
  organization: [{}, `organization_id = 2`, 'organization_id', '1'],
  uploadedBy: [{}, `uploaded_by_id = 2`, 'uploaded_by_id', '1'],
  publicationStatus: [{}, `publication_status = 'publishing'`, 'publication_status', 'publishing'],
  publicationError: [{}, `publication_error = 'E'`, 'publication_error', 'E'],
  publishIngestId: [{}, `publish_ingest_id = 'p1'`, 'publish_ingest_id', 'p1'],
  uploadedInSession: [{}, `uploaded_in_session_id = 2`, 'uploaded_in_session_id', '2'],
  kind: [{}, `kind = 'docx'`, 'kind', 'docx'],
  contentKind: [{}, `content_kind = 'testimonio'`, 'content_kind', 'testimonio'],
  anonymise: [{}, `anonymise = false`, 'anonymise', 'false'],
  keepPublicFigures: [{}, `keep_public_figures = true`, 'keep_public_figures', 'true'],
  keepDocumentAuthor: [{}, `keep_document_author = true`, 'keep_document_author', 'true'],
  keepCitedAuthors: [{}, `keep_cited_authors = true`, 'keep_cited_authors', 'true'],
  tema: [{}, `tema = 'T'`, 'tema', 'T'],
  lengua: [{ lengua: `'L0'` }, `lengua = NULL`, `coalesce(lengua, 'NULL')`, 'NULL'],
  redactedText: [{}, `redacted_text = 'NUEVO'`, 'redacted_text', 'NUEVO'],
  testimonioTitle: [{}, `testimonio_title = 'TT'`, 'testimonio_title', 'TT'],
  heldText: [{}, `held_text = 'H'`, 'held_text', 'H'],
  heldTextHash: [{}, `held_text_hash = 'hh'`, 'held_text_hash', 'hh'],
  anonymisationSurvivors: [{}, `anonymisation_survivors = '[{"start":1,"end":2}]'::jsonb`, `anonymisation_survivors->0->>'end'`, '2'],
  publicFiguresKept: [{}, `public_figures_kept = '[{"name":"N"}]'::jsonb`, `public_figures_kept->0->>'name'`, 'N'],
  authorsKept: [{}, `authors_kept = '[{"name":"N"}]'::jsonb`, `authors_kept->0->>'name'`, 'N'],
  citedAuthorsKept: [{}, `cited_authors_kept = '[{"name":"N"}]'::jsonb`, `cited_authors_kept->0->>'name'`, 'N'],
  anonymisationStatus: [{}, `anonymisation_status = 'held'`, 'anonymisation_status', 'held'],
  anonymisationError: [{ anonymisation_error: `'tokA'` }, `anonymisation_error = 'tokB'`, 'anonymisation_error', 'tokB'],
  anonymisationReport: [{}, `anonymisation_report = '{"k":1}'::jsonb`, `anonymisation_report->>'k'`, '1'],
  mode: [{}, `mode = 'rag-retrieve'`, 'mode', 'rag-retrieve'],
  bodyMarkdown: [{ body_markdown: `'B0'` }, `body_markdown = 'B1'`, 'body_markdown', 'B1'],
  processedBody: [{ processed_body: `'P0'` }, `processed_body = 'P1'`, 'processed_body', 'P1'],
  revisionOf: [{}, `revision_of_id = 62`, 'revision_of_id', '62'],
  reindexIngestId: [{ reindex_ingest_id: `'r0'` }, `reindex_ingest_id = NULL`, `coalesce(reindex_ingest_id, 'NULL')`, 'NULL'],
  mediaFile: [{}, `media_file_id = 1`, 'media_file_id', '1'],
  isPinned: [{}, `is_pinned = false`, 'is_pinned', 'false'],
  ingestStatus: [{}, `ingest_status = 'failed'`, 'ingest_status', 'failed'],
  ingestError: [{}, `ingest_error = 'E'`, 'ingest_error', 'E'],
  ingestId: [{ ingest_id: `'i0'` }, `ingest_id = 'i9'`, 'ingest_id', 'i9'],
  graphStatus: [{}, `graph_status = 'skipped'`, 'graph_status', 'skipped'],
  graphError: [{}, `graph_error = 'E'`, 'graph_error', 'E'],
  graphPromptVersion: [{ graph_prompt_version: `'v1'` }, `graph_prompt_version = NULL`, `coalesce(graph_prompt_version, 'NULL')`, 'NULL'],
  wikiLinks: [{ wiki_links: `'[{"t":"X"}]'::jsonb` }, `wiki_links = NULL`, `coalesce(wiki_links::text, 'NULL')`, 'NULL'],
  graphExtractedAt: [{}, `graph_extracted_at = '2026-11-12T10:00:00Z'`, `(graph_extracted_at IS NOT NULL)`, 'true'],
  transcribeId: [{ transcribe_id: `'t0'` }, `transcribe_id = 't1'`, 'transcribe_id', 't1'],
  transcribeAttempt: [{}, `transcribe_attempt = 3`, 'transcribe_attempt', '3'],
  audioMeta: [{}, `audio_meta = '{"durationSeconds":9}'::jsonb`, `audio_meta->>'durationSeconds'`, '9'],
  extractedText: [{}, `extracted_text = 'EDITADO'`, 'extracted_text', 'EDITADO'],
  name: [{}, `name = 'NUEVO'`, 'name', 'NUEVO'],
  consentHeld: [{}, `consent_held = true`, 'consent_held', 'true'],
}

/** The stale write: a rename, or an `isPinned` toggle when the raced field is `name`. */
const staleWrite = (field: string) => (field === 'name' ? { isPinned: false } : { name: 'despues' })

describe.skipIf(!dockerOk)('🔴 every documents field vs a stale whole-row write (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-every-col-${process.pid}`, 'every_col')
    payload = await bootPayload(pg.url, 'every-col-secret')
  }, 120_000)
  afterEach(() => {
    vi.restoreAllMocks()
  })
  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('the table names every stored field of the collection, so a new field fails here until it is raced', () => {
    const stored = Documents.fields
      .filter((f) => 'name' in f && !('virtual' in f && f.virtual))
      .map((f) => (f as { name: string }).name)
      // `session` has its own test; Payload adds the timestamps (and `id`) to the config it sanitizes.
      .filter((n) => !['session', 'id', 'createdAt', 'updatedAt'].includes(n))
    expect(Object.keys(COLUMNS).sort()).toEqual(stored.sort())
  })

  for (const [field, [over, narrow, expr, stood]] of Object.entries(COLUMNS)) {
    for (const who of ['user', 'server'] as const) {
      it(`${field}: a concurrent write vs a ${who}'s stale write, which still lands`, async () => {
        await seed(over)
        const data = staleWrite(field)
        await raced(set(narrow), () => (who === 'user' ? userWrite(data) : serverWrite(data)))
        expect(await val(expr)).toBe(stood)
        if (field === 'name') expect(await val('is_pinned')).toBe('false')
        else expect(await val('name')).toBe('despues')
      })
    }
  }

  it('session: a concurrent detach and a concurrent attach stand against a stale rename', async () => {
    for (const who of ['user', 'server'] as const) {
      await seed()
      await raced(`DELETE FROM documents_rels WHERE parent_id = ${DOC}`, () => (who === 'user' ? userWrite({ name: 'despues' }) : serverWrite({ name: 'despues' })))
      expect(await sessions(), `${who} detach`).toBe('')
      await seed()
      await raced(`INSERT INTO documents_rels ("order", parent_id, path, sessions_id) VALUES (2, ${DOC}, 'session', 2)`, () =>
        who === 'user' ? userWrite({ name: 'despues' }) : serverWrite({ name: 'despues' }),
      )
      expect(await sessions(), `${who} attach`).toBe('1,2')
      expect(await val('name')).toBe('despues')
    }
  })

  it('control: a user attach and detach, and a rename and a text edit, still write', async () => {
    await seed({ anonymise: 'false', anonymisation_status: `'n/a'`, redacted_text: 'NULL' })
    await userWrite({ session: [1, 3] })
    expect(await sessions()).toBe('1,3')
    await userWrite({ session: [3] })
    expect(await sessions()).toBe('3')
    await userWrite({ name: 'otro nombre' })
    expect(await val('name')).toBe('otro nombre')
    await serverWrite({ extractedText: 'TEXTO NUEVO' })
    expect(await val('extracted_text')).toBe('TEXTO NUEVO')
  })

  it('control: a server or user write that sends `session` still writes, with the NOT NULL columns in its row', async () => {
    // A `hasMany` value goes out as INSERT … ON CONFLICT DO UPDATE: `organization` and `uploadedBy` must be in it.
    await seed()
    await serverWrite({ session: [1, 2] })
    expect(await sessions()).toBe('1,2')
    await raced(set(`graph_status = 'skipped'`), () => userWrite({ session: [1, 3], isPinned: false }))
    expect(await sessions()).toBe('1,3')
    expect(await val('graph_status')).toBe('skipped')
    expect(await val('organization_id')).toBe('1')
  })

  it('control: a server write that SENDS the value it read still writes it over a concurrent change', async () => {
    await seed()
    await raced(set(`graph_status = 'skipped', extracted_text = 'EDITADO'`), () => serverWrite({ graphStatus: 'ready', extractedText: 'ORIGINAL' }))
    expect(await val('graph_status')).toBe('ready')
    expect(await val('extracted_text')).toBe('ORIGINAL')
  })

  it("C1c: a rename that read run A's claim, written after run B claimed on an edited text, never lets A's verdict reach eco-1", async () => {
    for (const who of ['user', 'server'] as const) {
      await seed({ anonymisation_status: `'pending'`, anonymisation_error: `'gate_running: tokA'`, redacted_text: 'NULL', anonymisation_report: 'NULL' })
      await raced(set(`extracted_text = 'EDITADO', anonymisation_status = 'pending', anonymisation_error = 'gate_running: tokB'`), () =>
        who === 'user' ? userWrite({ name: 'despues' }) : serverWrite({ name: 'despues' }),
      )
      expect(await val('anonymisation_error')).toBe('gate_running: tokB')
      const report = { settings: { keepDocumentAuthor: false, keepCitedAuthors: false, keepPublicFigures: false }, redactedTitle: 'T' }
      // Run A's and run B's final writes, as `finish` in lib/anonymiseDocument.ts: guarded on pending + the run's token.
      const finish = (token: string, text: string) =>
        updateDocumentColumns(payload as never, {
          id: DOC,
          data: { anonymisationStatus: 'ready', anonymisationError: null, redactedText: text, anonymisationReport: report },
          where: [{ anonymisationStatus: { equals: 'pending' } }, { anonymisationError: { equals: `gate_running: ${token}` } }] as never,
        })
      expect(await finish('tokA', 'REDACTADO DEL ORIGINAL')).toBe(0)
      expect(await finish('tokB', 'TEXTO DE B')).toBe(1)
      const eco = (await publish()).filter((s) => s.corpus === 'eco-1')
      expect(eco.map((s) => s.text)).toEqual(['TEXTO DE B'])
      expect(await val('extracted_text')).toBe('EDITADO')
    }
  })

  it('C3: a rename racing a text edit on a non-gated documento never puts the removed text back, nor sends it to eco-1', async () => {
    for (const who of ['user', 'server'] as const) {
      await seed({ anonymise: 'false', anonymisation_status: `'n/a'`, redacted_text: 'NULL', extracted_text: `'ORIGINAL CON PARRAFO RETIRADO'` })
      await raced(set(`extracted_text = 'EDITADO'`), () => (who === 'user' ? userWrite({ name: 'despues' }) : serverWrite({ name: 'despues' })))
      expect(await val('extracted_text')).toBe('EDITADO')
      const eco = (await publish()).filter((s) => s.corpus === 'eco-1')
      expect(eco.map((s) => s.text)).toEqual(['EDITADO'])
    }
  })
})
