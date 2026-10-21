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
  dropNoiseEntities,
  extractGraph,
  GRAPH_SHAPE_POLICY,
  GRAPH_WORD_CLASSES,
  isGenericLabel,
  isTransientWindowError,
  policyRejects,
  splitQualifiedPlaces,
  mergeWindows,
  parseWindowResponse,
  significantTokens,
  splitIntoWindows,
  wordClassOf,
  type GraphGenerateClient,
  type ParsedWindow,
} from './extract'
import { GRAPH_FRAGMENT_MAX_CHARS, graphResponseSchema } from './prompt'
import { GRAPH_ENTITY_TYPES } from './types'

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

describe('🔴 GRAPH_SHAPE_POLICY — the graph-shape decision, as data', () => {
  it('covers EVERY entity type, so a new type forces a decision', () => {
    // `satisfies Record<GraphEntityType, GraphShapeRule>` already makes this a
    // COMPILE error — verified by deleting a type and watching tsc fail. This
    // asserts it again at runtime because the policy is meant to be edited by
    // someone who may not run the typechecker before asking what it does.
    expect(Object.keys(GRAPH_SHAPE_POLICY).sort()).toEqual([...GRAPH_ENTITY_TYPES].sort())
  })

  it('🔴 carries the REASONING with every rule, not just the verdict', () => {
    // The point of the policy object: a specialist changing it must see the
    // argument and the measured cost at the point of change, not in a report
    // they were never sent. An empty rationale is a rule nobody can revisit.
    for (const type of GRAPH_ENTITY_TYPES) {
      const rule = GRAPH_SHAPE_POLICY[type]
      expect(rule.rule.length, `${type}.rule`).toBeGreaterThan(20)
      expect(rule.rationale.length, `${type}.rationale`).toBeGreaterThan(40)
      expect(rule.cost.length, `${type}.cost`).toBeGreaterThan(20)
    }
  })

  it('records the decision as it stands: only lugar, organizacion and persona', () => {
    // ⚠ THIS TEST IS THE DECISION RECORD, and it is MEANT to fail when the
    // policy changes. Failing here is the prompt to update the rationale, the
    // cost figures and `plan/adr-corpus-graph.md` — not to edit this list back.
    // Re-measure first: GRAPH_POLICY_ORG=1 payload run src/lib/graph/policy.cli.ts
    const requiring = GRAPH_ENTITY_TYPES.filter(
      (t) => GRAPH_SHAPE_POLICY[t].requiresProperName,
    )
    expect([...requiring].sort()).toEqual(['lugar', 'organizacion', 'persona'])
  })

  it('🔴 names the language axis and the subjects in the `tema` rationale', () => {
    // The exemption that saves the corpus's own vocabulary. If someone flips
    // `tema` to `true`, this rationale is what they read first.
    expect(GRAPH_SHAPE_POLICY.tema.requiresProperName).toBe(false)
    for (const word of ['náhuatl', 'mixteco', 'zapoteco', 'discapacidad', 'dengue']) {
      expect(GRAPH_SHAPE_POLICY.tema.rationale).toContain(word)
    }
    expect(GRAPH_SHAPE_POLICY.evento.cost).toContain('conversatorio')
  })

  it('records the v4 decision: only `tema` excludes word classes, and which', () => {
    // ⚠ DECISION RECORD, like the test above: meant to fail when the policy
    // changes. `lugar` etc. need no exclusion — the orthographic rule already
    // drops a bare `barranca` there.
    expect(GRAPH_SHAPE_POLICY.tema.excludes).toEqual(['lengua', 'lugarSinNombre'])
    for (const type of GRAPH_ENTITY_TYPES.filter((t) => t !== 'tema')) {
      expect(GRAPH_SHAPE_POLICY[type].excludes, type).toEqual([])
    }
  })

  it('🔴 every excluded word class carries its reasoning and a measured cost', () => {
    for (const [name, cls] of Object.entries(GRAPH_WORD_CLASSES)) {
      expect(cls.rule.length, `${name}.rule`).toBeGreaterThan(20)
      expect(cls.rationale.length, `${name}.rationale`).toBeGreaterThan(40)
      expect(cls.cost.length, `${name}.cost`).toBeGreaterThan(20)
      expect(cls.words.length, `${name}.words`).toBeGreaterThan(0)
    }
    // The word-class layer still names `español` only. Since 2026-10-21 every
    // language is dropped by the separate noise rule (`noise.ts`), and the
    // rationale says so.
    expect(GRAPH_WORD_CLASSES.lengua.words).toEqual(['español', 'castellano'])
    expect(GRAPH_WORD_CLASSES.lengua.rationale).toContain('2026-10-21')
  })
})

describe('🔴 wordClassOf — a PURE, type-blind word-class lookup', () => {
  it('finds `español` in any case, or with an article or a head', () => {
    // ⚠ `canonicalKey` keeps the ñ, so `espanol` is a different key, as everywhere.
    for (const label of ['español', 'Español', 'ESPAÑOL', 'castellano', 'idioma español',
      'el español']) {
      expect(wordClassOf(label), label).toBe('lengua')
    }
  })

  it('🔴 does NOT class the indigenous languages — they stay `tema`', () => {
    for (const label of ['náhuatl', 'nahuatl', 'mixteco', 'mazateco', 'zapoteco',
      'totonaco', 'tlahuica', 'tlapaneco', 'amuzgo', 'hñähñu', 'tsotsil', 'mixe',
      'lengua náhuatl']) {
      expect(wordClassOf(label), label).toBeNull()
    }
  })

  it('finds an unnamed geographic noun, singular or plural', () => {
    for (const label of ['barranca', 'barrancas', 'la barranca', 'colonia', 'río',
      'ríos', 'ciudades', 'cerro']) {
      expect(wordClassOf(label), label).toBe('lugarSinNombre')
    }
  })

  it('🔴 returns null once a QUALIFIER is present — that is a tema, not a word', () => {
    // The positive half: a qualified label is exactly what rule 3 asks for.
    for (const label of ['contaminación de barrancas', 'barranca de Amanalco',
      'lengua de señas mexicana', 'revitalización del náhuatl', 'enseñanza del español',
      'lenguas indígenas', 'pueblos indígenas']) {
      expect(wordClassOf(label), label).toBeNull()
    }
  })

  it('returns null for the corpus subjects and the deliberately excluded words', () => {
    // `escuela`, `mercado`, `clínica` are built spaces or subjects, not
    // geography; `ejido`/`comunidad` are subjects here; `mayo` is the month;
    // `lsm` and `braille` are the disability subject's vocabulary.
    for (const label of ['discapacidad', 'dengue', 'traducción', 'escuela', 'mercado',
      'clínica', 'ejido', 'comunidad', 'bosque', 'mayo', 'manzana', 'lsm', 'braille',
      'lengua', 'Morelos']) {
      expect(wordClassOf(label), label).toBeNull()
    }
  })
})

describe('policyRejects — the predicate the CLI measures', () => {
  it('rejects a bare noun where a name is required, and a word class where excluded', () => {
    expect(policyRejects('lugar', 'barranca')).toBe(true)
    expect(policyRejects('tema', 'barranca')).toBe(true)
    expect(policyRejects('tema', 'español')).toBe(true)
    expect(policyRejects('tema', 'discapacidad')).toBe(false)
    expect(policyRejects('lugar', 'barranca de Amanalco')).toBe(false)
  })

  it('⚠ leaves `evento` alone for word classes too — that decision is not taken here', () => {
    expect(policyRejects('evento', 'conversatorio')).toBe(false)
    expect(policyRejects('evento', 'barranca')).toBe(false)
  })

  it('takes a simulated `requiresProperName` without touching the word classes', () => {
    const all = () => true
    expect(policyRejects('tema', 'discapacidad', all)).toBe(true)
    expect(policyRejects('tema', 'español', () => false)).toBe(true)
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
   * 🔴 THE CORPUS'S INDIGENOUS LANGUAGE AXIS SURVIVES, ALL OF IT — and
   * `español` does not. Owner decision 2026-10-16, upholding 2026-09-04. For
   * a testimonio `documents.lengua` is NULL on purpose (ADR §18.5), so the
   * graph is where its language shows. `español` (93 documents in the v3
   * graph) is the language almost the whole corpus is written in: it links
   * everything and distinguishes nothing.
   */
  // ⚠ `dropGenericEntities` ALONE. Since 2026-10-21 `dropNoiseEntities` drops
  // every language after it — see the `extractGraph` noise test below.
  it('🔴 keeps all 11 corpus languages as `tema`, and drops only `español`', () => {
    const languages = [
      'náhuatl', 'mixteco', 'mazateco', 'zapoteco', 'totonaco', 'tlahuica',
      'tlapaneco', 'amuzgo', 'hñähñu', 'tsotsil', 'mixe',
    ]
    expect(
      labelsOf(windowOf(...[...languages, 'español'].map((l) => entity('tema', l)))),
    ).toEqual(languages)
  })

  it('🔴 drops `barranca` re-typed as a `tema` — the hole v3 left', () => {
    // v3 dropped `lugar|barranca`; the model answered with `tema|barranca`
    // (24 documents). Both doors are now shut, and the named and the
    // qualified forms still pass.
    expect(labelsOf(windowOf(entity('tema', 'barranca'), entity('tema', 'colonia')))).toEqual([])
    expect(
      labelsOf(
        windowOf(
          entity('lugar', 'barranca de Amanalco'),
          entity('tema', 'contaminación de barrancas'),
          entity('tema', 'enseñanza del español'),
        ),
      ),
    ).toEqual(['barranca de Amanalco', 'contaminación de barrancas', 'enseñanza del español'])
  })

  it('🔴 keeps the four subjects the corpus is organised by', () => {
    // `traduccion` 70 documents, `dengue` 60, `escuela` 60, `discapacidad` 60.
    const subjects = ['traducción', 'dengue', 'escuela', 'discapacidad']
    expect(labelsOf(windowOf(...subjects.map((s) => entity('tema', s))))).toEqual(subjects)
  })

  it('🔴 follows GRAPH_SHAPE_POLICY rather than a list of its own', () => {
    // Ties behaviour to the table so the two cannot drift: editing the policy
    // changes what is dropped, with no second place to remember to update.
    for (const type of GRAPH_ENTITY_TYPES) {
      const survives = labelsOf(windowOf(entity(type, 'cosa'))).length === 1
      expect(survives, `bare common noun typed as ${type}`).toBe(
        !GRAPH_SHAPE_POLICY[type].requiresProperName,
      )
      // The positive counterpart, per type: a NAMED label survives everywhere.
      expect(labelsOf(windowOf(entity(type, 'Tlayacapan')))).toEqual(['Tlayacapan'])
    }
  })

  it('⚠ leaves `evento` alone too — and this is the known cost', () => {
    // The prompt defines `evento` as "un hecho o un proceso", and a process is
    // a concept, so a bare noun there is not the unambiguous category error it
    // is for lugar/organizacion/persona. The price is named rather than hidden:
    // `conversatorio` stays a generic hub. Flipping `evento.requiresProperName`
    // in `GRAPH_SHAPE_POLICY` is the one-line change if that trade flips.
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

  it('🔴 drops languages and redaction placeholders, of any type, with their relations', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client } = fakeClient([
      okResponse(
        [
          { tipo: 'tema', etiqueta: 'náhuatl' },
          { tipo: 'tema', etiqueta: 'Amuzgo' },
          { tipo: 'tema', etiqueta: 'tlapaneco (me’phaa)' },
          { tipo: 'organizacion', etiqueta: 'Totonaco' },
          { tipo: 'tema', etiqueta: 'idioma español' },
          { tipo: 'lugar', etiqueta: '[Domicilio B]' },
          { tipo: 'lugar', etiqueta: 'Domicilio 1' },
          { tipo: 'lugar', etiqueta: '[Lugar B]' },
          { tipo: 'organizacion', etiqueta: '[Dato omitido]' },
          { tipo: 'evento', etiqueta: 'Persona A' },
          { tipo: 'tema', etiqueta: 'traducción del zapoteco al español' },
          { tipo: 'lugar', etiqueta: 'Tlayacapan' },
          { tipo: 'tema', etiqueta: 'personas sordas' },
        ],
        [
          { desde: 'náhuatl', hacia: 'Tlayacapan', tipo: 'relacionado_con' },
          { desde: 'traducción del zapoteco al español', hacia: '[Domicilio B]', tipo: 'ubicado_en' },
          { desde: 'traducción del zapoteco al español', hacia: 'Tlayacapan', tipo: 'ocurre_en' },
        ],
      ),
    ])
    const out = await extractGraph({
      docId: 7,
      contentKind: 'testimonio',
      text,
      client,
      windowChars: 5000,
      maxWindows: 8,
    })
    expect(out.entities.map((e) => e.label).sort()).toEqual(
      ['Tlayacapan', 'personas sordas', 'traducción del zapoteco al español'].sort(),
    )
    expect(out.relations).toEqual([
      { fromKey: 'traduccion del zapoteco al español', toKey: 'tlayacapan', type: 'ocurre_en' },
    ])
  })

  it('dropNoiseEntities leaves a clean window untouched', () => {
    const w = { entities: [{ tipo: 'tema' as const, etiqueta: 'dengue', menciones: 1, fragmento: null }], relations: [] }
    expect(dropNoiseEntities(w)).toBe(w)
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
          { tipo: 'tema', etiqueta: 'dengue', menciones: 7 },
          { tipo: 'tema', etiqueta: 'discapacidad', menciones: 4 },
          // v4: a language and a re-typed place noun, both refused as `tema`.
          { tipo: 'tema', etiqueta: 'español', menciones: 6 },
          { tipo: 'tema', etiqueta: 'barranca', menciones: 5 },
          { tipo: 'lugar', etiqueta: 'Morelos', menciones: 3 },
          { tipo: 'organizacion', etiqueta: 'Escuela Primaria Miguel Hidalgo', menciones: 2 },
        ],
        [
          { desde: 'barranca', hacia: 'Morelos', tipo: 'ubicado_en' },
          { desde: 'dengue', hacia: 'Morelos', tipo: 'relacionado_con' },
          { desde: 'español', hacia: 'dengue', tipo: 'relacionado_con' },
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
    expect(labels).not.toContain('español')
    // 🔴 …and the positive counterpart, twice over: the corpus's own subject
    // vocabulary survives, and so do the properly named entities. Without this
    // the suite could not tell a working filter from an extraction that
    // produced nothing at all.
    expect(labels).toEqual([
      'dengue',
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
    // organisations always do; and the one-word subject `tema` survives
    // because the orthographic rule never looks at a `tema`.
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client } = fakeClient([
      okResponse([
        { tipo: 'persona', etiqueta: 'Ernesto Ramírez', menciones: 4 },
        { tipo: 'lugar', etiqueta: 'barranca', menciones: 3 },
        { tipo: 'tema', etiqueta: 'dengue', menciones: 2 },
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
      'dengue',
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

  it('🔴 a failing extraction on a testimonio never logs or throws the reply content', async () => {
    const secret = 'Juana Pérez Hernández'
    const body = `{"entidades":[{"tipo":"persona","etiqueta":"${secret}","fragm`
    const client: GraphGenerateClient = {
      generate: {
        async sync() {
          return { parsed: undefined, text: body }
        },
      },
    }
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    )
    let message = ''
    try {
      for (const contentKind of ['testimonio', 'conversacion', 'unknown-kind']) {
        await extractGraph({ docId: 31, contentKind, text, client, windowChars: 5000 }).catch(
          (err: Error) => {
            message += err.message
          },
        )
      }
      const logged = spies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n')
      expect(logged).toContain('extraction window')
      expect(logged).not.toContain('Juana')
      expect(logged).not.toContain('entidades')
      expect(message).not.toContain('Juana')
      expect(message).toContain(`response length ${body.length}`)
      expect(message).toMatch(/position \d+/)
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
  })

  it('returns an empty extraction for empty text without calling the model', async () => {
    const { client, calls } = fakeClient([])
    const result = await extractGraph({ docId: 8, contentKind: 'documento', text: '  ', client })
    expect(calls).toHaveLength(0)
    expect(result).toMatchObject({ entities: [], relations: [], windows: 0 })
  })
})

// ---------------------------------------------------------------------------
// Backlog #16 — duplicate places, and a red badge from one dropped connection
// ---------------------------------------------------------------------------

describe('splitQualifiedPlaces', () => {
  const place = (etiqueta: string) => ({
    tipo: 'lugar' as const,
    etiqueta,
    menciones: 2,
    fragmento: null,
  })

  it('turns "Cuernavaca, Morelos" into Cuernavaca, Morelos and the edge between them', () => {
    const out = splitQualifiedPlaces({
      entities: [
        place('Cuernavaca, Morelos'),
        { tipo: 'tema', etiqueta: 'agua', menciones: 1, fragmento: null },
      ],
      relations: [{ desde: 'agua', hacia: 'Cuernavaca, Morelos', tipo: 'afecta_a' }],
    })
    expect(out.entities.map((e) => `${e.tipo}/${e.etiqueta}`)).toEqual([
      'lugar/Cuernavaca',
      'tema/agua',
      'lugar/Morelos',
    ])
    expect(out.relations).toEqual([
      { desde: 'Cuernavaca', hacia: 'Morelos', tipo: 'ubicado_en' },
      // The edge that named the qualified label now points at the bare place.
      { desde: 'agua', hacia: 'Cuernavaca', tipo: 'afecta_a' },
    ])
  })

  it('merges with the bare spelling in the same document', () => {
    const window = splitQualifiedPlaces({
      entities: [place('Xoxocotla, Morelos'), place('Xoxocotla'), place('Morelos')],
      relations: [],
    })
    const merged = mergeWindows([window], 'documento')
    expect(merged.entities.map((e) => e.label).sort()).toEqual(['Morelos', 'Xoxocotla'])
    expect(merged.entities.find((e) => e.label === 'Xoxocotla')?.occurrences).toBe(4)
    expect(merged.relations).toEqual([
      { fromKey: 'xoxocotla', toKey: 'morelos', type: 'ubicado_en' },
    ])
  })

  it('leaves anything that is not clearly "Place, Container" alone', () => {
    const untouched: ParsedWindow = {
      entities: [
        place('Xoxocotla, Puente de Ixtla, Morelos'),
        place('Tepoztlán, centro'),
        { tipo: 'organizacion', etiqueta: 'CIDE, A.C.', menciones: 1, fragmento: null },
      ],
      relations: [],
    }
    expect(splitQualifiedPlaces(untouched)).toEqual(untouched)
  })
})

describe('one retry for a transient window failure', () => {
  it('classifies network blips and 5xx as transient, and nothing else', () => {
    expect(isTransientWindowError(new TypeError('fetch failed'))).toBe(true)
    expect(isTransientWindowError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isTransientWindowError(Object.assign(new Error('x'), { status: 503 }))).toBe(true)
    expect(isTransientWindowError(Object.assign(new Error('x'), { status: 429 }))).toBe(true)
    expect(isTransientWindowError(Object.assign(new Error('budget'), { status: 402 }))).toBe(false)
    expect(isTransientWindowError(new Error('timeout'))).toBe(false)
  })

  it('recovers from one `fetch failed` instead of failing the document', async () => {
    const { client, calls } = fakeClient([
      new TypeError('fetch failed'),
      okResponse([{ tipo: 'tema', etiqueta: 'Agua', menciones: 1 }]),
    ])
    const result = await extractGraph({
      docId: 40,
      contentKind: 'documento',
      text: 'x'.repeat(300),
      client,
      retryDelayMs: 0,
      onWindowError: () => undefined,
    })
    expect(calls).toHaveLength(2)
    expect(result.windowsFailed).toBe(0)
    expect(result.entities.map((e) => e.label)).toEqual(['Agua'])
  })

  it('still fails after a second transient failure', async () => {
    const { client, calls } = fakeClient([
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
    ])
    await expect(
      extractGraph({
        docId: 41,
        contentKind: 'documento',
        text: 'x'.repeat(300),
        client,
        retryDelayMs: 0,
        onWindowError: () => undefined,
      }),
    ).rejects.toThrow(/every extraction window failed/)
    expect(calls).toHaveLength(2)
  })
})
