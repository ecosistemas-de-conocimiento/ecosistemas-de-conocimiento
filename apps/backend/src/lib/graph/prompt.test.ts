/**
 * 🔴 THE PERSON RULE, MECHANISM 1: the response schema simply cannot express a
 * person node for a testimonio. Tested here independently of the post-filter,
 * because the ADR's whole point is that the two mechanisms are separate and
 * either one must hold on its own.
 */
import { describe, expect, it } from 'vitest'

import {
  GRAPH_EXTRACT_UNIT_TYPE,
  GRAPH_FRAGMENT_MAX_CHARS,
  GRAPH_PROMPT_VERSION,
  graphBuiltInSpec,
  graphPromptTemplate,
  graphResponseSchema,
  graphUnitKey,
} from './prompt'
import { isGenericLabel } from './extract'
import { GRAPH_RELATION_TYPES } from './types'

interface EntityItem {
  required: string[]
  properties: Record<string, Record<string, unknown>>
}

const entityItem = (schema: Record<string, unknown>): EntityItem => {
  const entidades = (schema.properties as Record<string, Record<string, unknown>>).entidades
  return entidades.items as unknown as EntityItem
}

const tipoEnum = (schema: Record<string, unknown>): string[] =>
  entityItem(schema).properties.tipo.enum as unknown as string[]

describe('graphResponseSchema', () => {
  it('offers every entity type when personas are allowed', () => {
    expect(tipoEnum(graphResponseSchema(true))).toEqual([
      'tema',
      'lugar',
      'evento',
      'organizacion',
      'persona',
    ])
  })

  it('🔴 omits `persona` entirely when personas are not allowed', () => {
    const types = tipoEnum(graphResponseSchema(false))
    expect(types).not.toContain('persona')
    expect(types).toEqual(['tema', 'lugar', 'evento', 'organizacion'])
  })

  it('⚠ keeps `organizacion` in the restricted variant', () => {
    // ADR §5.3: organisations are always extracted. Naming an institution does
    // not identify a participant, and losing them would gut the analysis.
    expect(tipoEnum(graphResponseSchema(false))).toContain('organizacion')
  })

  it('holds the relation vocabulary in both variants', () => {
    for (const allow of [true, false]) {
      const schema = graphResponseSchema(allow)
      const relaciones = (
        schema.properties as Record<string, Record<string, Record<string, unknown>>>
      ).relaciones
      const items = relaciones.items as Record<string, Record<string, Record<string, unknown>>>
      expect(items.properties.tipo.enum).toEqual([...GRAPH_RELATION_TYPES])
    }
  })

  it('refuses extra keys, so a stray field fails the strict parsed gate', () => {
    const schema = graphResponseSchema(true)
    expect(schema.additionalProperties).toBe(false)
    const entidades = (schema.properties as Record<string, Record<string, unknown>>).entidades
    expect((entidades.items as Record<string, unknown>).additionalProperties).toBe(false)
  })

  it('caps the arrays, so one runaway response cannot fill a document', () => {
    // ⚠ 15/20 rather than the original 40/60, and the reason is measured: a
    // complete answer has to fit the output-token budget of ONE call, and on
    // the deployment this was measured against the model generates until it is
    // cut off rather than honouring `maxItems`. Lowering the cap did not by
    // itself rescue extraction (see `graphEffortLevel`), but a smaller schema
    // is the right shape regardless — 15 good entities per window beat 40
    // generic ones, which is what rule 8 of the prompt asks for in words.
    const schema = graphResponseSchema(true)
    const props = schema.properties as Record<string, Record<string, unknown>>
    expect(props.entidades.maxItems).toBe(15)
    expect(props.relaciones.maxItems).toBe(20)
  })

  it('asks each entity for a `fragmento` — the "why is this here" affordance', () => {
    // ADR §13.1 removed it; the owner asked for it back. It is requested in
    // BOTH variants, including for a testimonio, because the rule that protects
    // a testimonio is a STORAGE rule, not a request rule — see the next test.
    for (const allowPersona of [true, false]) {
      const item = entityItem(graphResponseSchema(allowPersona))
      expect(Object.keys(item.properties)).toContain('fragmento')
      expect(item.properties.fragmento).toEqual({ type: 'string', maxLength: 120 })
    }
  })

  it('⚠ keeps `fragmento` OPTIONAL, so a window with nothing to quote still parses', () => {
    // `required` is `['tipo','etiqueta']`. A model that cannot find a short
    // literal justification must be able to omit the field rather than invent
    // one — rule 7 says exactly that in words, and this is the schema agreeing.
    for (const allowPersona of [true, false]) {
      expect(entityItem(graphResponseSchema(allowPersona)).required).toEqual([
        'tipo',
        'etiqueta',
      ])
    }
  })

  it('🔴 caps the quotation at 120 characters, not the original 300', () => {
    // Two reasons, both real: `fragmento` is the single biggest OUTPUT cost in
    // the response and this deployment runs at ~8 tok/s (ADR §13); and a
    // shorter quotation is a smaller re-identification surface even where it is
    // allowed to be stored. `extract.ts` slices to the SAME number — asserted
    // in `extract.test.ts`, because the schema's cap is a request and the slice
    // is what holds.
    expect(GRAPH_FRAGMENT_MAX_CHARS).toBe(120)
    expect(entityItem(graphResponseSchema(true)).properties.fragmento).toMatchObject({
      maxLength: GRAPH_FRAGMENT_MAX_CHARS,
    })
  })
})

describe('graphPromptTemplate', () => {
  it('interpolates with TRIPLE staches, so Handlebars does not HTML-escape', () => {
    const template = graphPromptTemplate(true)
    for (const name of ['titulo', 'texto', 'ventana', 'ventanas']) {
      expect(template).toContain(`{{{${name}}}}`)
    }
    // A DOUBLE stache is `{{` that is neither preceded nor followed by another
    // brace. ai-service compiles with Handlebars escaping on, so one of those
    // would ship `&quot;` and `&#x27;` to the model — and the document body is
    // the largest interpolation here.
    expect(/(?<!\{)\{\{(?!\{)/.test(template)).toBe(false)
  })

  it('is Spanish and names the whole type vocabulary', () => {
    const template = graphPromptTemplate(true)
    expect(template).toContain('TIPOS DE ENTIDAD PERMITIDOS')
    expect(template).toContain('TIPOS DE RELACIÓN PERMITIDOS')
    for (const type of ['tema', 'lugar', 'evento', 'organizacion', 'persona']) {
      expect(template).toContain(type)
    }
  })

  it('asks for `fragmento` in words, and says how long it may be', () => {
    // The schema's `maxLength` is not what the model reads first. Rule 7 is.
    for (const allowPersona of [true, false]) {
      const template = graphPromptTemplate(allowPersona)
      expect(template).toContain('7. `fragmento` es una cita LITERAL y BREVE')
      expect(template).toContain(`máximo ${GRAPH_FRAGMENT_MAX_CHARS} caracteres`)
      // ⚠ "Omit it" has to be an option in words too, or the model invents one
      // for every entity — and an invented quotation is worse than none.
      expect(template).toContain('omite el campo')
    }
  })

  it('🔴 numbers the rules 1-9 exactly once each', () => {
    // The list used to run 1-6 and then have TWO rule 8s and no rule 7 — a list
    // that contradicted itself about its own length, handed to a model whose
    // job is to follow it. Restoring `fragmento` is what made the gap visible.
    for (const allowPersona of [true, false]) {
      const rules = graphPromptTemplate(allowPersona)
        .split('\n')
        .map((line) => /^(\d)\. /.exec(line)?.[1])
        .filter((n): n is string => n != null)
      expect(rules).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    }
  })

  it('⚠ states the SAME array caps the schema enforces', () => {
    // The prose said 60 relations while `maxItems` said 20. On this deployment
    // the model generates until it is cut off rather than honouring `maxItems`
    // (see `graphEffortLevel`), so the WORDS are the effective cap and the two
    // disagreeing by a factor of three was the schema losing.
    const template = graphPromptTemplate(true)
    const props = graphResponseSchema(true).properties as Record<string, Record<string, unknown>>
    expect(template).toContain(`Máximo ${props.entidades.maxItems} entidades`)
    expect(template).toContain(`y ${props.relaciones.maxItems} relaciones`)
  })

  it('🔴 names the measured category errors as counter-examples in rule 3', () => {
    // `v2`'s rule 3 said only "agua es demasiado vago", and the corpus came
    // back with `barranca` as a lugar (49 documents) and `escuela` as an
    // `organizacion` (22) among its biggest nodes. The failures the model
    // actually produced are now in the prompt by name — an abstract rule it
    // ignored, made concrete. The GUARANTEE is still `dropGenericEntities` in
    // `extract.ts`; this is the cheap second layer.
    for (const allowPersona of [true, false]) {
      const template = graphPromptTemplate(allowPersona)
      for (const observed of ['barranca', 'escuela', 'clínica', 'mercado']) {
        expect(template).toContain(`"${observed}"`)
      }
      // …paired with the qualified form of the same noun, so the rule reads as
      // "give me the name", not as "never mention these words".
      expect(template).toContain('"Escuela Primaria Miguel Hidalgo"')
      expect(template).toContain('"barranca de Amanalco"')
      expect(template).toContain('"mercado de Villa de Ayala"')
    }
  })

  it('⚠ tells the model that a bare one-word NAME-type label is DISCARDED', () => {
    // The strongest lever a prompt has is the consequence of disobeying, and
    // this one is true: `extract.ts` drops it. It is also scoped exactly as the
    // code is — the threat must not extend to `tema`, or the model stops
    // producing the corpus's subjects.
    const template = graphPromptTemplate(true)
    expect(template).toContain('DESCARTA automáticamente')
    expect(template).toContain('Un `lugar`, una `organizacion` o una `persona` de UNA SOLA palabra')
  })

  it('🔴 tells the model a one-word `tema` is WANTED — the corpus vocabulary', () => {
    // 🔴 THE OWNER'S CORRECTION, IN THE PROMPT (2026-09-04, upheld 2026-10-16).
    // All 11 of the corpus's indigenous languages land on `tema`, and for a
    // testimonio `documents.lengua` is NULL on purpose (ADR §18.5), so the graph
    // is where their language shows. An earlier draft told the model to write
    // "lengua náhuatl" instead of "náhuatl", which would have suppressed exactly
    // the vocabulary the corpus is organised by.
    for (const allowPersona of [true, false]) {
      const template = graphPromptTemplate(allowPersona)
      expect(template).toContain('Un `tema`, en cambio, SÍ puede ser una sola palabra')
      for (const subject of ['náhuatl', 'mixteco', 'discapacidad', 'dengue', 'braille']) {
        expect(template).toContain(`"${subject}"`)
      }
      // ⚠ And the routing rule that recovers the fourth theme: `escuela` is a
      // subject, so it belongs on `tema`, not on `organizacion`.
      expect(template).toContain('eso es un `tema`')
    }
  })

  it('🔴 v4: tells the model `español` and an unnamed place are NEVER a `tema`', () => {
    // Measured on the v3 graph: `tema|español` 93 documents, `tema|barranca` 24
    // after v3 refused it as a `lugar`. `extract.ts` drops both whatever the
    // model returns; these words are the cheap layer.
    for (const allowPersona of [true, false]) {
      const template = graphPromptTemplate(allowPersona)
      expect(template).toContain('NUNCA son `tema`')
      expect(template).toContain('- "español": casi todos los textos están en español')
      // ⚠ Scoped to Spanish ONLY: the indigenous languages are said to stay.
      expect(template).toContain('Las lenguas indígenas SÍ son temas.')
      expect(template).toContain('SIN NOMBRE ("barranca"')
      // The qualified form stays wanted, so this cannot read as "never mention".
      expect(template).toContain('"contaminación de barrancas"')
      // 🔴 The v3 escape route is gone: rule 3 no longer routes the mercado or
      // the clínica into `tema` "como asunto".
      expect(template).not.toContain('la clínica o el mercado como')
    }
  })

  it('⚠ never asks the model to turn a subject into a phrase', () => {
    // The suppressing instruction from the withdrawn draft, asserted absent.
    const template = graphPromptTemplate(true)
    expect(template).not.toContain('"lengua náhuatl"')
    expect(template).not.toContain('no "náhuatl"')
    expect(template).toContain('No los conviertas en frases')
  })

  it('🔴 no entity-type example demonstrates the mistake rule 3 forbids', () => {
    // `v2` listed "el desalojo" as an `evento` and "la asamblea ejidal" as an
    // `organizacion` — a bare common noun with an article in front of it, which
    // is exactly the shape rule 3 forbids and exactly what the corpus filled up
    // with. An example outranks a rule: the model reads the type list first.
    // ⚠ SCOPED TO THE TYPE BLOCK, deliberately. Rule 2 still quotes
    // "la asamblea ejidal" — as its own MAL example, which is the right place
    // for a bad form. What must not happen is a bad form appearing where the
    // model reads it as a MODEL to copy.
    const template = graphPromptTemplate(true)
    const typeBlock = template.slice(0, template.indexOf('TIPOS DE RELACIÓN'))
    for (const wasAnExample of ['"el desalojo"', '"la asamblea ejidal"', '"la clínica comunitaria"'])
      expect(typeBlock).not.toContain(wasAnExample)

    // 🔴 AND THE GENERAL FORM, checked against the rule itself rather than
    // against a list of strings: every label quoted in the TIPOS DE ENTIDAD
    // block must survive `extract.ts`'s filter. An example the code would throw
    // away is the prompt teaching the failure while forbidding it in words.
    const examples = [...typeBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(examples.length).toBeGreaterThan(8)
    expect(examples.filter((label) => isGenericLabel(label))).toEqual([])
  })

  it('🔴 says an `organizacion` needs a proper name — `escuela` was typed as one', () => {
    for (const allowPersona of [true, false]) {
      const template = graphPromptTemplate(allowPersona)
      expect(template).toContain('colectivo CON')
      expect(template).toContain('NOMBRE PROPIO ("CIDE"')
      expect(template).toContain('Un sustantivo genérico como escuela')
    }
  })

  it('🔴 tells the model not to extract people when personas are forbidden', () => {
    const forbidden = graphPromptTemplate(false)
    expect(forbidden).toContain('PROHIBIDO EXTRAER PERSONAS')
    expect(forbidden).not.toContain('`persona`: una persona nombrada')
    // Still asks for organisations, in the same breath.
    expect(forbidden).toContain('ORGANIZACIONES sí se extraen siempre')
  })
})

describe('graphBuiltInSpec', () => {
  it('carries the deep tier and the matching schema variant', () => {
    const spec = graphBuiltInSpec(false)
    expect(spec.effortLevel).toBe('deep')
    expect(tipoEnum(spec.responseSchema)).not.toContain('persona')
    expect(spec.promptTemplate).toContain('PROHIBIDO EXTRAER PERSONAS')
  })
})

describe('graphUnitKey', () => {
  it('is stable and window-scoped, so a run can be replayed without paying again', () => {
    expect(graphUnitKey(42, 0)).toBe(`${GRAPH_EXTRACT_UNIT_TYPE}:42:0`)
    expect(graphUnitKey('abc', 3)).toBe(`${GRAPH_EXTRACT_UNIT_TYPE}:abc:3`)
  })
})

describe('GRAPH_PROMPT_VERSION', () => {
  it('is a non-empty string, because it is stamped on every row it produces', () => {
    expect(typeof GRAPH_PROMPT_VERSION).toBe('string')
    expect(GRAPH_PROMPT_VERSION.length).toBeGreaterThan(0)
  })

  it('🔴 moved off `v1`, because `v1` asked for no `fragmento`', () => {
    // Every `v1` row has a NULL snippet even for a `documento` that is allowed
    // one. Those rows are incomplete, not wrong, and this stamp is the ONLY
    // thing that can find them: `backfill.ts` selects on
    // `graphPromptVersion != GRAPH_PROMPT_VERSION`. Leaving it at `v1` would
    // leave the corpus half-extracted under two contracts with nothing able to
    // tell the halves apart.
    expect(GRAPH_PROMPT_VERSION).not.toBe('v1')
  })

  it('🔴 is `v4`, the stamp the language/place re-extraction is findable by', () => {
    // `v2` rows were extracted under a contract that let `barranca`, `español`,
    // `escuela` and `discapacidad` become the corpus's biggest nodes. The ONLY
    // thing that can find them afterwards is this string: `backfill.ts` selects
    // on `graphPromptVersion != GRAPH_PROMPT_VERSION`. Leaving it at `v2` would
    // leave the corpus half-extracted under two contracts with nothing able to
    // tell the halves apart — which is exactly what happened at `v1`.
    // `v3` rows carry `tema|español` (93 documents) and `tema|barranca` (24);
    // `v4` refuses both, and only this stamp finds the rows still carrying them.
    expect(GRAPH_PROMPT_VERSION).toBe('v4')
  })
})
