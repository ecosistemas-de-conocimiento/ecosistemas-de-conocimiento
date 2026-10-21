/**
 * THE THREE DELETE PATHS RATINGS USED TO BREAK — AGAINST A REAL POSTGRES.
 *
 * Audit 2026-10-17 §3 item 9 (`plan/borradores-por-conversacion.md` §8): a
 * rated message, an ecosistema with ratings and a user who ever rated could
 * not be deleted, because every `ratings` FK was `ON DELETE set null` on a NOT
 * NULL column (23502). `20261020_193707_ratings_fk_cascade` makes them
 * `cascade`. This suite pins that, and pins what still blocks a user or an
 * ecosistema delete, so nobody reads "ratings fixed" as "accounts deletable".
 *
 * Harness: `lib/testing/realPostgres.ts`. No docker → SKIPS.
 */

import { sql } from '@payloadcms/db-postgres'
import type { MigrateDownArgs, MigrateUpArgs } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { migrations } from '../migrations'
import {
  bootPayload,
  dockerOk,
  rowsOf,
  shutdown,
  startRealPostgres,
  type RealPostgres,
} from '../lib/testing/realPostgres'

if (!dockerOk) console.warn('[Ratings.deletePaths.pg.test] docker is not usable — the real-Postgres tests SKIP.')

const MIGRATION = '20261020_193707_ratings_fk_cascade'

let pg: RealPostgres
let payload: Payload

const ids = async (table: string): Promise<number[]> =>
  (await rowsOf(pg.db, sql.raw(`SELECT id FROM ${table} ORDER BY id`))).map((r) => Number(r.id))

/** The Postgres error code a raw statement fails with, or 'ok'. */
const outcomeOf = async (statement: string): Promise<string> =>
  pg.db.execute(sql.raw(statement)).then(
    () => 'ok',
    (err: unknown) =>
      String((err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code),
  )

const ratingsDeleteRules = async (): Promise<Record<string, string>> =>
  Object.fromEntries(
    (
      await rowsOf(
        pg.db,
        sql`SELECT conname, confdeltype FROM pg_constraint
            WHERE conrelid = 'ratings'::regclass AND contype = 'f' ORDER BY conname`,
      )
    ).map((r) => [String(r.conname), String(r.confdeltype)]),
  )

describe.skipIf(!dockerOk)('ratings no longer block a delete, on a real Postgres', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-ratings-pg-${process.pid}`, 'ratings_test')
    payload = await bootPayload(pg.url, 'ratings-delete-paths-secret')
  }, 90_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  beforeEach(async () => {
    // User 1 owns conversation 10 in ecosistema 1 and rated its answer 101.
    // User 2 and ecosistema 2 carry ONLY ratings (written by SQL, below the
    // app's rules), so the ratings FKs are the only thing between them and a
    // delete.
    await pg.db.execute(sql.raw(`
      TRUNCATE ratings, messages, sessions, memberships, organizations, users RESTART IDENTITY CASCADE;
      INSERT INTO users (id, email) VALUES (1, 'rater@example.invalid'), (2, 'only-ratings@example.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Org uno', 'uno'), (2, 'Org dos', 'dos');
      INSERT INTO memberships (user_id, organization_id) VALUES (1, 1);
      INSERT INTO sessions (id, user_id, organization_id) VALUES (10, 1, 1);
      INSERT INTO messages (id, session_id, role, content) VALUES
        (100, 10, 'user', 'q'), (101, 10, 'assistant', 'a'), (102, 10, 'assistant', 'b');
      INSERT INTO ratings (id, message_id, session_id, organization_id, user_id, stars) VALUES
        (1, 101, 10, 1, 1, 4),
        (2, 102, 10, 1, 2, 2),
        (3, 102, 10, 2, 1, 5);
    `))
  })

  it('🔴 every ratings foreign key is ON DELETE CASCADE', async () => {
    expect(await ratingsDeleteRules()).toEqual({
      ratings_message_id_messages_id_fk: 'c',
      ratings_organization_id_organizations_id_fk: 'c',
      ratings_session_id_sessions_id_fk: 'c',
      ratings_user_id_users_id_fk: 'c',
    })
  })

  it('🔴 a rated message can be deleted through Payload, and its rating goes with it', async () => {
    await payload.delete({ collection: 'messages', id: 101, overrideAccess: true })

    expect(await ids('messages')).toEqual([100, 102])
    expect(await ids('ratings')).toEqual([2, 3])
  }, 30_000)

  it('🔴 a user whose only rows are ratings can be deleted; the ratings are deleted, not anonymised', async () => {
    expect(await outcomeOf('DELETE FROM users WHERE id = 2')).toBe('ok')

    expect(await ids('users')).toEqual([1])
    expect(await ids('ratings')).toEqual([1, 3])
  })

  it('an ecosistema whose only rows are ratings can be deleted, with its ratings', async () => {
    expect(await outcomeOf('DELETE FROM organizations WHERE id = 2')).toBe('ok')

    expect(await ids('ratings')).toEqual([1, 2])
  })

  it('a conversation delete still works, and still removes its ratings', async () => {
    await payload.delete({ collection: 'sessions', id: 10, overrideAccess: true })

    expect(await ids('sessions')).toEqual([])
    expect(await ids('ratings')).toEqual([])
  }, 30_000)

  it('⚠ a user with a conversation is STILL refused: other foreign keys, not ratings', async () => {
    // 23502 = not_null_violation: sessions/memberships `user_id` is NOT NULL +
    // SET NULL. Out of scope here; it needs a product decision.
    expect(await outcomeOf('DELETE FROM users WHERE id = 1')).toBe('23502')
    expect(await outcomeOf('DELETE FROM organizations WHERE id = 1')).toBe('23502')
    expect(await ids('ratings')).toEqual([1, 2, 3])
  })

  it('no ratings column is left in the README’s 23502 query', async () => {
    const left = await rowsOf(
      pg.db,
      sql`SELECT c.conrelid::regclass::text AS tbl, a.attname
          FROM pg_constraint c
          JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          WHERE c.contype = 'f' AND c.confdeltype = 'n' AND a.attnotnull AND c.conrelid = 'ratings'::regclass`,
    )
    expect(left).toEqual([])
  })

  it('down() restores SET NULL and up() re-applies CASCADE', async () => {
    const m = migrations.find((x) => x.name === MIGRATION)
    expect(m).toBeDefined()
    try {
      await m!.down({ db: pg.db, payload: {}, req: {} } as unknown as MigrateDownArgs)
      expect(Object.values(await ratingsDeleteRules())).toEqual(['n', 'n', 'n', 'n'])
      // The old failure, reproduced: a rated message cannot be deleted.
      expect(await outcomeOf('DELETE FROM messages WHERE id = 101')).toBe('23502')
    } finally {
      await m!.up({ db: pg.db, payload: {}, req: {} } as unknown as MigrateUpArgs)
    }
    expect(Object.values(await ratingsDeleteRules())).toEqual(['c', 'c', 'c', 'c'])
  })
})
