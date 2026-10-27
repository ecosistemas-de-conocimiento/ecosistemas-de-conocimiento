/**
 * 🔴 A QUEUED JOB MUST NOT TRUST THE TEXT IT WAS QUEUED WITH.
 *
 * The in-memory queue (`schedule.ts`) holds `args.text` from the moment the
 * upload scheduled it. Between then and the run — or between the run's start
 * and its write, which is minutes of `deep` calls — the row can be held,
 * rejected, withdrawn, unpublished or re-gated. Before this fix the job still
 * wrote graph rows from the stale text: e.g. a documento withdrawn because the
 * gate missed a name kept that name in `graph_entities`.
 *
 * The run now re-reads the row at start AND right before writing, derives the
 * text from it (`corpusTextFor`), and aborts — clearing the document's rows —
 * when the row is no longer graphable or has changed under it.
 */
import { describe, expect, it, vi } from 'vitest'

import { NO_DRIZZLE } from '@/lib/documentColumns.testFake'
vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

import { runGraphExtraction, type GraphSchedulerPayload } from './schedule'
import type { GraphGenerateClient } from './extract'

const TEXT = `Acta de la asamblea. ${'x'.repeat(300)}`
const REDACTED = `Acta de la asamblea [NOMBRE]. ${'x'.repeat(300)}`

type Row = Record<string, unknown>

/**
 * `rows` is consumed one per `documents` read: the first read is the job-start
 * check, the second the pre-write check. The last one repeats.
 */
function harness(rows: Row[]) {
  const created: { collection: string; data: Record<string, unknown> }[] = []
  const deletes: string[] = []
  const documentUpdates: Record<string, unknown>[] = []
  const prompts: string[] = []
  let reads = 0
  let nextId = 10

  const payload: GraphSchedulerPayload = {
    async find(args) {
      if (args.collection === 'documents') {
        const row = rows[Math.min(reads, rows.length - 1)]
        reads++
        return { docs: row ? [row] : [] }
      }
      return { docs: [] }
    },
    async create(args) {
      created.push({ collection: String(args.collection), data: args.data as Record<string, unknown> })
      return { id: nextId++ }
    },
    async update(args) {
      if (args.collection === 'documents') documentUpdates.push(args.data as Record<string, unknown>)
      return {}
    },
    async delete(args) {
      deletes.push(String(args.collection))
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
      async sync(req: unknown) {
        prompts.push(JSON.stringify(req))
        return { parsed: { entidades: [{ tipo: 'tema', etiqueta: 'Acceso al agua', menciones: 2 }], relaciones: [] } }
      },
    },
  }

  return { payload, client, created, deletes, documentUpdates, prompts, reads: () => reads }
}

const documento: Row = {
  id: 1,
  organization: 5,
  contentKind: 'documento',
  anonymise: false,
  extractedText: TEXT,
  anonymisationStatus: 'n/a',
  publicationStatus: 'published',
}
const gated: Row = {
  ...documento,
  anonymise: true,
  redactedText: REDACTED,
  anonymisationStatus: 'ready',
}

const baseArgs = { docId: 1, organizationId: 5 }
const graphWrites = (created: { collection: string }[]) =>
  created.filter((c) => c.collection === 'graphMentions' || c.collection === 'graphRelations')

describe('runGraphExtraction — 🔴 re-reads the row instead of trusting the queued text', () => {
  it('writes when the row is unchanged, from the row’s own corpus text', async () => {
    const h = harness([gated])
    const status = await runGraphExtraction({
      ...baseArgs, payload: h.payload, client: h.client,
      contentKind: 'documento', anonymise: true, publicationStatus: 'published', text: REDACTED,
    })
    expect(status).toBe('ready')
    expect(h.reads()).toBe(2)
    expect(graphWrites(h.created).length).toBeGreaterThan(0)
    // The model saw the redacted text, never the raw original.
    expect(h.prompts.join('')).toContain('[NOMBRE]')
  })

  it('🔴 aborts at start and clears rows when the row was held after queueing', async () => {
    const h = harness([{ ...gated, anonymisationStatus: 'held', redactedText: null }])
    const status = await runGraphExtraction({
      ...baseArgs, payload: h.payload, client: h.client,
      contentKind: 'documento', anonymise: true, publicationStatus: 'published', text: REDACTED,
    })
    expect(status).toBe('skipped')
    expect(h.prompts).toHaveLength(0)
    expect(graphWrites(h.created)).toHaveLength(0)
    expect(h.deletes).toEqual(expect.arrayContaining(['graphMentions', 'graphRelations']))
    expect(h.documentUpdates.at(-1)).toMatchObject({ graphStatus: 'skipped' })
  })

  it('🔴 aborts at start when the row is gone', async () => {
    const h = harness([])
    const status = await runGraphExtraction({
      ...baseArgs, payload: h.payload, client: h.client, contentKind: 'documento', text: TEXT,
    })
    expect(status).toBe('skipped')
    expect(h.prompts).toHaveLength(0)
  })

  it('🔴 aborts at start when the text changed since queueing (re-gated)', async () => {
    const h = harness([{ ...gated, redactedText: `${REDACTED} otra versión` }])
    const status = await runGraphExtraction({
      ...baseArgs, payload: h.payload, client: h.client,
      contentKind: 'documento', anonymise: true, publicationStatus: 'published', text: REDACTED,
    })
    expect(status).toBe('failed')
    expect(h.prompts).toHaveLength(0)
    expect(graphWrites(h.created)).toHaveLength(0)
    expect(h.deletes).toEqual(expect.arrayContaining(['graphMentions', 'graphRelations']))
    expect(String(h.documentUpdates.at(-1)?.graphError)).toMatch(/^graph_stale_job: /)
  })

  it('🔴 aborts at start when a documento was filed for anonymisation after queueing', async () => {
    // Queued as a plain documento with its raw text; the row is now gated and
    // not yet cleared, so there is nothing to graph.
    const h = harness([{ ...documento, anonymise: true, anonymisationStatus: 'pending' }])
    const status = await runGraphExtraction({
      ...baseArgs, payload: h.payload, client: h.client,
      contentKind: 'documento', anonymise: false, publicationStatus: 'published', text: TEXT,
    })
    expect(status).toBe('skipped')
    expect(h.prompts).toHaveLength(0)
  })

  it('🔴 aborts at start when a published row was unpublished after queueing', async () => {
    const h = harness([{ ...documento, publicationStatus: 'draft' }])
    const status = await runGraphExtraction({
      ...baseArgs, payload: h.payload, client: h.client,
      contentKind: 'documento', anonymise: false, publicationStatus: 'published', text: TEXT,
    })
    expect(status).toBe('failed')
    expect(h.prompts).toHaveLength(0)
    expect(h.deletes).toEqual(expect.arrayContaining(['graphMentions', 'graphRelations']))
  })

  it('does NOT abort when a draft is published while queued (auto-publish)', async () => {
    const h = harness([documento])
    const status = await runGraphExtraction({
      ...baseArgs, payload: h.payload, client: h.client,
      contentKind: 'documento', anonymise: false, publicationStatus: 'draft', text: TEXT,
    })
    expect(status).toBe('ready')
  })

  it('🔴 aborts BEFORE WRITING when the row was withdrawn during extraction', async () => {
    // Start check passes; the gate missed a name and a reviewer withdrew it
    // while the deep calls were running.
    const h = harness([gated, { ...gated, anonymisationStatus: 'rejected', redactedText: null, publicationStatus: 'draft' }])
    const status = await runGraphExtraction({
      ...baseArgs, payload: h.payload, client: h.client,
      contentKind: 'documento', anonymise: true, publicationStatus: 'published', text: REDACTED,
    })
    expect(status).toBe('skipped')
    expect(h.prompts.length).toBeGreaterThan(0)
    expect(graphWrites(h.created)).toHaveLength(0)
    expect(h.created.filter((c) => c.collection === 'graphEntities')).toHaveLength(0)
    expect(h.deletes).toEqual(expect.arrayContaining(['graphMentions', 'graphRelations']))
  })

  it('🔴 aborts BEFORE WRITING when the text changed during extraction', async () => {
    const h = harness([gated, { ...gated, redactedText: `${REDACTED} v2` }])
    const status = await runGraphExtraction({
      ...baseArgs, payload: h.payload, client: h.client,
      contentKind: 'documento', anonymise: true, publicationStatus: 'published', text: REDACTED,
    })
    expect(status).toBe('failed')
    expect(graphWrites(h.created)).toHaveLength(0)
  })

  it('🔴 aborts BEFORE WRITING when the row was unpublished during extraction', async () => {
    const h = harness([documento, { ...documento, publicationStatus: 'unpublishing' }])
    const status = await runGraphExtraction({
      ...baseArgs, payload: h.payload, client: h.client,
      contentKind: 'documento', anonymise: false, publicationStatus: 'published', text: TEXT,
    })
    expect(status).toBe('failed')
    expect(graphWrites(h.created)).toHaveLength(0)
  })
})

describe('runGraphExtraction — failure handling sees `anonymise`', () => {
  it('🔴 clears a gated documento’s rows when its extraction fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const h = harness([gated])
    h.client.generate.sync = async () => {
      throw new Error('boom')
    }
    const status = await runGraphExtraction({
      ...baseArgs, payload: h.payload, client: h.client,
      contentKind: 'documento', anonymise: true, publicationStatus: 'published', text: REDACTED,
    })
    expect(status).toBe('failed')
    expect(h.deletes).toEqual(expect.arrayContaining(['graphMentions', 'graphRelations']))
    vi.restoreAllMocks()
  })
})
