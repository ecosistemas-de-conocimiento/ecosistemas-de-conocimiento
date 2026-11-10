/**
 * 🔴 EACH CONSENT GUARD ON ITS OWN — AGAINST A REAL POSTGRES (audit 2026-11-10, A4).
 *
 * The guards in `collections/Documents.ts` stand in layers: the ingest hook,
 * then `runExtractAndIngest` on the re-read row, then `enqueueIngestForDoc` at
 * its entry and again before the send. `Documents.consentHeld.pg.test.ts`
 * holds the row from the start, so the first layer stops it and the rest are
 * never reached: any one of them could go and that file stays green. Each test
 * here reaches exactly one layer:
 *
 *   · the hook: `runExtractAndIngest` is never started for a held row;
 *   · `runExtractAndIngest`: a hold that lands after the hook ran, before the
 *     re-read (the hook's check blinded once), leaves the row `pending`; so
 *     does a revision whose own flag is false and whose note is held;
 *   · `enqueueIngestForDoc`'s entry: a held row never reaches the gate (model calls);
 *   · its last check: a hold that lands during the gate sends nothing;
 *   · the publish endpoint: a held row already published answers 409, not
 *     "already done" (`beginPublish`'s `publishBlocker` is never reached there).
 *
 * Harness: `lib/testing/realPostgres`, Payload's REST router (`handleEndpoints`).
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ai = vi.hoisted(() => ({ enqueue: vi.fn(async () => ({ ingestId: 'fake-ingest' })) }))
vi.mock('@/lib/aiClient', () => {
  const client = {
    ingest: { enqueue: ai.enqueue },
    admin: { setDocumentValidity: vi.fn(async () => ({})), deleteDocument: vi.fn(async () => ({})) },
  }
  return { getAdminAIClient: () => client, getAppAIClient: () => client }
})

/** `blindOnce`: the next `isConsentHeldNow` answers false, as if the hold landed just after it. */
const hold = vi.hoisted(() => ({ blindOnce: false }))
vi.mock('@/lib/consentHold', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/consentHold')>()
  return {
    ...real,
    isConsentHeldNow: async (...args: Parameters<typeof real.isConsentHeldNow>) => {
      if (hold.blindOnce) {
        hold.blindOnce = false
        return false
      }
      return real.isConsentHeldNow(...args)
    },
  }
})

/** `duringGate`: runs inside the gate, before it answers. */
const gate = vi.hoisted(() => ({ calls: 0, duringGate: null as null | (() => Promise<unknown>) }))
vi.mock('@/lib/anonymiseDocument', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/anonymiseDocument')>()
  return {
    ...real,
    anonymiseDocumentText: async (...args: Parameters<typeof real.anonymiseDocumentText>) => {
      gate.calls += 1
      if (gate.duringGate) await gate.duringGate()
      return real.anonymiseDocumentText(...args)
    },
  }
})

import { CONSENT_HELD_MESSAGE } from '@/lib/consentHold'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

const PASSWORD = 'consent-guards-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig

async function rest(method: string, path: string, token?: string): Promise<Response> {
  const { handleEndpoints } = await import('payload')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `JWT ${token}`
  return handleEndpoints({ config, request: new Request(`http://localhost${path}`, { method, headers }) })
}
const login = async () => {
  const { handleEndpoints } = await import('payload')
  const res = await handleEndpoints({
    config,
    request: new Request('http://localhost/api/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.invalid', password: PASSWORD }),
    }),
  })
  return ((await res.json()) as { token?: string }).token
}
const run = (s: string) => pg.db.execute(sql.raw(s))
const row = async (id: number) =>
  (await rowsOf(pg.db, sql`SELECT ingest_status, ingest_id, publication_status FROM documents WHERE id = ${id}`))[0]
const settle = () => new Promise((r) => setTimeout(r, 600))
const slice = { name: 'doc.pdf', kind: 'pdf', contentKind: 'documento', anonymise: false, anonymisationStatus: 'n/a' } as const

describe.skipIf(!dockerOk)('each consent guard catches on its own', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-consent-guards-${process.pid}`, 'consent_guards')
    payload = await bootPayload(pg.url, 'consent-guards-secret')
    config = await (await import('@payload-config')).default
    process.env.AI_SERVICE_CALLBACK_SECRET ??= 'x'
  }, 120_000)

  beforeEach(async () => {
    ai.enqueue.mockClear()
    hold.blindOnce = false
    gate.calls = 0
    gate.duringGate = null
    // 81 held, failed ingest; 82 free, extracting; 83 held, extracting; 84 held, published.
    await run(`
      TRUNCATE documents, media, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES (1, 'member@example.invalid', false);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES (1, 1, 1, 'member');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise,
                             anonymisation_status, extracted_text, name, ingest_status, ingest_id, consent_held)
        VALUES (81, 1, 1, 'draft', 'pdf', 'documento', false, 'n/a', 'TEXTO DEL TALLER', 'a.pdf', 'failed', NULL, true),
               (82, 1, 1, 'draft', 'pdf', 'documento', false, 'n/a', 'TEXTO LIBRE', 'b.pdf', 'extracting', NULL, false),
               (83, 1, 1, 'draft', 'pdf', 'documento', false, 'n/a', 'TEXTO DEL TALLER', 'c.pdf', 'extracting', NULL, true),
               (84, 1, 1, 'published', 'pdf', 'documento', false, 'n/a', 'TEXTO DEL TALLER', 'd.pdf', 'ready', 'i-84', true);
    `)
    for (const t of ['users', 'organizations', 'memberships', 'documents']) {
      await run(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`)
    }
    await payload.update({ collection: 'users', id: 1, overrideAccess: true, data: { password: PASSWORD } as never })
  }, 60_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  const rerun = (id: number) =>
    payload.update({ collection: 'documents', id, overrideAccess: true, data: { ingestStatus: 'pending', ingestError: null } as never })

  it('the ingest hook never starts runExtractAndIngest for a held row', async () => {
    const warn = vi.spyOn(console, 'warn')
    try {
      await rerun(81)
      await settle()
      const lines = warn.mock.calls.map((c) => c.map(String).join(' '))
      expect(lines.filter((l) => l.includes('skipping extract+ingest'))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('runExtractAndIngest: a hold that lands after the hook ran leaves the row pending', async () => {
    hold.blindOnce = true
    await rerun(81)
    await settle()
    expect(hold.blindOnce).toBe(false)
    expect(await row(81)).toMatchObject({ ingest_status: 'pending', ingest_id: null })
    expect(ai.enqueue).not.toHaveBeenCalled()
  })

  it('runExtractAndIngest: a revision of a held note is never extracted or ingested (the hold is inherited)', async () => {
    // 85 a free revision row of 84, a held note: its own flag is false.
    await run(`
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise,
                             anonymisation_status, extracted_text, name, ingest_status, consent_held, revision_of_id)
        VALUES (85, 1, 1, 'draft', 'pdf', 'documento', false, 'n/a', 'TEXTO NUEVO', 'd.pdf', 'failed', false, 84);
    `)
    hold.blindOnce = true
    await rerun(85)
    await settle()
    expect(hold.blindOnce).toBe(false)
    expect(await row(85)).toMatchObject({ ingest_status: 'pending', ingest_id: null })
    expect(ai.enqueue).not.toHaveBeenCalled()
  })

  it('enqueueIngestForDoc: a held row never reaches the gate', async () => {
    const { enqueueIngestForDoc } = await import('./Documents')
    await enqueueIngestForDoc({ payload, docId: 83, organizationId: 1, uploadedById: 1, fresh: slice, extractedText: 'TEXTO DEL TALLER' })
    expect(gate.calls).toBe(0)
    expect(await row(83)).toMatchObject({ ingest_status: 'extracting', ingest_id: null })
  })

  it('enqueueIngestForDoc: a hold that lands during the gate sends nothing', async () => {
    gate.duringGate = () => run(`UPDATE documents SET consent_held = true WHERE id = 82`)
    const { enqueueIngestForDoc } = await import('./Documents')
    await enqueueIngestForDoc({ payload, docId: 82, organizationId: 1, uploadedById: 1, fresh: slice, extractedText: 'TEXTO LIBRE' })
    expect(gate.calls).toBe(1)
    expect(await row(82)).toMatchObject({ ingest_status: 'extracting', ingest_id: null })
    expect(ai.enqueue).not.toHaveBeenCalled()
  })

  it('control: the same enqueue of a free row is sent', async () => {
    const { enqueueIngestForDoc } = await import('./Documents')
    await enqueueIngestForDoc({ payload, docId: 82, organizationId: 1, uploadedById: 1, fresh: slice, extractedText: 'TEXTO LIBRE' })
    expect(ai.enqueue).toHaveBeenCalledTimes(1)
  })

  it('the publish endpoint answers 409 for a held row already published, not "already done"', async () => {
    const res = await rest('POST', '/api/documents/84/publish', await login())
    expect(res.status).toBe(409)
    expect(((await res.json()) as { errors?: { message: string }[] }).errors?.[0]?.message).toBe(CONSENT_HELD_MESSAGE)
  })
})
