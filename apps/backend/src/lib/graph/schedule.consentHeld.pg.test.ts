/**
 * 🔴 A GRAPH JOB QUEUED BEFORE A CONSENT HOLD SENDS NOTHING TO THE MODEL
 * (ola 11, A2), on a real Payload + Postgres.
 *
 *   · held before the job starts: the re-read (`readGraphableRow`, a Payload
 *     `find` with no `select`) carries `consentHeld`, the run stops, the
 *     extraction client gets no call and nothing is written (status, rows);
 *   · held while the model runs: its output is dropped, no graph row written;
 *   · control: the same row, not held, is graphed.
 *
 * Harness: `lib/testing/realPostgres.ts`. No docker → SKIP. The model is a spy.
 */
import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '../testing/realPostgres'
import type { GraphGenerateClient } from './extract'
import { runGraphExtraction, type GraphSchedulerPayload } from './schedule'

if (!dockerOk) console.warn('[schedule.consentHeld.pg.test] docker is not usable — these tests SKIP.')

const ORG = 3
const USER = 50
const DOC = 701
const TEXT = 'Una nota larga sobre parteras, nacimientos y la clínica del pueblo, para pasar el mínimo.'.repeat(4)

let pg: RealPostgres | undefined
let payload: Payload | undefined
/** Runs inside the model call, before it answers. */
let duringModel: (() => Promise<void>) | null = null

const sync = vi.fn(async (_req: unknown) => {
  if (duringModel) await duringModel()
  return { parsed: { entidades: [{ tipo: 'tema', etiqueta: 'Partería', menciones: 2 }], relaciones: [] } }
})
const client = { generate: { sync } } as unknown as GraphGenerateClient

const run = () =>
  runGraphExtraction({
    payload: payload as unknown as GraphSchedulerPayload,
    docId: DOC,
    organizationId: ORG,
    contentKind: 'documento',
    anonymise: false,
    publicationStatus: 'published',
    text: TEXT,
    title: 'Partería',
    client,
  })
const state = async () =>
  (
    await rowsOf(
      pg!.db,
      sql`SELECT graph_status AS g, graph_error AS e, updated_at AS u,
                 (SELECT count(*)::int FROM graph_mentions WHERE document_id = ${DOC}) AS m
            FROM documents WHERE id = ${DOC}`,
    )
  )[0]!
const hold = (on: boolean) => pg!.db.execute(sql`UPDATE documents SET consent_held = ${on} WHERE id = ${DOC}`)

describe.skipIf(!dockerOk)('graph job vs consent hold (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-graph-consent-pg-${process.pid}`, 'graph_consent_test')
    payload = await bootPayload(pg.url, 'graph-consent-test-secret')
    await pg.db.execute(sql`INSERT INTO users (id, email) VALUES (${USER}, 'u@example.invalid')`)
    await pg.db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Tres', 'tres')`)
    await pg.db.execute(sql`
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise,
                             anonymisation_status, extracted_text, name, graph_status)
      VALUES (${DOC}, ${ORG}, ${USER}, 'published', 'pdf', 'documento', false, 'n/a', ${TEXT}, 'Partería', 'pending')`)
  }, 120_000)

  beforeEach(async () => {
    sync.mockClear()
    duringModel = null
    await hold(false)
    await pg!.db.execute(sql`DELETE FROM graph_mentions WHERE document_id = ${DOC}`)
    await pg!.db.execute(sql`UPDATE documents SET graph_status = 'pending', graph_error = NULL WHERE id = ${DOC}`)
  })

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('the re-read carries consentHeld (Payload find, no select)', async () => {
    await hold(true)
    const found = await payload!.find({ collection: 'documents', where: { id: { equals: DOC } }, depth: 0, overrideAccess: true })
    expect((found.docs[0] as unknown as { consentHeld?: unknown }).consentHeld).toBe(true)
  })

  it('🔴 held before the job starts: no model call, nothing written', async () => {
    await hold(true)
    const before = await state()
    expect(await run()).toBe('skipped')
    expect(sync).not.toHaveBeenCalled()
    expect(await state()).toEqual(before)
  })

  it('🔴 held while the model runs: its output is dropped, no graph row written', async () => {
    duringModel = () => hold(true).then(() => undefined)
    expect(await run()).toBe('skipped')
    expect(sync).toHaveBeenCalled()
    const after = await state()
    expect(after.m).toBe(0)
    expect(after.g).not.toBe('ready')
  })

  it('control: not held, the row is graphed', async () => {
    expect(await run()).toBe('ready')
    expect(sync).toHaveBeenCalled()
    expect((await state()).m).toBeGreaterThan(0)
  })
})
