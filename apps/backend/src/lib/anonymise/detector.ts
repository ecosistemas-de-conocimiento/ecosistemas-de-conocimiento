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
 *
 * ⚠ BUT A CALL THAT NEVER GOT AN ANSWER IS NOT A CONTENT FINDING. A 429, a 5xx,
 * a 402 budget refusal, a broken connection or our own timeout throws a
 * {@link DetectorFailure} with `infrastructure: true`. It still fails CLOSED —
 * nothing is ingested — but `anonymiseDocument.ts` records it as RETRYABLE, not
 * as a Revisión hold a human has to clear. Revisión is for real findings.
 */

import { withRateLimitRetry, type RetryOptions } from '@/lib/aiRetry'

import { chunkText } from './chunk'
import {
  ANONYMISE_DETECT_MODEL_VAR,
  ANONYMISE_DETECT_URL_VAR,
  openaiCompatFromEnv,
} from './openaiCompatGenerator'
import { cooldownMsFromEnv, fallbackModeFromEnv, withHostedFallback } from './fallbackGenerator'
import { detectorFallbackMode } from '../platformSettings'
import { PLACEHOLDER_PATTERN, type DetectorFinding, type PersonDetector } from './types'

/** Env var names, so docs and tests never hand-type a string that can drift. */
export const ANONYMISE_CHUNK_WORDS_VAR = 'ANONYMISE_CHUNK_WORDS'
export const ANONYMISE_DETECT_CONCURRENCY_VAR = 'ANONYMISE_DETECT_CONCURRENCY'
export const ANONYMISE_DETECT_TIMEOUT_MS_VAR = 'ANONYMISE_DETECT_TIMEOUT_MS'
export const ANONYMISE_DETECT_MIN_GAP_MS_VAR = 'ANONYMISE_DETECT_MIN_GAP_MS'

/**
 * 🔴 THE ONLY KNOB THAT BOUNDS DETECTOR CALLS PER MINUTE, PROCESS-WIDE.
 *
 * `ANONYMISE_DETECT_CONCURRENCY` caps chunks in flight PER `detect()` call — one
 * stage of one document. Documents gated in parallel multiply it, and a
 * document's call count is 2 × its chunk count, so no per-document spacing can
 * promise a calls/min figure. This gap is between the START of any two detector
 * calls in this process (retries included). 2_700 ms ≈ 22 calls/min, under
 * ai-service's 30/min generate cap per key. Unset or 0 = off.
 *
 * ⚠ Other generate callers on the same key (graph extraction) are not paced by
 * this.
 */
let nextDetectSlotAt = 0

/** Reserve the next start slot synchronously, then wait for it. */
export async function paceDetectCall(sleep: (ms: number) => Promise<void>): Promise<void> {
  const gap = nonNegativeIntFromEnv(ANONYMISE_DETECT_MIN_GAP_MS_VAR, 0)
  if (gap <= 0) return
  const now = Date.now()
  const slot = Math.max(now, nextDetectSlotAt)
  nextDetectSlotAt = slot + gap
  if (slot > now) await sleep(slot - now)
}

function nonNegativeIntFromEnv(name: string, fallback: number): number {
  const text = (process.env[name] ?? '').trim()
  if (text === '') return fallback
  const n = Number(text)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

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

export function positiveIntFromEnv(name: string, fallback: number): number {
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
  '{"hallazgos":[{"texto":"...","tipo":"persona|lugar|contacto|identificador|otro","identifica":true}]}',
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
  // 🔴 DEV, 2026-10-26: two staff documentos went `ready` with a co-author's
  // bare first name left in 7 and 12 times; the model reported the full name
  // and the surname only. The gate now spreads name parts itself
  // (`nameParts.ts`); these lines ask the model not to rely on that.
  // ⚠ "Una vez": asked for "cada vez que aparece", the model listed each
  // occurrence (measured 2026-10-26, local stack, 4 runs), which spends the
  // 400-token reply cap (`chunk.ts`). The gate redacts every occurrence anyway.
  '- Un nombre de pila solo o un apellido solo también es un hallazgo, aunque la persona',
  '  ya se haya nombrado completa: si dice "Fausto Arellano" y luego "Fausto propuso",',
  '  reporta también "Fausto". Repórtalo una sola vez.',
  '- Los nombres de autores, coautores, integrantes del equipo, entrevistadores y',
  '  participantes también se reportan. Un texto académico, una relatoría o un borrador',
  '  no cambian esta regla.',
  '- Referencias de parentesco que nombran a alguien: en "mi hermana Lucía" el hallazgo es "Lucía".',
  // ⚠ Measured 2026-10-21 (local stack, 6 runs, old and new prompt): without the
  // next line the model returned "Mi hermana Lucía" whole in 5/6, so a later bare
  // "Lucía" got a second label; with it, 0/3 (host torre, GATE_TEXT_FILE, 115
  // words). The kinship word is not a title here.
  '  El parentesco se queda fuera: solo el nombre. En "mi primo Arnulfo" el hallazgo es "Arnulfo".',
  // 🔴 OWNER'S RULING, 2026-10-21: an unnamed relative is a person. "mi mamá"
  // points at one person in the narrator's life; "el doctor" does not. The
  // model decides what is kinship: no word list in code (owner, 2026-10-17).
  // The possessive is part of the span, so "mi mamá" does not take "su mamá".
  '- Una referencia de parentesco que señala a una persona concreta sin nombrarla es un',
  '  hallazgo "tipo": "persona" con "identifica": true. Copia el tramo completo, con el',
  '  posesivo: en "mi mamá me llevó" el hallazgo es "mi mamá"; también "mi abuelo",',
  '  "su hermana", "la esposa de mi primo". No es un tratamiento o cargo solo.',
  // 🔴 THE MODEL OWNS SPAN BOUNDARIES (owner's rule, 2026-10-17: no word lists
  // in code). A span cut short leaves "Don [Persona F]" or "colonia [Domicilio L]".
  // 🔴 OWNER, 2026-10-23: titles are the model's to include, no word list.
  '- Devuelve el tramo COMPLETO que identifica. Un tratamiento o cargo que antecede al',
  '  nombre es parte del nombre, con su artículo, en UN solo hallazgo: en "Don Fernando',
  '  Vázquez" el hallazgo es "Don Fernando Vázquez"; en "la maestra Nicasia Olvera" es',
  '  "la maestra Nicasia Olvera"; en "la maestra Lucrecia" es "la maestra Lucrecia"; en',
  '  "el delegado Abundio Cázares" es "el delegado Abundio Cázares".',
  // 🔴 OWNER'S RULING Q24 = A (2026-10-28): "tan precisos que identifican" read
  // as licence to report any named institution; see "No es un hallazgo" below.
  '- Centros de trabajo, escuelas o cargos que, en ese texto, señalan a una persona concreta.',
  '- Teléfonos, correos, cuentas, identificadores oficiales y números de expediente.',
  '',
  // ⚠ Owner's rule, 2026-10-17: a bare title is not identifying and must not
  // hold a document, so the model is asked not to report it. If it does, stage
  // 3 still redacts it (over-redaction, accepted), and verify lets it pass only
  // when it is marked false and has no digit and no mid-sentence capital
  // (owner, 2026-10-21, Q4; `bareTitle` in `gate.ts`).
  'No es un hallazgo:',
  '- Un tratamiento o cargo SOLO, sin nombre ni apodo junto a él: "el doctor dijo",',
  '  "la maestra llegó". No identifica a nadie. No lo reportes; si lo reportas, pon',
  '  "identifica": false. Pon "identifica": true en todo lo demás.',
  // 🔴 OWNER'S RULING Q24 = A (2026-10-28). Measured on dev: the model typed
  // public names, concepts, work titles and course labels as "otro" or
  // "identificador", and the gate turns both into "[Dato omitido]" (`gate.ts`):
  // a staff documento lost a program name 22 times, another a sign language 18
  // times, and one ecosistema's 47 documentos held 762 "[Dato omitido]", of
  // which 2 were personal data. The gate still redacts whatever the model
  // reports (Q10 A), so these lines are what keep them. The shared exception
  // points at the Domicilios rule ("el Cereso") so the two do not contradict.
  // Every example is a made-up variant of a dev case.
  '- Nada de lo siguiente es un dato personal. No lo reportes, tampoco como "otro" ni como',
  '  "identificador":',
  '  · Nombres de instituciones, dependencias, programas, proyectos, eventos, medios, partidos',
  '    y organizaciones, lenguas y siglas: "PILARES", "INDISCAPACIDAD CDMX", "SECIHTI", "el',
  '    Centro de Investigación y Docencia Económicas", "la UNAM", "el proyecto Ecosistemas de',
  '    conocimiento y aprendizaje situado", "el Foro de Saberes Comunitarios", "la Lengua de',
  '    Señas Mexicana", "el náhuatl", "Radio Nopal", "la red Charla Social". En "trabajo en',
  '    un PILARES de la alcaldía" no se reporta nada.',
  '  · Conceptos, teorías, corrientes y palabras comunes, también las nacionalidades y los',
  '    gentilicios: "el mito", "la ironía", "el fetichismo", "la empatía", "yo, aquí, ahora",',
  '    "el marxismo", "el parentesco", "argentino", "oaxaqueña".',
  '  · Títulos de obras publicadas, libros, artículos, revistas, medios y sus citas:',
  '    "Gramática del relato", "La injusticia del oído", "la revista Umbral", "el periódico',
  '    El Faro del Sur", una frase citada de un autor publicado.',
  '  · Etiquetas de la estructura de un curso o documento: "sesión 2", "Sesión 3 de 8",',
  '    "Anexo D", "módulo IV", "CLIC 81".',
  '  · Claves públicas de proyectos, convocatorias o financiamientos: "Proyecto SECIHTI',
  '    PX-2024-II-118", "convocatoria 2025-B".',
  // 🔴 AUDIT 2026-10-28: the exception said "persona concreta y privada", and
  // "privada" is also the `ambito` label below, so a teacher or a nurse could
  // pass as "not private". It now fires for ANY one person, public or not.
  '  Esto vale salvo que, en ese texto, el nombre junto con el contexto señale a una sola',
  '  persona concreta, pública o no: el lugar donde está, vive, trabaja o estudia una',
  '  persona ("estoy en el Cereso", "la maestra de la secundaria Benito Juárez de San',
  '  Rafael") se marca "lugar", como dice la lista Domicilios. "identificador" queda para los',
  '  identificadores de UNA persona: su CURP, RFC, clave de elector, número de cuenta o de',
  '  expediente, un folio a su nombre.',
  '- Un equipo o colectivo no es una persona: "El equipo del Ecosistema", "el colectivo de',
  '  madres buscadoras", "las compañeras del taller". No lo reportes. El nombre de cada',
  '  integrante sí se reporta.',
  // ⚠ ONE PROMPT FOR DETECT AND VERIFY, measured 2026-10-17 on the chunk holding
  // "el Chacho Melgarejo": a separate verify addendum ("this text is already
  // redacted…") caught it 0/6 and 3/6; the shared prompt 10/12.
  // 🔴 OWNER'S RULING, 2026-10-21 (Q1, "accept leftover titles"): a title or
  // cargo left beside a person placeholder is published, so it is not asked
  // for. A name, surname or nickname beside one still is.
  '- Los marcadores entre corchetes ([Persona A], [Domicilio B], [Dato omitido]): ya están',
  '  censurados. Tampoco una palabra genérica de lugar pegada a un marcador de lugar:',
  '  "colonia [Domicilio L]".',
  '- Un tratamiento o cargo pegado a un marcador de persona: "la maestra [Persona A]",',
  '  "Don [Persona B]". Si lo reportas, pon "identifica": false.',
  '- Una palabra de parentesco pegada a un marcador de persona: "mi hermana [Persona A]".',
  '  El nombre ya está censurado. Si lo reportas, pon "identifica": false.',
  '- Pero un nombre, apellido o apodo pegado a un marcador de persona SÍ es hallazgo:',
  '  en "[Persona A] López" el hallazgo es "[Persona A] López".',
  '',
  // 🔴 ADDRESSES GET THEIR OWN SECTION BECAUSE ONE LINE WAS NOT ENOUGH. Measured:
  // on a live test testimony a street address went past this prompt, and the
  // verify stage held the document. Only the postal code (`C.P. 06700`) is
  // removed deterministically before the model sees the text (owner, Q3, see
  // `deterministic.ts`). Every street line, colonia and manzana is the model's,
  // so the list is spelled out with examples rather than named in passing.
  'Domicilios (marca "lugar"). Incluye TODOS estos casos, completos o parciales:',
  '- Calles, avenidas, andadores, cerradas, privadas y sus números.',
  '- Colonias, barrios, fraccionamientos, unidades habitacionales, manzana y lote.',
  '- Ranchos, parajes y haciendas con nombre: "el rancho Los Pinos", "el paraje Tres',
  '  Cruces", "la hacienda San José".',
  // 🔴 OWNER, 2026-10-23: an institution where someone lives or is held points
  // at them, also next to a town.
  // ⚠ Named, or next to a town: an unnamed "el hospital" is dropped as a
  // generic place (`genericPlaces.ts`), so the prompt does not ask for it.
  // 🔴 AUDIT 2026-10-28: "trabaja o estudia" restored. A named workplace or
  // school beside a person or a cargo points at that person, public or not
  // (a teacher, a nurse, a delegado). Without a person beside it, a named
  // institution is not a finding ("No es un hallazgo" above).
  '- Una institución CON NOMBRE, o junto a un pueblo, donde está, vive, trabaja o estudia una',
  '  persona: "el Cereso", "el hospital de Xochitepec", "la escuela Benito Juárez". En "estoy',
  '  en Atlacholoaya, en el Cereso" el hallazgo es "el Cereso". Un "el hospital" o "la',
  '  escuela" solo, sin nombre ni pueblo, no se reporta.',
  '- Un centro de trabajo, escuela, clínica u oficina CON NOMBRE, o junto a un pueblo o',
  '  alcaldía, junto a una persona o un cargo que la señala, se reporta como "lugar", aunque',
  '  no se diga su nombre y aunque sea un servidor público: en "la maestra de la secundaria',
  '  Benito Juárez de San Rafael" el hallazgo es "la secundaria Benito Juárez de San Rafael";',
  '  en "la enfermera del centro de salud de Tetelcingo", "el centro de salud de Tetelcingo";',
  '  en "el delegado de la alcaldía Xochimilco", "la alcaldía Xochimilco".',
  '- Códigos postales.',
  '- Referencias sin formato que permiten llegar a una casa: "enfrente de la tienda',
  '  de doña Mari", "subiendo por donde está el tanque", "la casa de la reja verde".',
  '- Un domicilio partido en varias frases cuenta como varios hallazgos, uno por trozo.',
  '- Incluye en el tramo la palabra genérica que encabeza el lugar: "colonia Las Flores",',
  '  "tortillería de Doña Lupe", no solo "Las Flores" ni "Doña Lupe".',
  '',
  // 🔴 OWNER'S RULING (2026-10-21, backlog #12): town and municipality names are
  // SHOWN. They are what a testimony is about, and a town alone points at
  // thousands of people, not at one home. The line between "shown" and "marked"
  // is the size of the unit, not how the sentence uses it:
  //   · shown: estado, municipio, alcaldía, ciudad, pueblo, comunidad, localidad,
  //     ejido, congregación — WHATEVER ITS SIZE. A small locality is shown too:
  //     a reader cannot tell a 300-person pueblo from a 3,000-person one, and a
  //     size cut-off the model cannot check is a rule it applies at random.
  //   · marked: anything inside a locality — colonia, barrio, fraccionamiento,
  //     unidad habitacional, rancho, paraje, a street, a house.
  // ⚠ "Rancho"/"paraje" are marked only when the WORD is said: in rural Mexico a
  // rancho is often one family's land. A locality whose name merely contains
  // "Rancho" ("vivo en Rancho Nuevo") is a town and is shown.
  // 🔴 OWNER, 2026-10-23 (Q10 A): "we dont need to redact towns, states". Stage
  // 3 redacts whatever the model reports, so this line is what keeps them.
  '⚠ Los pueblos, municipios, alcaldías, ciudades, comunidades, localidades, ejidos,',
  '  congregaciones y estados NO son datos personales y NO se reportan, aunque sean',
  '  pequeños y aunque digan dónde vive, trabaja o estudia alguien. En "Vivo en',
  '  Xochitepec, Morelos" no hay ningún hallazgo.',
  // ⚠ Reconciles with the workplace line above (audit 2026-10-28): the office
  // of an alcaldía beside its delegado points at one person; the town does not.
  'Pero una oficina, escuela o clínica junto a una persona o un cargo SÍ se marca, aunque lleve',
  'el nombre del pueblo o la alcaldía: en "el delegado de la alcaldía Xochimilco" el hallazgo',
  'es "la alcaldía Xochimilco".',
  'Una calle o colonia con nombre de pueblo o estado SÍ se marca: "calle Morelos 12",',
  '"colonia Xochitepec", "Hidalgo 12".',
  'Marca todo lo de la lista Domicilios aunque esté en una ciudad o pueblo.',
  '"Rancho Nuevo" como nombre de un pueblo no se marca.',
  // ⚠ Many Mexican towns carry a person's name (Dolores, Soledad, Guadalupe).
  // The town rule must not become a reason to leave a person's name in.
  '⚠ El nombre de una persona SIEMPRE se marca como "persona", aunque también sea el',
  'nombre de un pueblo: en "mi tía Soledad" el hallazgo es "Soledad"; en "Dolores me',
  'dijo" el hallazgo es "Dolores".',
  '',
  'Tipos: "persona" para nombres de personas; "lugar" para domicilios y lugares identificables;',
  '"contacto" para teléfonos, correos y redes; "identificador" para folios, CURP, RFC y números',
  'de cuenta de una persona; "otro" para otro dato que identifique a una persona concreta.',
  'Nunca uses "otro" ni "identificador" para nada de lo que la sección "No es un hallazgo" excluye.',
].join('\n')

/**
 * 🔴 KEEP PUBLIC FIGURES (owner rulings 2026-10-27). Appended to
 * {@link DETECT_SYSTEM_PROMPT} only when a `documento` runs with
 * `keepPublicFigures` on, so every other call sends the prompt unchanged.
 *
 * The model still REPORTS every person: the classification only decides what
 * the gate keeps. `parseFindings` treats a missing or odd `ambito`, or a
 * `publica` with no `motivo`, as private: unsure means redacted.
 */
export const DETECT_PUBLIC_ADDENDUM = [
  '',
  'Clasificación de personas (obligatoria en cada hallazgo "tipo": "persona"):',
  'Agrega "ambito": "publica" o "privada", y "motivo": una frase corta.',
  '{"texto":"...","tipo":"persona","identifica":true,"ambito":"publica","motivo":"senador"}',
  '- "publica" solo si el texto la nombra en el discurso público por un papel público:',
  '  político o política, funcionario o funcionaria, comentarista público, autor o autora',
  '  de una obra publicada que el texto cita, o ponente en un evento público con una cita',
  '  o atribución. En "motivo" pon el cargo, la obra citada o el evento.',
  '- "privada" para todos los demás: vecinos, víctimas, familiares, entrevistados,',
  '  interlocutores, y también integrantes del equipo del proyecto, salvo que aparezcan',
  '  como autores de una obra citada o como ponentes en un evento público.',
  '- Si dudas, pon "privada".',
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
    /**
     * 🔴 TRUE WHEN THE MODEL NEVER ANSWERED (429, 5xx, 402, network, timeout).
     * The gate still refuses to ingest, but the row is left RETRYABLE instead
     * of held for review. False for anything about the answer itself.
     */
    public readonly infrastructure: boolean = false,
  ) {
    super(message)
    this.name = 'DetectorFailure'
  }
}

/** Fold one character for matching: lower case, accents dropped. */
function foldChar(ch: string): string {
  return ch.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase()
}

/**
 * The folded text and its offset map, for the LAST source seen.
 *
 * ⚠ PERFORMANCE (audit 2026-10-27, 300 people × 3 parts × 100k words): the
 * gate spreads every name part over the same text one after another, and most
 * parts match nothing, so the text rarely changes between calls. Folding it
 * once per distinct text instead of once per part is the easy win. One entry:
 * nothing is kept past the next different text.
 */
let lastFold: { source: string; folded: string; startOf: number[] } | null = null

/** Drop the cached text. The gate calls it on exit, so no document text outlives its run. */
export function clearFoldCache(): void {
  lastFold = null
}

function foldSource(source: string): { folded: string; startOf: number[] } {
  if (lastFold !== null && lastFold.source === source) return lastFold
  let folded = ''
  const startOf: number[] = []
  for (let i = 0; i < source.length; ) {
    const cp = source.codePointAt(i) as number
    const ch = String.fromCodePoint(cp)
    for (const f of foldChar(ch)) {
      folded += f
      startOf.push(i)
    }
    i += ch.length
  }
  lastFold = { source, folded, startOf }
  return lastFold
}

/**
 * Every `[start, end)` range of `source` that equals `needle` once both are
 * folded (lower case, accents dropped), in order. Overlapping matches included.
 *
 * ⚠ Folding is per character with an offset map, so a character that folds to
 * two (or none) never shifts the ranges returned.
 */
export function foldedMatches(source: string, needle: string): Array<[number, number]> {
  const { folded, startOf } = foldSource(source)
  const want = [...needle].map(foldChar).join('')
  const out: Array<[number, number]> = []
  if (want.length === 0) return out
  for (let at = folded.indexOf(want); at !== -1; at = folded.indexOf(want, at + 1)) {
    const begin = startOf[at] as number
    const lastStart = startOf[at + want.length - 1] as number
    let end = lastStart + String.fromCodePoint(source.codePointAt(lastStart) as number).length
    // 🔴 Trailing accent marks belong to the last letter (final audit
    // 2026-10-21): decomposed "José" ended before its accent, and the gate then
    // saw the match glued to a letter and redacted nothing.
    while (end < source.length && /\p{M}/u.test(source.charAt(end))) end++
    out.push([begin, end])
  }
  return out
}

/**
 * `needle` as the text spells it: exactly, else case- and accent-blind, giving
 * back the substring of `source` it matched. Null when it is not there at all.
 *
 * 🔴 A MATCH WHOLLY INSIDE ONE OF OUR PLACEHOLDERS IS SKIPPED, exact or folded,
 * and the search goes on. Audit 2026-10-21: the model reported "Domi" for
 * "La domi", the first match was inside `[Domicilio A]`, the gate saw it as
 * covered, and "La domi" stayed in a ready text.
 */
export function locateSpan(source: string, needle: string): string | null {
  const spans = [...source.matchAll(PLACEHOLDER_PATTERN)].map(
    (m) => [m.index, m.index + m[0].length] as const,
  )
  // 🔴 A PLACEHOLDER CUT AT A CHUNK EDGE IS STILL A PLACEHOLDER. The chunker
  // cuts at whitespace, so `source` (one chunk) may end "[Domicilio" and the
  // next begin "A]". Re-audit 2026-10-21: "Domi" matched inside the cut
  // "[Domicilio", came back as found, and the gate, looking at the whole text,
  // saw it only inside `[Domicilio A]` and let "la domi" through.
  const tail = /\[(?:Persona|Domicilio|Dato)\s*$/.exec(source)
  if (tail) spans.push([tail.index, source.length] as const)
  const head = /^\s*(?:[A-Z]+|omitido)\]/.exec(source)
  if (head) spans.push([0, head[0].length] as const)
  // Only a match wholly INSIDE a placeholder is skipped. One that straddles an
  // edge ("Domicilio A], Ana") or contains one ("[Persona A] López") is real
  // text the gate's `resolveLeftover` knows how to redact.
  const clear = (at: number, end: number) => !spans.some(([s, e]) => at >= s && end <= e)
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    if (clear(at, at + needle.length)) return needle
  }
  for (const [begin, end] of foldedMatches(source, needle)) {
    if (clear(begin, end)) return source.slice(begin, end)
  }
  return null
}

/**
 * 🔴 THE MASK TOKENS ai-service PUTS IN EVERY OUTGOING PROMPT. Its PII
 * minimiser replaces addresses, phones, emails, CURP, RFC and names with these
 * before the prompt leaves, so the model sees "[DIRECCION]" where the text says
 * "calle Hidalgo 45". KEEP IN SYNC with `DEFAULT_PLACEHOLDERS` in
 * `services/ai-service/src/services/ai/pii/types.ts`.
 *
 * Stored folded (lower case, no accents) so "[Dirección]" matches too. EDC's
 * own placeholders (`[Domicilio A]`, `[Dato omitido]`) are a different set.
 */
const AI_SERVICE_MASK_TOKENS: readonly string[] = [
  '[curp]',
  '[rfc]',
  '[email]',
  '[telefono]',
  '[direccion]',
  '[nombre]',
]

/**
 * Pull `hallazgos` out of whatever the model actually said.
 *
 * ⚠ DEFENSIVE ABOUT SHAPE, NEVER ABOUT FAILURE. Fences and prose around the JSON
 * are normal model behaviour and are tolerated; a response we cannot parse at
 * all is NOT tolerated and throws. The distinction matters: the first is noise,
 * the second is "we have no idea what is in this document".
 */
/**
 * What `parseFindings` returns: the findings, plus `unlocated`, the spans the
 * model reported that could not be placed in the text. ⚠ `unlocated` is never
 * redacted (there is nothing to replace); the keep-public-figures restore
 * counts it as private evidence (third audit 2026-10-27: a son's name the
 * filter dropped never demoted his father's public name).
 */
export type ParsedFindings = DetectorFinding[] & { unlocated: DetectorFinding[] }

/** Attach `unlocated` NON-enumerably, so a plain list comparison ignores it. */
export function withUnlocated(list: DetectorFinding[], unlocated: DetectorFinding[]): ParsedFindings {
  Object.defineProperty(list, 'unlocated', { value: unlocated, enumerable: false })
  return list as ParsedFindings
}

export function parseFindings(raw: string, sourceText: string): ParsedFindings {
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
  const unlocated: DetectorFinding[] = []
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
    // ⚠ ONE RESCUE: a span in the wrong case or without its accents. Measured
    // 2026-10-17, 9,454 words: the model returned "la maestra Nicasia Olvera"
    // for "La maestra Nicasia Olvera"; dropping it lost the name. The span is
    // matched case- and accent-blind and replaced by the text's OWN spelling,
    // so the replacement still finds it.
    // Titles: no word list; a title left beside a placeholder is published (owner, 2026-10-21, Q1).
    const located = locateSpan(sourceText, trimmed)
    // 🔴 A MASKED FINDING IS NOT A HALLUCINATION. Measured 3/3 runs: the model
    // reported "[DIRECCION]", the drop below discarded it, and the real street
    // shipped in a ready document. A finding carrying an ai-service mask token
    // that we cannot place in the text means personal data we cannot see:
    // hold for a human. Not retryable — the same prompt is masked again.
    // A finding that IS in the text (a document really saying "[DIRECCION]")
    // is located and redacted like any other.
    if (located === null) {
      const folded = [...trimmed].map(foldChar).join('')
      if (AI_SERVICE_MASK_TOKENS.some((token) => folded.includes(token))) {
        throw new DetectorFailure(
          'dato-enmascarado',
          'El modelo vio un dato enmascarado (una dirección, teléfono, correo, CURP, RFC o nombre) y no se puede ubicar en el texto. Una persona tiene que revisarlo.',
        )
      }
      // Kept aside, with its classification: `publicFigureRestore.ts` counts
      // it as evidence. Never redacted: there is nothing in the text to replace.
      unlocated.push({ text: trimmed, type: tipo === 'persona' ? 'persona' : 'otro', ...publicOf(item, tipo) })
      continue
    }

    out.push({
      text: located,
      type: (FINDING_TYPES as readonly unknown[]).includes(tipo)
        ? (tipo as DetectorFinding['type'])
        : // The prompt files homes under "Domicilios (marca \"lugar\")"; a model
          // that answers "domicilio" means an address: labelled `[Domicilio X]`.
          tipo === 'domicilio'
          ? 'lugar'
          : 'otro',
      // 🔴 …and NEVER a town: the model itself called it a home (audit
      // 2026-10-23: "Vivo en Hidalgo 12" typed domicilio was shown).
      ...(tipo === 'domicilio' ? { typedAddress: true as const } : {}),
      // 🔴 Only a literal `false` counts; a missing or odd value is identifying.
      ...((item as { identifica?: unknown }).identifica === false ? { identifying: false } : {}),
      // 🔴 PUBLIC ONLY ON AN EXPLICIT "publica" WITH A REASON. Missing, invalid
      // or unsure is private: redacted (owner, 2026-10-27, fail closed).
      ...publicOf(item, tipo),
    })
  }
  return withUnlocated(out, unlocated)
}

/** Longest `motivo` kept for the log. A reason, not a paragraph. */
const MAX_MOTIVO = 200

/** `{ public: { motivo } }` for a person the model called public with a reason, else nothing. */
function publicOf(item: object, tipo: unknown): { public?: { motivo: string } } {
  if (tipo !== 'persona') return {}
  const { ambito, motivo } = item as { ambito?: unknown; motivo?: unknown }
  if (typeof ambito !== 'string' || [...ambito.trim()].map(foldChar).join('') !== 'publica') return {}
  if (typeof motivo !== 'string' || motivo.trim() === '') return {}
  return { public: { motivo: motivo.trim().slice(0, MAX_MOTIVO) } }
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
  /**
   * Per-chunk retry budget. Default: `aiRetry.ts`'s 4 tries / 120 s, sized for
   * an upload a person is waiting on. The bulk seed passes its patient
   * `SEED_PUBLISH_RETRY` here so two full-window 429s do not end the run.
   */
  retry?: Pick<RetryOptions, 'attempts' | 'budgetMs' | 'sleep' | 'random' | 'log'>
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

let backendLogged = false
/** Which backend the gate uses, logged once per process. Host and model only, never the key. */
function logBackendOnce(what: string): void {
  if (backendLogged) return
  backendLogged = true
  console.info(`[anonymise-detect] gate detector backend: ${what}`)
}

/**
 * The real detector: ai-service `/v1/generate/sync` through `@edc/ai-client`,
 * or, when `ANONYMISE_DETECT_URL` is set, a self-hosted OpenAI-compatible
 * endpoint (`openaiCompatGenerator.ts`) with ai-service behind it as a fallback
 * (`fallbackGenerator.ts`).
 *
 * ⚠ The client is imported LAZILY, matching `collections/Documents.ts`. Payload
 * collection modules are loaded during config construction, and a top-level
 * import of `aiClient` would run its env-var checks at that moment — turning a
 * missing `AI_SERVICE_API_KEY` into a boot crash of the whole admin panel
 * instead of a failed request.
 */
export function aiServiceDetector(opts: AIServiceDetectorOptions = {}): PersonDetector {
  const nextKey = opts.unitKey ?? (() => `anonymise-${crypto.randomUUID()}`)
  // SELF-HOSTED FIRST WHEN CONFIGURED. With `ANONYMISE_DETECT_URL` set, the
  // raw text goes to that box; when the box is unavailable the call falls back
  // to ai-service (hosted model) unless `ANONYMISE_DETECT_FALLBACK=none`, which
  // fails closed. See `fallbackGenerator.ts` for what counts as "unavailable".
  const selfHosted = !opts.client && (process.env[ANONYMISE_DETECT_URL_VAR] ?? '').trim() !== ''
  // ⚠ The env value names the detector until the first `detect`; from then on
  // the name follows the mode `detect` resolved (stored switch first), so the
  // gate row names the backend that could see the text (re-audit 2026-10-26:
  // a stored `none` still read `+fallback`). A bad env value throws in
  // `detect` (→ HOLD), not here.
  let fallbackForName = true
  try {
    fallbackForName = fallbackModeFromEnv() === 'hosted'
  } catch {
    /* reported by detect() */
  }
  const backendName = () =>
    !selfHosted ? 'ai-service' : fallbackForName ? 'openai-compat+ai-service' : 'openai-compat'

  const hostedClient = async (): Promise<SyncGenerator> => {
    const { getAppAIClient } = await import('@/lib/aiClient')
    return getAppAIClient(opts.organizationId) as unknown as SyncGenerator
  }

  return {
    // Recorded on the gate row (`gate.ts`), so it names the backend that saw the text.
    // ⚠ `+fallback` means "the Spark, or ai-service for any call the Spark could
    // not answer". Which one answered each call is in the WARN log lines; the
    // detector instance is shared across documents in the seed, so a per-call
    // record on the row would need a per-document channel this interface lacks.
    get name() {
      return (
        opts.name ??
        (selfHosted
          ? `openai-compat:${(process.env[ANONYMISE_DETECT_MODEL_VAR] ?? '').trim() || 'unset'}${fallbackForName ? '+fallback' : ''}`
          : 'ai-service:anonymise-detect')
      )
    },
    async detect({ text, contentKind, classifyPublic }) {
      let client = opts.client
      if (!client && selfHosted) {
        const resolved = openaiCompatFromEnv()
        if (!resolved) throw new Error(`${ANONYMISE_DETECT_URL_VAR} was unset after start`)
        // 🔴 Runtime switch first (`lib/platformSettings.ts`, ≤ 60 s cache), then env.
        const mode = await detectorFallbackMode()
        fallbackForName = mode === 'hosted'
        client =
          mode === 'hosted'
            ? withHostedFallback(resolved.generator, hostedClient, { cooldownMs: cooldownMsFromEnv() })
            : resolved.generator
        logBackendOnce(
          `openai-compat at ${resolved.host}, model ${resolved.model}` +
            (mode === 'hosted' ? ', falls back to ai-service when unavailable' : ', no fallback (fail closed)'),
        )
      }
      if (!client) {
        client = await hostedClient()
        logBackendOnce('ai-service /v1/generate/sync')
      }

      // ⚠ A `documento` is a staff draft, notes, minutes, a session rebuilt from
      // memory, or a participant's PDF. Described as a transcribed testimony,
      // the model missed co-authors' names (dev, 2026-10-26).
      const material =
        contentKind === 'testimonio'
          ? 'Es el testimonio de una persona, transcrito.'
          : contentKind === 'documento'
            ? 'Es un documento escrito: un borrador, notas, un acta, un informe o la reconstrucción de una sesión. Puede tener varios autores y citar o parafrasear a varias personas.'
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
          // ⚠ A 429, a 500/502/503/504, a broken connection and our own timeout
          // are retried (`aiRetry.ts`, `retryTransient`): by default 3 retries
          // (`opts.retry` raises it for the seed), Retry-After when
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
          //
          // ⚠ WITH THE SPARK FALLBACK, the fallback runs INSIDE each attempt:
          // 1 Spark try, then hosted tries; the breaker keeps later attempts off
          // the Spark. Not 4 × 4. See `fallbackGenerator.ts`.
          result = await withRateLimitRetry(
            async () => {
              await paceDetectCall(opts.sleep ?? opts.retry?.sleep ?? realSleep)
              return gen.generate.sync(
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
                    systemPrompt: classifyPublic
                      ? `${DETECT_SYSTEM_PROMPT}\n${DETECT_PUBLIC_ADDENDUM}`
                      : DETECT_SYSTEM_PROMPT,
                    specOverride: { promptTemplate: PROMPT_TEMPLATE_USER_PROMPT },
                  },
                  effortLevel: 'quick',
                },
                { timeoutMs },
              )
            },
            {
              ...(opts.retry ?? {}),
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
              : `The anonymisation detector could not reach ${backendName()}: ${name}`,
            // Every throw out of the CALL (as opposed to the parse below) means
            // the model never answered: rate limit, 5xx, budget, auth, network.
            true,
          )
        }
        return parseFindings(result.text ?? '', chunk.text)
      })

      // A name repeated across chunks is one finding.
      // 🔴 If any chunk judged it identifying, it is identifying: fail-closed.
      const byKey = new Map<string, DetectorFinding>()
      for (const f of perChunk.flat()) {
        const key = `${f.type}\u0000${f.text}`
        const prior = byKey.get(key)
        const chosen = prior === undefined || prior.identifying === false ? f : prior
        // 🔴 Public only if EVERY chunk said public: one "privada" wins.
        const { public: _private, ...rest } = chosen
        const kept: DetectorFinding = prior === undefined || (prior.public && f.public) ? chosen : rest
        // 🔴 If any chunk typed it `domicilio`, it is never a town: fail-closed.
        byKey.set(key, prior?.typedAddress || f.typedAddress ? { ...kept, typedAddress: true } : kept)
      }
      return withUnlocated(
        [...byKey.values()],
        perChunk.flatMap((c) => (c as Partial<ParsedFindings>).unlocated ?? []),
      )
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
      const kept = list.filter((f) => f.text.trim().length >= 2 && text.includes(f.text))
      return withUnlocated(kept, list.filter((f) => !kept.includes(f)))
    },
  }
}
