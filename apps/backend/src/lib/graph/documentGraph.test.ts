/**
 * `purgeDocumentGraph` against a fake Payload: the contract the re-gate
 * relies on (throws on failure, tenancy in every where, the grace period).
 * The real-SQL cycle is `documentGraph.pg.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'

import { NO_DRIZZLE } from '@/lib/documentColumns.testFake'
vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

import { purgeDocumentGraph } from './documentGraph'

const OLD = new Date(Date.now() - 86_400_000).toISOString()

function fake(opts: { deleteErrors?: boolean; entityAt?: string; referenced?: boolean; row?: boolean } = {}) {
  const calls: { op: string; collection: string; where?: unknown; data?: unknown }[] = []
  const payload = {
    async find(args: Record<string, unknown>) {
      calls.push({ op: 'find', collection: String(args.collection), where: args.where })
      switch (args.collection) {
        case 'documents':
          return { docs: opts.row === false ? [] : [{ id: 1, organization: 7 }] }
        case 'graphMentions': {
          const byEntity = JSON.stringify(args.where).includes('"entity"')
          if (byEntity) return { docs: opts.referenced ? [{ id: 99 }] : [] }
          return { docs: [{ id: 11, entity: 100 }] }
        }
        case 'graphRelations': {
          const byEntity = JSON.stringify(args.where).includes('fromEntity')
          if (byEntity) return { docs: [] }
          return { docs: [{ id: 21, fromEntity: 100, toEntity: { id: 101 } }] }
        }
        case 'graphEntities':
          return { docs: [{ id: 100, createdAt: opts.entityAt ?? OLD, updatedAt: opts.entityAt ?? OLD }] }
      }
      return { docs: [] }
    },
    async delete(args: Record<string, unknown>) {
      calls.push({ op: 'delete', collection: String(args.collection), where: args.where })
      if (opts.deleteErrors) return { docs: [], errors: [{ id: 11, message: 'x' }] }
      return { docs: [{ id: 'gone' }], errors: [] }
    },
    async update(args: Record<string, unknown>) {
      calls.push({ op: 'update', collection: String(args.collection), data: args.data })
      return {}
    },
    async create() {
      return {}
    },
    db: { drizzle: NO_DRIZZLE },
  }
  return { payload, calls }
}

describe('purgeDocumentGraph', () => {
  it('deletes the mentions, the relations and the entities only this document named, then marks the row pending', async () => {
    const { payload, calls } = fake()
    const { removed } = await purgeDocumentGraph(payload as never, 1)
    // 1 mention + 1 relation + entities 100 and 101 (the fake answers one row per delete).
    expect(removed).toBe(4)
    const deleted = calls.filter((c) => c.op === 'delete').map((c) => c.collection)
    expect(deleted).toEqual(['graphMentions', 'graphRelations', 'graphEntities', 'graphEntities'])
    expect(calls.find((c) => c.op === 'update')?.data).toMatchObject({ graphStatus: 'pending', graphPromptVersion: null })
  })

  it('🔴 every graph query names the ecosistema', async () => {
    const { payload, calls } = fake()
    await purgeDocumentGraph(payload as never, 1)
    for (const c of calls.filter((x) => x.collection.startsWith('graph'))) {
      expect(JSON.stringify(c.where)).toContain('"organization":{"equals":7}')
    }
  })

  it('🔴 throws when a delete reports failures (the re-gate treats it as erase-failed)', async () => {
    const { payload } = fake({ deleteErrors: true })
    await expect(purgeDocumentGraph(payload as never, 1)).rejects.toThrow(/could not be deleted/)
  })

  it('throws when the database does', async () => {
    const { payload } = fake()
    payload.delete = async () => {
      throw new Error('down')
    }
    await expect(purgeDocumentGraph(payload as never, 1)).rejects.toThrow('down')
  })

  it('spares an entity another document still names', async () => {
    const { payload, calls } = fake({ referenced: true })
    await purgeDocumentGraph(payload as never, 1)
    expect(calls.filter((c) => c.op === 'delete' && c.collection === 'graphEntities')).toHaveLength(0)
  })

  it('spares an entity written within the grace period (an in-flight reuse); the janitor gets it later', async () => {
    const { payload, calls } = fake({ entityAt: new Date().toISOString() })
    await purgeDocumentGraph(payload as never, 1)
    expect(calls.filter((c) => c.op === 'delete' && c.collection === 'graphEntities')).toHaveLength(0)
  })

  it('no row: nothing to purge, no write', async () => {
    const { payload, calls } = fake({ row: false })
    expect(await purgeDocumentGraph(payload as never, 1)).toEqual({ removed: 0 })
    expect(calls.filter((c) => c.op !== 'find')).toHaveLength(0)
  })
})
