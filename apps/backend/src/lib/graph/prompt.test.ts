/**
 * 🔴 THE PERSON RULE, MECHANISM 1: the response schema simply cannot express a
 * person node for a testimonio. Tested here independently of the post-filter,
 * because the ADR's whole point is that the two mechanisms are separate and
 * either one must hold on its own.
 */
import { describe, expect, it } from 'vitest'

import {
  GRAPH_EXTRACT_UNIT_TYPE,
  GRAPH_PROMPT_VERSION,
  graphBuiltInSpec,
  graphPromptTemplate,
  graphResponseSchema,
  graphUnitKey,
} from './prompt'
import { GRAPH_RELATION_TYPES } from './types'

const tipoEnum = (schema: Record<string, unknown>): string[] => {
  const entidades = (schema.properties as Record<string, Record<string, Record<string, unknown>>>)
    .entidades
  const items = entidades.items as Record<string, Record<string, Record<string, unknown>>>
  return items.properties.tipo.enum as unknown as string[]
}

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

  it('🔴 asks for NO verbatim quotation — nothing to leak, by construction', () => {
    // `fragmento` used to carry a literal quote justifying each entity. It is
    // gone from every schema variant. ADR §7.3.4 already refused to STORE one
    // for a testimonio on the grounds that a verbatim quotation is the most
    // direct re-identification surface in the design; not asking for one at all
    // is the stronger version of the same rule, and it removes the conditional
    // that someone could later get backwards.
    for (const allowPersona of [true, false]) {
      const schema = graphResponseSchema(allowPersona)
      const props = schema.properties as Record<string, Record<string, unknown>>
      const item = props.entidades.items as Record<string, Record<string, unknown>>
      expect(Object.keys(item.properties)).not.toContain('fragmento')
    }
    expect(JSON.stringify(graphResponseSchema(true))).not.toContain('fragmento')
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
})
