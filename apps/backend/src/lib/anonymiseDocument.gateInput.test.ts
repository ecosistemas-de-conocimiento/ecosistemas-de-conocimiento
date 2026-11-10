/**
 * I-06 (audit 2026-11-10): production builds its gate input with the same
 * `documentGateInput` as `/admin/evals`, so the two cannot drift. And P-04/I-13:
 * the verdict records the `keepPublicFigures` the gate applied, so
 * `verdictSettings` reads it instead of inferring it from `publicFiguresKept`.
 *
 * Fake Payload, static detector: no network.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./documentColumns', () => import('./documentColumns.testFake'))
vi.mock('./testimonioTitle', () => ({ scheduleTestimonioTitle: vi.fn() }))

const builder = vi.hoisted(() => ({ spy: null as null | ReturnType<typeof vi.fn> }))
vi.mock('./anonymise/gateInput', async (importOriginal) => {
  const m = await importOriginal<typeof import('./anonymise/gateInput')>()
  builder.spy = vi.fn(m.documentGateInput)
  return { ...m, documentGateInput: builder.spy }
})
const gateInputs: unknown[] = []
vi.mock('./anonymise', async (importOriginal) => {
  const m = await importOriginal<typeof import('./anonymise')>()
  return {
    ...m,
    runAnonymisationGate: (input: unknown, opts: never) => {
      gateInputs.push(input)
      return m.runAnonymisationGate(input as never, opts)
    },
  }
})

import { staticDetector } from './anonymise'
import { anonymiseDocumentText } from './anonymiseDocument'
import { verdictSettings } from './publicFigures'

function fakePayload() {
  const writes: Array<Record<string, unknown>> = []
  return {
    payload: {
      update: async (args: { data: Record<string, unknown> }) => {
        writes.push(args.data)
        return {}
      },
    },
    last(key: string): unknown {
      for (let i = writes.length - 1; i >= 0; i -= 1) {
        if (Object.prototype.hasOwnProperty.call(writes[i]!, key)) return writes[i]![key]
      }
      return undefined
    },
  }
}

const TEXT = 'Habló Rosario Ibarra en la plaza.'
const run = (fake: ReturnType<typeof fakePayload>, contentKind: string, keepPublicFigures?: boolean) =>
  anonymiseDocumentText({
    payload: fake.payload as never,
    docId: 9,
    organizationId: 1,
    contentKind: contentKind as never,
    anonymise: true,
    text: TEXT,
    detector: staticDetector([{ text: 'Rosario Ibarra', type: 'persona', public: { motivo: 'figura pública' } }]),
    roster: ['Beto Díaz'],
    authors: ['Ana Ruiz'],
    keepCitedAuthors: true,
    ...(keepPublicFigures === undefined ? {} : { keepPublicFigures }),
    settings: { keepDocumentAuthor: true, keepCitedAuthors: true },
  })

describe('anonymiseDocumentText — 🔴 the gate input comes from documentGateInput (I-06)', () => {
  it('the builder is called with the run and its result is what the gate gets', async () => {
    builder.spy!.mockClear()
    gateInputs.length = 0
    await run(fakePayload(), 'documento', true)
    expect(builder.spy).toHaveBeenCalledTimes(1)
    expect(builder.spy!.mock.calls[0]!.slice(0, 2)).toEqual(['documento', TEXT])
    expect(gateInputs).toEqual([builder.spy!.mock.results[0]!.value])
    expect(gateInputs[0]).toEqual({
      contentKind: 'documento',
      text: TEXT,
      roster: ['Beto Díaz'],
      keepPublicFigures: true,
      authors: ['Ana Ruiz'],
      keepCitedAuthors: true,
    })
  })
})

describe('anonymiseDocumentText — 🔴 settings record keepPublicFigures as applied (P-04/I-13)', () => {
  it.each([
    ['documento', true, true],
    ['documento', false, false],
    ['documento', undefined, false],
    // The gate keeps public figures in a documento only (`gate.ts`).
    ['testimonio', true, false],
  ] as const)('%s with keepPublicFigures=%s records %s', async (kind, keep, recorded) => {
    const fake = fakePayload()
    await run(fake, kind, keep)
    const report = fake.last('anonymisationReport') as { settings?: Record<string, unknown> }
    expect(report.settings).toEqual({ keepDocumentAuthor: true, keepCitedAuthors: true, keepPublicFigures: recorded })
    // The recorded value wins over the keep log, whatever the log says.
    expect(
      verdictSettings({ anonymisationReport: report, publicFiguresKept: recorded ? null : [{ name: 'x' }] }).keepPublicFigures,
    ).toBe(recorded)
  })
})
