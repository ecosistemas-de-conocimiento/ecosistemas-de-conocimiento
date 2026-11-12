/**
 * 🔴 A WHOLE-ROW `payload.update` NEVER WRITES `anonymise`, `contentKind`, A
 * `keep*` SWITCH, `publishIngestId` OR `ingestStatus` BACK FROM A STALE READ,
 * and a user's text edit never undoes a newer verdict, on a real Payload +
 * Postgres (audit 2026-11-12, V5–V7).
 *
 * A rename that read the row before a re-gate put back `anonymise = false`
 * (`regateMemberDocumentos`) or `contentKind = 'documento'`
 * (`autoPublishBackfill`), and the next publish sent the ORIGINAL to the
 * shared corpus. A user's text edit on a held row that read it before a
 * reviewer's reject wrote `n/a` over `rejected`. `hooks/writtenOnlyWhenSent.ts`,
 * `deferStatusReset` in `Documents.ts`. The narrow write lands from another
 * connection inside `payload.db.updateOne`: after Payload read the row, before
 * its UPDATE. Harness: `lib/testing/realPostgres`. No docker → SKIP.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { beginPublish, NotPublishableError } from '../lib/publishDocument'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '../lib/testing/realPostgres'

if (!dockerOk) console.warn('[Documents.switchColumnsStaleWrite.pg.test] docker is not usable — these tests SKIP.')

let pg: RealPostgres
let payload: Payload
const DOC = 61

/**
 * Local API calls in flight. A `contentKind` change schedules a detached
 * graph invalidation (`setImmediate`, then deletes and a `payload.update` of
 * the row) that would otherwise land in the next test, inside its race.
 */
let inFlight = 0
const counted = (p: Payload, method: 'update' | 'delete') => {
  const real = p[method].bind(p) as (...a: unknown[]) => Promise<unknown>
  ;(p as unknown as Record<string, unknown>)[method] = async (...a: unknown[]) => {
    inFlight += 1
    try {
      return await real(...a)
    } finally {
      inFlight -= 1
    }
  }
}
const settle = async () => {
  for (let quiet = 0; quiet < 5; ) {
    await new Promise((r) => setTimeout(r, 10))
    quiet = inFlight === 0 ? quiet + 1 : 0
  }
}

const row = async () =>
  (await rowsOf(pg.db, sql`SELECT publication_status p, anonymisation_status a, redacted_text r, held_text h,
    held_text_hash hh, name n, anonymise an, content_kind ck, keep_public_figures kpf, keep_document_author kda,
    keep_cited_authors kca, publish_ingest_id pi, ingest_status i, extracted_text x FROM documents WHERE id = ${DOC}`))[0]!

const seed = (overrides: Record<string, string> = {}) => {
  const cols: Record<string, string> = {
    content_kind: `'documento'`,
    anonymise: 'false',
    publication_status: `'draft'`,
    anonymisation_status: `'n/a'`,
    extracted_text: `'ORIGINAL'`,
    redacted_text: 'NULL',
    held_text: 'NULL',
    held_text_hash: 'NULL',
    ingest_status: `'ready'`,
    // Not NULL: Payload's fallback skips a NULL column, so a stale NULL is never written back.
    keep_public_figures: 'false',
    keep_document_author: 'false',
    keep_cited_authors: 'false',
    ...overrides,
  }
  return pg.db.execute(sql.raw(`
    TRUNCATE documents, memberships, organizations, users RESTART IDENTITY CASCADE;
    INSERT INTO users (id, email) VALUES (1, 'u@example.invalid');
    INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
    INSERT INTO memberships (user_id, organization_id, role) VALUES (1, 1, 'member');
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

const serverWrite = (data: Record<string, unknown>) =>
  payload.update({ collection: 'documents', id: DOC, data: data as never, overrideAccess: true, context: { __skipDocsExtract: true } })

const userWrite = async (data: Record<string, unknown>) => {
  const user = { ...(await payload.findByID({ collection: 'users', id: 1, overrideAccess: true })), collection: 'users' }
  return payload.update({
    collection: 'documents',
    id: DOC,
    data: data as never,
    overrideAccess: false,
    user: user as never,
    context: { __skipDocsExtract: true },
  })
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

const publishNow = async () => {
  const { sent, client } = recorder()
  const doc = (await payload.findByID({ collection: 'documents', id: DOC, depth: 0, overrideAccess: true })) as never
  let err: unknown = null
  try {
    await beginPublish(doc, { payload, client })
  } catch (e) {
    err = e
  }
  return { sent, err }
}

const NEW_TEXT = 'UN TEXTO COMPLETAMENTE NUEVO Y DISTINTO'

describe.skipIf(!dockerOk)('🔴 switch and pipeline columns vs a stale whole-row write (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-switch-stale-${process.pid}`, 'switch_stale')
    payload = await bootPayload(pg.url, 'switch-stale-secret')
    counted(payload, 'update')
    counted(payload, 'delete')
  }, 120_000)
  afterEach(settle)
  afterAll(async () => {
    await shutdown(pg, payload)
  })
  beforeEach(async () => {
    await seed()
  })

  // One per column: the concurrent narrow write stands, the rename lands.
  it.each([
    ['anonymise', `anonymise = true`, { an: true }],
    ['content_kind', `content_kind = 'testimonio'`, { ck: 'testimonio' }],
    ['keep_public_figures', `keep_public_figures = true`, { kpf: true }],
    ['keep_document_author', `keep_document_author = true`, { kda: true }],
    ['keep_cited_authors', `keep_cited_authors = true`, { kca: true }],
    ['publish_ingest_id', `publish_ingest_id = 'pub-1'`, { pi: 'pub-1' }],
    ['ingest_status', `ingest_status = 'extracting'`, { i: 'extracting' }],
  ])('🔴 %s written concurrently is not written back by a rename', async (_col, narrow, expected) => {
    await raced(narrow, () => serverWrite({ name: 'despues' }))
    expect(await row()).toMatchObject({ ...expected, n: 'despues' })
  })

  // One per column: a server write that SENDS the column still writes it, over the concurrent value.
  it.each([
    ['anonymise', `anonymise = true`, { anonymise: false }, { an: false }],
    ['content_kind', `content_kind = 'testimonio'`, { contentKind: 'documento' }, { ck: 'documento' }],
    ['keep_public_figures', `keep_public_figures = true`, { keepPublicFigures: false }, { kpf: false }],
    ['keep_document_author', `keep_document_author = true`, { keepDocumentAuthor: null }, { kda: null }],
    ['keep_cited_authors', `keep_cited_authors = true`, { keepCitedAuthors: false }, { kca: false }],
    ['publish_ingest_id', `publish_ingest_id = 'pub-1'`, { publishIngestId: null }, { pi: null }],
    ['ingest_status', `ingest_status = 'extracting'`, { ingestStatus: 'ready' }, { i: 'ready' }],
  ])('control: %s sent explicitly by a server write is written', async (_col, narrow, data, expected) => {
    await raced(narrow, () => serverWrite(data))
    expect(await row()).toMatchObject(expected)
  })

  it('🔴 V6: a rename racing regateMemberDocumentos (anonymise false → true): no original reaches eco-1', async () => {
    await seed({ publication_status: `'published'` })
    await raced(
      `anonymise = true, publication_status = 'draft', publish_ingest_id = NULL, anonymisation_status = 'n/a', redacted_text = NULL, ingest_status = 'extracting'`,
      () => serverWrite({ name: 'despues' }),
    )
    expect(await row()).toMatchObject({ an: true, p: 'draft', a: 'n/a', i: 'extracting', n: 'despues' })
    const { sent, err } = await publishNow()
    expect(err).toBeInstanceOf(NotPublishableError)
    expect(sent.filter((s) => s.corpus === 'eco-1')).toEqual([])
    expect(sent.some((s) => s.text === 'ORIGINAL')).toBe(false)
  })

  it('🔴 V7: a rename racing the REGATE_AS_TESTIMONIO backfill (documento → testimonio): no original reaches eco-1', async () => {
    await raced(`content_kind = 'testimonio', anonymisation_status = 'n/a', redacted_text = NULL, ingest_status = 'pending'`, () =>
      serverWrite({ name: 'despues' }),
    )
    expect(await row()).toMatchObject({ ck: 'testimonio', i: 'pending', n: 'despues' })
    const { sent, err } = await publishNow()
    expect(err).toBeInstanceOf(NotPublishableError)
    expect(sent.filter((s) => s.corpus === 'eco-1')).toEqual([])
    expect(sent.some((s) => s.text === 'ORIGINAL')).toBe(false)
  })

  it('control: an ungated documento, no race, still publishes its text', async () => {
    const { sent, err } = await publishNow()
    expect(err).toBeNull()
    expect(sent).toEqual([{ corpus: 'eco-1', text: 'ORIGINAL' }])
  })

  it('🔴 a USER update naming anonymise, contentKind and the switches changes none of them', async () => {
    await seed({ content_kind: `'testimonio'`, anonymise: 'true' })
    await userWrite({ name: 'x', anonymise: false, contentKind: 'documento', keepPublicFigures: true, keepDocumentAuthor: true, keepCitedAuthors: true })
    expect(await row()).toMatchObject({ n: 'x', an: true, ck: 'testimonio', kpf: false, kda: false, kca: false })
  })

  it('🔴 a USER update naming the switches under a race does not write the stale values back', async () => {
    await raced(`anonymise = true, content_kind = 'testimonio', keep_document_author = true`, () =>
      userWrite({ name: 'x', anonymise: false, contentKind: 'documento', keepDocumentAuthor: false }),
    )
    expect(await row()).toMatchObject({ n: 'x', an: true, ck: 'testimonio', kda: true })
  })

  it("control: a USER's transcript edit that sends ingestStatus writes it, over a concurrent value", async () => {
    await raced(`ingest_status = 'embedding'`, () => userWrite({ extractedText: NEW_TEXT, ingestStatus: 'ready' }))
    expect(await row()).toMatchObject({ x: NEW_TEXT, i: 'ready' })
  })

  it('🔴 a USER ingestStatus without a text edit (refused by field access) does not write the stale value back', async () => {
    // ⚠ A value that differs from the one read: the same value would be dropped as a fallback even if access let it through.
    await raced(`ingest_status = 'embedding'`, () => userWrite({ name: 'x', ingestStatus: 'failed' }))
    expect(await row()).toMatchObject({ n: 'x', i: 'embedding' })
  })

  describe('🔴 V5: a user text edit vs a newer verdict', () => {
    const HELD = { content_kind: `'testimonio'`, anonymise: 'true', anonymisation_status: `'held'`, held_text: `'HELD'`, held_text_hash: `'hash1'` }

    it('racing a reject: 409, the reject and the old text stand', async () => {
      await seed(HELD)
      const err = await raced(`anonymisation_status = 'rejected', held_text = NULL, redacted_text = NULL`, () =>
        userWrite({ extractedText: NEW_TEXT }).then(() => null, (e: unknown) => e),
      )
      expect((err as { status?: number } | null)?.status).toBe(409)
      expect(await row()).toMatchObject({ a: 'rejected', h: null, r: null, x: 'ORIGINAL' })
    })

    it('racing an approval: 409, the approval and its redaction stand', async () => {
      await seed(HELD)
      const err = await raced(`anonymisation_status = 'approved', redacted_text = 'APROBADA', held_text = NULL, held_text_hash = NULL`, () =>
        userWrite({ extractedText: NEW_TEXT }).then(() => null, (e: unknown) => e),
      )
      expect((err as { status?: number } | null)?.status).toBe(409)
      expect(await row()).toMatchObject({ a: 'approved', r: 'APROBADA', x: 'ORIGINAL' })
    })

    it('control: no race on a held row: reset written (n/a, nulls), the response says n/a', async () => {
      await seed(HELD)
      const doc = (await userWrite({ extractedText: NEW_TEXT })) as { anonymisationStatus?: unknown }
      expect(doc.anonymisationStatus).toBe('n/a')
      expect(await row()).toMatchObject({ a: 'n/a', h: null, hh: null, r: null, x: NEW_TEXT })
    })

    it('control: no race on an approved row: reset written (n/a, redacted null)', async () => {
      await seed({ ...HELD, anonymisation_status: `'approved'`, held_text: 'NULL', held_text_hash: 'NULL', redacted_text: `'APROBADA'` })
      await userWrite({ extractedText: NEW_TEXT })
      expect(await row()).toMatchObject({ a: 'n/a', r: null, x: NEW_TEXT })
    })

    it('control: a text edit on a rejected row leaves the reject alone', async () => {
      await seed({ ...HELD, anonymisation_status: `'rejected'`, held_text: 'NULL', held_text_hash: 'NULL' })
      await userWrite({ extractedText: NEW_TEXT })
      expect(await row()).toMatchObject({ a: 'rejected', x: NEW_TEXT })
    })
  })
})
