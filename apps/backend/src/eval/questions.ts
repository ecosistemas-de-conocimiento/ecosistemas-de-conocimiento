/**
 * The 20 questions, and where each expected answer comes from.
 *
 * ── HOW THE SET WAS CHOSEN, AND WHY THAT MATTERS ───────────────────────────
 *
 * The ten GLOBAL questions are the seven seeded regularities the corpus's own
 * README lists as *"regularidades sembradas a propósito (ground truth para
 * cotejo)"* — anchor sites, shared events, recurring named people, family pairs,
 * cross-ecosystem links, transversal themes, named tools — phrased the way a
 * person would ask them. They were written from the README and from the
 * manifest, and NOT adjusted afterwards to suit what the graph happened to seed
 * on. Two of them (G2, G8) name an institution the corpus repeats; the other
 * eight do not name any entity at all, which is what an aggregate question
 * normally looks like.
 *
 * ⚠ THAT IS A REAL EXPOSURE FOR THE GRAPH AND IT IS DELIBERATE. Seed matching
 * is whole-token containment of an ENTITY LABEL in the question
 * (`matchEntitiesToQuery`), so a question that names no entity seeds nothing
 * and the graph contributes nothing. Choosing questions that name entities
 * would have measured the graph at its best rather than at its job.
 *
 * The ten LOCAL questions each target ONE published document, picked to span
 * the four ecosistema themes and both long genres, with a full name that occurs
 * exactly once in the whole manifest. Their expected facts are verified at load
 * time to be present in that document's own text — a local question whose
 * answer is not in its document would measure nothing.
 *
 * ── THE EXPECTED SET IS FILTERED BY SUPPORT, AT RUNTIME ────────────────────
 *
 * A global fact is expected only when at least `MIN_GLOBAL_SUPPORT` published
 * documents name it. That is the same threshold the graph applies to itself
 * (`GRAPH_MIN_SUPPORT`), so neither arm is asked for something the corpus does
 * not repeat, and neither is asked for something the graph is forbidden to
 * know.
 */

import type { CorpusDoc, Fact } from './corpus'
import { factSupport } from './corpus'
import { containsAny } from './text'

export type QuestionClass = 'local' | 'global'

export interface EvalQuestion {
  id: string
  klass: QuestionClass
  /** The user's message, in Spanish, exactly as it goes into the turn. */
  text: string
  /** Facts an answer should name. Computed; see `buildQuestions`. */
  expected: Fact[]
  /**
   * For a LOCAL question: the one document that must be cited. `null` for a
   * global question, where no single document is the answer.
   */
  targetDocumentId: number | null
  /** Diagnostic: how many published documents support each expected fact. */
  support: Record<string, number>
}

/** ADR §7.3.3's threshold, applied to the ground truth so the two agree. */
export const MIN_GLOBAL_SUPPORT = 3

// ── Global questions ───────────────────────────────────────────────────────

interface GlobalSpec {
  id: string
  text: string
  candidates: Fact[]
}

/**
 * ⚠ Every alias below is a substring test. They were chosen to be unique in
 * this corpus: `Tlayacapan`, `Parres`, `Monsiváis`, `ovitrampa`, `Xochistlahuaca`.
 * Where a distinctive core would have been ambiguous — `escuela`, `mercado`,
 * `feria` — the longer form is used instead.
 */
const GLOBAL_SPECS: GlobalSpec[] = [
  {
    id: 'G01',
    text:
      '¿Qué centros de salud y hospitales aparecen mencionados en varios documentos ' +
      'distintos? Enuméralos.',
    candidates: [
      { label: 'Centro de Salud de Tlayacapan', aliases: ['Tlayacapan'] },
      { label: 'Centro de Salud de Villa de Ayala', aliases: ['Villa de Ayala'] },
      { label: 'Hospital General de Cuernavaca "José G. Parres"', aliases: ['Parres'] },
    ],
  },
  {
    id: 'G02',
    text:
      '¿Qué sedes de PILARES se repiten en los documentos sobre vida con discapacidad? ' +
      'Nómbralas.',
    candidates: [
      { label: 'PILARES "Carlos Monsiváis"', aliases: ['Monsiváis', 'Monsivais'] },
      { label: 'PILARES "Gabriel Vargas"', aliases: ['Gabriel Vargas'] },
    ],
  },
  {
    id: 'G03',
    text:
      '¿Qué eventos o jornadas comunitarias se mencionan en más de un documento? ' +
      'Enuméralos.',
    candidates: [
      { label: 'jornada de descacharrización de marzo de 2026', aliases: ['descacharrización', 'descacharrizacion'] },
      { label: 'feria escolar de prevención del dengue de noviembre de 2025', aliases: ['feria escolar'] },
      { label: 'Día Nacional de la Lengua de Señas Mexicana', aliases: ['Lengua de Señas Mexicana'] },
    ],
  },
  {
    id: 'G04',
    text:
      '¿Qué personas concretas se mencionan por su nombre en varios documentos ' +
      'distintos? Enuméralas.',
    candidates: [
      { label: 'doña Eulalia, partera de Hueyapan', aliases: ['Eulalia'] },
      { label: 'el delegado Reynaldo Ocampo', aliases: ['Reynaldo'] },
      { label: 'la maestra Imelda', aliases: ['Imelda'] },
      { label: 'Óscar, intérprete de LSM', aliases: ['Óscar', 'Oscar'] },
      { label: 'Chabela, promotora de vectores', aliases: ['Chabela'] },
    ],
  },
  {
    /**
     * ⚠ THE PRODUCT NOW ANSWERS THIS DETERMINISTICALLY; THIS EVAL DOES NOT YET.
     *
     * `apps/web` puts one line in the chat's Tier-1 summary naming every
     * language with its documento count (`lenguaSummaryLine` in
     * `apps/web/src/lib/lengua.ts`, fed by `GET /api/lenguas`, which reads
     * `documents.lengua` over published documentos only). Retrieval alone
     * cannot answer an aggregate question — 11 languages over 191 documentos do
     * not fit in a top-k — which is the 0.36 recall here.
     *
     * The harness builds its own summary (`engine.ts`, `adapter.scopeHierarchy`
     * names the ecosistema only), so its "plain" arm still measures retrieval
     * alone. To measure the deterministic path, `engine.ts` needs the same line,
     * from the same rows (published `contentKind = 'documento'`, `lengua` not
     * null). That file belongs to the eval lane; the question and its expected
     * set do not change: testimonios carry no `lengua`, and the expected facts
     * are already filtered by support over published documents.
     */
    id: 'G05',
    text: '¿Qué lenguas indígenas hablan las personas que aparecen en los documentos?',
    candidates: [
      { label: 'náhuatl', aliases: ['náhuatl', 'nahuatl'] },
      { label: 'mixteco', aliases: ['mixteco'] },
      { label: 'mazateco', aliases: ['mazateco'] },
      { label: 'zapoteco', aliases: ['zapoteco'] },
      { label: 'totonaco', aliases: ['totonaco'] },
      { label: "tlapaneco (me'phaa)", aliases: ['tlapaneco', "me'phaa", 'me’phaa'] },
      { label: 'hñähñu (otomí)', aliases: ['hñähñu', 'otomí', 'otomi'] },
      { label: 'mixe', aliases: ['mixe'] },
      { label: 'tlahuica', aliases: ['tlahuica'] },
      { label: 'tsotsil', aliases: ['tsotsil'] },
      { label: 'amuzgo', aliases: ['amuzgo'] },
    ],
  },
  {
    id: 'G06',
    text:
      '¿Qué herramientas o prácticas concretas para el control del dengue aparecen ' +
      'en los documentos? Enuméralas.',
    candidates: [
      { label: 'ovitrampas', aliases: ['ovitrampa'] },
      { label: 'patio limpio', aliases: ['patio limpio'] },
      { label: 'App-Salud Aedes', aliases: ['App-Salud Aedes', 'App Salud Aedes'] },
      { label: 'descacharrización', aliases: ['descacharrización', 'descacharrizacion'] },
    ],
  },
  {
    id: 'G07',
    text:
      '¿De qué comunidades o pueblos de origen vienen las personas que cuentan su ' +
      'trayectoria? Enumera los que se repitan.',
    candidates: [
      { label: 'San Juan Mixtepec', aliases: ['San Juan Mixtepec'] },
      { label: 'Huautla de Jiménez', aliases: ['Huautla'] },
      { label: 'Papantla', aliases: ['Papantla'] },
      { label: 'Malinaltepec', aliases: ['Malinaltepec'] },
      { label: 'Juchitán', aliases: ['Juchitán', 'Juchitan'] },
      { label: 'Xochistlahuaca', aliases: ['Xochistlahuaca'] },
      { label: 'Tlahuitoltepec', aliases: ['Tlahuitoltepec'] },
      { label: 'Cuentepec', aliases: ['Cuentepec'] },
      { label: 'Ixmiquilpan', aliases: ['Ixmiquilpan'] },
      { label: 'Potoichán', aliases: ['Potoichán', 'Potoichan'] },
      { label: 'Xoxocotla', aliases: ['Xoxocotla'] },
      { label: 'Chenalhó', aliases: ['Chenalhó', 'Chenalho'] },
      { label: 'San Juan Atzingo', aliases: ['San Juan Atzingo'] },
      { label: 'Hueyapan', aliases: ['Hueyapan'] },
    ],
  },
  {
    id: 'G08',
    text:
      'En los documentos sobre acompañamiento escolar, ¿qué escuela se repite y qué ' +
      'lugar de riesgo se menciona junto a ella?',
    candidates: [
      { label: 'Escuela Primaria "Miguel Hidalgo"', aliases: ['Miguel Hidalgo'] },
      { label: 'colonia Ciudad Chapultepec', aliases: ['Ciudad Chapultepec'] },
      { label: 'la barranca', aliases: ['barranca'] },
    ],
  },
  {
    id: 'G09',
    text:
      '¿Qué preocupaciones o temas de fondo se repiten a lo largo de los documentos ' +
      'publicados, más allá de un caso concreto?',
    candidates: [
      { label: 'desconfianza institucional', aliases: ['desconfianza', 'desconfía', 'desconfian'] },
      { label: 'el derecho a la salud', aliases: ['derecho a la salud'] },
      { label: 'el consentimiento informado', aliases: ['consentimiento informado'] },
      { label: 'la crítica a la palabra "inclusión"', aliases: ['inclusión', 'inclusion'] },
      { label: 'que los datos regresen a la comunidad', aliases: ['regresen', 'regrese'] },
      { label: 'la interpretación y el papel del intérprete', aliases: ['intérprete', 'interprete'] },
    ],
  },
  {
    id: 'G10',
    text:
      '¿Qué asuntos aparecen a la vez en los documentos sobre dengue y en los de la ' +
      'escuela primaria? Nombra lo que comparten.',
    candidates: [
      { label: 'feria escolar de prevención del dengue', aliases: ['feria escolar'] },
      { label: 'jornada de descacharrización', aliases: ['descacharrización', 'descacharrizacion'] },
      { label: 'la barranca de Ciudad Chapultepec', aliases: ['barranca'] },
      { label: 'Escuela Primaria "Miguel Hidalgo"', aliases: ['Miguel Hidalgo'] },
    ],
  },
]

// ── Local questions ────────────────────────────────────────────────────────

/**
 * Ten published documents, one per question.
 *
 * ⚠ Chosen for spread (all four themes, both long genres) and for a full name
 * that occurs exactly ONCE in the whole 250-row manifest — a repeated name
 * would make "did it cite the right document" unanswerable.
 */
const LOCAL_SIMS = [
  'SIM_0002',
  'SIM_0024',
  'SIM_0057',
  'SIM_0077',
  'SIM_0090',
  'SIM_0134',
  'SIM_0183',
  'SIM_0195',
  'SIM_0208',
  'SIM_0249',
] as const

/** The distinctive core of a value that arrives as `"Huautla de Jiménez, Oaxaca"`. */
function firstPart(value: string): string {
  return value.split(',')[0].trim()
}

/** `hñähñu (otomí)` → `hñähñu`; `tlapaneco (me'phaa)` → `tlapaneco`. */
function baseLanguage(value: string): string {
  return value.split('(')[0].trim()
}

// ── Assembly ───────────────────────────────────────────────────────────────

export interface QuestionSet {
  questions: EvalQuestion[]
  /** Global facts dropped for lack of support, with the count that dropped them. */
  droppedGlobalFacts: Array<{ question: string; label: string; support: number }>
  /** Local questions skipped because their target is a draft on this stack. */
  skippedLocal: string[]
}

export interface BuildQuestionsOptions {
  /**
   * SIM ids that exist in the ecosistema but are NOT published
   * (`loadUnpublishedSims`). The seed keeps every 8th `documento` a draft, so
   * on a seeded stack a local target such as SIM_0134 can be one.
   */
  unpublishedSims?: ReadonlySet<string>
  warn?: (message: string) => void
}

export function buildQuestions(
  docs: readonly CorpusDoc[],
  opts: BuildQuestionsOptions = {},
): QuestionSet {
  const warn = opts.warn ?? ((m: string) => console.error(m))
  const skippedLocal: string[] = []
  const questions: EvalQuestion[] = []
  const droppedGlobalFacts: QuestionSet['droppedGlobalFacts'] = []

  for (const spec of GLOBAL_SPECS) {
    const expected: Fact[] = []
    const support: Record<string, number> = {}
    for (const fact of spec.candidates) {
      const n = factSupport(docs, fact)
      support[fact.label] = n
      if (n >= MIN_GLOBAL_SUPPORT) expected.push(fact)
      else droppedGlobalFacts.push({ question: spec.id, label: fact.label, support: n })
    }
    questions.push({
      id: spec.id,
      klass: 'global',
      text: spec.text,
      expected,
      targetDocumentId: null,
      support,
    })
  }

  const bySim = new Map(docs.map((d) => [d.sim, d]))
  LOCAL_SIMS.forEach((sim, index) => {
    const doc = bySim.get(sim)
    if (!doc && opts.unpublishedSims?.has(sim)) {
      // ⚠ SKIPPED, NOT SCORED. Retrieval only sees published rows, so scoring a
      // draft target would charge both arms for a document neither may find.
      // The id stays pinned to the SIM (L06 is always SIM_0134), so a skipped
      // question leaves a gap rather than renumbering the rest.
      warn(`[eval] ⚠ skipping local question ${sim}: its document is not published on this stack`)
      skippedLocal.push(sim)
      return
    }
    if (!doc) {
      // Not even a draft: the database holds a different corpus.
      throw new Error(
        `[eval] local question ${sim} has no PUBLISHED document. The corpus in the ` +
          'database is not the one this question set was built against; re-pick.',
      )
    }
    const m = doc.manifest
    const candidates: Fact[] = [
      { label: baseLanguage(m.lengua), aliases: [baseLanguage(m.lengua)] },
      { label: firstPart(m.origen), aliases: [firstPart(m.origen)] },
      { label: m.sitio_ancla, aliases: [distinctiveCore(m.sitio_ancla)] },
    ]
    // 🔴 A fact its own document does not contain is not a fact. See `corpus.ts`.
    const expected = candidates.filter((f) => containsAny(doc.text, f.aliases))
    if (expected.length < candidates.length) {
      throw new Error(
        `[eval] ${sim} does not contain all of its manifest facts in its text ` +
          `(${expected.length}/${candidates.length}). Pick a different document.`,
      )
    }
    questions.push({
      id: `L${String(index + 1).padStart(2, '0')}`,
      klass: 'local',
      text:
        `Según los documentos publicados, ¿qué lengua habla ${m.nombre}, de qué ` +
        'comunidad viene y en qué lugar colabora?',
      expected,
      targetDocumentId: doc.documentId,
      support: Object.fromEntries(expected.map((f) => [f.label, factSupport(docs, f)])),
    })
  })

  return { questions, droppedGlobalFacts, skippedLocal }
}

/**
 * The part of an anchor-site name that an answer is likely to reuse.
 *
 * ⚠ Not a general-purpose function — a lookup with a fall-through, because the
 * eight anchor sites are a closed set and guessing a "core" by rule would
 * eventually produce a word like `Centro` that matches everything.
 */
export function distinctiveCore(sitio: string): string {
  const table: Array<[RegExp, string]> = [
    [/Tlayacapan/i, 'Tlayacapan'],
    [/Villa de Ayala/i, 'Villa de Ayala'],
    [/Parres/i, 'Parres'],
    [/Monsiv/i, 'Monsiv'],
    [/Gabriel Vargas/i, 'Gabriel Vargas'],
    [/Miguel Hidalgo/i, 'Miguel Hidalgo'],
    [/descacharri/i, 'descacharri'],
    [/App-Salud Aedes/i, 'App-Salud Aedes'],
  ]
  for (const [pattern, core] of table) if (pattern.test(sitio)) return core
  return sitio
}
