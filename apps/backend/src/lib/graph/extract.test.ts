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
  dropGenericEntities,
  extractGraph,
  isGenericLabel,
  mergeWindows,
  parseWindowResponse,
  significantTokens,
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

// ---------------------------------------------------------------------------
// 🔴 THE GENERIC-LABEL RULE — prompt v3
// ---------------------------------------------------------------------------

describe('significantTokens — the words that are not grammar', () => {
  // ⚠ ASSERTED DIRECTLY, not only through `isGenericLabel`. A tokenisation bug
  // that returned nothing would make every label look generic, and one that
  // returned too much would make every label look qualified — and a suite that
  // only checked the verdict could not tell either from a working rule
  // (00-context.md: a negative-only suite cannot see "never produced").
  it('drops articles, prepositions and contractions, keeps the content words', () => {
    expect(significantTokens('acceso al agua potable')).toEqual(['acceso', 'agua', 'potable'])
    expect(significantTokens('la barranca')).toEqual(['barranca'])
    expect(significantTokens('Centro de Salud de Tlayacapan')).toEqual([
      'Centro',
      'Salud',
      'Tlayacapan',
    ])
  })

  it('strips punctuation off the edges, so a quoted name still compares', () => {
    expect(significantTokens('PILARES "Carlos Monsiváis"')).toEqual([
      'PILARES',
      'Carlos',
      'Monsiváis',
    ])
  })

  it('returns nothing for a label made only of grammar', () => {
    expect(significantTokens('de la')).toEqual([])
    expect(significantTokens('   ')).toEqual([])
  })
})

describe('🔴 isGenericLabel — a PURE, type-blind label predicate', () => {
  // ⚠ Whether a bare common noun is a defect depends on the TYPE it was given.
  // That judgement is `dropGenericEntities`'s, below. This predicate only
  // answers "does this label contain a name?", and its tests stay at that
  // level — which is why `náhuatl` is `true` here and still survives in the
  // graph.
  const bareCommonNouns = ['barranca', 'escuela', 'agua', 'clínica', 'mercado', 'colonia']
  const properNames: Array<[string, string]> = [
    ['Morelos', 'lugar, 108 documents — the most-cited place in the corpus'],
    ['Cuernavaca', 'lugar, 74 documents'],
    ['Oaxaca', 'lugar, 46 documents'],
    ['Chenalhó', 'an accented capital must count as uppercase'],
    ['Óscar', 'the capital is the FIRST character and it is accented'],
    ['CIDE', 'an all-caps acronym'],
    ['QWERTYCaster', 'uppercase that is not at the start'],
  ]

  it.each(bareCommonNouns)('says `%s` carries no name', (label) => {
    expect(isGenericLabel(label)).toBe(true)
  })

  // 🔴 THE POSITIVE COUNTERPART, AND IT IS NOT OPTIONAL. Every case above is a
  // rejection, and a predicate that rejected EVERYTHING would pass all of them
  // while emptying the graph. These are real one-word entities measured in the
  // same corpus; all 55 capitalised one-word entities in it are of this shape.
  it.each(properNames)('says `%s` carries a name (%s)', (label) => {
    expect(isGenericLabel(label)).toBe(false)
  })

  it('is TYPE-BLIND on purpose — the corpus subjects come back `true` here', () => {
    // 🔴 THE REASON `dropGenericEntities` IS SCOPED. Read literally, this
    // predicate condemns the corpus's entire subject vocabulary. It is allowed
    // to, because it is never asked about a `tema`. If someone ever wires it in
    // type-blind, this test is the record of what that costs.
    for (const subject of ['náhuatl', 'mixteco', 'discapacidad', 'dengue', 'español']) {
      expect(isGenericLabel(subject)).toBe(true)
    }
  })

  it('says a bare common noun carries no name whatever article it wears', () => {
    // Prompt rule 2 forbids the leading article; this is what happens when the
    // model ignores rule 2 as well as rule 3, which is the case the
    // function-word list exists for.
    for (const label of ['agua', 'el agua', 'la barranca', 'las escuelas', 'los mercados']) {
      expect(isGenericLabel(label)).toBe(true)
    }
    // …and the qualified form of the same noun carries one, which is the whole
    // point — this is about the QUALIFIER, not about the word "agua".
    for (const label of ['acceso al agua potable', 'agua estancada', 'barranca de Amanalco']) {
      expect(isGenericLabel(label)).toBe(false)
    }
  })

  it('accepts every multi-word label — two content words is the qualifier', () => {
    // Measured: 524 of the corpus's 700 entities are multi-word, and that half
    // of the data was already good. The rule deliberately does not touch it.
    for (const label of [
      'traducción en salud',
      'prevención del dengue',
      'personas sordas',
      'zona de riesgo',
      'consentimiento informado',
      'Día Nacional de la Lengua de Señas Mexicana',
    ]) {
      expect(isGenericLabel(label)).toBe(false)
    }
  })

  it('rejects a label with no content at all', () => {
    expect(isGenericLabel('de la')).toBe(true)
    expect(isGenericLabel('   ')).toBe(true)
    expect(isGenericLabel('')).toBe(true)
  })
})

describe('🔴 dropGenericEntities — scoped to the types that name a particular', () => {
  const entity = (tipo: string, etiqueta: string) =>
    ({ tipo, etiqueta, menciones: 1, fragmento: null }) as ParsedWindow['entities'][number]

  const windowOf = (...entities: ParsedWindow['entities']): ParsedWindow => ({
    entities,
    relations: [],
  })

  const labelsOf = (w: ParsedWindow) => dropGenericEntities(w).entities.map((e) => e.etiqueta)

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  /**
   * 🔴 THE HEADLINE PAIR, and the whole design in two lines. The SAME word is a
   * defect as an `organizacion` and correct as a `tema`. `escuela` typed as an
   * `organizacion` (22 documents) is the category error the task was opened
   * for; `escuela` as a subject is one of the four themes the corpus is built
   * around. A type-blind rule cannot tell them apart, and this is why the rule
   * is not type-blind.
   */
  it('🔴 drops `escuela` as an `organizacion` and KEEPS `escuela` as a `tema`', () => {
    expect(labelsOf(windowOf(entity('organizacion', 'escuela')))).toEqual([])
    expect(labelsOf(windowOf(entity('tema', 'escuela')))).toEqual(['escuela'])
  })

  it('drops the measured junk hubs on the types that require a name', () => {
    // `barranca` as a lugar (49 documents) is the biggest node in the corpus
    // and is not a place; `tallerista` is a role, not a person.
    expect(labelsOf(windowOf(entity('lugar', 'barranca')))).toEqual([])
    expect(labelsOf(windowOf(entity('organizacion', 'clínica')))).toEqual([])
    expect(labelsOf(windowOf(entity('lugar', 'mercado')))).toEqual([])
    expect(labelsOf(windowOf(entity('persona', 'tallerista')))).toEqual([])
  })

  it('keeps a NAMED place, organisation and person on those same types', () => {
    // The positive counterpart: the rule must not empty the types it guards.
    expect(
      labelsOf(
        windowOf(
          entity('lugar', 'Morelos'),
          entity('organizacion', 'Centro de Salud de Tlayacapan'),
          entity('persona', 'Reynaldo Ocampo'),
          entity('lugar', 'barranca de Amanalco'),
        ),
      ),
    ).toEqual([
      'Morelos',
      'Centro de Salud de Tlayacapan',
      'Reynaldo Ocampo',
      'barranca de Amanalco',
    ])
  })

  /**
   * 🔴 THE CORPUS'S LANGUAGE AXIS SURVIVES, ALL OF IT.
   *
   * Every one of the 250 corpus documents carries a `lengua`; there are 11
   * distinct ones and EVERY one lands on `tema` in the live graph. `documents`
   * has no language column — checked in `information_schema` — so the graph is
   * the only place this vocabulary exists in the product. An earlier draft of
   * this rule deleted all of it.
   */
  it('🔴 keeps all 11 corpus languages, which are `tema` and one word each', () => {
    const languages = [
      'náhuatl', 'mixteco', 'mazateco', 'zapoteco', 'totonaco', 'tlahuica',
      'tlapaneco', 'amuzgo', 'hñähñu', 'tsotsil', 'mixe', 'español',
    ]
    expect(labelsOf(windowOf(...languages.map((l) => entity('tema', l))))).toEqual(languages)
  })

  it('🔴 keeps the four subjects the corpus is organised by', () => {
    // `traduccion` 70 documents, `dengue` 60, `escuela` 60, `discapacidad` 60.
    const subjects = ['traducción', 'dengue', 'escuela', 'discapacidad']
    expect(labelsOf(windowOf(...subjects.map((s) => entity('tema', s))))).toEqual(subjects)
  })

  it('⚠ leaves `evento` alone too — and this is the known cost', () => {
    // The prompt defines `evento` as "un hecho o un proceso", and a process is
    // a concept, so a bare noun there is not the unambiguous category error it
    // is for lugar/organizacion/persona. The price is named rather than hidden:
    // `conversatorio` (27 documents) stays a generic hub. Adding 'evento' to
    // `GENERIC_RULE_TYPES` is the one-line change if that trade flips.
    expect(labelsOf(windowOf(entity('evento', 'conversatorio')))).toEqual(['conversatorio'])
    expect(labelsOf(windowOf(entity('evento', 'pandemia')))).toEqual(['pandemia'])
  })

  it('drops the edges that touched a dropped label, and only those', () => {
    // 🔴 Not merely tidiness. `mergeWindows` would drop a dangling edge only if
    // nothing else in the document shares the label; if something does, the
    // edge silently re-attaches to the wrong node. Removing it here by
    // canonical key is what makes that impossible.
    const w: ParsedWindow = {
      entities: [
        entity('lugar', 'barranca'),
        entity('lugar', 'Morelos'),
        entity('tema', 'discapacidad'),
      ],
      relations: [
        { desde: 'barranca', hacia: 'Morelos', tipo: 'ubicado_en' },
        { desde: 'discapacidad', hacia: 'Morelos', tipo: 'afecta_a' },
      ],
    }
    const out = dropGenericEntities(w)
    expect(out.entities.map((e) => e.etiqueta)).toEqual(['Morelos', 'discapacidad'])
    expect(out.relations).toHaveLength(1)
    expect(out.relations[0]).toMatchObject({ desde: 'discapacidad', hacia: 'Morelos' })
  })

  it('returns the window untouched when nothing is generic', () => {
    const clean = windowOf(entity('lugar', 'Cuernavaca'), entity('tema', 'náhuatl'))
    expect(dropGenericEntities(clean)).toBe(clean)
  })

  it('⚠ LOGS what it dropped — the catastrophic failure mode must be visible', () => {
    // If a future model lowercases every label, this rejects every one-word
    // place, organisation and person at once. During a multi-hour backfill the
    // log is the only place that is visible before the money is spent.
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    dropGenericEntities(windowOf(entity('lugar', 'barranca'), entity('organizacion', 'escuela')))
    expect(log).toHaveBeenCalledWith(
      '[graph] etiquetas genéricas descartadas:',
      'lugar/barranca, organizacion/escuela',
    )
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

  it('🔴 drops the mistyped generic labels end to end, and keeps the subjects', async () => {
    // The junk hubs arriving exactly as the `v2` model produced them, mixed
    // with the corpus vocabulary that must survive. The prompt has forbidden
    // the first group since `v1`; this asserts the CODE now holds regardless,
    // and that it does NOT reach the second group.
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client } = fakeClient([
      okResponse(
        [
          { tipo: 'lugar', etiqueta: 'barranca', menciones: 9 },
          { tipo: 'organizacion', etiqueta: 'escuela', menciones: 5 },
          { tipo: 'lugar', etiqueta: 'clínica', menciones: 3 },
          { tipo: 'tema', etiqueta: 'náhuatl', menciones: 7 },
          { tipo: 'tema', etiqueta: 'discapacidad', menciones: 4 },
          { tipo: 'lugar', etiqueta: 'Morelos', menciones: 3 },
          { tipo: 'organizacion', etiqueta: 'Escuela Primaria Miguel Hidalgo', menciones: 2 },
        ],
        [
          { desde: 'barranca', hacia: 'Morelos', tipo: 'ubicado_en' },
          { desde: 'náhuatl', hacia: 'Morelos', tipo: 'relacionado_con' },
        ],
      ),
    ])

    const result = await extractGraph({
      docId: 20,
      contentKind: 'documento',
      text,
      client,
      windowChars: 5000,
    })

    const labels = result.entities.map((e) => e.label)
    // The rejections — a class of thing typed as a particular…
    expect(labels).not.toContain('barranca')
    expect(labels).not.toContain('escuela')
    expect(labels).not.toContain('clínica')
    // 🔴 …and the positive counterpart, twice over: the corpus's own subject
    // vocabulary survives, and so do the properly named entities. Without this
    // the suite could not tell a working filter from an extraction that
    // produced nothing at all.
    expect(labels).toEqual([
      'náhuatl',
      'discapacidad',
      'Morelos',
      'Escuela Primaria Miguel Hidalgo',
    ])
    // The edge from a dropped node went with it; the `tema` edge stayed.
    expect(result.relations).toHaveLength(1)
    expect(result.relations[0].type).toBe('relacionado_con')
  })

  it('🔴 applies the person rule AND the generic rule, neither shadowing the other', async () => {
    // Both post-filters run on the same window. A testimonio loses its persona
    // to the privacy rule; a class-of-thing typed as a place goes to the
    // quality rule; a named organisation survives both, because ADR §5.3 says
    // organisations always do; and the one-word `tema` survives because the
    // quality rule never looks at a `tema`.
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client } = fakeClient([
      okResponse([
        { tipo: 'persona', etiqueta: 'Ernesto Ramírez', menciones: 4 },
        { tipo: 'lugar', etiqueta: 'barranca', menciones: 3 },
        { tipo: 'tema', etiqueta: 'mixteco', menciones: 2 },
        { tipo: 'organizacion', etiqueta: 'Centro de Salud de Tlayacapan', menciones: 2 },
      ]),
    ])
    const result = await extractGraph({
      docId: 21,
      contentKind: 'testimonio',
      text,
      client,
      windowChars: 5000,
    })
    expect(result.entities.map((e) => e.label)).toEqual([
      'mixteco',
      'Centro de Salud de Tlayacapan',
    ])
  })

  it('carries the window failure reason into the thrown error, so `graphError` diagnoses itself', async () => {
    // 🔴 The 11 documents that failed the first corpus run all recorded the
    // same useless `graphError`: "every extraction window failed (1 of 1)". The
    // per-window message already carried the raw response, but only to
    // `console.warn`. `schedule.ts` persists THIS throw, so the evidence has to
    // ride on it — `generate.sync` writes no `generation_jobs` row, so there is
    // no other way to see the response without paying for the call again.
    const client: GraphGenerateClient = {
      generate: {
        async sync() {
          return { parsed: undefined, text: '{"entidades":[{"tipo":"tema","etiq' }
        },
      },
    }
    await expect(
      extractGraph({
        docId: 22,
        contentKind: 'documento',
        text,
        client,
        windowChars: 5000,
        onWindowError: () => undefined,
      }),
    ).rejects.toThrow(/every extraction window failed \(1 of 1\).*response text was: \{"entidades"/s)
  })

  it('shows the TAIL of a long response too — a cut-off array is diagnosed by its end', async () => {
    const body = `{"entidades":[${'{"tipo":"tema","etiqueta":"x"},'.repeat(40)}{"tipo":"tema","etiq`
    const client: GraphGenerateClient = {
      generate: {
        async sync() {
          return { parsed: undefined, text: body }
        },
      },
    }
    let message = ''
    await extractGraph({
      docId: 23,
      contentKind: 'documento',
      text,
      client,
      windowChars: 5000,
      onWindowError: () => undefined,
    }).catch((err: Error) => {
      message = err.message
    })
    expect(message).toContain('chars…')
    expect(message).toContain('"etiq')
    // Capped, so `recordFailure`'s 500-character slice does not eat the tail.
    expect(message.length).toBeLessThan(500)
  })

  it('returns an empty extraction for empty text without calling the model', async () => {
    const { client, calls } = fakeClient([])
    const result = await extractGraph({ docId: 8, contentKind: 'documento', text: '  ', client })
    expect(calls).toHaveLength(0)
    expect(result).toMatchObject({ entities: [], relations: [], windows: 0 })
  })
})
