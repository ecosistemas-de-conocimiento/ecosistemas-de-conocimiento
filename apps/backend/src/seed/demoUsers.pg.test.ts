/**
 * The dev demo accounts (`seed/demoUsers.ts`) against a real Postgres: they
 * log in, they hold the right roles, a re-run changes nothing, and no password
 * reaches the logger.
 *
 * ⚠ No docker → the suite SKIPS.
 */

import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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

import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '../lib/testing/realPostgres'
import { demoUsersRefusal, renderCredentials, seedDemoUsers, writeCredentials } from './demoUsers'

let pg: RealPostgres
let payload: Payload

describe.skipIf(!dockerOk)('seed/demoUsers (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-demo-users-pg-${process.pid}`, 'demo_users_test')
    payload = await bootPayload(pg.url, 'demo-users-secret')
  })

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('refuses before writing when an ecosistema is missing, or outside dev', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'demo-users-'))
    const file = path.join(dir, '.env.demo-users')
    expect(await demoUsersRefusal(payload, file, { EDC_ENV: 'dev' })).toMatch(/6, 7, 8 do not exist/)
    expect(await demoUsersRefusal(payload, file, { EDC_ENV: 'prod' })).toBeTruthy()
    expect(await demoUsersRefusal(payload, '/nonexistent-dir-xyz/.env', { EDC_ENV: 'dev' })).toMatch(/does not exist/)
  })

  it('creates the four accounts with their roles and sample work; a re-run is a no-op', async () => {
    await pg.db.execute(sql.raw(`
      INSERT INTO organizations (id, name, slug) VALUES (6, 'Dengue A', 'dengue-a'), (7, 'Dengue B', 'dengue-b'), (8, 'Semiosis', 'semiosis');
      SELECT setval('organizations_id_seq', 100);
    `))
    const dir = mkdtempSync(path.join(tmpdir(), 'demo-users-'))
    const file = path.join(dir, '.env.demo-users')
    expect(await demoUsersRefusal(payload, file, { EDC_ENV: 'dev' })).toBeNull()

    const logged: string[] = []
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(payload.logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(JSON.stringify(args))
      }) as never)
    }

    const first = await seedDemoUsers(payload)
    expect(first.map((r) => r.status)).toEqual(['created', 'created', 'created', 'created'])
    writeCredentials(file, first)

    const roles = await rowsOf(
      pg.db,
      sql.raw(`SELECT u.email, m.organization_id AS org, m.role FROM memberships m JOIN users u ON u.id = m.user_id ORDER BY u.email, m.organization_id`),
    )
    expect(roles).toEqual([
      { email: 'estudiante1@ecosistemas.test', org: 8, role: 'estudiante' },
      { email: 'estudiante2@ecosistemas.test', org: 8, role: 'estudiante' },
      { email: 'investigador-dengue@ecosistemas.test', org: 6, role: 'investigador' },
      { email: 'investigador-dengue@ecosistemas.test', org: 7, role: 'investigador' },
      { email: 'investigador-semiosis@ecosistemas.test', org: 8, role: 'investigador' },
    ])
    const docs = await rowsOf(
      pg.db,
      sql.raw(`SELECT u.email, d.name, d.publication_status AS s, d.ingest_status AS i FROM documents d JOIN users u ON u.id = d.uploaded_by_id ORDER BY u.email`),
    )
    expect(docs.map((d) => [d.email, d.s, d.i])).toEqual([
      ['estudiante1@ecosistemas.test', 'draft', 'n/a'],
      ['estudiante2@ecosistemas.test', 'draft', 'n/a'],
    ])
    expect(docs[0]!.name).not.toBe(docs[1]!.name)

    // The file holds working credentials, 0600.
    const text = readFileSync(file, 'utf8')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const pw = /DEMO_ESTUDIANTE1_PASSWORD=(\S+)/.exec(text)?.[1]
    expect(pw).toBeTruthy()
    const login = await payload.login({ collection: 'users', data: { email: 'estudiante1@ecosistemas.test', password: pw! } })
    expect(login.token).toBeTruthy()

    // 🔴 No password anywhere in the logs.
    for (const r of first) for (const line of logged) expect(line).not.toContain(r.password!)

    // Re-run: nothing new, file line kept.
    const second = await seedDemoUsers(payload)
    expect(second.map((r) => r.status)).toEqual(['existing', 'existing', 'existing', 'existing'])
    writeCredentials(file, second)
    expect(readFileSync(file, 'utf8')).toContain(`DEMO_ESTUDIANTE1_PASSWORD=${pw}`)
    expect((await rowsOf(pg.db, sql.raw(`SELECT count(*)::int AS n FROM memberships`)))[0]!.n).toBe(5)
    expect((await rowsOf(pg.db, sql.raw(`SELECT count(*)::int AS n FROM documents`)))[0]!.n).toBe(2)

    // A role drifted by hand converges back.
    await pg.db.execute(sql.raw(`UPDATE memberships SET role = 'member' WHERE role = 'investigador'`))
    await seedDemoUsers(payload)
    expect((await rowsOf(pg.db, sql.raw(`SELECT count(*)::int AS n FROM memberships WHERE role = 'investigador'`)))[0]!.n).toBe(3)
  }, 60_000)

  it('🔴 the credentials file is written BEFORE any account; a failed write creates none', async () => {
    const late = { key: 'LATE', email: 'late@ecosistemas.test', displayName: 'Late', memberships: [{ organization: 8, role: 'estudiante' as const }] }
    const exists = async (): Promise<number> =>
      Number((await rowsOf(pg.db, sql.raw(`SELECT count(*)::int AS n FROM users WHERE email = '${late.email}'`)))[0]!.n)
    // The file cannot be written → no account, so no password is lost.
    await expect(
      seedDemoUsers(payload, { users: [late], beforeWrite: () => { throw new Error('disk full') } }),
    ).rejects.toThrow('disk full')
    expect(await exists()).toBe(0)

    const dir = mkdtempSync(path.join(tmpdir(), 'demo-users-'))
    const file = path.join(dir, '.env.demo-users')
    let accountsWhenWritten = -1
    await seedDemoUsers(payload, {
      users: [late],
      beforeWrite: async (planned) => {
        accountsWhenWritten = await exists()
        writeCredentials(file, planned)
      },
    })
    expect(accountsWhenWritten).toBe(0)
    expect(await exists()).toBe(1)
    const pw = /DEMO_LATE_PASSWORD=(\S+)/.exec(readFileSync(file, 'utf8'))?.[1]
    const login = await payload.login({ collection: 'users', data: { email: late.email, password: pw! } })
    expect(login.token).toBeTruthy()
    // Temp + rename: only the final file is left, 0600.
    expect(readdirSync(dir)).toEqual(['.env.demo-users'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
  }, 60_000)

  it('renderCredentials keeps unrelated lines and overwrites only this run', () => {
    const out = renderCredentials('# old\nOTHER=1\nDEMO_X_PASSWORD=old\n', [
      { key: 'X', email: 'x@e.test', status: 'reset', password: 'new' },
      { key: 'Y', email: 'y@e.test', status: 'existing' },
    ])
    expect(out).toContain('OTHER=1')
    expect(out).toContain('DEMO_X_PASSWORD=new')
    expect(out).not.toContain('DEMO_X_PASSWORD=old')
    expect(out).toContain('DEMO_Y_EMAIL=y@e.test')
    expect(out).not.toContain('DEMO_Y_PASSWORD')
  })
})
