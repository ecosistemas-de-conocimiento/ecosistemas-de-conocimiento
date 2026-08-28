/**
 * THE EXTRACTION CONTRACT — prompt, JSON Schema, and the version stamp.
 *
 * `plan/adr-corpus-graph.md` §5.4. Everything the model is told and everything
 * it is allowed to answer lives here, so "what does a `v1` entity mean" is one
 * file to read rather than a diff to reconstruct.
 *
 * ── 🔴 THE PERSON RULE, MECHANISM 1 OF 2 (ADR §5.3) ────────────────────────
 *
 * {@link graphResponseSchema} takes `allowPersona`. When it is false the `tipo`
 * enum simply DOES NOT CONTAIN `persona`, which makes a person node
 * unrepresentable: ai-service surfaces `parsed` only if the response validates
 * against the full schema (`router.ts:120-135`), so a response carrying one
 * yields no `parsed` at all and the window is treated as failed.
 *
 * ⚠ That is the efficient mechanism, NOT the load-bearing one. A registry entry
 * for the `graph-extract` unit-type outranks the `specDefault` floor this ships
 * in, and could therefore replace this schema with one that re-admits `persona`
 * — silently, with no error anywhere. The unconditional post-filter in
 * `extract.ts` is what still holds in that case. Never delete it "because the
 * schema already covers it".
 *
 * ── ⚠ SPANISH, AND WHY IT MATTERS HERE ────────────────────────────────────
 *
 * The corpus is Spanish; the type and predicate vocabularies are Spanish so the
 * model is never translating a category before it answers. A label that comes
 * back in English anyway is not machine-detectable — it is a review item on the
 * first real run, not a guarantee (ADR §5.4).
 *
 * ── ⚠ TRIPLE STACHE ON EVERY INTERPOLATION ────────────────────────────────
 *
 * ai-service compiles prompt templates with Handlebars' default HTML escaping
 * ON. A double stache would ship `it&#x27;s`, `&lt;` and `&quot;` to the model —
 * an HTML rule applied to text no browser will ever render. Spanish document
 * text is full of quotation marks, apostrophes and angle brackets, and the
 * document body is the single largest interpolation in this template. Same
 * warning, same reason, as `packages/ai-client/src/text-to-sql.ts:41-50`.
 */

import {
  GRAPH_ENTITY_TYPES,
  GRAPH_ENTITY_TYPES_WITHOUT_PERSONA,
  GRAPH_RELATION_TYPES,
} from './types'

/**
 * 🔴 STAMPED ONTO EVERY ROW IT PRODUCES, as `documents.graphPromptVersion`.
 *
 * Bump it whenever the prompt or the schema changes in a way that changes what
 * comes back. That is what makes a corpus-wide re-run FINDABLE: the backfill
 * selects documents whose stamp is not this string. Not bumping it means a
 * changed prompt leaves a corpus half-extracted by two different contracts,
 * with nothing able to tell the halves apart.
 *
 * ⚠ Re-running the whole corpus costs real money and changes what the graph
 * view shows (ADR §10). Bumping this is a deliberate operation, not a
 * deploy-time one.
 */
export const GRAPH_PROMPT_VERSION = 'v1'

/**
 * The registry unit-type. A project takes ownership of extraction by
 * registering this type; until it does, the `specDefault` FLOOR below is what
 * runs, with zero registry config.
 */
export const GRAPH_EXTRACT_UNIT_TYPE = 'graph-extract'

/**
 * The stable `unitKey` for one window of one document.
 *
 * ⚠ STABLE ON PURPOSE. `GET /v1/generate/units/:unitKey/latest` can then be
 * used to inspect what a run actually returned without paying for it again
 * (ADR §5.2) — which is the only cheap way to debug extraction quality.
 */
export function graphUnitKey(docId: string | number, windowIndex: number): string {
  return `${GRAPH_EXTRACT_UNIT_TYPE}:${docId}:${windowIndex}`
}

// ---------------------------------------------------------------------------
// The response schema
// ---------------------------------------------------------------------------

/** The JSON Schema handed to ai-service as `responseSchema`. ADR §5.4. */
export function graphResponseSchema(allowPersona: boolean): Record<string, unknown> {
  const entityTypes = allowPersona
    ? [...GRAPH_ENTITY_TYPES]
    : [...GRAPH_ENTITY_TYPES_WITHOUT_PERSONA]

  return {
    type: 'object',
    additionalProperties: false,
    required: ['entidades', 'relaciones'],
    properties: {
      entidades: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['tipo', 'etiqueta'],
          properties: {
            tipo: { enum: entityTypes },
            etiqueta: { type: 'string', minLength: 2, maxLength: 120 },
            menciones: { type: 'integer', minimum: 1 },
            fragmento: { type: 'string', maxLength: 300 },
          },
        },
      },
      relaciones: {
        type: 'array',
        maxItems: 60,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['desde', 'hacia', 'tipo'],
          properties: {
            desde: { type: 'string' },
            hacia: { type: 'string' },
            tipo: { enum: [...GRAPH_RELATION_TYPES] },
          },
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/**
 * The person rule as the model sees it.
 *
 * Belt and braces with the schema: the schema makes a person node
 * unrepresentable, and this makes the model not want to produce one. Neither is
 * trusted — see the post-filter.
 */
const PERSONA_RULE_ALLOWED = [
  '8. Extrae `persona` SOLO cuando el texto nombra explícitamente a alguien y esa',
  '   persona es relevante para el contenido (una autoridad, una figura pública,',
  '   una firmante). No inventes nombres ni deduzcas identidades.',
].join('\n')

const PERSONA_RULE_FORBIDDEN = [
  '8. PROHIBIDO EXTRAER PERSONAS. Este texto es un testimonio o una conversación.',
  '   NO devuelvas ninguna entidad que nombre o identifique a un individuo, ni',
  '   siquiera como `tema`. Si el texto dice "don Ernesto contó que...", la',
  '   entidad NO es "don Ernesto": es el tema del que habla.',
  '   Las ORGANIZACIONES sí se extraen siempre; nombrar a una institución no',
  '   identifica a nadie.',
].join('\n')

/**
 * The Spanish extraction prompt, as a Handlebars template.
 *
 * Inputs: `titulo`, `texto`, `ventana`, `ventanas`. Every one is interpolated
 * with a TRIPLE stache — see the file header.
 */
export function graphPromptTemplate(allowPersona: boolean): string {
  const entityLines = [
    '- `tema`: un asunto, problema, derecho o concepto que el texto trata',
    '  ("acceso al agua", "desplazamiento forzado", "consulta previa").',
    '- `lugar`: un lugar geográfico o un espacio concreto',
    '  ("Chiapas", "el ejido San Isidro", "la clínica comunitaria").',
    '- `evento`: un hecho o un proceso con desarrollo en el tiempo',
    '  ("la asamblea de 2019", "el desalojo", "la negociación del convenio").',
    '- `organizacion`: una institución, dependencia, empresa o colectivo',
    '  ("CIDE", "la asamblea ejidal", "la Secretaría de Salud").',
  ]
  if (allowPersona) {
    entityLines.push('- `persona`: una persona nombrada en el texto.')
  }

  return [
    'Eres un analista documental. Lees un fragmento de texto en español y extraes',
    'un grafo de conocimiento: entidades y las relaciones entre ellas.',
    '',
    'TIPOS DE ENTIDAD PERMITIDOS (usa exactamente estas palabras en `tipo`):',
    ...entityLines,
    '',
    'TIPOS DE RELACIÓN PERMITIDOS (usa exactamente estas palabras en `tipo`):',
    '- `ocurre_en`: un evento sucede en un lugar.',
    '- `participa_en`: una organización o una persona toma parte en un evento.',
    '- `ubicado_en`: una organización o un lugar está dentro de otro lugar.',
    '- `parte_de`: algo forma parte de algo mayor.',
    '- `afecta_a`: algo incide sobre un tema, un lugar o una organización.',
    '- `relacionado_con`: relación SIMÉTRICA, sólo cuando ninguna de las',
    '  anteriores describe bien el vínculo.',
    '',
    'REGLAS:',
    '1. Responde ÚNICAMENTE con el objeto JSON del esquema. Sin explicaciones,',
    '   sin markdown, sin texto antes ni después.',
    '2. Las `etiqueta` van en ESPAÑOL. Usa la forma que aparece en el texto,',
    '   sin artículos iniciales ("asamblea ejidal", no "la asamblea ejidal").',
    '3. Usa la forma más CORTA que siga siendo específica. "agua" es demasiado',
    '   vago; "acceso al agua potable" es útil; una frase entera no es una',
    '   etiqueta.',
    '4. No inventes nada. Toda entidad debe estar sustentada en este fragmento.',
    '5. `menciones` es cuántas veces aparece la entidad EN ESTE FRAGMENTO.',
    '6. `fragmento` es una cita LITERAL del texto, de 300 caracteres como máximo,',
    '   que justifique por qué la entidad está ahí.',
    '7. `desde` y `hacia` deben coincidir EXACTAMENTE con una `etiqueta` de tu',
    '   propia lista `entidades`. No relaciones nada que no hayas extraído.',
    allowPersona ? PERSONA_RULE_ALLOWED : PERSONA_RULE_FORBIDDEN,
    '9. Prefiere pocas entidades buenas a muchas genéricas. Máximo 40 entidades',
    '   y 60 relaciones.',
    '',
    'TÍTULO DEL DOCUMENTO: {{{titulo}}}',
    'FRAGMENTO {{{ventana}}} DE {{{ventanas}}}.',
    '',
    'TEXTO:',
    '---',
    '{{{texto}}}',
    '---',
  ].join('\n')
}

/**
 * The built-in spec this module ships, for the `specDefault` FLOOR slot.
 *
 * 🔴 FLOOR, NEVER CEILING. `packages/ai-client/src/types.ts:44-68` is explicit:
 * a built-in sent in `specOverride` makes a project's registered row resolve and
 * then be DISCARDED, with no error anywhere. `extract.ts` falls back to
 * `specOverride` only for a deployment that predates the `specDefaultSlot`
 * capability, where it is the sole slot that exists.
 *
 * `effortLevel` rides inside the spec rather than at request level on purpose:
 * request level beats the registry, which would defeat the floor's whole point.
 * `deep` is ADR §5.2's tier — ~3500 output tokens, 2 validation passes.
 */
export function graphBuiltInSpec(allowPersona: boolean): {
  promptTemplate: string
  responseSchema: Record<string, unknown>
  effortLevel: 'deep'
} {
  return {
    promptTemplate: graphPromptTemplate(allowPersona),
    responseSchema: graphResponseSchema(allowPersona),
    effortLevel: 'deep',
  }
}
