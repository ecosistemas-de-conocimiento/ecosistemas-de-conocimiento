/**
 * 🔴 `confirmPublish` NEVER FLIPS A HELD ROW TO `published`, on a real Payload
 * + Postgres (audit 2026-11-11, B).
 *
 * The hold (`lib/consentHold.ts`) can land while the row is `publishing`: after
 * the callback read it, during the draft-copy retire. The flip is one
 * transaction that reads the hold `FOR SHARE` and repeats `publishing`, so a
 * hold either is seen (the shared copy is retired, the row is a draft) or waits
 * until the flip commits. Harness: `lib/testing/realPostgres`. No docker → SKIP.
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

import { CONSENT_HELD_MESSAGE } from './consentHold'
import { confirmPublish, isSharedCopyNotRetired, unpublish } from './publishDocument'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, tryHoldElsewhere, type RealPostgres } from './testing/realPostgres'

if (!dockerOk) console.warn('[publishDocument.consentHeld.pg.test] docker is not usable — these tests SKIP.')

let pg: RealPostgres
let payload: Payload
const DOC = 51
const SHARED = 'eco-1'
const DRAFT = 'eco-1-draft-1'

const state = async () =>
  (await rowsOf(pg.db, sql`SELECT publication_status p, publication_error e, publish_ingest_id j, ingest_status i
    FROM documents WHERE id = ${DOC}`))[0]!

const readDoc = async () =>
  (await payload.findByID({ collection: 'documents', id: DOC, depth: 0, overrideAccess: true })) as never

/** A client whose retire runs `during(corpus)` first. Records each retired corpus. */
const clientWith = (during?: (corpus: string) => Promise<void>) => {
  const retired: string[] = []
  const client = {
    ingest: { enqueue: async () => ({ ingestId: 'x' }) },
    admin: {
      setDocumentValidity: async (corpus: string) => {
        retired.push(corpus)
        await during?.(corpus)
        return {}
      },
    },
  }
  return { retired, client: client as never }
}

describe.skipIf(!dockerOk)('🔴 confirmPublish vs a consent hold (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-confirm-held-${process.pid}`, 'confirm_held')
    payload = await bootPayload(pg.url, 'confirm-held-secret')
  }, 120_000)
  afterAll(async () => {
    await shutdown(pg, payload)
  })
  beforeEach(async () => {
    await pg.db.execute(sql.raw(`
      TRUNCATE documents, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, 'u@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, content_kind, publication_status,
                             publish_ingest_id, anonymisation_status, consent_held, anonymise, extracted_text, ingest_status)
      VALUES (${DOC}, 1, 1, 'doc', 'pdf', 'documento', 'publishing', 'pub-J', 'n/a', false, false, 'texto', 'ready');
    `))
  })

  it('control: not held, the draft copy is retired and the row is `published`', async () => {
    const { retired, client } = clientWith()
    await confirmPublish(await readDoc(), { payload, client })
    expect(retired).toEqual([DRAFT])
    expect(await state()).toEqual({ p: 'published', e: null, j: null, i: 'ready' })
  })

  it('🔴 held before the callback ran: nothing published, the shared copy retired, a draft', async () => {
    await pg.db.execute(sql`UPDATE documents SET consent_held = true WHERE id = ${DOC}`)
    const { retired, client } = clientWith()
    await confirmPublish(await readDoc(), { payload, client })
    expect(retired).toEqual([SHARED])
    expect(await state()).toMatchObject({ p: 'draft', e: CONSENT_HELD_MESSAGE, j: null })
  })

  it('🔴 held AFTER the callback read the row (during the draft retire): not flipped, the shared copy retired', async () => {
    const doc = await readDoc()
    const { retired, client } = clientWith(async (corpus) => {
      if (corpus === DRAFT) await pg.db.execute(sql`UPDATE documents SET consent_held = true WHERE id = ${DOC}`)
    })
    await confirmPublish(doc, { payload, client })
    expect(retired).toEqual([DRAFT, SHARED])
    expect(await state()).toMatchObject({ p: 'draft', e: CONSENT_HELD_MESSAGE, j: null })
  })

  it('🔴 the flip holds the row FOR SHARE: a hold from another connection waits until commit', async () => {
    const drizzle = (payload.db as unknown as { drizzle: { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> } }).drizzle
    const real = drizzle.transaction.bind(drizzle)
    let attempt: 'blocked' | 'written' | null = null
    const spy = vi.spyOn(drizzle, 'transaction').mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
      real(async (tx) => {
        const t = tx as { execute(q: unknown): Promise<unknown> }
        const wrapped = {
          execute: async (q: unknown) => {
            const out = await t.execute(q)
            if (attempt === null) attempt = await tryHoldElsewhere(pg.db, DOC)
            return out
          },
        }
        return fn(wrapped)
      })) as never)
    try {
      const { client } = clientWith()
      await confirmPublish(await readDoc(), { payload, client })
    } finally {
      spy.mockRestore()
    }
    expect(attempt).toBe('blocked')
    expect((await state()).p).toBe('published')
  })

  it('🔴 withdrawn while the callback ran (`unpublishing`): not flipped, the shared copy retired again', async () => {
    const doc = await readDoc()
    const { retired, client } = clientWith(async (corpus) => {
      if (corpus === DRAFT) await pg.db.execute(sql`UPDATE documents SET publication_status = 'unpublishing' WHERE id = ${DOC}`)
    })
    await confirmPublish(doc, { payload, client })
    expect(retired).toEqual([DRAFT, SHARED])
    expect((await state()).p).toBe('unpublishing')
  })

  it('🔴 held in the TABLE after the snapshot was read: caught before the draft copy is retired', async () => {
    const doc = await readDoc()
    await pg.db.execute(sql`UPDATE documents SET consent_held = true WHERE id = ${DOC}`)
    const { retired, client } = clientWith()
    await confirmPublish(doc, { payload, client })
    expect(retired).toEqual([SHARED])
    expect((await state()).p).toBe('draft')
  })

  it("🔴 a revision: its ORIGINAL is locked FOR SHARE too, and the original's hold waits until commit", async () => {
    const ORIG = 50
    await pg.db.execute(sql.raw(`
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, content_kind, publication_status,
                             anonymisation_status, consent_held, anonymise, extracted_text, ingest_status)
      VALUES (${ORIG}, 1, 1, 'orig', 'pdf', 'documento', 'published', 'n/a', false, false, 'texto', 'ready');
      UPDATE documents SET revision_of_id = ${ORIG} WHERE id = ${DOC};
    `))
    const drizzle = (payload.db as unknown as { drizzle: { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> } }).drizzle
    const real = drizzle.transaction.bind(drizzle)
    let attempt: 'blocked' | 'written' | null = null
    const spy = vi.spyOn(drizzle, 'transaction').mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
      real(async (tx) => {
        const t = tx as { execute(q: unknown): Promise<unknown> }
        return fn({
          execute: async (q: unknown) => {
            const out = await t.execute(q)
            if (attempt === null) attempt = await tryHoldElsewhere(pg.db, ORIG)
            return out
          },
        })
      })) as never)
    try {
      const { client } = clientWith()
      await confirmPublish(await readDoc(), { payload, client })
    } finally {
      spy.mockRestore()
    }
    expect(attempt).toBe('blocked')
  })

  it('🔴 withdrawn meanwhile and the shared retire fails: it THROWS (the callback answers 500), not a row message', async () => {
    const doc = await readDoc()
    const client = {
      ingest: { enqueue: async () => ({ ingestId: 'x' }) },
      admin: {
        setDocumentValidity: async (corpus: string) => {
          if (corpus === DRAFT) {
            await pg.db.execute(sql`UPDATE documents SET publication_status = 'unpublishing' WHERE id = ${DOC}`)
            return {}
          }
          throw Object.assign(new Error('ai-service 503'), { status: 503 })
        },
      },
    } as never
    const err = await confirmPublish(doc, { payload, client }).then(() => null, (e: unknown) => e)
    expect(isSharedCopyNotRetired(err)).toBe(true)
  })

  it('🔴 a held unpublish whose retire fails: the reason is on the row and it throws (nothing swallowed)', async () => {
    await pg.db.execute(sql`UPDATE documents SET consent_held = true, publication_status = 'published', publish_ingest_id = NULL WHERE id = ${DOC}`)
    const client = {
      ingest: { enqueue: async () => ({ ingestId: 'x' }) },
      admin: { setDocumentValidity: async () => { throw Object.assign(new Error('ai-service 503'), { status: 503 }) } },
    } as never
    await expect(unpublish(await readDoc(), { payload, client, retry: { maxAttempts: 1 } } as never)).rejects.toThrow()
    const after = await state()
    expect(after.p).toBe('published')
    expect(typeof after.e === 'string' && (after.e as string).length > 0).toBe(true)
  })
})

