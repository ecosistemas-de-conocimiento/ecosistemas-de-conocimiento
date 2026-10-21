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
/** What the seed built its detector with — the retry budget lives here. */
let detectorOpts: Record<string, unknown> | undefined
/** Set to build the REAL detector (over a fake client) from the seed's options. */
let realDetectorFrom: ((opts: Record<string, unknown>) => PersonDetector) | null = null
vi.mock('@/lib/anonymise', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/anonymise')>()),
  aiServiceDetector: (opts: Record<string, unknown>) => {
    detectorOpts = opts
    return realDetectorFrom ? realDetectorFrom(opts) : detector
  },
}))

const { staticDetector } = await import('@/lib/anonymise')
const { aiServiceDetector: realAiServiceDetector } =
  await vi.importActual<typeof import('@/lib/anonymise')>('@/lib/anonymise')
const { SEED_PUBLISH_RETRY } = await import('./corpus')
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
  detectorOpts = undefined
  realDetectorFrom = null
})

describe('ingestSeededDocuments — 🔴 a rate-limited gate is retryable, not held (2026-10-21)', () => {
  it('🔴 a 429 past the SEED budget leaves the row retryable; a re-run gates and publishes it', async () => {
    let calls = 0
    const waits: number[] = []
    const rateLimited = {
      generate: {
        async sync() {
          calls += 1
          throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 60_000 })
        },
      },
    }
    // The REAL detector, built from the options the seed passed.
    realDetectorFrom = (opts) =>
      realAiServiceDetector({
        ...(opts as object),
        client: rateLimited as never,
        retry: {
          ...(opts.retry as object),
          sleep: async (ms: number) => {
            waits.push(ms)
          },
        },
      })
    const { payload, live } = fakePayload(seededDraft())

    const first = await run(payload)

    // The seed's patient budget reached the detector, not the 4 tries / 120 s default.
    expect(detectorOpts?.retry).toMatchObject(SEED_PUBLISH_RETRY)
    expect(calls).toBeGreaterThan(4)
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(SEED_PUBLISH_RETRY.budgetMs)
    expect(first).toEqual({ enqueued: 0, failed: 1, held: 0 })
    expect(enqueue).not.toHaveBeenCalled()
    expect(live).toMatchObject({ anonymisationStatus: 'n/a', publicationStatus: 'draft', redactedText: null })
    expect(String(live.anonymisationError)).toMatch(/^gate_unavailable: /)

    // ai-service is back: the re-run picks the row up and gates it.
    realDetectorFrom = null
    const second = await run(payload)
    expect(second).toEqual({ enqueued: 1, failed: 0, held: 0 })
    expect(live).toMatchObject({ anonymisationStatus: 'ready', publicationStatus: 'publishing' })
    expect(enqueue.mock.calls[0]![0].documents[0].text).toContain('[Persona A]')
  })
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

  it('a seeded testimonio is NOT published by this path: it stays a draft', async () => {
    const { payload, live } = fakePayload(
      seededDraft({ name: 'Testimonio — traducción en salud (01)' }),
    )
    await run(payload)
    expect(live.publicationStatus).toBe('draft')
  })

  it('a non-personal documento is published with its original text, ungated', async () => {
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
