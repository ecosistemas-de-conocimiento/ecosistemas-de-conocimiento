/**
 * 🔴 A STUDENT'S CONSENT ROW AND SUGGESTIONS NO LONGER BLOCK A DELETE — real Postgres.
 *
 * Audit 2026-10-27 item 5: `20261027_053800_student_view` gave the NOT NULL
 * `student_profiles.user_id` / `organization_id` and `suggestions.author_id` /
 * `organization_id` `ON DELETE set null` foreign keys, so Postgres refused
 * (23502) to delete a user or an ecosistema that had one.
 * `20261027_061014_student_view_fk_cascade` fixes it: consent rows cascade,
 * a suggestion stays and loses its author (anonymous), an ecosistema's go.
 *
 * ⚠ A real student also has a `memberships` row, which still refuses a user
 * delete (README's 23502 query). Not this migration's job.
 *
 * Harness: `lib/testing/realPostgres.ts`. No docker → SKIPS.
 */

import { sql } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dockerOk, rowsOf, startRealPostgres, type RealPostgres } from '../lib/testing/realPostgres'

if (!dockerOk) console.warn('[StudentProfiles.deletePaths.pg.test] docker is not usable — SKIP.')

let pg: RealPostgres | undefined

const outcomeOf = async (statement: string): Promise<string> =>
  pg!.db.execute(sql.raw(statement)).then(
    () => 'ok',
    (err: unknown) => String((err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code),
  )

const deleteRules = async (table: string): Promise<Record<string, string>> =>
  Object.fromEntries(
    (
      await rowsOf(
        pg!.db,
        sql.raw(`SELECT conname, confdeltype FROM pg_constraint
                  WHERE conrelid = '${table}'::regclass AND contype = 'f' ORDER BY conname`),
      )
    ).map((r) => [String(r.conname), String(r.confdeltype)]),
  )

describe.skipIf(!dockerOk)('student view rows do not block a delete (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-student-fk-pg-${process.pid}`, 'student_fk_test')
    // User 2 and ecosistema 9 carry ONLY student-view rows.
    await pg.db.execute(
      sql.raw(`
      INSERT INTO users (id, email) VALUES (1, 'a@x.invalid'), (2, 'b@x.invalid');
      INSERT INTO organizations (id, name, slug) VALUES (8, 'Semiosis', 'semiosis'), (9, 'Otra', 'otra');
      INSERT INTO student_profiles (id, user_id, organization_id, share_with_peers) VALUES
        (1, 1, 8, true), (2, 2, 8, true), (3, 1, 9, true);
      INSERT INTO suggestions (id, organization_id, author_id, kind, text) VALUES
        (1, 8, 2, 'contenido', 'más lecturas'), (2, 9, 1, 'interaccion', 'otra');
    `),
    )
  }, 120_000)

  afterAll(async () => {
    await (pg?.db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    pg?.stop()
  })

  it('🔴 consent rows cascade; a suggestion keeps its row and loses its author', async () => {
    expect(await deleteRules('student_profiles')).toEqual({
      student_profiles_organization_id_organizations_id_fk: 'c',
      student_profiles_user_id_users_id_fk: 'c',
    })
    expect(await deleteRules('suggestions')).toEqual({
      suggestions_author_id_users_id_fk: 'n',
      suggestions_organization_id_organizations_id_fk: 'c',
    })
    const nullable = await rowsOf(
      pg!.db,
      sql`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'suggestions' AND column_name = 'author_id'`,
    )
    expect(nullable).toEqual([{ is_nullable: 'YES' }])
  })

  it('🔴 a user with a consent row and a suggestion can be deleted', async () => {
    expect(await outcomeOf('DELETE FROM users WHERE id = 2')).toBe('ok')
    expect(await rowsOf(pg!.db, sql`SELECT id FROM student_profiles ORDER BY id`)).toEqual([{ id: 1 }, { id: 3 }])
    expect(await rowsOf(pg!.db, sql`SELECT id, author_id FROM suggestions ORDER BY id`)).toEqual([
      { id: 1, author_id: null },
      { id: 2, author_id: 1 },
    ])
  })

  it('an ecosistema whose only rows are student-view rows can be deleted, with them', async () => {
    expect(await outcomeOf('DELETE FROM organizations WHERE id = 9')).toBe('ok')
    expect(await rowsOf(pg!.db, sql`SELECT id FROM student_profiles ORDER BY id`)).toEqual([{ id: 1 }])
    expect(await rowsOf(pg!.db, sql`SELECT id FROM suggestions ORDER BY id`)).toEqual([{ id: 1 }])
  })
})
