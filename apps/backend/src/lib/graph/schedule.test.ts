/**
 * The run, end to end: a faked model response goes in, `documents.graphStatus`
 * and graph rows come out.
 *
 * 🔴 THE TEST THAT MATTERS MOST IS `stores NOTHING for a persona when the
 * document is a testimonio`. It feeds a model response containing a `persona`
 * all the way to the writer with `contentKind: 'testimonio'` and asserts that no
 * such row is created. That is the person rule proven at the STORAGE boundary,
 * not at the parse boundary — the schema variant is bypassed entirely here,
 * exactly as it would be if a registry entry replaced it.
 *
 * ⚠ No real inference anywhere. The client is a stub.
 */
import { describe, expect, it, vi } from 'vitest'

import { NO_DRIZZLE } from '@/lib/documentColumns.testFake'
vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

import { runGraphExtraction as realRun, type GraphSchedulerPayload } from './schedule'

/**
 * The run re-reads its row (`schedule.stale.test.ts`). These cases are about
 * what happens AFTER that check, so each one gets a row that matches its args.
 */
const ROWS = new WeakMap<object, Record<string, unknown>>()
const runGraphExtraction: typeof realRun = (args) => {
  if (!ROWS.has(args.payload)) {
    ROWS.set(args.payload, {
      id: args.docId,
      organization: args.organizationId,
      contentKind: args.contentKind,
      extractedText: args.text,
      redactedText: args.text,
      anonymisationStatus: 'ready',
    })
  }
  return realRun(args)
}
import type { GraphGenerateClient } from './extract'
import { GRAPH_FRAGMENT_MAX_CHARS, GRAPH_PROMPT_VERSION } from './prompt'

const LONG_TEXT = `Primer párrafo del acta. ${'x'.repeat(300)}`

function harness(parsed: unknown | Error) {
  const created: { collection: string; data: Record<string, unknown> }[] = []
  const documentUpdates: Record<string, unknown>[] = []
  let nextId = 10

  const payload: GraphSchedulerPayload = {
    async find(args) {
      const row = args.collection === 'documents' ? ROWS.get(payload) : undefined
      return { docs: row ? [row] : [] }
    },
    async create(args) {
      created.push({
        collection: String(args.collection),
        data: args.data as Record<string, unknown>,
      })
      return { id: nextId++ }
    },
    async update(args) {
      if (args.collection === 'documents') {
        documentUpdates.push(args.data as Record<string, unknown>)
      }
      return {}
    },
    async delete() {
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
        if (parsed instanceof Error) throw parsed
        return { parsed }
      },
    },
  }

  return { payload, client, created, documentUpdates }
}

const response = (entidades: unknown[], relaciones: unknown[] = []) => ({
  entidades,
  relaciones,
})

describe('runGraphExtraction', () => {
  it('walks pending → extracting → ready and stamps the prompt version', async () => {
    const { payload, client, documentUpdates } = harness(
      response([{ tipo: 'tema', etiqueta: 'Acceso al agua', menciones: 2 }]),
    )

    const status = await runGraphExtraction({
      payload,
      docId: 1,
      organizationId: 5,
      contentKind: 'documento',
      text: LONG_TEXT,
      client,
    })

    expect(status).toBe('ready')
    expect(documentUpdates[0]).toMatchObject({ graphStatus: 'extracting' })
    expect(documentUpdates.at(-1)).toMatchObject({
      graphStatus: 'ready',
      graphError: null,
      graphPromptVersion: GRAPH_PROMPT_VERSION,
    })
    expect(documentUpdates.at(-1)?.graphExtractedAt).toBeTruthy()
  })

  it('records a failure as `failed` with a `code: message` reason', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { payload, client, documentUpdates } = harness(new Error('ai-service caído'))

    const status = await runGraphExtraction({
      payload,
      docId: 2,
      organizationId: 5,
      contentKind: 'documento',
      text: LONG_TEXT,
      client,
    })

    expect(status).toBe('failed')
    const last = documentUpdates.at(-1) as { graphStatus: string; graphError: string }
    expect(last.graphStatus).toBe('failed')
    expect(last.graphError).toMatch(/^graph_extract_failed: /)
    vi.restoreAllMocks()
  })

  it('skips a document with almost no text instead of paying for a deep call', async () => {
    const { payload, client, documentUpdates, created } = harness(response([]))
    const status = await runGraphExtraction({
      payload,
      docId: 3,
      organizationId: 5,
      contentKind: 'documento',
      text: 'dos líneas',
      client,
    })
    expect(status).toBe('skipped')
    expect(created).toHaveLength(0)
    expect(documentUpdates[0]).toMatchObject({ graphStatus: 'skipped' })
  })

  it('never throws — a detached run has nowhere to put an exception', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { payload, client } = harness(new Error('boom'))
    payload.update = (async () => {
      throw new Error('database gone')
    }) as unknown as GraphSchedulerPayload['update']
    await expect(
      runGraphExtraction({
        payload,
        docId: 4,
        organizationId: 5,
        contentKind: 'documento',
        text: LONG_TEXT,
        client,
      }),
    ).resolves.toBe('failed')
    vi.restoreAllMocks()
  })

  describe('🔴 the person rule at the storage boundary', () => {
    const personaResponse = response(
      [
        // Marked public, so only the content kind decides below.
        { tipo: 'persona', etiqueta: 'Ernesto Ramírez', menciones: 4, fragmento: 'me llamo Ernesto', figura_publica: true },
        { tipo: 'organizacion', etiqueta: 'Asamblea Ejidal', menciones: 2 },
      ],
      [{ desde: 'Ernesto Ramírez', hacia: 'Asamblea Ejidal', tipo: 'participa_en' }],
    )

    it('stores NOTHING for a persona when the document is a testimonio', async () => {
      const { payload, client, created } = harness(personaResponse)

      await runGraphExtraction({
        payload,
        docId: 10,
        organizationId: 5,
        contentKind: 'testimonio',
        text: LONG_TEXT,
        client,
      })

      const entities = created.filter((c) => c.collection === 'graphEntities')
      // Not one row of type persona, and not one row carrying the name.
      expect(entities.map((e) => e.data.type)).not.toContain('persona')
      expect(JSON.stringify(created)).not.toContain('Ernesto')
      // The organisation survived — losing those would gut the analysis.
      expect(entities.map((e) => e.data.label)).toEqual(['Asamblea Ejidal'])
      // The edge that touched the person went with it.
      expect(created.filter((c) => c.collection === 'graphRelations')).toHaveLength(0)
    })

    it('🔴 stores NOTHING for a persona the model did not mark public, even in a documento', async () => {
      const privateResponse = response(
        [
          { tipo: 'persona', etiqueta: 'Ernesto Ramírez', menciones: 4, figura_publica: false },
          { tipo: 'organizacion', etiqueta: 'Asamblea Ejidal', menciones: 2 },
        ],
        [{ desde: 'Ernesto Ramírez', hacia: 'Asamblea Ejidal', tipo: 'participa_en' }],
      )
      const { payload, client, created } = harness(privateResponse)
      await runGraphExtraction({
        payload,
        docId: 12,
        organizationId: 5,
        contentKind: 'documento',
        text: LONG_TEXT,
        client,
      })
      expect(JSON.stringify(created)).not.toContain('Ernesto')
      expect(created.filter((c) => c.collection === 'graphRelations')).toHaveLength(0)
    })

    it('stores the public persona when the document really is a `documento`', async () => {
      const { payload, client, created } = harness(personaResponse)
      await runGraphExtraction({
        payload,
        docId: 11,
        organizationId: 5,
        contentKind: 'documento',
        text: LONG_TEXT,
        client,
      })
      const entities = created.filter((c) => c.collection === 'graphEntities')
      expect(entities.map((e) => e.data.type)).toContain('persona')
      expect(created.filter((c) => c.collection === 'graphRelations')).toHaveLength(1)
    })

    it('⚠ fails closed on a conversacion and on an unknown content kind', async () => {
      for (const kind of ['conversacion', null, 'algo-nuevo']) {
        const { payload, client, created } = harness(personaResponse)
        await runGraphExtraction({
          payload,
          docId: 12,
          organizationId: 5,
          contentKind: kind,
          text: LONG_TEXT,
          client,
        })
        expect(JSON.stringify(created)).not.toContain('Ernesto')
      }
    })

    it('🔴 stores no snippet for a testimonio either', async () => {
      const { payload, client, created } = harness(
        response([{ tipo: 'tema', etiqueta: 'Acceso al agua', fragmento: 'nos cortaron el agua' }]),
      )
      await runGraphExtraction({
        payload,
        docId: 13,
        organizationId: 5,
        contentKind: 'testimonio',
        text: LONG_TEXT,
        client,
      })
      const mention = created.find((c) => c.collection === 'graphMentions')
      expect(mention?.data.snippet).toBeNull()
      expect(JSON.stringify(created)).not.toContain('nos cortaron el agua')
    })

    it("stores the model's `fragmento` as the snippet for a `documento`", async () => {
      // ⚠ THE POSITIVE HALF, and it did not exist before. Every other test here
      // proves the quotation does NOT arrive somewhere. Without one that proves
      // it DOES, the whole feature could be silently dead — the schema could
      // stop asking, the model could stop answering, `parseWindowResponse` could
      // drop the field — and the suite would stay green, because "no snippet"
      // is what almost every other case asserts.
      const { payload, client, created } = harness(
        response([{ tipo: 'tema', etiqueta: 'Acceso al agua', fragmento: 'nos cortaron el agua' }]),
      )
      await runGraphExtraction({
        payload,
        docId: 14,
        organizationId: 5,
        contentKind: 'documento',
        text: LONG_TEXT,
        client,
      })
      const mention = created.find((c) => c.collection === 'graphMentions')
      expect(mention?.data.snippet).toBe('nos cortaron el agua')
    })

    it('⚠ truncates an over-long quotation before it reaches the table', async () => {
      // The schema asks for 120 characters; a model that ignores `maxLength`
      // must not be able to widen the stored re-identification surface.
      const { payload, client, created } = harness(
        response([{ tipo: 'tema', etiqueta: 'Acceso al agua', fragmento: 'á'.repeat(400) }]),
      )
      await runGraphExtraction({
        payload,
        docId: 15,
        organizationId: 5,
        contentKind: 'documento',
        text: LONG_TEXT,
        client,
      })
      const mention = created.find((c) => c.collection === 'graphMentions')
      expect(mention?.data.snippet).toHaveLength(GRAPH_FRAGMENT_MAX_CHARS)
    })
  })
})

describe('runGraphExtraction — a failure on gated content', () => {
  /**
   * 🔴 A failed re-extraction must not leave a gated document's previous rows
   * in place: they may have been built from the raw transcript by a run before
   * the backfill read `corpusTextFor`, and they would go live when the
   * testimonio is published.
   */
  function withDeletes(parsed: unknown | Error) {
    const h = harness(parsed)
    const deletes: { collection: string; where: unknown }[] = []
    h.payload.delete = async (args) => {
      deletes.push({ collection: String(args.collection), where: args.where })
      return {}
    }
    return { ...h, deletes }
  }
  const where = { and: [{ organization: { equals: 5 } }, { document: { equals: 9 } }] }

  it.each(['testimonio', 'conversacion', null])(
    '🔴 clears the rows of a %s whose extraction failed',
    async (contentKind) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const { payload, client, deletes } = withDeletes(new Error('boom'))
      const status = await runGraphExtraction({
        payload, docId: 9, organizationId: 5, contentKind, text: LONG_TEXT, client,
      })
      expect(status).toBe('failed')
      expect(deletes).toContainEqual({ collection: 'graphMentions', where })
      expect(deletes).toContainEqual({ collection: 'graphRelations', where })
      vi.restoreAllMocks()
    },
  )

  it('🔴 clears them too when the AI client cannot even be resolved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { payload, deletes } = withDeletes(new Error('unused'))
    // No `client` and no AI_SERVICE_API_KEY: fails at client resolution.
    const status = await runGraphExtraction({
      payload, docId: 9, organizationId: 5, contentKind: 'testimonio', text: LONG_TEXT,
    })
    expect(status).toBe('failed')
    expect(deletes).toContainEqual({ collection: 'graphMentions', where })
    vi.restoreAllMocks()
  })

  it('keeps a documento’s previous rows — its raw text IS its corpus text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { payload, client, deletes } = withDeletes(new Error('boom'))
    const status = await runGraphExtraction({
      payload, docId: 9, organizationId: 5, contentKind: 'documento', text: LONG_TEXT, client,
    })
    expect(status).toBe('failed')
    expect(deletes).toHaveLength(0)
    vi.restoreAllMocks()
  })
})
