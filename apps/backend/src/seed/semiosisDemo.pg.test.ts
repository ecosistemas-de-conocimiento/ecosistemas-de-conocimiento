/**
 * The Semiosis demo (`seed/semiosisDemo.ts`) against a real Postgres: nine
 * students in ecosistema 8 with consent, suggestions, conversations and their
 * trabajos filed AS THE STUDENT (so the participant rules apply), a re-run
 * changes nothing, and no password reaches the logger.
 *
 * 🔴 The pipeline (gate, ingest, graph) stays OFF here: `docContext` keeps the
 * extract hook from firing, so the test spends nothing.
 *
 * ⚠ No docker → the suite SKIPS.
 */

import { mkdtempSync } from 'node:fs'
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
import { DEMO_USERS, seedDemoUsers } from './demoUsers'
import { SEMIOSIS_STUDENTS } from './fixtures/semiosisTrabajos'
import { seedSemiosisDemo, semiosisDemoReadiness, type SemiosisChecks } from './semiosisDemo'

let pg: RealPostgres
let payload: Payload

const ok: SemiosisChecks = { missingCallbacks: () => [], aiProblem: () => null, graphDisabled: () => false }
const count = async (q: string): Promise<number> => Number((await rowsOf(pg.db, sql.raw(q)))[0]!.n)
const SKIP = { __skipDocsExtract: true }

describe.skipIf(!dockerOk)('seed/semiosisDemo (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-semiosis-demo-pg-${process.pid}`, 'semiosis_demo_test')
    payload = await bootPayload(pg.url, 'semiosis-demo-secret')
  })

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('refuses before writing: outside dev, no ecosistema 8, switches off, no callbacks, graph off', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'semiosis-demo-')), '.env.demo-users')
    const dev = { EDC_ENV: 'dev' }
    expect((await semiosisDemoReadiness(payload, file, { EDC_ENV: 'prod' }, ok)).refusal).toBeTruthy()
    expect((await semiosisDemoReadiness(payload, file, dev, ok)).refusal).toMatch(/ecosistema 8 does not exist/)

    await pg.db.execute(sql.raw(`INSERT INTO organizations (id, name, slug) VALUES (8, 'Semiosis', 'semiosis'); SELECT setval('organizations_id_seq', 100);`))
    expect((await semiosisDemoReadiness(payload, file, dev, ok)).refusal).toMatch(/studentView off/)

    await pg.db.execute(sql.raw(`UPDATE organizations SET features = '{"studentView": true}' WHERE id = 8`))
    const ready = await semiosisDemoReadiness(payload, file, dev, ok)
    expect(ready.refusal).toBeNull()
    expect(ready.warnings.join(' ')).toMatch(/keepPublicFigures off/)

    expect((await semiosisDemoReadiness(payload, file, dev, { ...ok, missingCallbacks: () => ['CALLBACK_SECRET'] })).refusal).toMatch(/callbacks/)
    expect((await semiosisDemoReadiness(payload, file, dev, { ...ok, aiProblem: () => 'no key' })).refusal).toMatch(/no key/)
    expect((await semiosisDemoReadiness(payload, file, dev, { ...ok, graphDisabled: () => true })).refusal).toMatch(/GRAPH_EXTRACT/)
    expect((await semiosisDemoReadiness(payload, '/nonexistent-dir-xyz/.env', dev, ok)).refusal).toMatch(/does not exist/)

    await pg.db.execute(sql.raw(`UPDATE organizations SET features = '{"studentView": true, "autoPublishMembers": false}' WHERE id = 8`))
    expect((await semiosisDemoReadiness(payload, file, dev, ok)).refusal).toMatch(/autoPublishMembers off/)
    await pg.db.execute(sql.raw(`UPDATE organizations SET features = '{"studentView": true, "keepPublicFigures": true}' WHERE id = 8`))
    const { invalidateFeatures } = await import('../lib/features')
    invalidateFeatures(8)
    expect(await semiosisDemoReadiness(payload, file, dev, ok)).toEqual({ refusal: null, warnings: [] })
  })

  it('seeds nine students with consent, suggestions, conversations and their trabajos; a re-run is a no-op', async () => {
    // estudiante1 already exists, as `seed:demo-users` left it on dev.
    const [old] = await seedDemoUsers(payload, { users: DEMO_USERS.filter((u) => u.key === 'ESTUDIANTE1') })
    expect(old!.status).toBe('created')

    const logged: string[] = []
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(payload.logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(JSON.stringify(args))
      }) as never)
    }

    const first = await seedSemiosisDemo(payload, { docContext: SKIP, log: (l) => logged.push(l) })
    expect(first.accounts.map((a) => a.status)).toEqual(['existing', ...Array(8).fill('created')])
    expect(first.accounts[0]!.password).toBeUndefined() // estudiante1 keeps its password
    expect(first.trabajos.every((t) => t.action === 'create')).toBe(true)

    // The kept password still logs in; the account now has its invented name.
    const login = await payload.login({ collection: 'users', data: { email: old!.email, password: old!.password! } })
    expect(login.user?.displayName).toBe(SEMIOSIS_STUDENTS[0]!.displayName)

    expect(await count(`SELECT count(*)::int AS n FROM memberships WHERE organization_id = 8 AND role::text = 'estudiante' AND is_active`)).toBe(9)
    expect(await count(`SELECT count(*)::int AS n FROM student_profiles WHERE organization_id = 8 AND share_with_peers AND share_activity`)).toBe(9)
    const suggestions = SEMIOSIS_STUDENTS.reduce((n, s) => n + s.sugerencias.length, 0)
    const conversations = SEMIOSIS_STUDENTS.reduce((n, s) => n + s.conversaciones.length, 0)
    expect(await count(`SELECT count(*)::int AS n FROM suggestions WHERE organization_id = 8 AND author_id IS NOT NULL`)).toBe(suggestions)
    // Each conversation belongs to its student, in ecosistema 8.
    expect(
      await count(`SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.organization_id = 8 AND u.email LIKE 'estudiante%'`),
    ).toBe(conversations)

    // 🔴 Every trabajo filed as the student's own upload: a gated documento draft
    // (`anonymise` set by the participant rule, not by the seed), queued for ingest.
    const docs = await rowsOf(
      pg.db,
      sql.raw(`SELECT d.name, u.email, d.content_kind AS k, d.publication_status AS p, d.ingest_status AS i, d.anonymise AS a, d.kind
                 FROM documents d JOIN users u ON u.id = d.uploaded_by_id
                WHERE d.organization_id = 8 AND d.ingest_status <> 'n/a'`), // not estudiante1's private sample note
    )
    expect(docs).toHaveLength(22)
    for (const d of docs) expect([d.k, d.p, d.i, d.a, d.kind]).toEqual(['documento', 'draft', 'pending', true, 'markdown'])
    for (const s of SEMIOSIS_STUDENTS) {
      expect(docs.filter((d) => d.email === s.email).map((d) => d.name).sort()).toEqual(s.trabajos.map((t) => t.name).sort())
    }

    // 🔴 No password anywhere in the logs.
    for (const a of first.accounts) if (a.password) for (const line of logged) expect(line).not.toContain(a.password)

    // Re-run: nothing new; fresh pending drafts are left to the pipeline.
    const second = await seedSemiosisDemo(payload, { docContext: SKIP })
    expect(second.accounts.every((a) => a.status === 'existing')).toBe(true)
    expect([second.renamed, second.profiles.created, second.profiles.updated, second.suggestions, second.conversations]).toEqual([0, 0, 0, 0, 0])
    expect(second.trabajos.every((t) => t.action === 'wait')).toBe(true)
    expect(await count(`SELECT count(*)::int AS n FROM documents WHERE organization_id = 8`)).toBe(22 + 1) // + the sample note
    expect(await count(`SELECT count(*)::int AS n FROM suggestions`)).toBe(suggestions)

    // A consent switched off by hand converges back on.
    await pg.db.execute(sql.raw(`UPDATE student_profiles SET share_activity = false`))
    const third = await seedSemiosisDemo(payload, { docContext: SKIP, trabajos: false })
    expect(third.profiles.updated).toBe(9)
  }, 120_000)
})
