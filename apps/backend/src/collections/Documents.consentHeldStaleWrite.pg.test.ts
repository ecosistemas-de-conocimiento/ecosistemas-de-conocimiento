/**
 * 🔴 A WHOLE-ROW `payload.update` NEVER WRITES `consent_held` BACK, on a real
 * Payload + Postgres.
 *
 * Payload 3.88's update (`collections/operations/utilities/update.js`) hands
 * the adapter the WHOLE merged document, and `@payloadcms/drizzle` writes every
 * column whose value is not `undefined`. A hold that commits after Payload read
 * the row and before its UPDATE would be written back to `false`: the stale
 * value of an unrelated edit. The hold's only writer is raw SQL
 * (`lib/consentHold.ts`), so the column is dropped from every Payload update.
 *
 * Deterministic: the hold lands from another connection inside
 * `payload.db.updateOne`, after Payload read the row, before its UPDATE.
 * Harness: `lib/testing/realPostgres`. No docker → SKIP.
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

import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '../lib/testing/realPostgres'

if (!dockerOk) console.warn('[Documents.consentHeldStaleWrite.pg.test] docker is not usable — these tests SKIP.')

let pg: RealPostgres
let payload: Payload
const DOC = 41

const held = async () => (await rowsOf(pg.db, sql`SELECT consent_held AS h, name AS n FROM documents WHERE id = ${DOC}`))[0]!

describe.skipIf(!dockerOk)('a whole-row Payload update vs a consent hold (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-consent-stale-${process.pid}`, 'consent_stale')
    payload = await bootPayload(pg.url, 'consent-stale-secret')
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
                             anonymisation_status, consent_held)
      VALUES (${DOC}, 1, 1, 'antes', 'pdf', 'documento', 'draft', 'n/a', false);
    `))
  })

  const editWhileHoldLands = async (data: Record<string, unknown>) => {
    const db = payload.db as unknown as { updateOne: (a: { collection: string; data: Record<string, unknown> }) => Promise<unknown> }
    const real = db.updateOne.bind(db)
    const seen: Array<Record<string, unknown>> = []
    const spy = vi.spyOn(db, 'updateOne').mockImplementation((async (a: { collection: string; data: Record<string, unknown> }) => {
      if (a.collection === 'documents') {
        seen.push({ ...a.data })
        await pg.db.execute(sql`UPDATE documents SET consent_held = true WHERE id = ${DOC}`)
      }
      return real(a as never)
    }) as never)
    try {
      await payload.update({
        collection: 'documents',
        id: DOC,
        data: data as never,
        overrideAccess: true,
        context: { __skipDocsExtract: true },
      })
    } finally {
      spy.mockRestore()
    }
    return seen
  }

  it('🔴 an edit of another field, concurrent with the hold, leaves the hold in place', async () => {
    const seen = await editWhileHoldLands({ name: 'después' })
    expect(seen).toHaveLength(1)
    expect('consentHeld' in seen[0]!).toBe(false)
    expect(await held()).toEqual({ h: true, n: 'después' })
  })

  it('🔴 even a server write that names `consentHeld: false` does not lift a hold', async () => {
    await editWhileHoldLands({ name: 'otra', consentHeld: false })
    expect((await held()).h).toBe(true)
  })

  it('a create still stores the default (false)', async () => {
    await pg.db.execute(sql`DELETE FROM documents`)
    const created = await payload.create({
      collection: 'documents',
      data: { name: 'nuevo', kind: 'pdf', organization: 1, uploadedBy: 1, session: [] } as never,
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
    const r = await rowsOf(pg.db, sql`SELECT consent_held AS h FROM documents WHERE id = ${Number(created.id)}`)
    expect(r[0]!.h).toBe(false)
  })
})
