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
})
