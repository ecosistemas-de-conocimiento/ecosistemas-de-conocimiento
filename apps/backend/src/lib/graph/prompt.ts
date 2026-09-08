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
 *
 * ── WHY IT IS `v3` ─────────────────────────────────────────────────────────
 *
 * `v1` did not ask for `fragmento`, so every `v1` row has a NULL
 * `graph_mentions.snippet` even for a `documento` that would be allowed one.
 * Those rows are not wrong, they are INCOMPLETE.
 *
 * `v2` produced GENERIC HUB NODES. Measured on the 261-document corpus: the
 * highest-degree nodes included `barranca` (lugar, 49 documents), `español`
 * (tema, 46), `discapacidad` (tema, 27) and `escuela` typed as an
 * `organizacion` (22). Those are common nouns, not entities — a hub that means
 * nothing joins documents that have nothing to do with each other, and it
 * inflates the support counts `GRAPH_MIN_SUPPORT` gates on (ADR §7.3).
 *
 * `v3` answers that in two places, and only one of them is a request:
 *   1. Rule 3 below now carries the observed failures as explicit
 *      counter-examples, the entity-type examples no longer demonstrate the
 *      very mistake rule 3 forbids, and `organizacion` says CON NOMBRE PROPIO.
 *   2. 🔴 `extract.ts`'s `dropGenericEntities` REJECTS a bare common noun after
 *      the fact. Rule 3 already said this in `v2` and the model did not obey —
 *      so, exactly like the person rule, the load-bearing mechanism is the one
 *      in code, and the prompt is the cheap second layer.
 *
 * 🔴 SCOPED TO `lugar`, `organizacion` AND `persona`, AND THAT IS THE WHOLE
 * DESIGN. `español` and `discapacidad` were on the junk list too and are NOT
 * junk: they are `tema`, and a one-word `tema` is the corpus's own subject.
 * All 11 of this corpus's indigenous languages land on `tema`, and `documents`
 * has no language or theme column, so the graph is the only place they exist.
 * Rule 3 therefore asks for a NAME only where a name is what the type means,
 * and says out loud that a one-word `tema` is wanted. `extract.ts`'s
 * `GENERIC_RULE_TYPES` carries the measurement.
 *
 * Only this stamp can find the rows any of that leaves stale.
 * `lib/graph/backfill.ts` selects on `graphPromptVersion != GRAPH_PROMPT_VERSION`.
 */
export const GRAPH_PROMPT_VERSION = 'v3'

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

/**
 * 🔴 THE LENGTH CAP ON `fragmento`, IN CHARACTERS, AND IT IS DELIBERATELY TIGHT.
 *
 * ⚠ 120, NOT THE 300 THE ORIGINAL SCHEMA ASKED FOR. Two independent reasons,
 * and both are load-bearing:
 *
 *   1. OUTPUT TOKENS ARE THE BINDING COST. ADR §13 measured this deployment at
 *      roughly 8 tokens/second, and `fragmento` is the single biggest output
 *      cost in the response — it is why the array caps came down to 15/20 in
 *      the first place. A quotation is charged per window, per entity, so 300
 *      characters × 15 entities is most of a window's answer spent on prose the
 *      graph does not traverse. `LLM_REQUEST_TIMEOUT_MS` is now 600 s
 *      (ADR §14), so there is room — but room is not a reason to spend it.
 *   2. A SHORTER QUOTATION IS A SMALLER RE-IDENTIFICATION SURFACE. This is
 *      stored only for a `documento` (ADR §7.3.4, and `snippetAllowed` enforces
 *      it in three places), so the privacy argument is already answered — but a
 *      sentence identifies less than a paragraph, and the affordance this
 *      exists for ("why is this entity here") needs a phrase, not an excerpt.
 *
 * ⚠ `extract.ts` TRUNCATES TO THE SAME NUMBER and imports it from here. The
 * schema's `maxLength` is a request the model can miss; the slice is what
 * actually holds.
 */
export const GRAPH_FRAGMENT_MAX_CHARS = 120

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
        maxItems: 15,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['tipo', 'etiqueta'],
          properties: {
            tipo: { enum: entityTypes },
            etiqueta: { type: 'string', minLength: 2, maxLength: 120 },
            menciones: { type: 'integer', minimum: 1 },
            /**
             * 🔴 A LITERAL QUOTATION, ASKED FOR IN EVERY VARIANT, STORED IN ONE.
             *
             * It answers "why is this entity here" — the affordance ADR §13.1
             * removed and the owner asked back. It is requested even for a
             * testimonio, and it is the WRITER that refuses to store it there
             * (`snippetAllowed`, enforced again in `mergeWindows` and a third
             * time in `queries.ts`'s `CASE`).
             *
             * ⚠ ADR §13.1 argued the opposite — that not ASKING is the same rule
             * without a conditional a later change could get backwards. That
             * reasoning is answered by there being THREE conditionals, in three
             * files, each with a test, rather than one; and by the cost §13.1
             * itself called real: without this, the graph cannot say why any
             * entity is there, for an ordinary document either.
             */
            fragmento: { type: 'string', maxLength: GRAPH_FRAGMENT_MAX_CHARS },
          },
        },
      },
      relaciones: {
        type: 'array',
        maxItems: 20,
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
 *
 * ⚠ THE RULES ARE NUMBERED 1–9 AND THE NUMBERING WAS BROKEN. Before `fragmento`
 * came back there was no rule 7 at all: the list ran 1–6, then BOTH the person
 * rule and the "few good entities" rule called themselves 8. The model was
 * being handed a list that contradicted itself about its own length. Rule 7 is
 * now `fragmento`, the person rule keeps 8 (its two variants hard-code the
 * number, so they stay in step), and the caps rule is 9.
 *
 * 🔴 RULE 3 IS THE ONE THE MODEL DOES NOT OBEY, and `v3` is the second attempt
 * at it. `v2` already said "agua es demasiado vago" and the corpus still came
 * back with `barranca`, `español`, `discapacidad` and `escuela` as its biggest
 * nodes. What changed in `v3` is that rule 3 is now BACKED BY CODE:
 * `extract.ts`'s `dropGenericEntities` drops a one-word label that is not a
 * proper noun, whatever the model returns. The words below are the cheap layer
 * that tries to make the drop unnecessary — they are not the guarantee. Same
 * division of labour as the person rule, and for the same measured reason.
 *
 * ⚠ Rule 9 says "20 relaciones", matching `maxItems` in
 * {@link graphResponseSchema}. It said 60 — the number from before ADR §13.1
 * lowered the caps — so the prose and the schema disagreed by a factor of three
 * on the one instruction the schema cannot enforce by itself (the measurement in
 * {@link graphEffortLevel}: this model generates until it is cut off rather than
 * honouring `maxItems`, which makes the WORDS the effective cap).
 */
export function graphPromptTemplate(allowPersona: boolean): string {
  // ⚠ EVERY EXAMPLE HERE IS ALSO A DEMONSTRATION OF RULE 3, and in `v2` three
  // of them demonstrated the opposite: "el desalojo" is a bare common noun with
  // an article in front of it — the exact shape rule 3 forbids and the exact
  // shape the corpus came back full of. An example outranks a rule; the model
  // reads the list of types before it reads the list of rules. All four lines
  // now show a QUALIFIED label with no leading article.
  const entityLines = [
    '- `tema`: un asunto, problema, derecho o concepto que el texto trata',
    '  ("acceso al agua potable", "desplazamiento forzado", "consulta previa").',
    '- `lugar`: un lugar geográfico o un espacio concreto',
    '  ("Chiapas", "ejido San Isidro", "clínica comunitaria de Xoxocotla").',
    '- `evento`: un hecho o un proceso con desarrollo en el tiempo',
    '  ("asamblea ejidal de 2019", "desalojo de Potoichán",',
    '  "negociación del convenio").',
    '- `organizacion`: una institución, dependencia, empresa o colectivo CON',
    '  NOMBRE PROPIO ("CIDE", "Secretaría de Salud",',
    '  "Escuela Primaria Miguel Hidalgo"). Un sustantivo genérico como escuela,',
    '  clínica, universidad o comité nombra una CLASE de cosa, no una',
    '  organización: usa el nombre completo o no la extraigas.',
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
    '3. Usa la forma más CORTA que siga siendo específica. Una frase entera no',
    '   es una etiqueta.',
    '   Un `lugar`, una `organizacion` y una `persona` deben NOMBRAR a UNO en',
    '   concreto, no a una clase de cosa. Si el texto no da el nombre, no',
    '   extraigas la entidad.',
    '   MAL: "escuela", "clínica", "barranca", "mercado", "colonia",',
    '   "hospital", "universidad", "abogados", "tallerista".',
    '   BIEN: "Escuela Primaria Miguel Hidalgo", "Centro de Salud de',
    '   Tlayacapan", "barranca de Amanalco", "mercado de Villa de Ayala",',
    '   "Morelos", "CIDE".',
    '   ⚠ Un `lugar`, una `organizacion` o una `persona` de UNA SOLA palabra',
    '   que no sea nombre propio se DESCARTA automáticamente.',
    '   Un `tema`, en cambio, SÍ puede ser una sola palabra cuando esa palabra',
    '   es el asunto mismo: "náhuatl", "mixteco", "discapacidad", "dengue",',
    '   "braille" son temas válidos y ÚTILES. No los conviertas en frases.',
    '   ⚠ Si el texto trata SOBRE la escuela, la clínica o el mercado como',
    '   asunto, eso es un `tema` ("escuela", "salud comunitaria"), no un',
    '   `lugar` ni una `organizacion`.',
    '4. No inventes nada. Toda entidad debe estar sustentada en este fragmento.',
    '5. `menciones` es cuántas veces aparece la entidad EN ESTE FRAGMENTO.',
    '6. `desde` y `hacia` deben coincidir EXACTAMENTE con una `etiqueta` de tu',
    '   propia lista `entidades`. No relaciones nada que no hayas extraído.',
    `7. \`fragmento\` es una cita LITERAL y BREVE del texto (máximo ${GRAPH_FRAGMENT_MAX_CHARS} caracteres)`,
    '   que muestra por qué extrajiste esa entidad. Copia las palabras tal como',
    '   aparecen; no las resumas, no las parafrasees, no las expliques. Si',
    '   ninguna frase corta lo justifica, omite el campo.',
    allowPersona ? PERSONA_RULE_ALLOWED : PERSONA_RULE_FORBIDDEN,
    '9. Prefiere pocas entidades buenas a muchas genéricas. Máximo 15 entidades',
    '   y 20 relaciones.',
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
const EFFORT_LEVELS = ['quick', 'standard', 'deep', 'maximum'] as const
export type GraphEffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * The effort tier one extraction window runs at.
 *
 * 🔴 MEASURED, AND THE REASON THIS IS A KNOB AT ALL. At `deep`, ONE window over
 * a ~1.2k-character Spanish document did not finish: ai-service answered 200 at
 * exactly 120,008 ms with no `parsed`, which is its own `LLM_REQUEST_TIMEOUT_MS`
 * default firing mid-generation. `deep` runs TWO validation passes over ~3500
 * output tokens, so the cost is in the OUTPUT, not the input.
 *
 * ⚠ THAT IS WHY SHRINKING `GRAPH_EXTRACT_WINDOW_CHARS` DOES NOT RESCUE IT — the
 * document that timed out was already tiny. Halving an input that was never the
 * bottleneck buys nothing and doubles the number of calls. The two levers that
 * work are this tier and ai-service's own timeout.
 *
 * ── 🔴 THREE MEASUREMENTS, AND WHAT THEY RULE OUT ─────────────────────────
 *
 * Against the local ai-service on 2026-08-28, one window over an 809-character
 * Spanish asamblea fragment:
 *
 *   · `deep`      — 120,008 ms, no `parsed`. That is ai-service's own
 *                   `LLM_REQUEST_TIMEOUT_MS` default firing mid-generation.
 *   · `standard`  — 82 s, then 85 s, then 96 s across three schema sizes. Every
 *                   one returned well-formed Spanish that was CUT OFF mid-array:
 *                   the 800-token output cap, not the clock.
 *
 * ⚠ Shrinking the schema did NOT help. Entity cap 40 → 25 → 15 changed nothing,
 * because the model generates until it is cut off rather than honouring
 * `maxItems`. Shrinking `GRAPH_EXTRACT_WINDOW_CHARS` cannot help either — the
 * document that failed was already tiny.
 *
 * 🔴 THE BINDING CONSTRAINT IS THE MODEL'S SPEED ON THIS DEPLOYMENT: roughly
 * 8 tokens/second. A complete answer needs the ~3500-token `deep` budget, and
 * 3500 tokens at 8 tok/s is ~440 s — well past the 120 s cap. No combination of
 * prompt, schema or window fixes that. The levers are OUTSIDE this file:
 *
 *   1. raise ai-service's `LLM_REQUEST_TIMEOUT_MS` to ~600 s, or
 *   2. point extraction at a faster model, or
 *   3. run it against a deployment that is not this one.
 *
 * The default stays `deep` DELIBERATELY, even though it currently fails. It is
 * the tier the ADR specifies, it is the only tier whose token budget can hold a
 * complete answer, and it is the tier that starts working the moment lever 1 is
 * pulled. `standard` would fail too — and would keep failing after the timeout
 * was raised, because its ceiling is tokens rather than seconds, which is a far
 * more confusing thing to debug.
 */
export function graphEffortLevel(): GraphEffortLevel {
  const raw = process.env.GRAPH_EXTRACT_EFFORT?.trim()
  return (EFFORT_LEVELS as readonly string[]).includes(raw ?? '')
    ? (raw as GraphEffortLevel)
    : 'deep'
}

export function graphBuiltInSpec(allowPersona: boolean): {
  promptTemplate: string
  responseSchema: Record<string, unknown>
  effortLevel: GraphEffortLevel
} {
  return {
    promptTemplate: graphPromptTemplate(allowPersona),
    responseSchema: graphResponseSchema(allowPersona),
    effortLevel: graphEffortLevel(),
  }
}
