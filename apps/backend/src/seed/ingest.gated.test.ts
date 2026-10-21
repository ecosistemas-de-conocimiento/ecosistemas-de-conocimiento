/**
 * #34 — a seeded carta, biografía, ficha or diario goes through the
 * anonymisation gate BEFORE it is embedded, and is published from the
 * redacted text.
 *
 * The real `ingestSeededDocuments`, `anonymiseDocumentText`, gate and
 * `beginPublish` run. Faked: the ai-service client (so nothing is embedded),
 * the detector (so no model is called), and the column writer (replayed as
 * `payload.update`, which the fake row below applies to itself).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DetectorFinding, PersonDetector } from '@/lib/anonymise/types'

const enqueue = vi.fn()
vi.mock('@/lib/aiClient', () => ({
  getAdminAIClient: () => ({ ingest: { enqueue } }),
}))
vi.mock('@/lib/callbackConfig', () => ({ ingestCallbackUrl: () => null }))
vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

let detector: PersonDetector
vi.mock('@/lib/anonymise', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/anonymise')>()),
  aiServiceDetector: () => detector,
}))

const { staticDetector } = await import('@/lib/anonymise')
const { ingestSeededDocuments } = await import('./corpus')

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined }

const CARTA_TEXT = 'Me llamo Camilo Bautista Flores y vivo en Xoxocotla, Morelos, desde niño.'
const CARTA_FINDINGS: DetectorFinding[] = [{ text: 'Camilo Bautista Flores', type: 'persona' }]

/** One row that applies every `update` to itself, so `findByID` sees the gate's writes. */
function fakePayload(row: Record<string, unknown>) {
  const live = { ...row }
  const payload = {
    logger: silentLogger,
    find: async () => ({ docs: [{ ...live }] }),
    findByID: async () => ({ ...live }),
    update: async (args: { data: Record<string, unknown> }) => {
      Object.assign(live, args.data)
      return { ...live }
    },
  }
  return { payload: payload as never, live }
}

function seededDraft(over: Record<string, unknown> = {}) {
  return {
    id: 30,
    organization: 1,
    uploadedBy: 2,
    contentKind: 'testimonio',
    kind: 'pdf',
    name: 'Carta de presentación — traducción en salud (01)',
    tema: 'traduccion',
    extractedText: CARTA_TEXT,
    publicationStatus: 'draft',
    anonymisationStatus: null,
    ...over,
  }
}

const run = (payload: never) =>
  ingestSeededDocuments(payload, 1, { sleep: async () => undefined, spacingMs: 0 })

beforeEach(() => {
  enqueue.mockReset()
  enqueue.mockResolvedValue({ ingestId: 'ing-1' })
  detector = staticDetector(CARTA_FINDINGS)
})

describe('ingestSeededDocuments — 🔴 personal genres pass the gate first (#34)', () => {
  it('a carta with a name is redacted BEFORE it is embedded, then published', async () => {
    const { payload, live } = fakePayload(seededDraft())

    const result = await run(payload)

    expect(result).toEqual({ enqueued: 1, failed: 0, held: 0 })
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [req] = enqueue.mock.calls[0]!
    const sent = req.documents[0]
    expect(sent.text).not.toContain('Camilo')
    expect(sent.text).toContain('[Persona A]')
    // Towns are shown (#12).
    expect(sent.text).toContain('Xoxocotla, Morelos')
    // A gated row's citation title is neutral, never the row's name.
    expect(sent.title).toBe('Testimonio')
    expect(req.corpus).toMatch(/^eco-1$/)
    expect(live).toMatchObject({ anonymisationStatus: 'ready', publicationStatus: 'publishing' })
    expect(live.extractedText).toBe(CARTA_TEXT)
  })

  it('🔴 a hold is NOT published: it stays a draft at `held`, for Revisión', async () => {
    let calls = 0
    // Stage 3 misses the name, stage 4 (verify) finds it: the gate holds.
    detector = {
      name: 'misses-then-finds',
      async detect() {
        calls += 1
        return calls === 1 ? [] : CARTA_FINDINGS
      },
    }
    const { payload, live } = fakePayload(seededDraft())

    const result = await run(payload)

    expect(result).toEqual({ enqueued: 0, failed: 0, held: 1 })
    expect(enqueue).not.toHaveBeenCalled()
    expect(live).toMatchObject({ anonymisationStatus: 'held', publicationStatus: 'draft', redactedText: null })
  })

  it('a re-run publishes an already-cleared row without running the gate again', async () => {
    detector = {
      name: 'must-not-run',
      async detect() {
        throw new Error('the gate ran twice')
      },
    }
    const { payload } = fakePayload(
      seededDraft({ anonymisationStatus: 'ready', redactedText: 'Me llamo [Persona A].' }),
    )

    const result = await run(payload)

    expect(result).toEqual({ enqueued: 1, failed: 0, held: 0 })
    expect(enqueue.mock.calls[0]![0].documents[0].text).toBe('Me llamo [Persona A].')
  })

  it('🔴 a person\'s OWN draft titled like a seeded genre is never gated or published here', async () => {
    // Same title shape, but no `tema` and no SIM id: not a seeded row. It takes
    // the ordinary draft route (a plain re-save), never the gate-then-publish one.
    detector = {
      name: 'must-not-run',
      async detect() {
        throw new Error('the seed gated a user draft')
      },
    }
    const { payload, live } = fakePayload(
      seededDraft({ name: 'Diario personal — mis notas de campo', tema: null }),
    )
    const result = await run(payload)
    expect(enqueue).not.toHaveBeenCalled()
    expect(live.publicationStatus).toBe('draft')
    expect(live.anonymisationStatus).toBeNull()
    expect(result).toEqual({ enqueued: 1, failed: 0, held: 0 })
  })

  it('🔴 a person\'s OWN documento draft, even titled like a seeded genre, is not published', async () => {
    // A user upload keeps its behaviour: an ungated `documento`. The seed loads
    // every row in the ecosistema, so it must leave this one a draft.
    detector = {
      name: 'must-not-run',
      async detect() {
        throw new Error('the seed gated a user documento')
      },
    }
    const { payload, live } = fakePayload(
      seededDraft({
        contentKind: 'documento',
        name: 'Carta de presentación — mi propuesta',
        tema: null,
        anonymisationStatus: 'n/a',
      }),
    )
    await run(payload)
    expect(enqueue).not.toHaveBeenCalled()
    expect(live.publicationStatus).toBe('draft')
    expect(live.anonymisationStatus).toBe('n/a')
  })

  it('a seeded testimonio is NOT published by this path: it stays a draft', async () => {
    const { payload, live } = fakePayload(
      seededDraft({ name: 'Testimonio — traducción en salud (01)' }),
    )
    await run(payload)
    expect(live.publicationStatus).toBe('draft')
  })

  it('an already-published documento (a user upload, or an older seed) keeps its original text, ungated', async () => {
    const { payload, live } = fakePayload(
      seededDraft({
        contentKind: 'documento',
        name: 'Documento — acompañamiento escolar (SIM_0003)',
        extractedText: 'Informe del taller: asistieron 14 familias.',
        publicationStatus: 'published',
        anonymisationStatus: 'n/a',
      }),
    )
    detector = {
      name: 'must-not-run',
      async detect() {
        throw new Error('a documento was gated')
      },
    }
    await run(payload)
    expect(enqueue.mock.calls[0]![0].documents[0].text).toBe('Informe del taller: asistieron 14 familias.')
    expect(live.anonymisationStatus).toBe('n/a')
  })
})
