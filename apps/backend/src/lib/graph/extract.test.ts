/**
 * Extraction: windowing, parsing, merging, the specDefault slot, and 🔴 the
 * person rule's SECOND mechanism — the unconditional post-filter.
 *
 * ⚠ EVERY TEST HERE USES A FAKE ai-client. Real inference costs money, and a
 * loop over generation while iterating is how a test suite becomes a bill.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetSpecSlotForTests,
  dropForbiddenPersonas,
  extractGraph,
  mergeWindows,
  parseWindowResponse,
  splitIntoWindows,
  type GraphGenerateClient,
  type ParsedWindow,
} from './extract'
import { GRAPH_FRAGMENT_MAX_CHARS, graphResponseSchema } from './prompt'

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

interface Call {
  unit: Record<string, unknown>
}

function fakeClient(
  responses: unknown[] | ((call: number) => unknown),
): { client: GraphGenerateClient; calls: Call[] } {
  const calls: Call[] = []
  const client: GraphGenerateClient = {
    generate: {
      async sync(req) {
        calls.push({ unit: req.unit })
        const index = calls.length - 1
        const parsed = typeof responses === 'function' ? responses(index) : responses[index]
        if (parsed instanceof Error) throw parsed
        return { parsed }
      },
    },
  }
  return { client, calls }
}

const okResponse = (entidades: unknown[], relaciones: unknown[] = []) => ({
  entidades,
  relaciones,
})

// ---------------------------------------------------------------------------

describe('splitIntoWindows', () => {
  it('returns nothing for empty text', () => {
    expect(splitIntoWindows('   ')).toEqual({ windows: [], truncated: false })
  })

  it('keeps a short document in one window', () => {
    const { windows, truncated } = splitIntoWindows('Un párrafo.\n\nOtro párrafo.', {
      windowChars: 1000,
      maxWindows: 8,
    })
    expect(windows).toEqual(['Un párrafo.\n\nOtro párrafo.'])
    expect(truncated).toBe(false)
  })

  it('cuts on paragraph boundaries, never mid-paragraph', () => {
    const a = 'A'.repeat(60)
    const b = 'B'.repeat(60)
    const c = 'C'.repeat(60)
    const { windows } = splitIntoWindows([a, b, c].join('\n\n'), {
      windowChars: 130,
      maxWindows: 8,
    })
    expect(windows).toHaveLength(2)
    expect(windows[0]).toBe(`${a}\n\n${b}`)
    expect(windows[1]).toBe(c)
  })

  it('hard-splits one giant paragraph — a transcript has no blank lines', () => {
    const words = Array.from({ length: 400 }, (_, i) => `palabra${i}`).join(' ')
    // maxWindows well above what the text needs, so this case is only about
    // the hard split. Truncation has its own test below.
    const { windows } = splitIntoWindows(words, { windowChars: 500, maxWindows: 50 })
    expect(windows.length).toBeGreaterThan(1)
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(500)
    // Nothing lost except the whitespace at the cuts.
    expect(windows.join(' ')).toBe(words)
  })

  it('⚠ truncates past the window cap and says so', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `P${i} ${'x'.repeat(90)}`)
    const { windows, truncated } = splitIntoWindows(paragraphs.join('\n\n'), {
      windowChars: 100,
      maxWindows: 3,
    })
    expect(windows).toHaveLength(3)
    expect(truncated).toBe(true)
  })
})

describe('parseWindowResponse', () => {
  it('rejects anything that is not an object with `entidades`', () => {
    expect(parseWindowResponse(undefined)).toBeNull()
    expect(parseWindowResponse('{"entidades":[]}')).toBeNull()
    expect(parseWindowResponse({ relaciones: [] })).toBeNull()
  })

  it('defaults `menciones` to 1 and trims a long `fragmento`', () => {
    const parsed = parseWindowResponse(
      okResponse([{ tipo: 'tema', etiqueta: 'Agua', fragmento: 'x'.repeat(500) }]),
    )
    expect(parsed?.entities[0].menciones).toBe(1)
    expect(parsed?.entities[0].fragmento).toHaveLength(GRAPH_FRAGMENT_MAX_CHARS)
  })

  it('🔴 truncates to the SAME number the schema asks for, and it is 120', () => {
    // The schema's `maxLength` is a request the model can miss; this slice is
    // what actually holds. Repeating the number in two files is how they drift,
    // so `extract.ts` imports it — this asserts the value has not quietly gone
    // back to the original 300, which is the output-token cost ADR §13 measured.
    expect(GRAPH_FRAGMENT_MAX_CHARS).toBe(120)
    const item = (
      (graphResponseSchema(true).properties as Record<string, Record<string, unknown>>).entidades
        .items as Record<string, Record<string, Record<string, unknown>>>
    ).properties
    expect(item.fragmento.maxLength).toBe(GRAPH_FRAGMENT_MAX_CHARS)
  })

  it('drops entities with an unknown type or an unusable label', () => {
    const parsed = parseWindowResponse(
      okResponse([
        { tipo: 'planeta', etiqueta: 'Marte' },
        { tipo: 'tema', etiqueta: '   ' },
        { tipo: 'tema', etiqueta: 'Agua' },
      ]),
    )
    expect(parsed?.entities.map((e) => e.etiqueta)).toEqual(['Agua'])
  })

  it('drops relations with an unknown predicate or a missing endpoint', () => {
    const parsed = parseWindowResponse(
      okResponse(
        [{ tipo: 'tema', etiqueta: 'Agua' }],
        [
          { desde: 'Agua', hacia: 'Río', tipo: 'inventado' },
          { desde: 'Agua', hacia: '', tipo: 'afecta_a' },
          { desde: 'Agua', hacia: 'Río', tipo: 'afecta_a' },
        ],
      ),
    )
    expect(parsed?.relations).toHaveLength(1)
  })
})

describe('🔴 dropForbiddenPersonas — the person rule, mechanism 2', () => {
  const withPersona: ParsedWindow = {
    entities: [
      { tipo: 'persona', etiqueta: 'Ernesto Ramírez', menciones: 3, fragmento: null },
      { tipo: 'organizacion', etiqueta: 'Asamblea Ejidal', menciones: 2, fragmento: null },
      { tipo: 'tema', etiqueta: 'Acceso al agua', menciones: 5, fragmento: null },
    ],
    relations: [
      { desde: 'Ernesto Ramírez', hacia: 'Asamblea Ejidal', tipo: 'participa_en' },
      { desde: 'Asamblea Ejidal', hacia: 'Acceso al agua', tipo: 'afecta_a' },
    ],
  }

  it('keeps personas for a `documento`', () => {
    const out = dropForbiddenPersonas(withPersona, 'documento')
    expect(out.entities.map((e) => e.tipo)).toContain('persona')
    expect(out.relations).toHaveLength(2)
  })

  it('drops personas for a `testimonio`, whatever the model returned', () => {
    const out = dropForbiddenPersonas(withPersona, 'testimonio')
    expect(out.entities.map((e) => e.tipo)).not.toContain('persona')
    expect(out.entities).toHaveLength(2)
  })

  it('drops personas for a `conversacion`', () => {
    expect(
      dropForbiddenPersonas(withPersona, 'conversacion').entities.map((e) => e.tipo),
    ).not.toContain('persona')
  })

  it('⚠ FAILS CLOSED on an unknown, null or missing contentKind', () => {
    for (const kind of [null, undefined, '', 'algo-nuevo']) {
      expect(dropForbiddenPersonas(withPersona, kind).entities.map((e) => e.tipo)).not.toContain(
        'persona',
      )
    }
  })

  it('⚠ ALWAYS keeps organisations — naming an institution identifies nobody', () => {
    const out = dropForbiddenPersonas(withPersona, 'testimonio')
    expect(out.entities.map((e) => e.etiqueta)).toContain('Asamblea Ejidal')
  })

  it('drops the edges that touched a removed persona, and only those', () => {
    const out = dropForbiddenPersonas(withPersona, 'testimonio')
    expect(out.relations).toHaveLength(1)
    expect(out.relations[0].desde).toBe('Asamblea Ejidal')
  })
})

describe('mergeWindows', () => {
  it('sums occurrences across windows and collects surface forms as aliases', () => {
    const w1: ParsedWindow = {
      entities: [{ tipo: 'tema', etiqueta: 'Acceso al agua', menciones: 2, fragmento: 'cita 1' }],
      relations: [],
    }
    const w2: ParsedWindow = {
      entities: [{ tipo: 'tema', etiqueta: 'ACCESO AL AGUA', menciones: 3, fragmento: 'cita 2' }],
      relations: [],
    }
    const { entities } = mergeWindows([w1, w2], 'documento')
    expect(entities).toHaveLength(1)
    expect(entities[0].occurrences).toBe(5)
    expect(entities[0].label).toBe('Acceso al agua')
    expect(entities[0].aliases).toEqual(['ACCESO AL AGUA'])
    expect(entities[0].snippet).toBe('cita 1')
  })

  it('keeps two types with the same canonical key apart', () => {
    const w: ParsedWindow = {
      entities: [
        { tipo: 'lugar', etiqueta: 'Oaxaca', menciones: 1, fragmento: null },
        { tipo: 'organizacion', etiqueta: 'Oaxaca', menciones: 1, fragmento: null },
      ],
      relations: [],
    }
    expect(mergeWindows([w], 'documento').entities).toHaveLength(2)
  })

  it('🔴 drops a relation whose endpoint was never extracted', () => {
    const w: ParsedWindow = {
      entities: [{ tipo: 'tema', etiqueta: 'Agua', menciones: 1, fragmento: null }],
      relations: [{ desde: 'Agua', hacia: 'Río Verde', tipo: 'ubicado_en' }],
    }
    expect(mergeWindows([w], 'documento').relations).toEqual([])
  })

  it('drops a self-loop', () => {
    const w: ParsedWindow = {
      entities: [{ tipo: 'tema', etiqueta: 'Agua', menciones: 1, fragmento: null }],
      relations: [{ desde: 'Agua', hacia: 'agua', tipo: 'relacionado_con' }],
    }
    expect(mergeWindows([w], 'documento').relations).toEqual([])
  })

  it('🔴 never carries a snippet for a testimonio', () => {
    const w: ParsedWindow = {
      entities: [{ tipo: 'tema', etiqueta: 'Agua', menciones: 1, fragmento: 'cita literal' }],
      relations: [],
    }
    expect(mergeWindows([w], 'testimonio').entities[0].snippet).toBeNull()
    expect(mergeWindows([w], 'documento').entities[0].snippet).toBe('cita literal')
  })
})

describe('extractGraph', () => {
  beforeEach(() => {
    __resetSpecSlotForTests()
    vi.restoreAllMocks()
  })

  const text = ['P1 ' + 'x'.repeat(200), 'P2 ' + 'y'.repeat(200), 'P3 ' + 'z'.repeat(200)].join(
    '\n\n',
  )

  it('sends the built-in spec in the specDefault FLOOR slot, with a stable unitKey', async () => {
    const { client, calls } = fakeClient([okResponse([{ tipo: 'tema', etiqueta: 'Agua' }])])
    await extractGraph({
      docId: 7,
      contentKind: 'documento',
      text,
      client,
      windowChars: 5000,
      maxWindows: 8,
    })

    expect(calls).toHaveLength(1)
    const unit = calls[0].unit
    expect(unit.unitKey).toBe('graph-extract:7:0')
    expect(unit.unitType).toBe('graph-extract')
    // 🔴 FLOOR, never ceiling. `specOverride` would make a registered row
    // resolve and then be discarded, silently.
    expect(unit.specDefault).toBeTruthy()
    expect(unit.specOverride).toBeUndefined()
    expect((unit.specDefault as Record<string, unknown>).effortLevel).toBe('deep')
  })

  it('retries once in `specOverride` when ai-service rejects the specDefault key', async () => {
    let attempt = 0
    const calls: Record<string, unknown>[] = []
    const client: GraphGenerateClient = {
      generate: {
        async sync(req) {
          calls.push(req.unit)
          attempt++
          if (attempt === 1) {
            const err = Object.assign(new Error("Unrecognized key(s) in object: 'specDefault'"), {
              status: 400,
            })
            throw err
          }
          return { parsed: okResponse([{ tipo: 'tema', etiqueta: 'Agua' }]) }
        },
      },
    }

    const result = await extractGraph({
      docId: 1,
      contentKind: 'documento',
      text,
      client,
      windowChars: 5000,
    })
    expect(result.entities).toHaveLength(1)
    expect(calls[0].specDefault).toBeTruthy()
    expect(calls[1].specOverride).toBeTruthy()
  })

  it('propagates a real error rather than swallowing it as a slot problem', async () => {
    const boom = Object.assign(new Error('budget exhausted'), { status: 402 })
    const { client } = fakeClient([boom])
    await expect(
      extractGraph({
        docId: 1,
        contentKind: 'documento',
        text,
        client,
        windowChars: 5000,
        onWindowError: () => undefined,
      }),
    ).rejects.toThrow(/every extraction window failed/)
  })

  it('one call per window, and it never loops over generation', async () => {
    const { client, calls } = fakeClient(() => okResponse([{ tipo: 'tema', etiqueta: 'Agua' }]))
    const result = await extractGraph({
      docId: 3,
      contentKind: 'documento',
      text,
      client,
      windowChars: 210,
      maxWindows: 8,
    })
    expect(calls).toHaveLength(3)
    expect(result.windows).toBe(3)
    expect(calls.map((c) => c.unit.unitKey)).toEqual([
      'graph-extract:3:0',
      'graph-extract:3:1',
      'graph-extract:3:2',
    ])
  })

  it('keeps a partial result when one window fails', async () => {
    const { client } = fakeClient([
      okResponse([{ tipo: 'tema', etiqueta: 'Agua', menciones: 2 }]),
      new Error('timeout'),
      okResponse([{ tipo: 'tema', etiqueta: 'Agua', menciones: 1 }]),
    ])
    const result = await extractGraph({
      docId: 4,
      contentKind: 'documento',
      text,
      client,
      windowChars: 210,
      onWindowError: () => undefined,
    })
    expect(result.windowsFailed).toBe(1)
    expect(result.entities[0].occurrences).toBe(3)
  })

  it('treats a response with no usable `parsed` as a failed window', async () => {
    const { client } = fakeClient([undefined])
    await expect(
      extractGraph({
        docId: 5,
        contentKind: 'documento',
        text,
        client,
        windowChars: 5000,
        onWindowError: () => undefined,
      }),
    ).rejects.toThrow(/every extraction window failed/)
  })

  it('🔴 strips a persona a testimonio response smuggled through, end to end', async () => {
    // The model ignored the enum. The schema variant did not save us; the
    // post-filter did.
    const { client } = fakeClient([
      okResponse(
        [
          { tipo: 'persona', etiqueta: 'Ernesto Ramírez', menciones: 4 },
          { tipo: 'tema', etiqueta: 'Acceso al agua', menciones: 2 },
        ],
        [{ desde: 'Ernesto Ramírez', hacia: 'Acceso al agua', tipo: 'afecta_a' }],
      ),
    ])
    const result = await extractGraph({
      docId: 6,
      contentKind: 'testimonio',
      text,
      client,
      windowChars: 5000,
    })
    expect(result.entities.map((e) => e.type)).not.toContain('persona')
    expect(result.entities).toHaveLength(1)
    expect(result.relations).toEqual([])
  })

  it('returns an empty extraction for empty text without calling the model', async () => {
    const { client, calls } = fakeClient([])
    const result = await extractGraph({ docId: 8, contentKind: 'documento', text: '  ', client })
    expect(calls).toHaveLength(0)
    expect(result).toMatchObject({ entities: [], relations: [], windows: 0 })
  })
})
