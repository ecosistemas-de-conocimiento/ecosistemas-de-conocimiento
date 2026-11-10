/**
 * 🔴 A "PUBLICAR CAMBIOS" REVISION OF A HELD NOTE IS HELD TOO — AGAINST A REAL
 * POSTGRES (audit 2026-11-10, A1).
 *
 * A revision (`revisionOf`, `lib/studentNotes.ts`) is hidden staging that
 * `promoteRevision` later swaps over the note. Each helper of
 * `lib/consentHold.ts` answers for the original; the ingest hook,
 * `enqueueIngestForDoc`, `scheduleGraphExtractionForDoc` and `publishBlocker`
 * refuse the revision of a held note and let the revision of a free one through.
 *
 * Harness: `lib/testing/realPostgres`.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ai = vi.hoisted(() => ({
  enqueue: vi.fn(async () => ({ ingestId: 'fake-ingest' })),
  setDocumentValidity: vi.fn(async () => ({})),
}))
vi.mock('@/lib/aiClient', () => {
  const client = {
    ingest: { enqueue: ai.enqueue },
    admin: { setDocumentValidity: ai.setDocumentValidity, deleteDocument: vi.fn(async () => ({})) },
  }
  return { getAdminAIClient: () => client, getAppAIClient: () => client }
})

import {
  holdForConsent,
  isConsentHeld,
  isConsentHeldNow,
  NOT_CONSENT_HELD,
  notConsentHeldSql,
  readConsentHeld,
} from '@/lib/consentHold'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

let pg: RealPostgres
let payload: Payload
const run = (s: string) => pg.db.execute(sql.raw(s))
const row = async (id: number) =>
  (await rowsOf(pg.db, sql`SELECT ingest_status, ingest_id, graph_status FROM documents WHERE id = ${id}`))[0]
const settle = () => new Promise((r) => setTimeout(r, 400))

// 71 a held published note, 72 its revision; 73 a free published note, 74 its revision.
const HELD_REVISION = 72
const FREE_REVISION = 74

describe.skipIf(!dockerOk)('a revision of a consent-held note is held', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-consent-revision-${process.pid}`, 'consent_revision')
    payload = await bootPayload(pg.url, 'consent-revision-secret')
    process.env.AI_SERVICE_CALLBACK_SECRET ??= 'x'
  }, 120_000)

  beforeEach(async () => {
    ai.enqueue.mockClear()
    await run(`
      TRUNCATE documents, media, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES (1, 'member@example.invalid', false);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES (1, 1, 1, 'member');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise,
                             anonymisation_status, extracted_text, body_markdown, name, ingest_status, ingest_id,
                             consent_held, revision_of_id)
        VALUES (71, 1, 1, 'published', 'markdown', 'documento', false, 'n/a', 'NOTA', 'NOTA', 'nota', 'ready', 'i-71', true, NULL),
               (72, 1, 1, 'draft', 'markdown', 'documento', false, 'n/a', 'NOTA NUEVA', 'NOTA NUEVA', 'nota', 'ready', 'i-72', false, 71),
               (73, 1, 1, 'published', 'markdown', 'documento', false, 'n/a', 'LIBRE', 'LIBRE', 'libre', 'ready', 'i-73', false, NULL),
               (74, 1, 1, 'draft', 'markdown', 'documento', false, 'n/a', 'LIBRE NUEVA', 'LIBRE NUEVA', 'libre', 'ready', 'i-74', false, 73);
    `)
    await run(`SELECT setval(pg_get_serial_sequence('documents', 'id'), 1000)`)
  }, 60_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('isConsentHeld: a populated original or the flag decides; an original known only by id holds (fail closed)', () => {
    expect(isConsentHeld({ consentHeld: false, revisionOf: { id: 71, consentHeld: true } })).toBe(true)
    expect(isConsentHeld({ consentHeld: false, revisionOf: { id: 73, consentHeld: false } })).toBe(false)
    expect(isConsentHeld({ consentHeld: false, revisionOf: 71, revisionOfConsentHeld: true })).toBe(true)
    expect(isConsentHeld({ consentHeld: false, revisionOf: 73, revisionOfConsentHeld: false })).toBe(false)
    expect(isConsentHeld({ consentHeld: false, revisionOf: 73 })).toBe(true)
    expect(isConsentHeld({ consentHeld: false, revisionOf: { id: 73 } })).toBe(true)
    expect(isConsentHeld({ consentHeld: false, revisionOf: null })).toBe(false)
  })

  it('isConsentHeldNow and readConsentHeld read the original', async () => {
    const at = async (id: number) =>
      (await payload.findByID({ collection: 'documents', id, depth: 0, overrideAccess: true })) as never
    expect(await isConsentHeldNow(payload, await at(HELD_REVISION))).toBe(true)
    expect(await isConsentHeldNow(payload, await at(FREE_REVISION))).toBe(false)
    expect(await readConsentHeld(payload, HELD_REVISION)).toBe(true)
    expect(await readConsentHeld(payload, FREE_REVISION)).toBe(false)
    expect(await readConsentHeld(payload, 71)).toBe(true)
    expect(await readConsentHeld(payload, 73)).toBe(false)
  })

  it('NOT_CONSENT_HELD (server read) and notConsentHeldSql leave out the held note and its revision only', async () => {
    const found = await payload.find({
      collection: 'documents',
      where: NOT_CONSENT_HELD,
      depth: 0,
      pagination: false,
      overrideAccess: true,
      sort: 'id',
    })
    expect(found.docs.map((d) => d.id)).toEqual([73, FREE_REVISION])
    const viaSql = await rowsOf(pg.db, sql`SELECT d.id FROM documents d WHERE ${sql.raw(notConsentHeldSql('d'))} ORDER BY d.id`)
    expect(viaSql.map((r) => r.id)).toEqual([73, FREE_REVISION])
    const unaliased = await rowsOf(pg.db, sql`SELECT id FROM documents WHERE ${sql.raw(notConsentHeldSql())} ORDER BY id`)
    expect(unaliased.map((r) => r.id)).toEqual([73, FREE_REVISION])
  })

  it('holdForConsent reports the revisions of what it holds, and writes only the original', async () => {
    await run(`UPDATE documents SET consent_held = false WHERE id = 71`)
    const report = await holdForConsent(pg.db, { organizationId: 1, ids: [71, 73] }, { apply: true })
    expect(report.revisions).toEqual([HELD_REVISION, FREE_REVISION])
    expect(report.held).toBe(2)
    const flags = await rowsOf(pg.db, sql`SELECT id, consent_held FROM documents ORDER BY id`)
    expect(flags.filter((r) => r.consent_held).map((r) => r.id)).toEqual([71, 73])
  })

  it('the ingest hook: a server save that re-runs the revision of a held note sends nothing; a free one is sent', async () => {
    for (const id of [HELD_REVISION, FREE_REVISION]) {
      await run(`UPDATE documents SET ingest_status = 'failed', ingest_id = NULL WHERE id = ${id}`)
      await payload.update({
        collection: 'documents',
        id,
        overrideAccess: true,
        data: { ingestStatus: 'pending', ingestError: null } as never,
      })
    }
    await vi.waitFor(() => expect(ai.enqueue).toHaveBeenCalled(), { timeout: 10_000 })
    await settle()
    expect(ai.enqueue).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(ai.enqueue.mock.calls)).not.toContain('NOTA NUEVA')
    expect((await row(HELD_REVISION))?.ingest_status).toBe('pending')
  })

  it('enqueueIngestForDoc with a slice that does not carry revisionOf still refuses the revision', async () => {
    await run(`UPDATE documents SET ingest_status = 'extracting', ingest_id = NULL WHERE id = ${HELD_REVISION}`)
    const { enqueueIngestForDoc } = await import('./Documents')
    await enqueueIngestForDoc({
      payload,
      docId: HELD_REVISION,
      organizationId: 1,
      uploadedById: 1,
      fresh: { name: 'nota', kind: 'markdown', contentKind: 'documento', anonymise: false, anonymisationStatus: 'n/a' },
      extractedText: 'NOTA NUEVA',
    })
    expect(await row(HELD_REVISION)).toMatchObject({ ingest_status: 'extracting', ingest_id: null })
    expect(ai.enqueue).not.toHaveBeenCalled()
  })

  it('scheduleGraphExtractionForDoc writes nothing for the revision', async () => {
    const { scheduleGraphExtractionForDoc } = await import('./Documents')
    await scheduleGraphExtractionForDoc({ payload, docId: HELD_REVISION, organizationId: 1, fresh: { name: 'nota', contentKind: 'documento' } })
    expect((await row(HELD_REVISION))?.graph_status).toBe('n/a')
  })

  it('publishBlocker: the revision of a held note is consent-held; of a free one, not', async () => {
    const { publishBlocker } = await import('@/lib/publishDocument')
    expect(await publishBlocker({ id: HELD_REVISION } as never, payload)).toBe('consent-held')
    expect(await publishBlocker({ id: FREE_REVISION } as never, payload)).toBeNull()
  })
})
