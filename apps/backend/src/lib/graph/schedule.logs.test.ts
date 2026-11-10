/**
 * P-07 in the graph run (audit 2026-11-10): a database error from a graph
 * write is drizzle's `DrizzleQueryError`, whose message is the query with its
 * params: an entity label, an alias, a snippet. Neither the log nor
 * `graphError` (which the frontend shows) may carry it.
 */
import { DrizzleQueryError } from '@payloadcms/db-postgres/drizzle'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NO_DRIZZLE } from '@/lib/documentColumns.testFake'
vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

import type { GraphGenerateClient } from './extract'
import { runGraphExtraction, type GraphSchedulerPayload } from './schedule'

const SECRET = 'Lucía Hernández'
const LONG_TEXT = `Acta de la asamblea. ${'x'.repeat(300)}`
const dbError = () =>
  new DrizzleQueryError(
    'insert into "graph_mentions" ("label", "snippet") values ($1, $2)',
    [SECRET, `dijo ${SECRET}`],
    Object.assign(new Error('deadlock detected'), { code: '40P01' }),
  )

function harness(opts: { failCreate?: boolean; failReadyWrite?: boolean; failDelete?: boolean }) {
  const updates: Record<string, unknown>[] = []
  const row = { id: 1, organization: 5, contentKind: 'documento', extractedText: LONG_TEXT, anonymisationStatus: 'n/a' }
  let nextId = 10
  const payload: GraphSchedulerPayload = {
    async find(args) {
      return { docs: args.collection === 'documents' ? [row] : [] }
    },
    async create(args) {
      if (opts.failCreate && args.collection === 'graphMentions') throw dbError()
      return { id: nextId++ }
    },
    async update(args) {
      const data = args.data as Record<string, unknown>
      if (opts.failReadyWrite && data.graphStatus === 'ready') throw dbError()
      if (args.collection === 'documents') updates.push(data)
      return {}
    },
    async delete() {
      if (opts.failDelete) throw dbError()
      return {}
    },
    db: {
      drizzle: NO_DRIZZLE,
      beginTransaction: async () => 'tx',
      commitTransaction: async () => undefined,
      rollbackTransaction: async () => undefined,
    },
  }
  const client: GraphGenerateClient = {
    generate: {
      async sync() {
        return { parsed: { entidades: [{ tipo: 'tema', etiqueta: 'Agua', menciones: 2 }], relaciones: [] } }
      },
    },
  }
  return { payload, client, updates }
}

function logged(...spies: { mock: { calls: unknown[][] } }[]): string {
  return spies
    .flatMap((s) => s.mock.calls)
    .map((args) => args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    .join('\n')
}

afterEach(() => vi.restoreAllMocks())

describe('P-07: graph run logs', () => {
  it('🔴 a failed status write after the rows landed (schedule.ts:309) logs no row text', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { payload, client } = harness({ failReadyWrite: true })
    await runGraphExtraction({ payload, docId: 1, organizationId: 5, contentKind: 'documento', text: LONG_TEXT, client })
    expect(logged(error)).toContain('DrizzleQueryError(40P01)')
    expect(logged(error)).not.toContain('Lucía')
  })

  it('🔴 a failed graph write on a documento: neither the log nor graphError carries the row', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { payload, client, updates } = harness({ failCreate: true })
    const status = await runGraphExtraction({ payload, docId: 1, organizationId: 5, contentKind: 'documento', text: LONG_TEXT, client })
    expect(status).toBe('failed')
    const last = updates.at(-1) as { graphStatus: string; graphError: string }
    expect(last.graphStatus).toBe('failed')
    expect(last.graphError).toBe('graph_extract_failed: DrizzleQueryError(40P01)')
    expect(logged(error)).not.toContain('Lucía')
  })

  it('a non-database failure keeps its message in graphError', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { payload, updates } = harness({})
    const client: GraphGenerateClient = { generate: { sync: async () => { throw new Error('ai-service caído') } } }
    await runGraphExtraction({ payload, docId: 1, organizationId: 5, contentKind: 'documento', text: LONG_TEXT, client })
    expect(String(updates.at(-1)?.graphError)).toContain('ai-service caído')
  })

  it('🔴 a failed clear of a too-short document logs no row text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { payload, client } = harness({ failDelete: true })
    const short = 'corto'
    ;(payload.find as unknown) = async () => ({ docs: [{ id: 1, organization: 5, contentKind: 'documento', extractedText: short, anonymisationStatus: 'n/a' }] })
    await runGraphExtraction({ payload, docId: 1, organizationId: 5, contentKind: 'documento', text: short, client })
    expect(warn).toHaveBeenCalled()
    expect(logged(warn)).not.toContain('Lucía')
  })
})
