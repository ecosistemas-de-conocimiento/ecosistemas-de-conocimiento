/**
 * 🔴 A RE-GATE THAT FAILED, OR IS STILL OWED, BLOCKS PUBLICATION — AGAINST A
 * REAL POSTGRES.
 *
 * Owner decision 2026-11-10. A gated `ready` draft passes `corpusTextFor` and
 * the guarded write in `beginPublish`, and used to be published while:
 *   · its re-gate failed (`anonymisationReport.regate.failedAt`): the text
 *     still keeps a name the new switches remove;
 *   · its re-gate is pending (`pendingRegateOf`): its verdict kept the author
 *     under a switch that is now off (the ecosistema default, off).
 * Both 409 (`publishBlocker`); the verdict a successful gate writes (made
 * under the current switches, no `failedAt`) publishes.
 *
 * Harness: `lib/testing/realPostgres`, Payload's REST router (`handleEndpoints`).
 */

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ai = vi.hoisted(() => ({ enqueue: vi.fn(async () => ({ ingestId: 'fake-ingest' })) }))
vi.mock('@/lib/aiClient', () => {
  const client = { ingest: { enqueue: ai.enqueue }, admin: { setDocumentValidity: vi.fn(async () => ({})) } }
  return { getAdminAIClient: () => client, getAppAIClient: () => client }
})

import { PUBLISH_BLOCK_MESSAGES } from './publishDocument'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from './testing/realPostgres'

const PASSWORD = 'regate-block-pw'
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
const status = async () =>
  (await rowsOf(pg.db, sql`SELECT publication_status FROM documents WHERE id = 71`))[0]?.publication_status

const KEPT = `'[{"name":"Autora","model":"m","at":"2026-11-09T00:00:00.000Z"}]'::jsonb`

describe.skipIf(!dockerOk)('publish waits for a re-gate to succeed', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-regate-block-${process.pid}`, 'regate_block')
    payload = await bootPayload(pg.url, 'regate-block-secret')
    config = await (await import('@payload-config')).default
  }, 120_000)

  beforeEach(async () => {
    ai.enqueue.mockClear()
    // A gated documento, cleared (`ready`, redacted), a draft. Ecosistema switches: defaults (all off).
    await run(`
      TRUNCATE documents, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email, is_platform_admin) VALUES (1, 'member@example.invalid', false);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (id, user_id, organization_id, role) VALUES (1, 1, 1, 'member');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise,
                             anonymisation_status, extracted_text, redacted_text, name, ingest_status, ingest_id,
                             anonymisation_report)
        VALUES (71, 1, 1, 'draft', 'pdf', 'documento', true, 'ready', 'ORIGINAL', 'REDACTADO', 'doc.pdf', 'ready', 'i-71',
                '{"settings":{"keepDocumentAuthor":false,"keepCitedAuthors":false}}'::jsonb);
    `)
    for (const t of ['users', 'organizations', 'memberships', 'documents']) {
      await run(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), 1000)`)
    }
    await payload.update({ collection: 'users', id: 1, overrideAccess: true, data: { password: PASSWORD } as never })
  }, 60_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('a failed re-gate: 409, nothing sent, still a draft', async () => {
    await run(`UPDATE documents SET anonymisation_report = jsonb_set(anonymisation_report, '{regate}',
               '{"failedAt":"2026-11-10T00:00:00.000Z","reason":"erase-failed"}') WHERE id = 71`)
    const res = await rest('POST', '/api/documents/71/publish', await login())
    expect(res.status).toBe(409)
    expect(await message(res)).toBe(PUBLISH_BLOCK_MESSAGES['regate-failed'])
    expect(await status()).toBe('draft')
    expect(ai.enqueue).not.toHaveBeenCalled()
  })

  it('a pending re-gate (the verdict kept the author; the switch is now off): 409', async () => {
    await run(`UPDATE documents SET authors_kept = ${KEPT},
               anonymisation_report = '{"settings":{"keepDocumentAuthor":true,"keepCitedAuthors":false}}'::jsonb
               WHERE id = 71`)
    const res = await rest('POST', '/api/documents/71/publish', await login())
    expect(res.status).toBe(409)
    expect(await message(res)).toBe(PUBLISH_BLOCK_MESSAGES['regate-pending'])
    expect(await status()).toBe('draft')
    expect(ai.enqueue).not.toHaveBeenCalled()
  })

  it('the verdict a successful re-gate leaves (current switches, no failure) publishes', async () => {
    // What the gate writes after the reset: settings = the switches it ran under, no keep log, no `regate` mark.
    await run(`UPDATE documents SET authors_kept = NULL,
               anonymisation_report = '{"settings":{"keepDocumentAuthor":false,"keepCitedAuthors":false}}'::jsonb
               WHERE id = 71`)
    const res = await rest('POST', '/api/documents/71/publish', await login())
    expect(res.status).toBe(202)
    expect(await status()).toBe('publishing')
    expect(ai.enqueue).toHaveBeenCalledTimes(1)
  })

  it('beginPublish itself refuses, for every other publisher (auto-publish, seeds)', async () => {
    await run(`UPDATE documents SET anonymisation_report = jsonb_set(anonymisation_report, '{regate}',
               '{"failedAt":"2026-11-10T00:00:00.000Z","reason":"failed"}') WHERE id = 71`)
    const { beginPublish, PublishBlockedError } = await import('./publishDocument')
    const doc = await payload.findByID({ collection: 'documents', id: 71, overrideAccess: true, depth: 0 })
    // A snapshot taken before the failure was stamped: the stored row decides.
    const stale = { ...doc, anonymisationReport: { settings: { keepDocumentAuthor: false, keepCitedAuthors: false } } }
    await expect(
      beginPublish(stale as never, { payload, client: { ingest: { enqueue: ai.enqueue }, admin: {} } as never }),
    ).rejects.toBeInstanceOf(PublishBlockedError)
    expect(await status()).toBe('draft')
  })
})
