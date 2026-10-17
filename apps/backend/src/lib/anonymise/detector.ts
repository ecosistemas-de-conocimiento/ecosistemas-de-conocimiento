/**
 * STAGE 3'S ENGINE — the model that FINDS what to hide.
 *
 * ⚠ THIS FILE IS THE ONE PLACE THE UNREDACTED TEXT LEAVES THIS PROCESS. The
 * full argument, and the owner's explicit acceptance of it for development
 * only, is on {@link import('./types').PersonDetector} in `types.ts` — read it
 * there rather than trusting a paraphrase here. The short version: the OUTPUT of
 * the gate is clean, which makes it very easy to forget that the INPUT was sent
 * to a hosted model to produce it.
 *
 * ── WHY IT ASKS FOR JSON AND NOT FOR REDACTED TEXT ──────────────────────────
 *
 * The model is a DETECTOR. It returns a list of literal strings; `gate.ts` does
 * the replacing. A rewriting model can drop a paragraph, merge two sentences or
 * invent a detail and the output still looks clean, so nobody would ever catch
 * it. A detector's output is CHECKABLE — running it again over the redacted text
 * is a real verification (stage 4), which is not a thing you can do to a
 * rewriter.
 *
 * ── 🔴 THE FAILURE MODE THIS FILE IS BUILT AROUND ───────────────────────────
 *
 * `[]` means "there is nothing to redact". A parse error, a timeout, a 500, a
 * truncated response — none of those mean that, and every one of them is easy
 * to turn into `[]` with a `catch` that felt defensive at the time. That catch
 * would let raw testimony through the gate labelled `ready`, into a corpus with
 * no per-document delete. So: THROW. `gate.ts` turns a throw into a HOLD, which
 * is the honest answer to "we do not know".
 */

import type { DetectorFinding, PersonDetector } from './types'

/** Finding types the prompt is allowed to return. Anything else is dropped. */
const FINDING_TYPES: readonly DetectorFinding['type'][] = [
  'persona',
  'lugar',
  'contacto',
  'identificador',
  'otro',
]

/**
 * The Spanish instruction. STRICT JSON, and `texto` copied VERBATIM.
 *
 * 🔴 "Copy the text exactly" is not politeness — it is the contract. `gate.ts`
 * redacts by literal string replacement, so a model that helpfully normalises
 * "MARÍA" to "María" hands back a string that does not occur in the input, the
 * replacement silently does nothing, and the name ships. That is why
 * {@link parseFindings} drops any finding it cannot locate in the input: a
 * finding we cannot replace is not a redaction, it is a false sense of one.
 */
export const DETECT_SYSTEM_PROMPT = [
  'Eres un detector de datos personales en textos en español de México.',
  '',
  'Tu única tarea es LOCALIZAR, no reescribir. Devuelves exclusivamente JSON válido con esta forma:',
  '{"hallazgos":[{"texto":"...","tipo":"persona|lugar|contacto|identificador|otro"}]}',
  '',
  'Reglas obligatorias:',
  '- Copia en "texto" la cadena EXACTAMENTE como aparece en la entrada, con sus mismas',
  '  mayúsculas, acentos y espacios. No la corrijas, no la normalices, no la traduzcas.',
  '- No reescribas el texto de entrada. No devuelvas el texto censurado.',
  '- No expliques nada. No agregues comentarios ni bloques de código.',
  '- Si no hay nada que ocultar, devuelve exactamente {"hallazgos":[]}.',
  '',
  'Debes incluir:',
  '- Nombres de personas, apellidos, apodos y diminutivos.',
  '- Referencias de parentesco que nombran a alguien: en "mi hermana Lucía" el hallazgo es "Lucía".',
  '- Centros de trabajo, escuelas o cargos tan precisos que identifican a una persona.',
  '- Teléfonos, correos, cuentas, identificadores oficiales y números de expediente.',
  '',
  // 🔴 ADDRESSES GET THEIR OWN SECTION BECAUSE ONE LINE WAS NOT ENOUGH. Measured:
  // on a live test testimony a street address went past this prompt, and the
  // verify stage held the document. The shaped forms (`C.P. 06700`,
  // `Calle X No. 45`) are now removed deterministically before the model ever
  // sees them — see `deterministic.ts`. What is left for the model is the
  // free-form half, which is the half regexes cannot reach, so it is spelled out
  // with examples rather than named in passing.
  'Domicilios (marca "lugar"). Incluye TODOS estos casos, completos o parciales:',
  '- Calles, avenidas, andadores, cerradas, privadas y sus números.',
  '- Colonias, barrios, fraccionamientos, unidades habitacionales, manzana y lote.',
  '- Códigos postales, alcaldías, delegaciones y municipios cuando ubican un domicilio.',
  '- Referencias sin formato que permiten llegar a una casa: "enfrente de la tienda',
  '  de doña Mari", "subiendo por donde está el tanque", "la casa de la reja verde".',
  '- Un domicilio partido en varias frases cuenta como varios hallazgos, uno por trozo.',
  '',
  '⚠ No marques como "lugar" un municipio, estado o pueblo mencionado solo como',
  'origen o como tema ("el problema del agua en Cuernavaca"). Márcalo cuando ubique',
  'dónde vive, trabaja o estudia alguien.',
  '',
  'Tipos: "persona" para nombres de personas; "lugar" para domicilios y lugares identificables;',
  '"contacto" para teléfonos, correos y redes; "identificador" para folios, CURP, RFC y números',
  'de cuenta; "otro" para cualquier otro dato que permita identificar a alguien.',
].join('\n')

/**
 * ai-service still renders exactly one user message from a Handlebars template.
 *
 * 🔴 TRIPLE STACHE. `{{userPrompt}}` HTML-escapes its value, so an apostrophe in
 * a testimony becomes `&#x27;` — and then the `texto` the model copies back
 * "exactly" contains an entity that does not appear in OUR text, the replacement
 * misses, and the name ships. Same reasoning as `apps/web`'s `wire.ts`, with a
 * sharper consequence here.
 */
const PROMPT_TEMPLATE_USER_PROMPT = '{{{userPrompt}}}'

/** Raised when the detector could not produce a trustworthy answer. See header. */
export class DetectorFailure extends Error {
  constructor(
    /** A failure CLASS, never the text. `gate.ts` puts this in a user-visible reason. */
    public readonly failureClass: string,
    message: string,
  ) {
    super(message)
    this.name = 'DetectorFailure'
  }
}

/**
 * Pull `hallazgos` out of whatever the model actually said.
 *
 * ⚠ DEFENSIVE ABOUT SHAPE, NEVER ABOUT FAILURE. Fences and prose around the JSON
 * are normal model behaviour and are tolerated; a response we cannot parse at
 * all is NOT tolerated and throws. The distinction matters: the first is noise,
 * the second is "we have no idea what is in this document".
 */
export function parseFindings(raw: string, sourceText: string): DetectorFinding[] {
  const withoutFences = raw.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '')
  const first = withoutFences.indexOf('{')
  const last = withoutFences.lastIndexOf('}')
  if (first === -1 || last <= first) {
    throw new DetectorFailure(
      'respuesta-no-json',
      'The detector returned no JSON object. Refusing to treat that as "nothing to redact".',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(withoutFences.slice(first, last + 1))
  } catch {
    throw new DetectorFailure(
      'json-invalido',
      'The detector returned malformed JSON. Refusing to treat that as "nothing to redact".',
    )
  }

  const hallazgos = (parsed as { hallazgos?: unknown }).hallazgos
  if (!Array.isArray(hallazgos)) {
    throw new DetectorFailure(
      'json-sin-hallazgos',
      'The detector JSON had no `hallazgos` array. Refusing to treat that as "nothing to redact".',
    )
  }

  const out: DetectorFinding[] = []
  for (const item of hallazgos) {
    if (!item || typeof item !== 'object') continue
    const texto = (item as { texto?: unknown }).texto
    const tipo = (item as { tipo?: unknown }).tipo
    if (typeof texto !== 'string') continue

    const trimmed = texto.trim()

    // ⚠ ONE-CHARACTER FINDINGS ARE DISCARDED. A stray "y" or "a" would be
    // replaced everywhere it occurs and shred the testimony into placeholders,
    // and it identifies nobody. The redaction has to leave a readable document
    // or the reviewer who has to approve it cannot do their job.
    if (trimmed.length < 2) continue

    // 🔴 HALLUCINATION FILTER. A `texto` that does not occur in the input cannot
    // be replaced — `String.replace` would find nothing — so keeping it would
    // inflate the report's counts with redactions that never happened, and make
    // stage 4 look like it verified something it did not. Dropping it is not
    // permissive: the text it claims to describe is still in the document and
    // stage 4 still runs over the result.
    if (!sourceText.includes(trimmed)) continue

    out.push({
      text: trimmed,
      type: (FINDING_TYPES as readonly unknown[]).includes(tipo)
        ? (tipo as DetectorFinding['type'])
        : 'otro',
    })
  }
  return out
}

/** The slice of `@edc/ai-client` this detector uses. Injected so tests need no network. */
export interface SyncGenerator {
  generate: {
    sync(req: {
      unit: {
        unitKey: string
        unitType: string
        input: { userPrompt: string }
        systemPrompt?: string
        specOverride?: { promptTemplate: string }
      }
      effortLevel?: string
    }): Promise<{ text: string; modelUsed?: string }>
  }
}

export interface AIServiceDetectorOptions {
  /** Override the client. Default: `getAppAIClient(organizationId)`, imported lazily. */
  client?: SyncGenerator
  /**
   * The ecosistema the text belongs to. The model call is booked to its
   * ai-service org (budget and usage). Omitted = the base org.
   */
  organizationId?: number | string
  /** Unique-per-call key generator. Default: a random uuid. */
  unitKey?: () => string
  /** Reported as the detector's name. */
  name?: string
  effortLevel?: string
}

/**
 * The real detector: ai-service `/v1/generate/sync` through `@edc/ai-client`.
 *
 * ⚠ The client is imported LAZILY, matching `collections/Documents.ts`. Payload
 * collection modules are loaded during config construction, and a top-level
 * import of `aiClient` would run its env-var checks at that moment — turning a
 * missing `AI_SERVICE_API_KEY` into a boot crash of the whole admin panel
 * instead of a failed request.
 */
export function aiServiceDetector(opts: AIServiceDetectorOptions = {}): PersonDetector {
  const nextKey = opts.unitKey ?? (() => `anonymise-${crypto.randomUUID()}`)

  return {
    name: opts.name ?? 'ai-service:anonymise-detect',
    async detect({ text, contentKind }) {
      let client = opts.client
      if (!client) {
        const { getAppAIClient } = await import('@/lib/aiClient')
        client = getAppAIClient(opts.organizationId) as unknown as SyncGenerator
      }

      const material =
        contentKind === 'testimonio'
          ? 'Es el testimonio de una persona, transcrito.'
          : 'Es una conversación entre integrantes de una comunidad.'

      let result: { text: string }
      try {
        result = await client.generate.sync({
          unit: {
            // 🔴 UNIQUE PER CALL. ai-service keys a unit's latest generation by
            // `unitKey`; reusing one across documents would let a cached or
            // concurrent result from ANOTHER document answer this one — findings
            // for the wrong text, which reads as "nothing to redact here".
            unitKey: nextKey(),
            unitType: 'anonymise-detect',
            input: { userPrompt: `${material}\n\n${text}` },
            systemPrompt: DETECT_SYSTEM_PROMPT,
            specOverride: { promptTemplate: PROMPT_TEMPLATE_USER_PROMPT },
          },
          effortLevel: 'quick',
        })
      } catch (err) {
        // ⚠ The message names the FAILURE, never the document. A transport error
        // string can carry a request body in some clients, and this reason ends
        // up on a row an admin reads.
        throw new DetectorFailure(
          'transporte',
          `The anonymisation detector could not reach ai-service: ${
            err instanceof Error ? err.name : 'unknown error'
          }`,
        )
      }

      return parseFindings(result.text ?? '', text)
    },
  }
}

/**
 * A fixed-answer detector — the seam that keeps the gate's tests free and
 * offline.
 *
 * ⚠ Findings that do not occur in the text are dropped here TOO, deliberately.
 * A test seam that behaved more permissively than the real thing would let a
 * gate test pass on a replacement the real detector could never have produced.
 */
export function staticDetector(
  findings: readonly DetectorFinding[] | ((text: string) => readonly DetectorFinding[]),
  name = 'static',
): PersonDetector {
  return {
    name,
    async detect({ text }) {
      const list = typeof findings === 'function' ? findings(text) : findings
      return list.filter((f) => f.text.trim().length >= 2 && text.includes(f.text))
    },
  }
}
