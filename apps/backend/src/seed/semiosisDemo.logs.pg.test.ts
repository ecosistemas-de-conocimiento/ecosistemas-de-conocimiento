/**
 * P-07 (audit 2026-11-10): a trabajo the seed cannot write is logged by its
 * error's type, never by drizzle's message, which carries the essay in its
 * params. Real Postgres for the seed; the failing write is a `DrizzleQueryError`
 * built as in `lib/errorSummary.test.ts`. No docker → SKIPS.
 */
import { createRequire } from 'node:module'

import { DrizzleQueryError } from '@payloadcms/db-postgres/drizzle'
import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { bootPayload, dockerOk, shutdown, startRealPostgres, type RealPostgres } from '../lib/testing/realPostgres'
import { SEMIOSIS_STUDENTS } from './fixtures/semiosisTrabajos'
import { seedSemiosisDemo } from './semiosisDemo'

const SECRET = 'Me llamo Lucía Hernández y vivo con mi hermano Tomás Ruiz'
const requireFromPg = createRequire(
  createRequire(createRequire(import.meta.url).resolve('@payloadcms/db-postgres')).resolve('pg'),
)

function dbError(): Error {
  const { DatabaseError } = requireFromPg('pg-protocol') as {
    DatabaseError: new (message: string, length: number, name: string) => Error & Record<string, unknown>
  }
  const cause = new DatabaseError(`value too long, near "${SECRET}"`, 0, 'error')
  cause.code = '57P01'
  return new DrizzleQueryError('insert into "documents" ("body_markdown") values ($1)', [SECRET], cause)
}

let pg: RealPostgres
let payload: Payload

describe.skipIf(!dockerOk)('seed/semiosisDemo log lines (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-semiosis-logs-pg-${process.pid}`, 'semiosis_logs_test')
    payload = await bootPayload(pg.url, 'semiosis-logs-secret')
    await pg.db.execute(
      sql.raw(`INSERT INTO organizations (id, name, slug, features) VALUES (8, 'Semiosis', 'semiosis', '{"studentView": true}');
               SELECT setval('organizations_id_seq', 100);`),
    )
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('🔴 a trabajo whose write fails is logged without the query’s params', async () => {
    const create = payload.create.bind(payload)
    vi.spyOn(payload, 'create').mockImplementation(((args: { collection: string }) =>
      args.collection === 'documents' ? Promise.reject(dbError()) : create(args as never)) as never)

    const lines: string[] = []
    await seedSemiosisDemo(payload, {
      students: SEMIOSIS_STUDENTS.slice(0, 1),
      docContext: { __skipDocsExtract: true },
      log: (l) => lines.push(l),
    })
    const failed = lines.filter((l) => l.includes('failed:'))
    expect(failed.length).toBeGreaterThan(0)
    for (const line of failed) {
      expect(line).toContain('DrizzleQueryError(57P01)')
      expect(line).not.toContain('Lucía')
    }
  }, 120_000)
})
