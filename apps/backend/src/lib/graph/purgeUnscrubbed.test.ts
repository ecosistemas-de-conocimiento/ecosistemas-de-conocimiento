import { describe, expect, it } from 'vitest'

import { purgeUnscrubbedGraphRows, type PurgePayload } from './purgeUnscrubbed'

const silent = () => undefined

function fakePayload(documents: Record<string, unknown>[], rowsPerDoc: Record<string, number>) {
  const deletes: { collection: string; where?: unknown; id?: unknown }[] = []
  const updates: unknown[] = []
  const docIdOf = (where: unknown) =>
    String(
      ((where as { and: Record<string, { equals: unknown }>[] }).and.find((c) => 'document' in c)
        ?.document?.equals) ?? '',
    )
  const payload: PurgePayload = {
    async find(args) {
      return { docs: args.collection === 'documents' ? documents : [] }
    },
    async count(args) {
      return { totalDocs: rowsPerDoc[docIdOf(args.where)] ?? 0 }
    },
    async create() {
      return { id: 1 }
    },
    async update(args) {
      updates.push(args)
      return {}
    },
    async delete(args) {
      deletes.push({ collection: String(args.collection), where: args.where, id: args.id })
      return {}
    },
    db: {},
  }
  return { payload, deletes, updates }
}

const DOCS = [
  { id: 1, organization: 5, contentKind: 'testimonio', anonymisationStatus: 'held', redactedText: null },
  { id: 2, organization: 5, contentKind: 'testimonio', anonymisationStatus: 'ready', redactedText: 'ok' },
  { id: 3, organization: 5, contentKind: 'documento', anonymisationStatus: 'n/a' },
  { id: 4, organization: 5, contentKind: 'testimonio', anonymisationStatus: 'pending' },
]

describe('purgeUnscrubbedGraphRows', () => {
  it('🔴 is a dry run by default: counts, deletes nothing', async () => {
    const { payload, deletes, updates } = fakePayload(DOCS, { '1': 3, '2': 9, '3': 9, '4': 0 })
    const report = await purgeUnscrubbedGraphRows(payload, { log: silent })
    expect(report).toMatchObject({
      apply: false,
      unscrubbedDocuments: 2, // 1 and 4; 2 is approved, 3 is not gated
      documentsWithRows: 1,
      mentions: 3,
      relations: 3,
    })
    expect(deletes).toHaveLength(0)
    expect(updates).toHaveLength(0)
  })

  it('with apply, deletes only the unscrubbed document’s rows', async () => {
    const { payload, deletes } = fakePayload(DOCS, { '1': 3, '2': 9, '3': 9 })
    await purgeUnscrubbedGraphRows(payload, { apply: true, log: silent })
    const rowDeletes = deletes.filter((d) => d.collection !== 'graphEntities')
    const where = { and: [{ organization: { equals: 5 } }, { document: { equals: 1 } }] }
    expect(rowDeletes).toEqual([
      { collection: 'graphMentions', where, id: undefined },
      { collection: 'graphRelations', where, id: undefined },
    ])
  })
})
