/**
 * DELETING A CONVERSATION ERASES ITS TURNS FROM AI-SERVICE — REAL POSTGRES.
 *
 * Audit 2026-10-17 §3 item 2. The unit side is `conversationTurnErasure.test.ts`;
 * this pins what a fake cannot: the retire runs IN the transaction, the erase
 * (`admin.deleteDocument`) only after a real COMMIT, never after a failed one,
 * and the plan carries a real `txid_current()`. ai-service is a spy.
 *
 * Harness: `lib/testing/realPostgres.ts`. No docker → SKIPS.
 */

import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
/**
 * What ai-service holds, as `corpus/externalId`. `deleteDocument` removes a
 * document and its chunks, or answers ai-service's own 404 when it is absent:
 * a turn still `embedding` is not in here yet (its worker has not run).
 */
const stored = new Set<string>()
const deleteDocument = vi.fn(async (corpus: string, id: string) => {
  calls.push(`delete ${corpus} ${id}`)
  if (!stored.delete(`${corpus}/${id}`)) {
    throw Object.assign(new Error('not found'), { status: 404, code: 'DOCUMENT_NOT_FOUND' })
  }
  return { deleted: true }
})
const setDocumentValidity = vi.fn(async (corpus: string, id: string, _bounds: unknown) => {
  calls.push(`retire ${corpus} ${id}`)
  return { ok: true }
})
vi.mock('@/lib/aiClient', () => ({
  getAdminAIClient: () => ({ admin: { deleteDocument, setDocumentValidity } }),
}))

import { KEEP_CONVERSATION_UPLOADS } from './conversationUploads'
import { signCallback } from './hmac'
import {
  bootPayload,
  dockerOk,
  eventually,
  rowsOf,
  shutdown,
  startRealPostgres,
  type RealPostgres,
} from './testing/realPostgres'

if (!dockerOk) console.warn('[conversationTurnErasure.pg.test] docker is not usable — the real-Postgres tests SKIP.')

/**
 * How long a "nothing must happen" test waits. The erase acts on the first
 * `txid_status` poll that answers (250 ms interval); 6 s is a chosen margin,
 * not a measured one, the same as `conversationUploads.pg.test.ts`.
 */
const OUTLAST_ERASE_MS = 6_000

let pg: RealPostgres
let payload: Payload

const ids = async (table: string): Promise<number[]> =>
  (await rowsOf(pg.db, sql.raw(`SELECT id FROM ${table} ORDER BY id`))).map((r) => Number(r.id))

const erased = () => deleteDocument.mock.calls.map((c) => `${c[0]} ${c[1]}`).sort()

describe.skipIf(!dockerOk)('deleting a conversation erases its turns, on a real Postgres', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-turn-erasure-pg-${process.pid}`, 'turn_erasure_test')
    payload = await bootPayload(pg.url, 'turn-erasure-test-secret')
  }, 90_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  beforeEach(async () => {
    calls.length = 0
    stored.clear()
    for (const id of ['msg-100', 'msg-101', 'msg-110']) stored.add(`eco-3/${id}`)
    deleteDocument.mockClear()
    setDocumentValidity.mockClear()
    // Conversation 10: two turns in the corpus (one still embedding), one that
    // never went, and a rating. Conversation 11 is someone else's bystander.
    await pg.db.execute(sql.raw(`
      DROP TRIGGER IF EXISTS fail_session_commit ON sessions;
      TRUNCATE ratings, messages, sessions, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, 'erase-owner@example.invalid'), (2, 'erase-other@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (3, 'Org tres', 'tres');
      INSERT INTO sessions (id, user_id, organization_id) VALUES (10, 1, 3), (11, 2, 3);
      INSERT INTO messages (id, session_id, role, content, corpus_status) VALUES
        (100, 10, 'user', 'q', 'ingested'),
        (101, 10, 'assistant', 'a', 'embedding'),
        (102, 10, 'user', 'x', 'pending'),
        (110, 11, 'user', 'other', 'ingested');
      INSERT INTO ratings (message_id, session_id, organization_id, user_id, stars) VALUES (101, 10, 3, 1, 4);
    `))
  })

  it('🔴 retires in the transaction, then ERASES each turn after commit', async () => {
    await payload.delete({ collection: 'sessions', id: 10, overrideAccess: true })

    expect(await ids('sessions')).toEqual([11])
    expect(await ids('messages')).toEqual([110])
    expect(await eventually(async () => deleteDocument.mock.calls.length === 2)).toBe(true)
    expect(erased()).toEqual(['eco-3 msg-100', 'eco-3 msg-101'])
    // Retire first (immediate hide), erase second (permanent).
    expect(calls.slice(0, 2).every((c) => c.startsWith('retire '))).toBe(true)
    expect(calls.slice(2).every((c) => c.startsWith('delete '))).toBe(true)
  }, 30_000)

  it('🔴 upgrade tripwire: the schedule-time log carries a real txid and every turn id', async () => {
    const info = vi.spyOn(payload.logger, 'info')
    try {
      await payload.delete({ collection: 'sessions', id: 10, overrideAccess: true })
      const scheduled = info.mock.calls.find((c) => String(c[1]).includes('scheduled post-commit turn erasure'))
      expect(scheduled?.[0]).toMatchObject({
        sessionId: '10',
        xid: expect.stringMatching(/^\d+$/),
        corpus: 'eco-3',
        turnIds: ['msg-100', 'msg-101'],
      })
      expect(await eventually(async () => deleteDocument.mock.calls.length === 2)).toBe(true)
    } finally {
      info.mockRestore()
    }
  }, 30_000)

  it('🔴 a COMMIT that fails erases nothing: the turns stay retired, the conversation stays', async () => {
    await pg.db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION refuse_session_delete() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'forced commit failure'; END $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER fail_session_commit AFTER DELETE ON sessions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_session_delete();
    `))

    await payload.delete({ collection: 'sessions', id: 10, overrideAccess: true }).catch(() => {})
    await delay(OUTLAST_ERASE_MS)

    expect(await ids('sessions')).toEqual([10, 11])
    expect(await ids('messages')).toEqual([100, 101, 102, 110])
    expect(setDocumentValidity).toHaveBeenCalledTimes(2)
    expect(deleteDocument).not.toHaveBeenCalled()
  }, 30_000)

  it('the janitor’s delete (uploads kept) still erases the turns', async () => {
    await payload.delete({
      collection: 'sessions',
      id: 10,
      overrideAccess: true,
      context: { [KEEP_CONVERSATION_UPLOADS]: true },
    })

    expect(await eventually(async () => deleteDocument.mock.calls.length === 2)).toBe(true)
    expect(erased()).toEqual(['eco-3 msg-100', 'eco-3 msg-101'])
  }, 30_000)

  it('🔴 a non-owner’s delete retires nothing and erases nothing', async () => {
    const other = await payload.findByID({ collection: 'users', id: 2, overrideAccess: true })

    await expect(
      payload.delete({ collection: 'sessions', id: 10, overrideAccess: false, user: other }),
    ).rejects.toMatchObject({ status: 403 })
    await delay(OUTLAST_ERASE_MS)

    expect(await ids('messages')).toEqual([100, 101, 102, 110])
    expect(setDocumentValidity).not.toHaveBeenCalled()
    expect(deleteDocument).not.toHaveBeenCalled()
  }, 30_000)

  it('a bulk delete of two conversations erases the turns of both', async () => {
    const result = await payload.delete({
      collection: 'sessions',
      where: { id: { in: [10, 11] } },
      overrideAccess: true,
    })
    expect(result.errors).toEqual([])

    expect(await eventually(async () => deleteDocument.mock.calls.length === 3)).toBe(true)
    expect(erased()).toEqual(['eco-3 msg-100', 'eco-3 msg-101', 'eco-3 msg-110'])
  }, 30_000)

  it('🔴 RACE: deleted while embedding, the turn lands late, and the callback erases it', async () => {
    // msg-101 is `embedding`: ai-service has not created its document yet.
    stored.delete('eco-3/msg-101')
    const secret = 'e'.repeat(64)
    process.env.CALLBACK_SECRET = secret

    await payload.delete({ collection: 'sessions', id: 10, overrideAccess: true })
    // The post-commit erase ran: msg-100 gone, msg-101 not there to erase.
    expect(await eventually(async () => deleteDocument.mock.calls.length === 2)).toBe(true)
    expect([...stored]).toEqual(['eco-3/msg-110'])

    // ai-service's worker now lands msg-101, LIVE, and sends its callback.
    stored.add('eco-3/msg-101')
    const body = JSON.stringify({
      event: 'ingest.completed',
      ingestId: 'ing-late',
      docId: 'msg-101',
      corpus: 'eco-3',
    })
    const timestamp = Math.floor(Date.now() / 1000)
    const { POST } = await import('@/app/api/ai-service/callback/route')
    const res = await POST(
      new Request('http://backend.test/api/ai-service/callback', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-aiservice-timestamp': String(timestamp),
          'x-aiservice-signature': signCallback({ timestamp, body, secret }),
        },
      }),
    )

    expect(res.status).toBe(200)
    expect([...stored]).toEqual(['eco-3/msg-110'])
    expect(await ids('messages')).toEqual([110])
  }, 30_000)
})
