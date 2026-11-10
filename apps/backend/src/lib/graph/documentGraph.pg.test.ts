/**
 * P-02 ON A REAL POSTGRES (audit 2026-11-10): a re-gate purges a document's
 * graph and the normal path rebuilds it from the new text.
 *
 * The scenario of the audit: a `documento` kept a cited author visible, so
 * the graph holds a public `persona` "Ana López" with a snippet naming her.
 * The switch goes off. After the purge, no row of that document and no entity
 * only it named remains; an entity another document shares stays; the row is
 * no longer `ready` and the backfill finds it; and the live path
 * (`rebuildDocumentGraph` → `scheduleGraphExtractionForDoc` →
 * `runGraphExtraction`) extracts it again although it was extracted before.
 *
 * Harness: `lib/testing/realPostgres.ts` (own container, random port, --rm).
 * No docker → SKIP. The model is a stub.
 */
import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type Entidad = { tipo: string; etiqueta: string; menciones: number; figura_publica?: boolean }
type Relacion = { desde: string; hacia: string; tipo: string }
const replies = new Map<string, { entidades: Entidad[]; relaciones: Relacion[] }>()
const stub = {
  generate: {
    async sync(req: { unit?: unknown }) {
      const unitKey = String((req.unit as { unitKey?: unknown })?.unitKey ?? '')
      const doc = unitKey.split(':').find((part) => replies.has(part)) ?? ''
      return { parsed: replies.get(doc) ?? { entidades: [], relaciones: [] } }
    },
  },
}

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})
vi.mock('./client', () => ({ getGraphAIClient: async () => stub }))
vi.mock('@/lib/graph/client', () => ({ getGraphAIClient: async () => stub }))

import { bootPayload, dockerOk, eventually, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '../testing/realPostgres'
import { staleDocumentsWhere } from './backfill'
import { purgeDocumentGraph, rebuildDocumentGraph } from './documentGraph'
import type { GraphGenerateClient } from './extract'
import { runGraphExtraction, type GraphSchedulerPayload } from './schedule'

if (!dockerOk) console.warn('[documentGraph.pg.test] docker is not usable — these tests SKIP.')

const ORG = 3
const USER = 60
const DOC = 901
const PEER = 902
const PAD = ' Un acta larga sobre el acceso al agua en la comunidad, para pasar el mínimo de texto.'.repeat(4)
const OLD_TEXT = 'Como señala López (2020), el acceso al agua es desigual.' + PAD
const NEW_TEXT = 'Como señala [Autor citado] (2020), el acceso al agua es desigual.' + PAD

let pg: RealPostgres | undefined
let payload: Payload | undefined
const q = async (query: ReturnType<typeof sql>) => rowsOf(pg!.db, query)
const n = async (query: ReturnType<typeof sql>) => Number((await q(query))[0]!.n)
const mentionsOf = (doc: number) => n(sql`SELECT count(*)::int AS n FROM graph_mentions WHERE document_id = ${doc}`)
const relationsOf = (doc: number) => n(sql`SELECT count(*)::int AS n FROM graph_relations WHERE document_id = ${doc}`)
const entity = async (key: string) =>
  (await q(sql`SELECT id, type FROM graph_entities WHERE organization_id = ${ORG} AND canonical_key = ${key}`)).map((r) => String(r.type))
const docRow = async (doc: number) => (await q(sql`SELECT graph_status, graph_prompt_version FROM documents WHERE id = ${doc}`))[0]!

const run = (docId: number, text: string) =>
  runGraphExtraction({
    payload: payload as unknown as GraphSchedulerPayload,
    docId,
    organizationId: ORG,
    contentKind: 'documento',
    text,
    title: 'Acta',
    client: stub as unknown as GraphGenerateClient,
  })

describe.skipIf(!dockerOk)('purgeDocumentGraph → rebuild (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc2-gr-pg-docgraph-${process.pid}`, 'docgraph_test')
    payload = await bootPayload(pg.url, 'docgraph-test-secret')
    await pg.db.execute(sql`INSERT INTO users (id, email) VALUES (${USER}, 'gr@example.invalid')`)
    await pg.db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Eco', 'eco-gr')`)
    for (const [id, text] of [[DOC, OLD_TEXT], [PEER, 'Otra acta sobre el acceso al agua.' + PAD]] as const) {
      await pg.db.execute(sql`
        INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise,
                               anonymisation_status, extracted_text, name, graph_status)
        VALUES (${id}, ${ORG}, ${USER}, 'published', 'pdf', 'documento', false, 'n/a', ${text}, 'acta', 'pending')`)
    }
    replies.set(String(DOC), {
      entidades: [
        { tipo: 'persona', etiqueta: 'Ana López', menciones: 1, figura_publica: true },
        { tipo: 'tema', etiqueta: 'Acceso al agua', menciones: 2 },
      ],
      relaciones: [{ desde: 'Ana López', hacia: 'Acceso al agua', tipo: 'relacionado_con' }],
    })
    replies.set(String(PEER), { entidades: [{ tipo: 'tema', etiqueta: 'Acceso al agua', menciones: 1 }], relaciones: [] })
  }, 120_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('🔴 purge, then the live path re-extracts a document it had already extracted', async () => {
    expect(await run(DOC, OLD_TEXT)).toBe('ready')
    expect(await run(PEER, 'Otra acta sobre el acceso al agua.' + PAD)).toBe('ready')
    expect(await entity('ana lopez')).toEqual(['persona'])
    expect(await mentionsOf(DOC)).toBe(2)
    expect(await relationsOf(DOC)).toBe(1)
    expect((await docRow(DOC)).graph_status).toBe('ready')
    // Older than the orphan grace period, as an entity from last week would be.
    await pg!.db.execute(sql`UPDATE graph_entities SET created_at = now() - interval '1 day', updated_at = now() - interval '1 day'`)

    const { removed } = await purgeDocumentGraph(payload!, DOC)
    // 2 mentions + 1 relation + the persona only this document named.
    expect(removed).toBe(4)
    expect(await mentionsOf(DOC)).toBe(0)
    expect(await relationsOf(DOC)).toBe(0)
    expect(await entity('ana lopez')).toEqual([])
    // Shared with PEER: kept, with PEER's mention.
    expect(await entity('acceso al agua')).toEqual(['tema'])
    expect(await mentionsOf(PEER)).toBe(1)
    // Not `ready` any more, and the backfill's selection finds it.
    expect(await docRow(DOC)).toEqual({ graph_status: 'pending', graph_prompt_version: null })
    const stale = await payload!.find({
      collection: 'documents',
      where: staleDocumentsWhere(ORG) as never,
      limit: 0,
      depth: 0,
      overrideAccess: true,
    })
    expect(stale.docs.map((d) => d.id)).toContain(DOC)

    // Idempotent.
    expect(await purgeDocumentGraph(payload!, DOC)).toEqual({ removed: 0 })

    // The re-gate's new text, then the normal path.
    await pg!.db.execute(sql`UPDATE documents SET extracted_text = ${NEW_TEXT} WHERE id = ${DOC}`)
    replies.set(String(DOC), { entidades: [{ tipo: 'tema', etiqueta: 'Acceso al agua', menciones: 2 }], relaciones: [] })
    await rebuildDocumentGraph(payload!, DOC)
    expect(await eventually(async () => (await docRow(DOC)).graph_status === 'ready', 15_000)).toBe(true)
    expect(await mentionsOf(DOC)).toBe(1)
    expect(await entity('ana lopez')).toEqual([])
  }, 60_000)

  it('🔴 C-05: deleting a document leaves its entities; the orphan janitor\'s sweep removes them', async () => {
    const GONE = 903
    await pg!.db.execute(sql`
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise,
                             anonymisation_status, extracted_text, name, graph_status)
      VALUES (${GONE}, ${ORG}, ${USER}, 'published', 'pdf', 'documento', false, 'n/a', ${'Reunión con la Cooperativa Tlaloc.' + PAD}, 'acta', 'pending')`)
    replies.set(String(GONE), { entidades: [{ tipo: 'organizacion', etiqueta: 'Cooperativa Tlaloc', menciones: 1 }], relaciones: [] })
    expect(await run(GONE, 'Reunión con la Cooperativa Tlaloc.' + PAD)).toBe('ready')
    await payload!.delete({ collection: 'documents', id: GONE, overrideAccess: true })
    // Mentions cascade; the entity stays.
    expect(await mentionsOf(GONE)).toBe(0)
    expect(await entity('cooperativa tlaloc')).toEqual(['organizacion'])
    await pg!.db.execute(sql`UPDATE graph_entities SET created_at = now() - interval '1 day', updated_at = now() - interval '1 day'`)

    const { sweepGraphOrphans } = await import('./orphanJanitor')
    const r = await sweepGraphOrphans(payload as never)
    expect(r.failed).toBe(0)
    expect(r.deleted).toBeGreaterThanOrEqual(1)
    expect(await entity('cooperativa tlaloc')).toEqual([])
    // Referenced entities stay.
    expect(await entity('acceso al agua')).toEqual(['tema'])
  }, 60_000)

  it('a document that does not exist purges nothing and does not throw', async () => {
    expect(await purgeDocumentGraph(payload!, 999_999)).toEqual({ removed: 0 })
  })
})
