/**
 * 🔴 WHICH TEXT THE CORPUS GRAPH IS BUILT FROM.
 *
 * This is the highest-stakes line in the graph pipeline and it was wrong in the
 * first implementation, so it gets its own file rather than a case buried in a
 * larger one.
 *
 * `scheduleGraphExtractionForDoc` used to accept `extractedText` from its
 * caller. Every caller had it in hand, so passing it was the obvious thing to
 * do — and for a `testimonio` that value is the RAW, UN-SCRUBBED transcript.
 * Extracting entities from it would have written the names, places and
 * organisations the anonymisation gate exists to remove into `graph_entities`,
 * queryable, permanently, on a surface the gate never looks at.
 *
 * ⚠ THE PERSON RULE WOULD NOT HAVE CAUGHT IT. That rule blocks `persona` nodes
 * from gated content, and it works. But a `lugar` and an `organizacion` lifted
 * out of an un-scrubbed Voz identify someone just as precisely in a small
 * ecosistema — which is the entire premise of the minimum-support threshold in
 * `plan/adr-corpus-graph.md` §7.3. A rule that only names one entity type is
 * not a defence against a text source that leaks all of them.
 *
 * So: the graph reads what the CORPUS reads, via the same `corpusTextFor`
 * helper `lib/publishDocument.ts` embeds from. The two can never disagree about
 * what a document says, and a gated document that has not cleared the gate has
 * no text to give.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

import { scheduleGraphExtractionForDoc } from './Documents'

const scheduleGraphExtraction = vi.fn()
vi.mock('@/lib/graph/schedule', () => ({
  scheduleGraphExtraction: (...args: unknown[]) => scheduleGraphExtraction(...args),
}))

/** A Payload double that hands back one row and records every update. */
function fakePayload(row: Record<string, unknown>) {
  const updates: Record<string, unknown>[] = []
  return {
    updates,
    payload: {
      findByID: async () => row,
      update: async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data)
        return row
      },
    } as never,
  }
}

const RAW = 'Me llamo María López y vivo en San Juan Copala desde 1998.'
const GATED = 'Me llamo [Persona A] y vivo en [Lugar A] desde 1998.'

beforeEach(() => {
  scheduleGraphExtraction.mockClear()
})

describe('🔴 the graph is built from the text the CORPUS got, never the original', () => {
  it('extracts a testimonio from redactedText, not from extractedText', async () => {
    const { payload } = fakePayload({
      contentKind: 'testimonio',
      extractedText: RAW,
      redactedText: GATED,
      anonymisationStatus: 'ready',
    })

    await scheduleGraphExtractionForDoc({
      payload,
      docId: 7,
      organizationId: 1,
      fresh: { name: 'Testimonio de María López.mp3', contentKind: 'testimonio' },
    })

    expect(scheduleGraphExtraction).toHaveBeenCalledTimes(1)
    const call = scheduleGraphExtraction.mock.calls[0]![0] as { text: string }
    expect(call.text).toBe(GATED)
    // The assertion that actually matters: the un-scrubbed name never reaches
    // the extractor, so it can never reach `graph_entities`.
    expect(call.text).not.toContain('María López')
    expect(call.text).not.toContain('San Juan Copala')
  })

  it('SKIPS a gated document whose scrub has not cleared, rather than reaching for the original', async () => {
    // Fails closed. There is no per-document delete at ai-service and no
    // per-row delete story for a leaked entity either, so "not extracted yet"
    // is the only safe answer to "we are not sure this text is clean".
    const { payload, updates } = fakePayload({
      contentKind: 'testimonio',
      extractedText: RAW,
      redactedText: null,
    })

    await scheduleGraphExtractionForDoc({
      payload,
      docId: 7,
      organizationId: 1,
      fresh: { name: 'Voz', contentKind: 'testimonio' },
    })

    expect(scheduleGraphExtraction).not.toHaveBeenCalled()
    expect(updates.at(-1)).toMatchObject({ graphStatus: 'skipped' })
    expect(String(updates.at(-1)?.graphError)).toMatch(/not_graphable/)
  })

  it('🔴 SKIPS a testimonio whose gate verdict is not `ready` or `approved`', async () => {
    // Tightened when the human-review screen landed on main: a row that cleared
    // the gate ONCE and was later held or rejected still carries a stale
    // `redactedText`. Asking only "is it non-empty?" would graph text a human
    // has since refused. The graph reads what the corpus reads, so it inherits
    // the condition rather than re-deriving it.
    for (const status of ['held', 'rejected', 'pending', undefined]) {
      const { payload, updates } = fakePayload({
        contentKind: 'testimonio',
        extractedText: RAW,
        redactedText: GATED,
        anonymisationStatus: status,
      })

      await scheduleGraphExtractionForDoc({
        payload,
        docId: 7,
        organizationId: 1,
        fresh: { name: 'Voz', contentKind: 'testimonio' },
      })

      expect(scheduleGraphExtraction).not.toHaveBeenCalled()
      expect(updates.at(-1)).toMatchObject({ graphStatus: 'skipped' })
    }
  })

  it('graphs an APPROVED testimonio from the text the human cleared', async () => {
    // `approved` is a human's verdict recorded in `anonymisation-reviews`, and
    // the text may be one they corrected by hand. It is as publishable as
    // `ready`, so it is as graphable.
    const { payload } = fakePayload({
      contentKind: 'testimonio',
      extractedText: RAW,
      redactedText: GATED,
      anonymisationStatus: 'approved',
    })

    await scheduleGraphExtractionForDoc({
      payload,
      docId: 7,
      organizationId: 1,
      fresh: { name: 'Voz', contentKind: 'testimonio' },
    })

    const call = scheduleGraphExtraction.mock.calls[0]![0] as { text: string }
    expect(call.text).toBe(GATED)
  })

  it('extracts an ordinary documento from extractedText, which is what it should be', async () => {
    // The gate does not run for a `documento`, so `extractedText` IS the corpus
    // text. Nothing is lost by routing it through the same helper.
    const { payload } = fakePayload({
      contentKind: 'documento',
      extractedText: 'Informe sobre el acceso al agua en la Sierra Norte.',
      redactedText: null,
    })

    await scheduleGraphExtractionForDoc({
      payload,
      docId: 8,
      organizationId: 1,
      fresh: { name: 'Informe de agua.pdf', contentKind: 'documento' },
    })

    const call = scheduleGraphExtraction.mock.calls[0]![0] as { text: string }
    expect(call.text).toBe('Informe sobre el acceso al agua en la Sierra Norte.')
  })
})

describe('🔴 the title the graph carries is neutral for gated content', () => {
  // `documents.name` is free text the uploader typed and it never went through
  // the gate. `lib/contentKind.ts` records "Testimonio de María López.mp3" as
  // the case that nearly reached the shared corpus on the citation card. The
  // graph surfaces titles too — on entity cards and on an edge's supporting
  // documents — so it needs the same rule, not a second chance to leak.
  it('replaces a testimonio filename with the neutral title', async () => {
    const { payload } = fakePayload({
      contentKind: 'testimonio',
      extractedText: RAW,
      redactedText: GATED,
      anonymisationStatus: 'ready',
    })

    await scheduleGraphExtractionForDoc({
      payload,
      docId: 7,
      organizationId: 1,
      fresh: { name: 'Testimonio de María López.mp3', contentKind: 'testimonio' },
    })

    const call = scheduleGraphExtraction.mock.calls[0]![0] as { title: string }
    expect(call.title).toBe('Testimonio')
    expect(call.title).not.toContain('María López')
  })

  it('keeps a documento own title, because it is the uploader own material', async () => {
    const { payload } = fakePayload({
      contentKind: 'documento',
      extractedText: 'texto',
      redactedText: null,
    })

    await scheduleGraphExtractionForDoc({
      payload,
      docId: 8,
      organizationId: 1,
      fresh: { name: 'Informe de agua.pdf', contentKind: 'documento' },
    })

    const call = scheduleGraphExtraction.mock.calls[0]![0] as { title: string }
    expect(call.title).toBe('Informe de agua.pdf')
  })
})

describe('GRAPH_EXTRACT=off — an install that does not want the graph', () => {
  const row = { contentKind: 'documento', extractedText: 'texto', redactedText: null }
  const fresh = { name: 'Informe.pdf', contentKind: 'documento' as const }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(['off', 'OFF', ' false ', '0', 'no'])(
    'schedules nothing and writes nothing when set to %j',
    async (value) => {
      vi.stubEnv('GRAPH_EXTRACT', value)
      const { payload, updates } = fakePayload(row)
      await scheduleGraphExtractionForDoc({ payload, docId: 9, organizationId: 1, fresh })
      expect(scheduleGraphExtraction).not.toHaveBeenCalled()
      expect(updates).toEqual([])
    },
  )

  it.each([undefined, '', 'on', 'true', 'junk'])('stays ON by default (%j)', async (value) => {
    if (value !== undefined) vi.stubEnv('GRAPH_EXTRACT', value)
    const { payload } = fakePayload(row)
    await scheduleGraphExtractionForDoc({ payload, docId: 9, organizationId: 1, fresh })
    expect(scheduleGraphExtraction).toHaveBeenCalledTimes(1)
  })
})
