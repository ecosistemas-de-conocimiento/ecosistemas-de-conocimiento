/**
 * 🔴 RETENIDO POR CONSENTIMIENTO: NOTHING IS SENT, NOTHING IS PUBLISHED —
 * AGAINST A REAL POSTGRES.
 *
 * Owner decision 2026-11-10 (`lib/consentHold.ts`). Every door in
 * `collections/Documents.ts` and `lib/publishDocument.ts`: the API cannot set
 * or clear the flag; publish, retry, graph-retry and the note editor 409; the
 * ingest hook, `enqueueIngestForDoc` (with a hand-built slice, as the audio
 * drive builds it) and `scheduleGraphExtractionForDoc` write and send nothing;
 * `unpublish` retires the shared copy and re-embeds nothing.
 *
 * Harness: `lib/testing/realPostgres`, Payload's REST router (`handleEndpoints`).
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
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

import { CONSENT_HELD_MESSAGE } from '@/lib/consentHold'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

const PASSWORD = 'consent-held-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig

async function rest(method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const { handleEndpoints } = await import('payload')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `JWT ${token}`
  return handleEndpoints({
    config,
    request: new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  })
}

const login = async () => {
  const res = await rest('POST', '/api/users/login', undefined, { email: 'member@example.invalid', password: PASSWORD })
  return ((await res.json()) as { token?: string }).token
}
const message = async (res: Response) => ((await res.json()) as { errors?: { message: string }[] }).errors?.[0]?.message
const run = (s: string) => pg.db.execute(sql.raw(s))
const row = async (id: number) =>
  (
    await rowsOf(
      pg.db,
      sql`SELECT consent_held, publication_status, ingest_status, ingest_id, graph_status, name, anonymisation_status
          FROM documents WHERE id = ${id}`,
    )
  )[0]
const settle = () => new Promise((r) => setTimeout(r, 400))

describe.skipIf(!dockerOk)('a consent-held document is never processed or published', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-consent-held-${process.pid}`, 'consent_held')
    payload = await bootPayload(pg.url, 'consent-held-secret')
    config = await (await import('@payload-config')).default
    process.env.AI_SERVICE_CALLBACK_SECRET ??= 'x'
  }, 120_000)

  beforeEach(async () => {
    ai.enqueue.mockClear()
    ai.setDocumentValidity.mockClear()
    // 61 draft documento, 62 failed ingest, 63 in-app note, 64 published, 65 extracting
    // (the audio drive's state), 66 a draft NOT held: the control.
    await run(`
      TRUNCATE documents, media, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES (1, 'member@example.invalid', false);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES (1, 1, 1, 'member');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise,
                             anonymisation_status, extracted_text, body_markdown, name, ingest_status, ingest_id, consent_held)
        VALUES (61, 1, 1, 'draft', 'pdf', 'documento', false, 'n/a', 'TEXTO DEL TALLER', NULL, 'taller.pdf', 'ready', 'i-61', true),
               (62, 1, 1, 'draft', 'pdf', 'documento', false, 'n/a', 'TEXTO DEL TALLER', NULL, 'fallo.pdf', 'failed', NULL, true),
               (63, 1, 1, 'draft', 'markdown', 'documento', false, 'n/a', NULL, 'NOTA', 'nota', 'n/a', NULL, true),
               (64, 1, 1, 'published', 'pdf', 'documento', false, 'n/a', 'TEXTO DEL TALLER', NULL, 'pub.pdf', 'ready', 'i-64', true),
               (65, 1, 1, 'draft', 'audio', 'documento', false, 'n/a', 'TRANSCRIPCION', NULL, 'audio.webm', 'extracting', NULL, true),
               (66, 1, 1, 'draft', 'pdf', 'documento', false, 'n/a', 'TEXTO LIBRE', NULL, 'libre.pdf', 'ready', 'i-66', false);
    `)
    for (const t of ['users', 'organizations', 'memberships', 'documents']) {
      await run(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`)
    }
    await payload.update({ collection: 'users', id: 1, overrideAccess: true, data: { password: PASSWORD } as never })
  }, 60_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('the API cannot clear or set the flag', async () => {
    const token = await login()
    await rest('PATCH', '/api/documents/61', token, { consentHeld: false })
    await rest('PATCH', '/api/documents/66', token, { consentHeld: true })
    expect((await row(61))?.consent_held).toBe(true)
    expect((await row(66))?.consent_held).toBe(false)
  })

  it('publish, retry, graph-retry and the note editor answer 409 and change nothing', async () => {
    const token = await login()
    for (const [method, path] of [
      ['POST', '/api/documents/61/publish'],
      ['POST', '/api/documents/62/retry'],
      ['POST', '/api/documents/61/graph-retry'],
      ['PATCH', '/api/documents/63/note'],
    ] as const) {
      const res = await rest(method, path, token, method === 'PATCH' ? { name: 'otra' } : undefined)
      expect(res.status, path).toBe(409)
      expect(await message(res), path).toBe(CONSENT_HELD_MESSAGE)
    }
    await settle()
    expect(await row(61)).toMatchObject({ publication_status: 'draft', graph_status: 'n/a' })
    expect(await row(62)).toMatchObject({ ingest_status: 'failed' })
    expect((await row(63))?.name).toBe('nota')
    expect(ai.enqueue).not.toHaveBeenCalled()
  })

  it('control: the same publish of a draft that is not held goes through', async () => {
    const token = await login()
    expect((await rest('POST', '/api/documents/66/publish', token)).status).toBe(202)
    expect(ai.enqueue).toHaveBeenCalledTimes(1)
  })

  it('a server save that would re-run the ingest does nothing', async () => {
    await payload.update({
      collection: 'documents',
      id: 62,
      overrideAccess: true,
      data: { ingestStatus: 'pending', ingestError: null } as never,
    })
    await settle()
    expect((await row(62))?.ingest_status).toBe('pending')
    expect(ai.enqueue).not.toHaveBeenCalled()
  })

  it('enqueueIngestForDoc with a slice that does not carry the flag still refuses', async () => {
    const { enqueueIngestForDoc } = await import('./Documents')
    await enqueueIngestForDoc({
      payload,
      docId: 65,
      organizationId: 1,
      uploadedById: 1,
      fresh: { name: 'audio.webm', kind: 'audio', contentKind: 'documento', anonymise: false, anonymisationStatus: 'n/a' },
      extractedText: 'TRANSCRIPCION',
    })
    expect(await row(65)).toMatchObject({ ingest_status: 'extracting', ingest_id: null })
    expect(ai.enqueue).not.toHaveBeenCalled()
  })

  it('scheduleGraphExtractionForDoc writes nothing', async () => {
    const { scheduleGraphExtractionForDoc } = await import('./Documents')
    await scheduleGraphExtractionForDoc({ payload, docId: 61, organizationId: 1, fresh: { name: 'taller.pdf', contentKind: 'documento' } })
    expect((await row(61))?.graph_status).toBe('n/a')
  })

  it('unpublish retires the shared copy and re-embeds nothing', async () => {
    const token = await login()
    const res = await rest('POST', '/api/documents/64/unpublish', token)
    expect(res.status).toBe(200)
    expect((await row(64))?.publication_status).toBe('draft')
    expect(ai.setDocumentValidity).toHaveBeenCalledWith('eco-1', '64', expect.objectContaining({ validTo: expect.any(String) }))
    expect(ai.enqueue).not.toHaveBeenCalled()
  })
})
