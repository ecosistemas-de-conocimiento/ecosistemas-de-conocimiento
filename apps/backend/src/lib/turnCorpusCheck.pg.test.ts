/**
 * THE TURN-CORPUS CHECK'S SQL, against a real Postgres.
 *
 * The backend database gets the real migrations. The ai-service side is a
 * second database in the same container with only the columns the check reads,
 * copied from `services/ai-service/src/db/schema/index.ts` (`corpora`,
 * `documents`, `chunks`). Seeded with the two dev cases the 2026-10-17 audit
 * measured (`msg-2`, `msg-11`) and the 2026-10-20 dev lane's microsecond
 * retire.
 *
 * Harness: `lib/testing/realPostgres.ts`. No docker → SKIPS.
 */

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { dockerOk, startRealPostgres, type Db, type RealPostgres } from './testing/realPostgres'
import { checkTurnCorpus, readOnlyUrl, sqlReaders } from './turnCorpusCheck'

if (!dockerOk) console.warn('[turnCorpusCheck.pg.test] docker is not usable — the real-Postgres tests SKIP.')

let pg: RealPostgres
let ai: Db
let aiReadOnly: Db

const PAST = '2026-10-01T00:00:00.000Z'
const FUTURE = '2099-01-01T00:00:00.000Z'

describe.skipIf(!dockerOk)('the turn-corpus check on a real Postgres', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-turn-check-pg-${process.pid}`, 'turn_check_backend')
    await pg.db.execute(sql.raw('CREATE DATABASE turn_check_ai'))
    ai = drizzle(pg.urlFor('turn_check_ai'))
    aiReadOnly = drizzle(readOnlyUrl(pg.urlFor('turn_check_ai')))

    await ai.execute(sql.raw(`
      CREATE TABLE corpora (id uuid PRIMARY KEY, org text NOT NULL, name text NOT NULL);
      CREATE TABLE documents (id uuid PRIMARY KEY, corpus_id uuid NOT NULL REFERENCES corpora(id),
        org text NOT NULL, external_id text, valid_from timestamptz, valid_to timestamptz);
      CREATE TABLE chunks (id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES documents(id),
        valid_from timestamptz, valid_to timestamptz);
      INSERT INTO corpora VALUES
        ('00000000-0000-0000-0000-00000000000a', 'edc-eco-1', 'eco-1'),
        ('00000000-0000-0000-0000-00000000000b', 'edc-eco-1', 'eco-1-draft-4');
      INSERT INTO documents VALUES
        -- msg-1: message exists, live. Fine.
        ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'edc-eco-1', 'msg-1', NULL, NULL),
        -- msg-2: message gone, doc retired, chunk LIVE (the dev case).
        ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'edc-eco-1', 'msg-2', NULL, '${PAST}'),
        -- msg-11: message gone, doc and chunk live.
        ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-00000000000a', 'edc-eco-1', 'msg-11', NULL, NULL),
        -- msg-3: message gone, everything retired (stored, hidden).
        ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'edc-eco-1', 'msg-3', NULL, '${PAST}'),
        -- msg-5: message gone, valid_to in the future = still live.
        ('00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000a', 'edc-eco-1', 'msg-5', NULL, '${FUTURE}'),
        -- document 57: retired at microsecond precision, its chunk not.
        ('00000000-0000-0000-0000-000000000057', '00000000-0000-0000-0000-00000000000a', 'edc-eco-1', '57', NULL, '2026-10-10T10:00:00.123456Z'),
        -- msg-4 in a draft corpus, message gone: reported, never auto-erased.
        ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000b', 'edc-eco-1', 'msg-4', NULL, NULL);
      INSERT INTO chunks VALUES
        ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', NULL, NULL),
        ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', NULL, NULL),
        ('10000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000011', NULL, NULL),
        ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000003', NULL, '${PAST}'),
        ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000005', NULL, '${FUTURE}'),
        ('10000000-0000-0000-0000-000000000057', '00000000-0000-0000-0000-000000000057', NULL, '2026-10-10T10:00:00.123Z'),
        ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000004', NULL, NULL);
    `))

    // Backend: only message 1 still exists.
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email) VALUES (1, 'check@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Org uno', 'uno');
      INSERT INTO sessions (id, user_id, organization_id) VALUES (10, 1, 1);
      INSERT INTO messages (id, session_id, role, content) VALUES (1, 10, 'user', 'q');
    `))
  }, 90_000)

  afterAll(async () => {
    for (const d of [ai, aiReadOnly, pg?.db]) {
      await (d as unknown as { $client?: { end(): Promise<void> } } | undefined)?.$client?.end()
    }
    pg?.stop()
  })

  it('🔴 finds the orphans and the mismatch, read-only by default', async () => {
    const lines: string[] = []
    const erase = vi.fn(async () => {})

    const report = await checkTurnCorpus({
      ...sqlReaders(aiReadOnly, pg.db),
      erase,
      log: (l) => lines.push(l),
      apply: false,
    })

    expect(report).toEqual({
      apply: false,
      turnDocs: 6,
      orphanLive: 4, // msg-2, msg-11, msg-5, msg-4
      orphanStored: 1, // msg-3
      validityMismatches: 2, // 57 (microseconds), msg-2 (doc retired, chunk live)
      erased: 0,
      eraseFailed: 0,
      skipped: 0,
    })
    expect(erase).not.toHaveBeenCalled()
    expect(lines.filter((l) => l.startsWith('orphan-live')).map((l) => l.split('doc=')[1]).sort()).toEqual([
      'msg-11',
      'msg-2',
      'msg-4',
      'msg-5',
    ])
    expect(lines.filter((l) => l.startsWith('validity-mismatch')).map((l) => l.split(' ')[3])).toEqual([
      'doc=57',
      'doc=msg-2',
    ])
  })

  it('with apply, erases only shared-corpus orphans', async () => {
    const erase = vi.fn(async () => {})

    const report = await checkTurnCorpus({ ...sqlReaders(aiReadOnly, pg.db), erase, log: () => {}, apply: true })

    expect(erase.mock.calls.map((c) => (c as unknown[]).join(' ')).sort()).toEqual([
      'eco-1 msg-11',
      'eco-1 msg-2',
      'eco-1 msg-3',
      'eco-1 msg-5',
    ])
    expect(report).toMatchObject({ erased: 4, skipped: 1 })
  })

  it('🔴 the backend connection the script opens refuses writes too, and still reads', async () => {
    const backendReadOnly = drizzle(readOnlyUrl(pg.urlFor('turn_check_backend')))
    try {
      const report = await checkTurnCorpus({
        ...sqlReaders(aiReadOnly, backendReadOnly),
        erase: async () => {},
        log: () => {},
        apply: false,
      })
      expect(report).toMatchObject({ turnDocs: 6, orphanLive: 4, orphanStored: 1 })

      const code = await backendReadOnly.execute(sql.raw(`DELETE FROM messages`)).then(
        () => 'ok',
        (err: unknown) =>
          String((err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code),
      )
      expect(code).toBe('25006') // read_only_sql_transaction
    } finally {
      await (backendReadOnly as unknown as { $client?: { end(): Promise<void> } }).$client?.end()
    }
  })

  it('🔴 the ai-service connection refuses writes', async () => {
    const code = await aiReadOnly.execute(sql.raw(`DELETE FROM chunks`)).then(
      () => 'ok',
      (err: unknown) =>
        String((err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code),
    )
    // 25006 = read_only_sql_transaction.
    expect(code).toBe('25006')
  })
})
