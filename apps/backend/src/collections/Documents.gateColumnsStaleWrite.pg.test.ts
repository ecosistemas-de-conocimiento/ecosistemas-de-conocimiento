/**
 * 🔴 A WHOLE-ROW `payload.update` NEVER WRITES A GATE OR PUBLICATION COLUMN
 * BACK FROM A STALE READ, on a real Payload + Postgres (audit 2026-11-11).
 *
 * Payload fills every field the caller did not send with the value it READ,
 * and writes them all. A reviewer's reject (`rejectPublished`) that committed
 * between that read and the write was undone: the row went back to
 * `published` / `ready` with the rejected `redactedText`, and the next publish
 * shared it. `hooks/writtenOnlyWhenSent.ts`. The narrow write lands from
 * another connection inside `payload.db.updateOne`: after Payload read the
 * row, before its UPDATE. Harness: `lib/testing/realPostgres`. No docker → SKIP.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { beginPublish, NotPublishableError } from '../lib/publishDocument'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '../lib/testing/realPostgres'

if (!dockerOk) console.warn('[Documents.gateColumnsStaleWrite.pg.test] docker is not usable — these tests SKIP.')

let pg: RealPostgres
let payload: Payload
const DOC = 61

const row = async () =>
  (await rowsOf(pg.db, sql`SELECT publication_status p, anonymisation_status a, redacted_text r, held_text h,
    held_text_hash hh, name n FROM documents WHERE id = ${DOC}`))[0]!

/** `payload.update(data)` with `narrow` committed from another connection between its read and its write. */
const raced = async (narrow: string, data: Record<string, unknown> = { name: 'despues' }) => {
  const db = payload.db as unknown as { updateOne: (a: { collection: string }) => Promise<unknown> }
  const real = db.updateOne.bind(db)
  const spy = vi.spyOn(db, 'updateOne').mockImplementation((async (a: { collection: string }) => {
    if (a.collection === 'documents') await pg.db.execute(sql.raw(`UPDATE documents SET ${narrow} WHERE id = ${DOC}`))
    return real(a as never)
  }) as never)
  try {
    await payload.update({ collection: 'documents', id: DOC, data: data as never, overrideAccess: true, context: { __skipDocsExtract: true } })
  } finally {
    spy.mockRestore()
  }
  return row()
}

const recorder = () => {
  const sent: Array<{ corpus: string; text: string }> = []
  const client = {
    ingest: {
      enqueue: async (req: { corpus: string; documents: Array<{ text: string }> }) => {
        sent.push({ corpus: req.corpus, text: req.documents[0]!.text })
        return { ingestId: `i${sent.length}` }
      },
    },
    admin: { setDocumentValidity: async () => ({}) },
  }
  return { sent, client: client as never }
}

describe.skipIf(!dockerOk)('🔴 gate and publication columns vs a stale whole-row write (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-gate-stale-${process.pid}`, 'gate_stale')
    payload = await bootPayload(pg.url, 'gate-stale-secret')
  }, 120_000)
  afterAll(async () => {
    await shutdown(pg, payload)
  })
  beforeEach(async () => {
    await pg.db.execute(sql.raw(`
      TRUNCATE documents, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, 'u@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (user_id, organization_id, role) VALUES (1, 1, 'member');
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, content_kind, publication_status,
                             anonymisation_status, consent_held, anonymise, extracted_text, redacted_text, ingest_status)
      VALUES (${DOC}, 1, 1, 'antes', 'pdf', 'testimonio', 'published', 'ready', false, true, 'ORIGINAL', 'REDACCION', 'ready');
    `))
  })

  // One per column: the concurrent narrow write stands, the rename lands.
  it.each([
    ['publication_status', `publication_status = 'unpublishing'`, { p: 'unpublishing' }],
    ['anonymisation_status', `anonymisation_status = 'rejected'`, { a: 'rejected' }],
    ['redacted_text', `redacted_text = NULL`, { r: null }],
    ['held_text', `held_text = 'HT'`, { h: 'HT' }],
    ['held_text_hash', `held_text_hash = 'HH'`, { hh: 'HH' }],
  ])('🔴 %s written concurrently is not written back by a rename', async (_col, narrow, expected) => {
    expect(await raced(narrow)).toMatchObject({ ...expected, n: 'despues' })
  })

  // One per column: a server write that SENDS the column still writes it, over the concurrent value.
  it.each([
    ['publication_status', `publication_status = 'unpublishing'`, { publicationStatus: 'draft' }, { p: 'draft' }],
    ['anonymisation_status', `anonymisation_status = 'held'`, { anonymisationStatus: 'rejected' }, { a: 'rejected' }],
    ['redacted_text', `redacted_text = 'OTRA'`, { redactedText: null }, { r: null }],
    ['held_text', `held_text = 'HT'`, { heldText: null }, { h: null }],
    ['held_text_hash', `held_text_hash = 'HH'`, { heldTextHash: null }, { hh: null }],
  ])('control: %s sent explicitly by a server write is written', async (_col, narrow, data, expected) => {
    expect(await raced(narrow, data)).toMatchObject(expected)
  })

  it('control: a server write that sends the value the row already holds keeps it (no reset by omission)', async () => {
    await payload.update({ collection: 'documents', id: DOC, data: { anonymisationStatus: 'ready', name: 'x' } as never, overrideAccess: true, context: { __skipDocsExtract: true } })
    expect(await row()).toMatchObject({ a: 'ready', r: 'REDACCION', n: 'x' })
  })

  it('🔴 a USER update that names a gate column (refused by field access) does not write the stale value back', async () => {
    const user = { ...(await payload.findByID({ collection: 'users', id: 1, overrideAccess: true })), collection: 'users' }
    const db = payload.db as unknown as { updateOne: (a: { collection: string }) => Promise<unknown> }
    const real = db.updateOne.bind(db)
    const spy = vi.spyOn(db, 'updateOne').mockImplementation((async (a: { collection: string }) => {
      if (a.collection === 'documents')
        await pg.db.execute(sql.raw(`UPDATE documents SET anonymisation_status = 'rejected', redacted_text = NULL WHERE id = ${DOC}`))
      return real(a as never)
    }) as never)
    try {
      await payload.update({
        collection: 'documents',
        id: DOC,
        data: { name: 'despues', anonymisationStatus: 'ready', redactedText: 'REDACCION' } as never,
        overrideAccess: false,
        user: user as never,
        context: { __skipDocsExtract: true },
      })
    } finally {
      spy.mockRestore()
    }
    expect(await row()).toMatchObject({ a: 'rejected', r: null, n: 'despues' })
  })

  it("🔴 the audit's path: a rename racing a reject, then a publish: the rejected redaction is never sent", async () => {
    const after = await raced(`publication_status = 'draft', anonymisation_status = 'rejected', redacted_text = NULL, publish_ingest_id = NULL`)
    expect(after).toMatchObject({ p: 'draft', a: 'rejected', r: null })
    const { sent, client } = recorder()
    const doc = (await payload.findByID({ collection: 'documents', id: DOC, depth: 0, overrideAccess: true })) as never
    await expect(beginPublish(doc, { payload, client })).rejects.toBeInstanceOf(NotPublishableError)
    expect(sent).toEqual([])
  })

  it('🔴 beginPublish on a snapshot whose redaction was replaced since: refused, nothing sent', async () => {
    await pg.db.execute(sql`UPDATE documents SET publication_status = 'draft' WHERE id = ${DOC}`)
    const stale = (await payload.findByID({ collection: 'documents', id: DOC, depth: 0, overrideAccess: true })) as never
    await pg.db.execute(sql`UPDATE documents SET redacted_text = 'OTRA REDACCION' WHERE id = ${DOC}`)
    const { sent, client } = recorder()
    await expect(beginPublish(stale, { payload, client })).rejects.toBeInstanceOf(NotPublishableError)
    expect(sent).toEqual([])
    expect((await row()).p).toBe('draft')
  })

  it('control: beginPublish on a fresh cleared draft sends its redaction', async () => {
    await pg.db.execute(sql`UPDATE documents SET publication_status = 'draft' WHERE id = ${DOC}`)
    const doc = (await payload.findByID({ collection: 'documents', id: DOC, depth: 0, overrideAccess: true })) as never
    const { sent, client } = recorder()
    await beginPublish(doc, { payload, client })
    expect(sent).toEqual([{ corpus: 'eco-1', text: 'REDACCION' }])
  })
})
