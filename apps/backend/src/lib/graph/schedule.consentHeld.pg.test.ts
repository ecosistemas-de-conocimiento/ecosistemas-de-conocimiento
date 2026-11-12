/**
 * 🔴 A GRAPH JOB QUEUED BEFORE A CONSENT HOLD SENDS NOTHING TO THE MODEL
 * (ola 11, A2), on a real Payload + Postgres.
 *
 *   · held before the job starts: the re-read (`readGraphableRow`, a Payload
 *     `find` with no `select`) carries `consentHeld`, the run stops, the
 *     extraction client gets no call and nothing is written (status, rows);
 *   · held while the model runs: its output is dropped, no entity, mention or
 *     relation is written, and `graph_status` ends `skipped` (not `extracting`);
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
  return {
    parsed: {
      entidades: [
        { id: 'e1', tipo: 'tema', etiqueta: 'Partería', menciones: 2 },
        { id: 'e2', tipo: 'tema', etiqueta: 'Clínica del pueblo', menciones: 1 },
      ],
      relaciones: [{ desde: 'e1', hacia: 'e2', tipo: 'relacionado_con' }],
    },
  }
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
                 (SELECT count(*)::int FROM graph_mentions WHERE document_id = ${DOC}) AS m,
                 (SELECT count(*)::int FROM graph_relations WHERE document_id = ${DOC}) AS r,
                 (SELECT count(*)::int FROM graph_entities WHERE organization_id = ${ORG}) AS ent
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
    // This org has only DOC, so its entities are DOC's.
    await pg!.db.execute(sql`DELETE FROM graph_relations WHERE organization_id = ${ORG}`)
    await pg!.db.execute(sql`DELETE FROM graph_mentions WHERE organization_id = ${ORG}`)
    await pg!.db.execute(sql`DELETE FROM graph_entities WHERE organization_id = ${ORG}`)
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

  it('🔴 held while the model runs: output dropped, no graph row, status `skipped`', async () => {
    // The model "runs": the hold lands in the database, then it answers.
    duringModel = () => hold(true).then(() => undefined)
    expect(await run()).toBe('skipped')
    expect(sync).toHaveBeenCalled()
    const after = await state()
    expect({ m: after.m, r: after.r, ent: after.ent }).toEqual({ m: 0, r: 0, ent: 0 })
    // Before the fix it stayed `extracting`.
    expect(after.g).toBe('skipped')
  })

  it('🔴 held while the model runs, with graph rows from an earlier run: they stay, status `skipped`', async () => {
    // An earlier run's rows for DOC. Without the pre-write hold check,
    // `abortIfStale` sees "no longer graphable" and DELETES them.
    await pg!.db.execute(sql`
      INSERT INTO graph_entities (id, organization_id, type, label, canonical_key)
      VALUES (9701, ${ORG}, 'tema', 'Previa', 'previa'), (9702, ${ORG}, 'tema', 'Otra previa', 'otra previa')`)
    await pg!.db.execute(sql`
      INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences)
      VALUES (${ORG}, ${DOC}, 9701, 1), (${ORG}, ${DOC}, 9702, 1)`)
    await pg!.db.execute(sql`
      INSERT INTO graph_relations (organization_id, document_id, from_entity_id, to_entity_id, type)
      VALUES (${ORG}, ${DOC}, 9701, 9702, 'relacionado_con')`)
    duringModel = () => hold(true).then(() => undefined)
    expect(await run()).toBe('skipped')
    expect(sync).toHaveBeenCalled()
    const after = await state()
    expect({ m: after.m, r: after.r, ent: after.ent, g: after.g }).toEqual({ m: 2, r: 1, ent: 2, g: 'skipped' })
  })

  it('control: not held, the row is graphed (entities, mentions, relation)', async () => {
    expect(await run()).toBe('ready')
    expect(sync).toHaveBeenCalled()
    const after = await state()
    expect(after.g).toBe('ready')
    expect(after.m).toBeGreaterThan(0)
    expect(after.r).toBeGreaterThan(0)
    expect(after.ent).toBeGreaterThan(0)
  })
})
