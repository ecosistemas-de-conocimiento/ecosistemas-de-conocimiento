/**
 * The writer. Three things are load-bearing and each has its own block:
 *
 *   · 🔴 `snippet` is NEVER stored for a testimonio (ADR §7.3.4).
 *   · 🔴 A persona that reached the writer with `contentKind = 'testimonio'`
 *     stores NOTHING — tested independently of the extraction post-filter, so
 *     each mechanism is proven on its own.
 *   · Every WHERE names `organization_id` in its own predicate.
 */
import { describe, expect, it, vi } from 'vitest'

import { orderSymmetricEndpoints, writeGraphForDocument, type GraphWriterPayload } from './writer'
import type { GraphExtraction, MergedEntity, MergedRelation } from './types'

// ---------------------------------------------------------------------------
// An in-memory Payload stand-in
// ---------------------------------------------------------------------------

interface Created {
  collection: string
  data: Record<string, unknown>
  req?: unknown
}

function fakePayload(existingEntities: Record<string, number> = {}) {
  const created: Created[] = []
  const deleted: { collection: string; where: unknown; req?: unknown }[] = []
  const updated: { collection: string; id: unknown; data: unknown }[] = []
  const finds: Record<string, unknown>[] = []
  let nextId = 100
  const tx: string[] = []

  const payload: GraphWriterPayload = {
    async find(args) {
      finds.push(args)
      if (args.collection !== 'graphEntities') return { docs: [] }
      const clauses = ((args.where as { and?: Record<string, Record<string, unknown>>[] }).and ??
        []) as Record<string, Record<string, unknown>>[]
      const type = clauses.find((c) => 'type' in c)?.type?.equals
      const key = clauses.find((c) => 'canonicalKey' in c)?.canonicalKey?.equals
      const id = existingEntities[`${String(type)}::${String(key)}`]
      return id ? { docs: [{ id, label: 'existente', aliases: ['vieja'] }] } : { docs: [] }
    },
    async create(args) {
      const row = { collection: String(args.collection), data: args.data as Record<string, unknown>, req: args.req }
      created.push(row)
      return { id: nextId++ }
    },
    async update(args) {
      updated.push({ collection: String(args.collection), id: args.id, data: args.data })
      return {}
    },
    async delete(args) {
      deleted.push({ collection: String(args.collection), where: args.where, req: args.req })
      return {}
    },
    db: {
      beginTransaction: async () => {
        tx.push('begin')
        return 'tx-1'
      },
      commitTransaction: async () => {
        tx.push('commit')
      },
      rollbackTransaction: async () => {
        tx.push('rollback')
      },
    },
  }

  return { payload, created, deleted, updated, finds, tx }
}

const entity = (over: Partial<MergedEntity> = {}): MergedEntity => ({
  type: 'tema',
  label: 'Acceso al agua',
  canonicalKey: 'acceso al agua',
  occurrences: 3,
  aliases: [],
  snippet: 'una cita literal del documento',
  ...over,
})

const extraction = (
  entities: MergedEntity[],
  relations: MergedRelation[] = [],
): GraphExtraction => ({
  entities,
  relations,
  windows: 1,
  windowsFailed: 0,
  truncated: false,
  promptVersion: 'v1',
})

// ---------------------------------------------------------------------------

describe('orderSymmetricEndpoints', () => {
  it('leaves a directed edge alone', () => {
    expect(orderSymmetricEndpoints(9, 2, 'afecta_a')).toEqual({ from: 9, to: 2 })
  })

  it('orders a symmetric edge ascending, so A-B and B-A collapse', () => {
    expect(orderSymmetricEndpoints(9, 2, 'relacionado_con')).toEqual({ from: 2, to: 9 })
    expect(orderSymmetricEndpoints(2, 9, 'relacionado_con')).toEqual({ from: 2, to: 9 })
  })

  it('falls back to string order for non-numeric ids', () => {
    expect(orderSymmetricEndpoints('zeta', 'alfa', 'relacionado_con')).toEqual({
      from: 'alfa',
      to: 'zeta',
    })
  })
})

describe('writeGraphForDocument', () => {
  it('creates entities, mentions and relations, and names the tenant everywhere', async () => {
    const { payload, created, deleted, finds } = fakePayload()
    const a = entity()
    const b = entity({ label: 'Río Verde', canonicalKey: 'rio verde', type: 'lugar' })

    const result = await writeGraphForDocument({
      payload,
      docId: 55,
      organizationId: 7,
      contentKind: 'documento',
      extraction: extraction([a, b], [{ fromKey: a.canonicalKey, toKey: b.canonicalKey, type: 'afecta_a' }]),
    })

    expect(result).toMatchObject({ entitiesUpserted: 2, mentions: 2, relations: 1, relationsDropped: 0 })

    // 🔴 Every entity lookup carries its own organization predicate.
    for (const call of finds) {
      const and = (call.where as { and: Record<string, Record<string, unknown>>[] }).and
      expect(and[0]).toEqual({ organization: { equals: 7 } })
    }
    // 🔴 So does every wholesale delete.
    for (const call of deleted) {
      const and = (call.where as { and: Record<string, Record<string, unknown>>[] }).and
      expect(and).toContainEqual({ organization: { equals: 7 } })
      expect(and).toContainEqual({ document: { equals: 55 } })
    }
    // And every row written carries it too.
    for (const row of created) {
      expect(row.data.organization).toBe(7)
    }
  })

  it('replaces a document’s mentions and relations wholesale, in one transaction', async () => {
    const { payload, deleted, tx } = fakePayload()
    await writeGraphForDocument({
      payload,
      docId: 1,
      organizationId: 1,
      contentKind: 'documento',
      extraction: extraction([entity()]),
    })
    expect(deleted.map((d) => d.collection)).toEqual(['graphMentions', 'graphRelations'])
    expect(tx).toEqual(['begin', 'commit'])
    // Both deletes and every insert ride the same transaction.
    for (const d of deleted) expect(d.req).toEqual({ transactionID: 'tx-1' })
  })

  it('rolls back and rethrows when an insert fails mid-replace', async () => {
    const { payload, tx } = fakePayload()
    const boom = new Error('constraint')
    payload.create = vi.fn(async (args: Record<string, unknown>) => {
      if (args.collection === 'graphMentions') throw boom
      return { id: 1 }
    }) as unknown as GraphWriterPayload['create']

    await expect(
      writeGraphForDocument({
        payload,
        docId: 1,
        organizationId: 1,
        contentKind: 'documento',
        extraction: extraction([entity()]),
      }),
    ).rejects.toThrow('constraint')
    expect(tx).toEqual(['begin', 'rollback'])
  })

  it('appends a new surface form to an existing entity instead of duplicating it', async () => {
    const { payload, created, updated } = fakePayload({ 'tema::acceso al agua': 42 })
    await writeGraphForDocument({
      payload,
      docId: 1,
      organizationId: 1,
      contentKind: 'documento',
      extraction: extraction([entity({ label: 'Acceso al agua potable' })]),
    })
    expect(created.filter((c) => c.collection === 'graphEntities')).toHaveLength(0)
    expect(updated[0]).toMatchObject({ collection: 'graphEntities', id: 42 })
    expect((updated[0].data as { aliases: string[] }).aliases).toContain('Acceso al agua potable')
  })

  it('adopts the winner’s row when a create loses the unique-index race', async () => {
    const { payload, created } = fakePayload()
    let findCall = 0
    payload.find = (async () => {
      findCall++
      // First lookup: nothing. After the failed create: the winner exists.
      return findCall === 1 ? { docs: [] } : { docs: [{ id: 999, label: 'Agua', aliases: [] }] }
    }) as unknown as GraphWriterPayload['find']
    payload.create = (async (args: Record<string, unknown>) => {
      if (args.collection === 'graphEntities') throw new Error('duplicate key value')
      created.push({ collection: String(args.collection), data: args.data as Record<string, unknown> })
      return { id: 1 }
    }) as unknown as GraphWriterPayload['create']

    const result = await writeGraphForDocument({
      payload,
      docId: 1,
      organizationId: 1,
      contentKind: 'documento',
      extraction: extraction([entity()]),
    })
    expect(result.mentions).toBe(1)
    expect(created[0].data.entity).toBe(999)
  })

  describe('🔴 relations', () => {
    it('drops an edge whose endpoint did not resolve to a row', async () => {
      const { payload, created } = fakePayload()
      const a = entity()
      const result = await writeGraphForDocument({
        payload,
        docId: 1,
        organizationId: 1,
        contentKind: 'documento',
        extraction: extraction([a], [{ fromKey: a.canonicalKey, toKey: 'fantasma', type: 'afecta_a' }]),
      })
      expect(result.relations).toBe(0)
      expect(result.relationsDropped).toBe(1)
      expect(created.filter((c) => c.collection === 'graphRelations')).toHaveLength(0)
    })

    it('collapses a symmetric A-B / B-A pair into one row', async () => {
      const { payload, created } = fakePayload()
      const a = entity({ label: 'Agua', canonicalKey: 'agua' })
      const b = entity({ label: 'Río', canonicalKey: 'rio', type: 'lugar' })
      const result = await writeGraphForDocument({
        payload,
        docId: 1,
        organizationId: 1,
        contentKind: 'documento',
        extraction: extraction(
          [a, b],
          [
            { fromKey: 'agua', toKey: 'rio', type: 'relacionado_con' },
            { fromKey: 'rio', toKey: 'agua', type: 'relacionado_con' },
          ],
        ),
      })
      expect(result.relations).toBe(1)
      const rows = created.filter((c) => c.collection === 'graphRelations')
      expect(rows).toHaveLength(1)
      // Ascending by id: the first entity created got the lower id.
      expect(Number(rows[0].data.fromEntity)).toBeLessThan(Number(rows[0].data.toEntity))
    })

    it('keeps a directed A→B and B→A pair as two rows', async () => {
      const { payload, created } = fakePayload()
      const a = entity({ label: 'Agua', canonicalKey: 'agua' })
      const b = entity({ label: 'Río', canonicalKey: 'rio', type: 'lugar' })
      await writeGraphForDocument({
        payload,
        docId: 1,
        organizationId: 1,
        contentKind: 'documento',
        extraction: extraction(
          [a, b],
          [
            { fromKey: 'agua', toKey: 'rio', type: 'afecta_a' },
            { fromKey: 'rio', toKey: 'agua', type: 'afecta_a' },
          ],
        ),
      })
      expect(created.filter((c) => c.collection === 'graphRelations')).toHaveLength(2)
    })
  })

  describe('🔴 two entity types sharing one canonical key', () => {
    // Identity is (type, canonicalKey). Resolving mentions by canonical key
    // alone made both rows point at the FIRST entity's id, so the second
    // graphMentions insert violated (document_id, entity_id) — rolling back the
    // transaction and losing the whole document's graph. Realistic in Spanish:
    // "asamblea ejidal" as both an organizacion and an evento.
    const asOrg = entity({
      type: 'organizacion',
      label: 'Asamblea Ejidal',
      canonicalKey: 'asamblea ejidal',
    })
    const asEvent = entity({
      type: 'evento',
      label: 'Asamblea Ejidal',
      canonicalKey: 'asamblea ejidal',
    })

    it('writes one mention per entity, each pointing at its OWN row', async () => {
      const { payload, created } = fakePayload()
      const result = await writeGraphForDocument({
        payload,
        docId: 1,
        organizationId: 1,
        contentKind: 'documento',
        extraction: extraction([asOrg, asEvent]),
      })

      expect(result.entitiesUpserted).toBe(2)
      expect(result.mentions).toBe(2)

      const entityIds = created
        .filter((c) => c.collection === 'graphEntities')
        .map((_, i) => 100 + i)
      const mentionTargets = created
        .filter((c) => c.collection === 'graphMentions')
        .map((c) => c.data.entity)
      // No duplicate (document, entity) pair — the unique index would reject it.
      expect(new Set(mentionTargets).size).toBe(2)
      expect(mentionTargets.sort()).toEqual(entityIds.sort())
    })

    it('still resolves a relation endpoint by canonical key alone', async () => {
      // An endpoint is only a LABEL, so it has no type to match on. First type
      // seen wins, which is what `mergeWindows` already assumed.
      const other = entity({ type: 'lugar', label: 'Chiapas', canonicalKey: 'chiapas' })
      const { payload, created } = fakePayload()
      const result = await writeGraphForDocument({
        payload,
        docId: 1,
        organizationId: 1,
        contentKind: 'documento',
        extraction: extraction(
          [asOrg, asEvent, other],
          [{ fromKey: 'asamblea ejidal', toKey: 'chiapas', type: 'ubicado_en' }],
        ),
      })
      expect(result.relations).toBe(1)
      expect(created.filter((c) => c.collection === 'graphRelations')).toHaveLength(1)
    })
  })

  describe('🔴 the person rule, at the table’s edge', () => {
    // ADR §5.3 puts the rule upstream (schema variant + post-filter). This is a
    // third gate, symmetric with the snippet one below, so that ANY caller —
    // a replay, a hand-built extraction, a future backfill variant — is covered
    // rather than only the paths that exist today.
    const persona = entity({
      type: 'persona',
      label: 'Ernesto Ramírez',
      canonicalKey: 'ernesto ramirez',
      publicFigure: true,
    })
    const tema = entity()

    it('stores nothing for a persona handed straight to the writer as a testimonio', async () => {
      const { payload, created } = fakePayload()
      const result = await writeGraphForDocument({
        payload,
        docId: 1,
        organizationId: 1,
        contentKind: 'testimonio',
        extraction: extraction([persona, tema]),
      })
      expect(result.entitiesUpserted).toBe(1)
      expect(result.mentions).toBe(1)
      expect(JSON.stringify(created)).not.toContain('Ernesto')
    })

    it('drops the edges that touched the removed persona', async () => {
      const { payload, created } = fakePayload()
      const result = await writeGraphForDocument({
        payload,
        docId: 1,
        organizationId: 1,
        contentKind: 'testimonio',
        extraction: extraction([persona, tema], [
          { fromKey: persona.canonicalKey, toKey: tema.canonicalKey, type: 'afecta_a' },
        ]),
      })
      expect(result.relations).toBe(0)
      expect(result.relationsDropped).toBe(1)
      expect(created.filter((c) => c.collection === 'graphRelations')).toHaveLength(0)
    })

    it('keeps a public persona for a real `documento`, and stores the mark', async () => {
      const { payload, created } = fakePayload()
      await writeGraphForDocument({
        payload,
        docId: 1,
        organizationId: 1,
        contentKind: 'documento',
        extraction: extraction([persona, tema]),
      })
      const rows = created.filter((c) => c.collection === 'graphEntities').map((c) => c.data)
      expect(rows.map((r) => [r.label, r.publicFigure])).toEqual([
        ['Ernesto Ramírez', true],
        [tema.label, false],
      ])
    })

    it('🔴 stores nothing for a persona not marked public, even from a `documento`', async () => {
      for (const publicFigure of [false, undefined]) {
        const { payload, created } = fakePayload()
        const result = await writeGraphForDocument({
          payload,
          docId: 1,
          organizationId: 1,
          contentKind: 'documento',
          extraction: extraction([{ ...persona, publicFigure }, tema], [
            { fromKey: persona.canonicalKey, toKey: tema.canonicalKey, type: 'afecta_a' },
          ]),
        })
        expect(JSON.stringify(created)).not.toContain('Ernesto')
        expect(result.relationsDropped).toBe(1)
      }
    })

    it('marks an existing persona row public when a documento names her as public', async () => {
      const { payload, updated } = fakePayload({ 'persona::ernesto ramirez': 7 })
      await writeGraphForDocument({
        payload,
        docId: 1,
        organizationId: 1,
        contentKind: 'documento',
        extraction: extraction([persona]),
      })
      expect(updated).toContainEqual(
        expect.objectContaining({ collection: 'graphEntities', id: 7, data: expect.objectContaining({ publicFigure: true }) }),
      )
    })

    it('⚠ fails closed on an unknown content kind', async () => {
      for (const kind of [null, undefined, 'conversacion', 'algo-nuevo']) {
        const { payload, created } = fakePayload()
        await writeGraphForDocument({
          payload,
          docId: 1,
          organizationId: 1,
          contentKind: kind,
          extraction: extraction([persona, tema]),
        })
        expect(JSON.stringify(created)).not.toContain('Ernesto')
      }
    })
  })

  describe('🔴 snippet is a privacy control, not a field', () => {
    it('stores the snippet for a `documento`', async () => {
      const { payload, created } = fakePayload()
      await writeGraphForDocument({
        payload,
        docId: 1,
        organizationId: 1,
        contentKind: 'documento',
        extraction: extraction([entity()]),
      })
      const mention = created.find((c) => c.collection === 'graphMentions')
      expect(mention?.data.snippet).toBe('una cita literal del documento')
    })

    it('writes NULL for a `testimonio`, even when the extraction carried one', async () => {
      const { payload, created } = fakePayload()
      await writeGraphForDocument({
        payload,
        docId: 1,
        organizationId: 1,
        contentKind: 'testimonio',
        extraction: extraction([entity({ snippet: 'me contó que su hija...' })]),
      })
      const mention = created.find((c) => c.collection === 'graphMentions')
      expect(mention?.data.snippet).toBeNull()
    })

    it('writes NULL for a `conversacion` and for an unknown content kind', async () => {
      for (const kind of ['conversacion', null, undefined, 'algo-nuevo']) {
        const { payload, created } = fakePayload()
        await writeGraphForDocument({
          payload,
          docId: 1,
          organizationId: 1,
          contentKind: kind,
          extraction: extraction([entity({ snippet: 'texto sensible' })]),
        })
        expect(created.find((c) => c.collection === 'graphMentions')?.data.snippet).toBeNull()
      }
    })
  })
})
