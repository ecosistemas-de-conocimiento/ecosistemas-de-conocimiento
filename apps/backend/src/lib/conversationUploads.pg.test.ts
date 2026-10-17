/**
 * DELETING A CONVERSATION DELETES ITS OWN UPLOADS — AGAINST A REAL POSTGRES.
 *
 * `Sessions.cascade.test.ts` pins the rule against a fake Payload. This file
 * pins what a fake cannot:
 *
 *   · the QUERIES `lib/conversationUploads.ts` sends are ones
 *     `@payloadcms/drizzle` accepts (a rejected `where` throws and makes every
 *     conversation with an upload undeletable);
 *   · 🔴 a non-owner's delete touches NOTHING — Payload 3.88 runs
 *     `beforeDelete` before it applies `ownOnly`;
 *   · 🔴 files and ai-service documents go only AFTER commit: a delete that
 *     fails, or whose commit fails, leaves the rows AND the file.
 *   · the 2026-10-17 rulings: a held testimonio draft goes with its review
 *     rows, `uploadedInSession` decides where a document came from, and a
 *     document deleted ON ITS OWN takes its file with it, after commit.
 *
 * Same harness as `documentColumns.pg.test.ts`: a throwaway
 * `postgres:16-alpine` on a kernel-assigned port with `--tmpfs` (no volume is
 * left behind), the production baseline migration, then the real Payload
 * config booted against it. Files go to local disk (no `S3_*` set), under
 * `./media/` with names unique to this process. ai-service is a spy.
 *
 * ⚠ No docker → the suite SKIPS, with a console warning naming the reason.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { sql } from '@payloadcms/db-postgres'
import { drizzle } from '@payloadcms/db-postgres/drizzle/node-postgres'
import type { MigrateUpArgs } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const deleteDocument = vi.fn(async (_corpus: string, _id: string) => ({ deleted: true }))
const setDocumentValidity = vi.fn(async () => ({ ok: true }))
vi.mock('@/lib/aiClient', () => ({
  getAdminAIClient: () => ({ admin: { deleteDocument, setDocumentValidity } }),
}))

// Every migration, not the baseline alone: the booted config expects the
// columns later ones add (`documents.uploaded_in_session_id`).
import { migrations } from '../migrations'

const CONTAINER = `edc-backend-conv-uploads-pg-${process.pid}`
const IMAGE = 'postgres:16-alpine'

function hasDocker(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

const dockerOk = hasDocker()
if (!dockerOk) {
  console.warn('[conversationUploads.pg.test] docker is not usable — the real-Postgres tests SKIP.')
}

type Db = ReturnType<typeof drizzle>
let db: Db
let payload: Payload

function stopContainer(): void {
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
}

async function startPostgres(): Promise<string> {
  stopContainer()
  const run = spawnSync(
    'docker',
    [
      'run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data', '--name', CONTAINER, '-p', '0:5432',
      '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=conv_uploads_test', IMAGE,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  const port = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' })
    .stdout.split('\n')[0]?.trim().split(':').pop()
  if (!port) throw new Error('could not read the container port')
  return `postgres://postgres:postgres@127.0.0.1:${port}/conv_uploads_test`
}

async function waitForQueries(candidate: Db): Promise<void> {
  const deadline = Date.now() + 25_000
  let last: unknown
  while (Date.now() < deadline) {
    try {
      await candidate.execute(sql`select 1`)
      return
    } catch (err) {
      last = err
      await delay(300)
    }
  }
  throw new Error(`postgres never answered: ${String(last)}`)
}

const rows = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
  ((await db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows

const ids = async (
  table: 'documents' | 'media' | 'sessions' | 'messages' | 'anonymisation_reviews',
): Promise<number[]> =>
  (await rows(sql.raw(`SELECT id FROM ${table} ORDER BY id`))).map((r) => Number(r.id))

/** Poll until `check` holds; the file/ai-service half runs after commit, asynchronously. */
async function eventually(check: () => Promise<boolean>, ms = 8_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await delay(100)
  }
  return false
}

/**
 * How long a "nothing must happen" test waits before looking. The cleanup
 * acts as soon as `txid_status` answers `committed` or `aborted`, which on a
 * local container is the first poll (250 ms); 6 s is a wide margin, chosen,
 * not measured.
 */
const OUTLAST_CLEANUP_MS = 6_000

const OPENED = '2026-10-17T10:00:00.000Z'
const LATER = '2026-10-17T10:05:00.000Z'

// Payload's default `staticDir` for `media` is the slug, relative to cwd.
const MEDIA_DIR = path.resolve(process.cwd(), 'media')
const fileName = (tag: string) => `conv-uploads-test-${process.pid}-${tag}.pdf`
const FILE_A = fileName('a')
const FILE_B = fileName('b')
const FILE_C = fileName('c')
const FILE_D = fileName('d')
const FILE_E = fileName('e')
const fileA = path.join(MEDIA_DIR, FILE_A)
const fileB = path.join(MEDIA_DIR, FILE_B)
const fileC = path.join(MEDIA_DIR, FILE_C)
const fileD = path.join(MEDIA_DIR, FILE_D)
const fileE = path.join(MEDIA_DIR, FILE_E)
const ALL_FILES = [fileA, fileB, fileC, fileD, fileE]

describe.skipIf(!dockerOk)('deleting a conversation on a real Postgres', () => {
  beforeAll(async () => {
    const url = await startPostgres()
    db = drizzle(url)
    await waitForQueries(db)
    for (const m of migrations) await m.up({ db, payload: {}, req: {} } as unknown as MigrateUpArgs)

    process.env.DATABASE_URI = url
    process.env.PAYLOAD_SECRET = 'conv-uploads-test-secret'
    // The boot sweeps are not under test, and would poll this database.
    for (const v of [
      'TRANSCRIPTION_JANITOR_ENABLED',
      'PUBLISH_JANITOR_ENABLED',
      'EMBEDDING_JANITOR_ENABLED',
      'INGEST_RECOVERY_JANITOR_ENABLED',
    ]) {
      process.env[v] = 'false'
    }
    const { getPayload } = await import('payload')
    const { default: config } = await import('@payload-config')
    payload = await getPayload({ config })
    mkdirSync(MEDIA_DIR, { recursive: true })
  }, 90_000)

  beforeEach(async () => {
    deleteDocument.mockClear()
    setDocumentValidity.mockClear()
    for (const file of ALL_FILES) writeFileSync(file, 'not a real pdf')
    // `sql.raw`: several statements in one call need the simple query protocol,
    // which a parameterised query cannot use.
    await db.execute(sql.raw(`
      DROP TRIGGER IF EXISTS fail_session_delete ON sessions;
      DROP TRIGGER IF EXISTS fail_session_commit ON sessions;
      DROP TRIGGER IF EXISTS fail_document_commit ON documents;
      TRUNCATE documents, documents_rels, media, sessions, sessions_rels, messages, messages_rels,
               ratings, anonymisation_reviews, memberships, organizations, users, payload_migrations
               RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, 'uploads-owner@example.invalid'), (2, 'uploads-other@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Org uno', 'uno');
      INSERT INTO sessions (id, user_id, organization_id, created_at) VALUES
        (10, 1, 1, '${OPENED}'), (11, 1, 1, '${OPENED}'), (12, 1, 1, '${OPENED}'), (13, 1, 1, '${OPENED}');
      INSERT INTO media (id, uploaded_by_id, filename) VALUES
        (70, 1, '${FILE_A}'), (71, 1, '${FILE_B}'), (72, 1, '${FILE_C}'), (73, 1, '${FILE_D}');
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, media_file_id, created_at) VALUES
        (50, 1, 1, 'solo', 'pdf', 70, '${LATER}'),
        (51, 1, 1, 'shared', 'pdf', 71, '${LATER}'),
        (52, 1, 1, 'scoped', 'markdown', NULL, '${LATER}'),
        (53, 1, 1, 'solo-12', 'pdf', 72, '${LATER}'),
        (54, 1, 1, 'solo-13', 'pdf', 73, '${LATER}');
      INSERT INTO documents_rels (parent_id, path, sessions_id, "order") VALUES
        (50, 'session', 10, 1), (51, 'session', 10, 1), (51, 'session', 11, 2), (52, 'session', 10, 1),
        (53, 'session', 12, 1), (54, 'session', 13, 1);
      INSERT INTO sessions_rels (parent_id, path, documents_id, "order") VALUES
        (11, 'contextScope', 52, 1);
    `))
  })

  afterAll(async () => {
    // ⚠ Payload's pool cannot be ended: `@payloadcms/db-postgres` 3.88.0
    // `connect.js` checks out a client at boot and never releases it, so
    // `pool.end()` waits forever. Instead, listen for the "Connection
    // terminated" each of its clients emits when the container goes, so it is
    // not reported as an unhandled error.
    const pool = (payload?.db as unknown as {
      pool?: { on(e: 'error', f: () => void): void; _clients?: Array<{ on(e: 'error', f: () => void): void }> }
    })?.pool
    pool?.on('error', () => {})
    for (const client of pool?._clients ?? []) client.on('error', () => {})
    await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    stopContainer()
    for (const file of ALL_FILES) rmSync(file, { force: true })
  })

  it('🔴 a bulk delete of 3 conversations cleans up all 3', async () => {
    // Payload's bulk delete runs the row hooks concurrently on ONE req
    // (`collections/operations/delete.js`, 3.88.0). Plans keyed on one shared
    // slot overwrote each other there.
    const result = await payload.delete({
      collection: 'sessions',
      where: { id: { in: [10, 12, 13] } },
      overrideAccess: true,
    })
    expect(result.errors).toEqual([])

    expect(await ids('sessions')).toEqual([11])
    expect(await ids('documents')).toEqual([51, 52])
    expect(await eventually(async () => (await ids('media')).join() === '71')).toBe(true)
    expect([fileA, fileC, fileD].map(existsSync)).toEqual([false, false, false])
    expect(existsSync(fileB)).toBe(true)
    expect(deleteDocument.mock.calls.map((c) => c[1]).sort()).toEqual(['50', '50', '53', '53', '54', '54'])
  }, 30_000)

  it('🔴 a half-failed bulk delete: the conversation that survived keeps its file and ai-service doc', async () => {
    // Session 13's own row delete throws after its beforeDelete ran; Payload
    // 3.88 bulk delete collects the error and commits the rest. Session 13's
    // upload ROW (54) went in the shared transaction, but its file and
    // ai-service document must stay.
    //
    // ⚠ The throw is in JS (the adapter's `deleteOne`), not a database trigger.
    // A trigger error aborts the whole Postgres transaction, so all three
    // conversations survive (measured on this suite 2026-10-17). A JS-level
    // failure leaves the transaction usable, which is the case that commits.
    const realDeleteOne = payload.db.deleteOne.bind(payload.db)
    const spy = vi.spyOn(payload.db, 'deleteOne').mockImplementation(async (args) => {
      const where = JSON.stringify(args.where)
      if (args.collection === 'sessions' && where.includes('13')) throw new Error('forced failure for 13')
      return realDeleteOne(args)
    })

    let result: Awaited<ReturnType<typeof payload.delete>>
    try {
      result = await payload.delete({
        collection: 'sessions',
        where: { id: { in: [10, 12, 13] } },
        overrideAccess: true,
      })
    } finally {
      spy.mockRestore()
    }
    await delay(OUTLAST_CLEANUP_MS)

    expect(result.errors.map((e) => Number(e.id))).toEqual([13])
    expect(await ids('sessions')).toEqual([11, 13])
    // The others were cleaned…
    expect([fileA, fileC].map(existsSync)).toEqual([false, false])
    // …13's file and ai-service document were not.
    expect(existsSync(fileD)).toBe(true)
    expect(await ids('media')).toContain(73)
    expect(deleteDocument.mock.calls.map((c) => c[1])).not.toContain('54')
  }, 30_000)

  it('🔴 upgrade tripwire: a real delete’s plan carries a non-null txid', async () => {
    // If `payload.db.sessions` changes shape, `currentTxid` returns null and
    // every cleanup is silently skipped. The schedule-time log carries the xid.
    const info = vi.spyOn(payload.logger, 'info')
    try {
      await payload.delete({ collection: 'sessions', id: 10, overrideAccess: true })
      const scheduled = info.mock.calls.find((c) => String(c[1]).includes('scheduled post-commit'))
      expect(scheduled?.[0]).toMatchObject({ sessionId: '10', xid: expect.stringMatching(/^\d+$/) })
    } finally {
      info.mockRestore()
    }
  }, 30_000)

  it('🔴 a rolled-back attempt never runs its plan, even after a retry removes the row', async () => {
    // Attempt 1 fails at commit; its plan names document 50 and file A.
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION refuse_session_delete() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'forced commit failure'; END $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER fail_session_commit AFTER DELETE ON sessions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_session_delete();
    `))
    await payload.delete({ collection: 'sessions', id: 10, overrideAccess: true }).catch(() => {})

    // Meanwhile document 50 is attached to conversation 11 as well, so the
    // retry must keep it — and a stale plan that only asked "is session 10
    // gone?" would wipe its file.
    await db.execute(sql.raw(`
      DROP TRIGGER fail_session_commit ON sessions;
      INSERT INTO documents_rels (parent_id, path, sessions_id, "order") VALUES (50, 'session', 11, 2);
    `))
    await payload.delete({ collection: 'sessions', id: 10, overrideAccess: true })
    await delay(OUTLAST_CLEANUP_MS)

    expect(await ids('sessions')).toEqual([11, 12, 13])
    expect(await ids('documents')).toContain(50)
    expect(await ids('media')).toContain(70)
    expect(existsSync(fileA)).toBe(true)
    expect(deleteDocument.mock.calls.map((c) => c[1])).not.toContain('50')
  }, 30_000)

  it('deletes the upload that is only here, then its file and ai-service doc after commit', async () => {
    await payload.delete({ collection: 'sessions', id: 10, overrideAccess: true })

    expect(await ids('sessions')).toEqual([11, 12, 13])
    // 50: only here → gone. 51: also in session 11 → kept.
    // 52: in session 11's context scope (polymorphic query) → kept.
    expect(await ids('documents')).toEqual([51, 52, 53, 54])
    const rels = await rows(
      sql`SELECT parent_id, sessions_id FROM documents_rels WHERE parent_id IN (50, 51, 52) ORDER BY parent_id`,
    )
    expect(rels).toEqual([{ parent_id: 51, sessions_id: 11 }])

    // The irreversible half lands after commit.
    expect(await eventually(async () => (await ids('media')).join() === '71,72,73')).toBe(true)
    expect(existsSync(fileA)).toBe(false)
    expect(existsSync(fileB)).toBe(true)
    expect(deleteDocument.mock.calls.map((c) => c[1])).toEqual(['50', '50'])
  }, 30_000)

  it('keeps a document cited by a message in another conversation', async () => {
    await db.execute(sql.raw(`
      INSERT INTO messages (id, session_id, role, content) VALUES (90, 11, 'assistant', 'x');
      INSERT INTO messages_rels (parent_id, path, documents_id, "order") VALUES (90, 'contextRefs', 50, 1);
    `))

    await payload.delete({ collection: 'sessions', id: 10, overrideAccess: true })
    await delay(OUTLAST_CLEANUP_MS)

    expect(await ids('documents')).toEqual([50, 51, 52, 53, 54])
    expect(await ids('media')).toEqual([70, 71, 72, 73])
    expect(existsSync(fileA)).toBe(true)
  }, 30_000)

  it('keeps every upload when the janitor flag is set', async () => {
    const { KEEP_CONVERSATION_UPLOADS } = await import('./conversationUploads')

    await payload.delete({
      collection: 'sessions',
      id: 10,
      overrideAccess: true,
      context: { [KEEP_CONVERSATION_UPLOADS]: true },
    })

    expect(await ids('sessions')).toEqual([11, 12, 13])
    expect(await ids('documents')).toEqual([50, 51, 52, 53, 54])
    expect(await ids('media')).toEqual([70, 71, 72, 73])
  }, 30_000)

  it('🔴 a non-owner’s delete touches nothing: no file, no document, no ai-service call, no turn', async () => {
    await db.execute(sql.raw(`
      INSERT INTO messages (id, session_id, role, content, corpus_status)
        VALUES (91, 10, 'assistant', 'x', 'ingested');
    `))
    const other = await payload.findByID({ collection: 'users', id: 2, overrideAccess: true })

    await expect(
      payload.delete({ collection: 'sessions', id: 10, overrideAccess: false, user: other }),
    ).rejects.toMatchObject({ status: 403 })
    await delay(OUTLAST_CLEANUP_MS)

    expect(await ids('sessions')).toEqual([10, 11, 12, 13])
    expect(await ids('messages')).toEqual([91])
    expect(await ids('documents')).toEqual([50, 51, 52, 53, 54])
    expect(await ids('media')).toEqual([70, 71, 72, 73])
    expect(existsSync(fileA)).toBe(true)
    expect(deleteDocument).not.toHaveBeenCalled()
    expect(setDocumentValidity).not.toHaveBeenCalled()
  }, 30_000)

  it('🔴 a delete that fails after the row step leaves the rows AND the file', async () => {
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION refuse_session_delete() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'forced failure'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_session_delete BEFORE DELETE ON sessions
        FOR EACH ROW EXECUTE FUNCTION refuse_session_delete();
    `))

    await expect(
      payload.delete({ collection: 'sessions', id: 10, overrideAccess: true }),
    ).rejects.toThrow()
    await delay(OUTLAST_CLEANUP_MS)

    expect(await ids('documents')).toEqual([50, 51, 52, 53, 54])
    expect(await ids('media')).toEqual([70, 71, 72, 73])
    expect(existsSync(fileA)).toBe(true)
    expect(deleteDocument).not.toHaveBeenCalled()
  }, 30_000)

  it('🔴 a COMMIT that fails, after afterDelete scheduled the cleanup, leaves the rows AND the file', async () => {
    // A deferred constraint trigger fires at COMMIT, i.e. after every hook ran.
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION refuse_session_delete() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'forced commit failure'; END $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER fail_session_commit AFTER DELETE ON sessions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_session_delete();
    `))

    // Whether Payload surfaces a failed commit is its business; what matters
    // is what is left behind.
    await payload.delete({ collection: 'sessions', id: 10, overrideAccess: true }).catch(() => {})
    await delay(OUTLAST_CLEANUP_MS)

    expect(await ids('sessions')).toEqual([10, 11, 12, 13])
    expect(await ids('documents')).toEqual([50, 51, 52, 53, 54])
    expect(await ids('media')).toEqual([70, 71, 72, 73])
    expect(existsSync(fileA)).toBe(true)
    expect(deleteDocument).not.toHaveBeenCalled()
  }, 30_000)
  // ── 2026-10-17: testimonio drafts, uploadedInSession, standalone deletes ──

  /**
   * Conversation 14 holds one row per new rule:
   *   55 held testimonio draft, uploaded here, file E, a review row (95) left
   *      by an earlier decision → goes, with the review row and the file;
   *   56 published testimonio → kept;
   *   57 documento draft uploaded in conversation 11 (`uploadedInSession`)
   *      and shared here → kept;
   *   58 documento draft with no recorded origin, born after 14 → the old
   *      guess, unless the migration row says recording had begun.
   */
  async function seedConversation14(): Promise<void> {
    await db.execute(sql.raw(`
      INSERT INTO sessions (id, user_id, organization_id, created_at) VALUES (14, 1, 1, '${OPENED}');
      INSERT INTO media (id, uploaded_by_id, filename) VALUES (74, 1, '${FILE_E}');
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, content_kind,
                             anonymisation_status, publication_status, media_file_id,
                             uploaded_in_session_id, created_at) VALUES
        (55, 1, 1, 't-held', 'audio', 'testimonio', 'held', 'draft', 74, 14, '${LATER}'),
        (56, 1, 1, 't-pub', 'markdown', 'testimonio', 'ready', 'published', NULL, 14, '${LATER}'),
        (57, 1, 1, 'from-11', 'markdown', 'documento', 'n/a', 'draft', NULL, 11, '${LATER}'),
        (58, 1, 1, 'legacy', 'markdown', 'documento', 'n/a', 'draft', NULL, NULL, '${LATER}');
      INSERT INTO documents_rels (parent_id, path, sessions_id, "order") VALUES
        (55, 'session', 14, 1), (56, 'session', 14, 1), (57, 'session', 14, 1), (58, 'session', 14, 1);
      INSERT INTO anonymisation_reviews (id, document_id, organization_id, reviewer_id, decision)
        VALUES (95, 55, 1, 2, 'approved');
    `))
  }

  it('🔴 a held testimonio draft goes with its review row and its file; published and foreign-origin rows stay', async () => {
    await seedConversation14()

    await payload.delete({ collection: 'sessions', id: 14, overrideAccess: true })

    // 55 (held, here) and 58 (no origin, legacy guess) go; 56 published and
    // 57 uploaded in conversation 11 stay.
    expect((await ids('documents')).filter((id) => id >= 55)).toEqual([56, 57])
    expect(await ids('anonymisation_reviews')).toEqual([])
    expect(await eventually(async () => !(await ids('media')).includes(74))).toBe(true)
    expect(existsSync(fileE)).toBe(false)
    expect(deleteDocument.mock.calls.map((c) => c[1]).sort()).toEqual(['55', '55', '58', '58'])
  }, 30_000)

  it('🔴 no recorded origin on a row born AFTER the column’s migration ran → kept', async () => {
    await seedConversation14()
    // Recording began when conversation 14 was opened; 58 was born after.
    await db.execute(sql.raw(`
      INSERT INTO payload_migrations (name, batch, created_at, updated_at)
        VALUES ('20261017_231817_documents_uploaded_in_session', 2, '${OPENED}', '${OPENED}');
    `))

    await payload.delete({ collection: 'sessions', id: 14, overrideAccess: true })

    expect((await ids('documents')).filter((id) => id >= 55)).toEqual([56, 57, 58])
  }, 30_000)

  it('a chat upload records its conversation, and an update cannot re-point it', async () => {
    const owner = await payload.findByID({ collection: 'users', id: 1, overrideAccess: true })
    const created = await payload.create({
      collection: 'documents',
      data: { name: 'chat upload', kind: 'markdown', session: [12], uploadedInSession: 13 } as never,
      overrideAccess: false,
      user: owner,
    })
    const row = async () =>
      (await rows(sql`SELECT uploaded_in_session_id AS s FROM documents WHERE id = ${created.id}`))[0]?.s
    // The body's 13 is ignored: the origin is the one conversation named.
    expect(await row()).toBe(12)

    await payload.update({
      collection: 'documents',
      id: created.id,
      data: { name: 'renamed', uploadedInSession: 13 } as never,
      overrideAccess: false,
      user: owner,
    })
    expect(await row()).toBe(12)
  }, 30_000)

  it('🔴 a document deleted on its own takes its media row and file with it, after commit', async () => {
    const owner = await payload.findByID({ collection: 'users', id: 1, overrideAccess: true })

    await payload.delete({ collection: 'documents', id: 53, overrideAccess: false, user: owner })

    expect(await ids('documents')).toEqual([50, 51, 52, 54])
    expect(await eventually(async () => (await ids('media')).join() === '70,71,73')).toBe(true)
    expect(existsSync(fileC)).toBe(false)
    expect([fileA, fileB, fileD].map(existsSync)).toEqual([true, true, true])
  }, 30_000)

  it('keeps a file another surviving document still points at', async () => {
    await db.execute(sql.raw(`
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, media_file_id, created_at)
        VALUES (59, 1, 1, 'same file', 'pdf', 70, '${LATER}');
    `))

    await payload.delete({ collection: 'documents', id: 50, overrideAccess: true })
    await delay(OUTLAST_CLEANUP_MS)

    expect(await ids('documents')).not.toContain(50)
    expect(await ids('media')).toContain(70)
    expect(existsSync(fileA)).toBe(true)
  }, 30_000)

  it('🔴 never deletes someone else’s file a document points at', async () => {
    await db.execute(sql.raw(`UPDATE media SET uploaded_by_id = 2 WHERE id = 72;`))

    await payload.delete({ collection: 'documents', id: 53, overrideAccess: true })
    await delay(OUTLAST_CLEANUP_MS)

    expect(await ids('media')).toContain(72)
    expect(existsSync(fileC)).toBe(true)
  }, 30_000)

  it('🔴 a document delete whose COMMIT fails keeps the row AND the file', async () => {
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION refuse_document_delete() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'forced commit failure'; END $$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER fail_document_commit AFTER DELETE ON documents
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_document_delete();
    `))

    await payload.delete({ collection: 'documents', id: 53, overrideAccess: true }).catch(() => {})
    await delay(OUTLAST_CLEANUP_MS)

    expect(await ids('documents')).toContain(53)
    expect(await ids('media')).toContain(72)
    expect(existsSync(fileC)).toBe(true)
  }, 30_000)

  it('🔴 a bulk delete of 3 documents cleans up all 3 files', async () => {
    // Payload runs the row hooks concurrently on ONE req; each plans its own.
    const result = await payload.delete({
      collection: 'documents',
      where: { id: { in: [50, 53, 54] } },
      overrideAccess: true,
    })
    expect(result.errors).toEqual([])

    expect(await ids('documents')).toEqual([51, 52])
    expect(await eventually(async () => (await ids('media')).join() === '71')).toBe(true)
    expect([fileA, fileC, fileD].map(existsSync)).toEqual([false, false, false])
    expect(existsSync(fileB)).toBe(true)
  }, 30_000)

  it('a bulk delete of 2 documents sharing one file deletes it once, with no orphan warning', async () => {
    await db.execute(sql.raw(`
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, kind, media_file_id, created_at)
        VALUES (59, 1, 1, 'same file', 'pdf', 70, '${LATER}');
    `))
    const warn = vi.spyOn(payload.logger, 'warn')
    try {
      await payload.delete({ collection: 'documents', where: { id: { in: [50, 59] } }, overrideAccess: true })
      expect(await eventually(async () => !(await ids('media')).includes(70))).toBe(true)
      await delay(1_000)
      expect(existsSync(fileA)).toBe(false)
      expect(warn.mock.calls.filter((c) => String(c[1]).includes('orphan'))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  }, 30_000)

  it('🔴 a conversation delete plans each file ONCE: its documents plan none of their own', async () => {
    const info = vi.spyOn(payload.logger, 'info')
    try {
      await payload.delete({ collection: 'sessions', id: 10, overrideAccess: true })
      const scheduled = info.mock.calls.filter((c) => String(c[1]).includes('scheduled post-commit'))
      expect(scheduled.map((c) => String(c[1]))).toEqual(['[sessions] scheduled post-commit upload cleanup'])
      expect(await eventually(async () => !(await ids('media')).includes(70))).toBe(true)
    } finally {
      info.mockRestore()
    }
  }, 30_000)
})
