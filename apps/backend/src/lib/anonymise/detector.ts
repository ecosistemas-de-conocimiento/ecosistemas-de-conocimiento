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

import { withRateLimitRetry } from '@/lib/aiRetry'

import { chunkText } from './chunk'
import { stripLeadingTitles } from './titles'
import type { DetectorFinding, PersonDetector } from './types'

/** Env var names, so docs and tests never hand-type a string that can drift. */
export const ANONYMISE_CHUNK_WORDS_VAR = 'ANONYMISE_CHUNK_WORDS'
export const ANONYMISE_DETECT_CONCURRENCY_VAR = 'ANONYMISE_DETECT_CONCURRENCY'
export const ANONYMISE_DETECT_TIMEOUT_MS_VAR = 'ANONYMISE_DETECT_TIMEOUT_MS'

/**
 * Words per detector call. See `chunk.ts` for the measurement: the reply cap
 * limits how many FINDINGS fit, and 250 words of dense testimony stays under it
 * (inferred from the measured 218-word text: 11 findings, at most 290 of 400
 * output tokens).
 */
export const DEFAULT_CHUNK_WORDS = 250

/**
 * Chunk calls in flight at once, per stage.
 *
 * ⚠ ai-service caps generation at 30 requests/min per API key (quoted:
 * `services/ai-service/src/server-limits.ts`, `GENERATE_RATE_LIMIT_MAX`). A
 * 10k-word text is ~40 chunks per stage, so it WILL meet that limit; 3 keeps
 * the burst small, and each chunk waits out a 429 through `withRateLimitRetry`.
 */
export const DEFAULT_CONCURRENCY = 3

/**
 * Per-call deadline. Without one, `@edc/ai-client`'s 30 s default applies, and
 * one measured call (4,862-word text, 2026-10-17) was aborted at exactly that.
 */
export const DEFAULT_TIMEOUT_MS = 90_000

function positiveIntFromEnv(name: string, fallback: number): number {
  // ⚠ Blank is "unset", not 0 — same rule as `aiRetry.ts`.
  const text = (process.env[name] ?? '').trim()
  if (text === '') return fallback
  const n = Number(text)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

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
  // ⚠ Titles are part of the name (owner's rule, 2026-10-17); `titles.ts` also
  // absorbs them in code, so a model that ignores this line is still covered.
  '- Un tratamiento o cargo que antecede al nombre es parte del nombre: incluye "don", "doña",',
  '  "señor", "señora", "la maestra", "el maestro", "el profe", "el doctor", "la doctora",',
  '  "licenciado", "ingeniero", "el padre" y similares. En "Don Fernando Vázquez" el hallazgo',
  '  es "Don Fernando Vázquez"; en "la maestra Imelda" es "la maestra Imelda".',
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
    //
    // ⚠ ONE RESCUE: a titled span whose TITLE is in the wrong case. Measured
    // 2026-10-17, 9,454 words: asked to include titles, the model returned
    // "la maestra Nicasia Olvera" for "La maestra Nicasia Olvera"; dropping it
    // lost the name. The bare name is a literal substring, so it is kept, and
    // `titles.ts` absorbs the title once the name is a placeholder.
    let located = trimmed
    if (!sourceText.includes(located)) {
      located = stripLeadingTitles(trimmed).trim()
      if (located === trimmed || located.length < 2 || !sourceText.includes(located)) continue
    }

    out.push({
      text: located,
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
    }, opts?: { timeoutMs?: number }): Promise<{ text: string; modelUsed?: string }>
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
  /** Words per chunk. Default: `ANONYMISE_CHUNK_WORDS`, else {@link DEFAULT_CHUNK_WORDS}. */
  chunkWords?: number
  /** Chunks in flight. Default: `ANONYMISE_DETECT_CONCURRENCY`, else {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number
  /** Per-call deadline. Default: `ANONYMISE_DETECT_TIMEOUT_MS`, else {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Injected in tests so a 429 retry does not really sleep. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Run `work` over `items` with at most `limit` in flight, results in input order.
 *
 * 🔴 FIRST FAILURE WINS AND NOTHING NEW STARTS. The caller turns any throw into
 * a HOLD, so further chunks would be paid for and thrown away. Calls already in
 * flight finish on their own; their results are ignored.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++
      try {
        results[i] = await work(items[i] as T)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
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

      const chunkWords =
        opts.chunkWords ?? positiveIntFromEnv(ANONYMISE_CHUNK_WORDS_VAR, DEFAULT_CHUNK_WORDS)
      const concurrency =
        opts.concurrency ??
        positiveIntFromEnv(ANONYMISE_DETECT_CONCURRENCY_VAR, DEFAULT_CONCURRENCY)
      const timeoutMs =
        opts.timeoutMs ?? positiveIntFromEnv(ANONYMISE_DETECT_TIMEOUT_MS_VAR, DEFAULT_TIMEOUT_MS)
      const gen = client

      // 🔴 ONE CALL PER CHUNK, NOT PER DOCUMENT. The whole document in one call
      // overflowed the reply cap on every multi-paragraph testimony — see
      // `chunk.ts`. This covers stage 3 AND stage 4, since both call `detect`.
      //
      // ⚠ OFFSETS NEED NO REMAPPING, BY CONSTRUCTION. A finding is a literal
      // string, `parseFindings` checks it against its OWN chunk, and the chunks
      // partition `text` exactly, so every kept finding occurs in `text`. The
      // gate replaces and locates findings over the FULL text, so every
      // occurrence in every chunk is replaced, and survivor offsets are
      // full-text offsets.
      const chunks = chunkText(text, chunkWords).filter((c) => /\S/.test(c.text))

      const perChunk = await mapBounded(chunks, concurrency, async (chunk) => {
        let result: { text: string }
        try {
          // ⚠ A 429, a 503, a broken connection and our own timeout are retried
          // (`aiRetry.ts`, `retryTransient`): at most 3 retries, Retry-After when
          // the server sends one, else 1 s, 2 s, 4 s, all under one total sleep
          // ceiling. Anything else, and the last failure, throws through to a
          // HOLD — never to "nothing to redact".
          //
          // ⚠ `/v1/generate/sync` does not dedupe, so a retry after a lost answer
          // is a second generation and a second budget debit. Accepted here: the
          // call is read-only, and one chunk costs well under a cent.
          //
          // ⚠ The ceiling counts SLEEP, not attempts in flight: a chunk that
          // times out every time takes up to 4 × `timeoutMs` plus ~7 s.
          result = await withRateLimitRetry(
            () =>
              gen.generate.sync(
                {
                  unit: {
                    // 🔴 UNIQUE PER CALL. ai-service keys a unit's latest generation
                    // by `unitKey`; reusing one across documents would let a cached
                    // or concurrent result from ANOTHER document answer this one —
                    // findings for the wrong text, which reads as "nothing to redact".
                    //
                    // ⚠ ai-service ALSO caches identical PROMPTS for ~5 minutes,
                    // whatever the unitKey (observed while measuring, 2026-10-17).
                    // Chunking makes identical prompts likelier: the same boilerplate
                    // paragraph in two documents is the same chunk. That is correct —
                    // the same text has the same findings — but a re-run inside the
                    // window is a cached answer, not a fresh opinion from the model.
                    unitKey: nextKey(),
                    unitType: 'anonymise-detect',
                    input: { userPrompt: `${material}\n\n${chunk.text}` },
                    systemPrompt: DETECT_SYSTEM_PROMPT,
                    specOverride: { promptTemplate: PROMPT_TEMPLATE_USER_PROMPT },
                  },
                  effortLevel: 'quick',
                },
                { timeoutMs },
              ),
            {
              label: 'anonymise-detect',
              retryTransient: true,
              ...(opts.sleep ? { sleep: opts.sleep } : {}),
            },
          )
        } catch (err) {
          // ⚠ The message names the FAILURE, never the document. A transport error
          // string can carry a request body in some clients, and this reason ends
          // up on a row an admin reads.
          const name = err instanceof Error ? err.name : 'unknown error'
          const timedOut = (err as { reason?: unknown } | null)?.reason === 'timeout'
          throw new DetectorFailure(
            timedOut ? 'tiempo-agotado' : 'transporte',
            timedOut
              ? `The anonymisation detector timed out after ${timeoutMs} ms.`
              : `The anonymisation detector could not reach ai-service: ${name}`,
          )
        }
        return parseFindings(result.text ?? '', chunk.text)
      })

      // A name repeated across chunks is one finding.
      const seen = new Set<string>()
      const out: DetectorFinding[] = []
      for (const f of perChunk.flat()) {
        const key = `${f.type}\u0000${f.text}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(f)
      }
      return out
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
