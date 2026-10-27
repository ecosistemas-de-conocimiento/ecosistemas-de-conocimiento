/**
 * 🔴 A TESTIMONIO'S DISTINCT TITLE, PROPOSED BY THE SYSTEM FROM ITS REDACTED TEXT.
 *
 * Owner ruling 2026-10-24: a participant uploads audio or chats and never types
 * a title, so every testimonio read "Testimonio · <tema>" and lists of them
 * could not be told apart. This module asks a model for a short Spanish title
 * (4–9 words, the concrete subject) and stores it on `documents.testimonioTitle`.
 *
 * 🔴 WHICH MODEL: the gate detector's own backend choice
 * ({@link titleClientFromEnv}) — the self-hosted box when `ANONYMISE_DETECT_URL`
 * is set, the hosted model only when `ANONYMISE_DETECT_FALLBACK` allows it, and
 * never the hosted model for a held row.
 *
 * ── 🔴 WHAT THE MODEL SEES: THE GATE'S OUTPUT, NOTHING ELSE ────────────────
 *
 * The only text input is the gate's redacted output: `redactedText` at `ready`
 * (the gate's verdict) or `approved` (a reviewer's), or — for a HELD row (owner
 * ruling 2026-10-24: Revisión gets titles too) — `heldText`, the gate's
 * redacted output at the moment it refused. Never `extractedText`. A held row
 * with no `heldText` (a structural hold) gets no title, so the fallback label.
 *
 * ⚠ `heldText` can still carry what verify flagged (that is why it is held).
 * Those spans (`anonymisationSurvivors`) are passed as `forbidden`, and a title
 * that contains one is refused.
 *
 * ── 🔴 WHAT A TITLE MAY NOT CARRY (owner rulings 2026-10-24) ───────────────
 *
 * Never a person's name, never a redacted value or a placeholder. A town and a
 * language MAY appear. {@link cleanTitle} refuses an answer that breaks this in
 * a way code can see — any `[`/`]` or placeholder words without them
 * ("Persona A", "Dato omitido"); a person name as the first word; a capitalised
 * word that is not a town, state or language the redacted source carries
 * (Spanish titles are sentence case, so it is a proper noun the model invented,
 * one the gate removed, or one it missed); a `forbidden` span or any ≥3-letter
 * token of one. A refused answer is retried once, then the title stays NULL and
 * the UI shows the old label.
 *
 * ── 🔴 NEVER ON THE CRITICAL PATH ───────────────────────────────────────────
 *
 * The call runs detached after the gate clears the row. Ingest and publish
 * never wait on it, and a failure (budget 402, 429, timeout) writes NULL, which
 * the UI reads as "use the fallback label". It shares the gate detector's
 * process-wide pacing (`ANONYMISE_DETECT_MIN_GAP_MS`), because it spends the
 * same ai-service key's 30/min generate cap.
 *
 * ── 🔴 STALE WRITES ARE REFUSED BY THE UPDATE ITSELF ────────────────────────
 *
 * The write is guarded on `anonymisationStatus IN (ready, approved)` AND
 * `redactedText = <the text this title was made from>`. A re-gate, a hold or a
 * rejection that lands while the model is thinking changes one of those, the
 * UPDATE matches 0 rows, and the title is dropped. The gate's claim clears the
 * column (`anonymiseDocument.ts`), so a re-gated row never shows an old title.
 */

import { randomUUID } from 'node:crypto'

import { withRateLimitRetry } from './aiRetry'
import { paceDetectCall } from './anonymise/detector'
import { cooldownMsFromEnv, fallbackModeFromEnv, withHostedFallback } from './anonymise/fallbackGenerator'
import { openaiCompatFromEnv } from './anonymise/openaiCompatGenerator'
import { isPersonNameWord, isStateName, isTownLevelPlace } from './anonymise/townPlaces'

export const TESTIMONIO_TITLE_UNIT_TYPE = 'testimonio-title'

/** `off` / `0` / `false` disables generation (tests, a cost freeze). Default on. */
export const TESTIMONIO_TITLES_VAR = 'TESTIMONIO_TITLES'

/**
 * Redacted characters sent to the model. The subject of a testimonio is in its
 * first minutes; ~6 000 chars ≈ 1 500 tokens (inferred: ~4 chars/token for
 * Spanish) keeps one call cheap whatever the transcript's length.
 */
export const TESTIMONIO_TITLE_INPUT_CHARS = 6_000

/** Titles of the same ecosistema shown to the model, newest first. */
export const TESTIMONIO_TITLE_AVOID_MAX = 60

export const MIN_TITLE_WORDS = 3
export const MAX_TITLE_WORDS = 12
const MAX_TITLE_CHARS = 100

const TITLE_SYSTEM_PROMPT = [
  'Escribes el título de un testimonio anonimizado de una comunidad.',
  'Responde SOLO con el título, en una línea, sin comillas y sin punto final.',
  '',
  'Reglas:',
  '- Entre 4 y 9 palabras, en español sencillo y cotidiano.',
  '- Di el tema concreto: qué vivió o de qué habla la persona (por ejemplo, "Una madre pide intérprete de señas en la escuela").',
  '- Mayúscula solo en la primera letra.',
  '- NUNCA escribas el nombre de una persona. Puedes nombrar el pueblo o la lengua si el texto los dice.',
  '- NUNCA copies marcadores entre corchetes como [Persona A], [Domicilio B] o [Dato omitido].',
  '- No empieces con la palabra "Testimonio".',
  '- Debe ser distinto de los títulos ya usados que se listan.',
].join('\n')

/** Same reason as the detector's: `{{userPrompt}}` would HTML-escape the text. */
const PROMPT_TEMPLATE_USER_PROMPT = '{{{userPrompt}}}'

/** Fold for comparison: lower case, accents dropped, whitespace collapsed. */
export function foldTitle(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const words = (s: string): string[] => s.split(/\s+/).filter(Boolean)

const startsUpper = (w: string): boolean => {
  const first = w.replace(/^[^\p{L}]+/u, '')[0]
  return first !== undefined && first !== first.toLowerCase()
}

/** Does `source` contain `word` as a whole word, with the same capitalisation? */
function appearsIn(source: string, word: string): boolean {
  const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  if (bare === '') return true
  const esc = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'u').test(source)
}

/** `word`, capitalised, somewhere other than a sentence start: a proper noun in the source. */
function appearsMidSentence(source: string, word: string): boolean {
  if (word === '') return false
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<=[\\p{L}\\p{N},;:\\]]\\s+)${esc}(?![\\p{L}\\p{N}])`, 'u').test(source)
}

/** Letters only, folded: the unit every token comparison below uses. */
const letterTokens = (s: string): string[] => foldTitle(s).split(/[^\p{L}]+/u).filter(Boolean)

/** Leading/trailing punctuation off one word. */
const bareWord = (w: string): string => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')

/**
 * 🔴 The placeholder vocabulary (`anonymise/types.ts`) WITHOUT its brackets:
 * "Persona A", "domicilio B", "Dato omitido". The letter after Persona or
 * Domicilio is upper case in every placeholder, so "una persona mayor" stays.
 */
const PLACEHOLDER_WORDS =
  /(?<!\p{L})[Pp]ersona\s+\p{Lu}{1,3}(?!\p{L})|(?<!\p{L})[Dd]omicilio\s+\p{Lu}{1,3}(?!\p{L})|(?<!\p{L})[Dd]atos?\s+[Oo]mitidos?(?!\p{L})/u

/**
 * Languages a title may name capitalised (owner ruling 2026-10-24). Folded.
 * Compact on purpose: a language missing here is refused only when written
 * with a capital, which costs the fallback label, and titles are sentence case.
 */
const LANGUAGES = new Set(
  [
    'español', 'castellano', 'inglés', 'náhuatl', 'maya', 'zapoteco', 'mixteco', 'otomí', 'hñähñu',
    'totonaco', 'tsotsil', 'tzotzil', 'tseltal', 'tzeltal', 'mazahua', 'mazateco', 'chol', 'purépecha',
    'tarahumara', 'rarámuri', 'mixe', 'ayuuk', 'huasteco', 'tének', 'triqui', 'chinanteco', 'tlapaneco',
    'amuzgo', 'popoluca', 'tojolabal', 'zoque', 'huichol', 'wixárika', 'yaqui', 'cora', 'tepehuano', 'lsm',
  ].map(foldTitle),
)
const CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'el'])

/**
 * 🔴 A capitalised run ("Xoxocotla", "San Juan Chamula") may stay only when
 * the redacted source has it AND it is a language, a state, or a town by the
 * gate's own town rule (`isTownLevelPlace`: every occurrence in a town
 * context). Anything else capitalised is a person, a home or an institution.
 */
function isShowablePlaceOrLanguage(run: string, source: string): boolean {
  if (run === '' || !appearsIn(source, run)) return false
  if (isStateName(run)) return true
  const ws = words(run)
  if (ws.every((w) => CONNECTORS.has(foldTitle(w)) || LANGUAGES.has(foldTitle(w)))) return true
  if (ws.some((w) => isPersonNameWord(w))) return false
  return isTownLevelPlace({ text: run, type: 'lugar' }, source)
}

/**
 * The model's answer → a title, or `null` when it breaks a rule code can check.
 * `source` is the redacted text the title was made from: a capitalised word
 * must occur in it as a town, state or language (without `source`, any
 * capitalised word after the first is refused). `forbidden`: spans that must
 * not appear (a hold's flagged survivors), nor any ≥3-letter token of one.
 */
export function cleanTitle(raw: unknown, source?: string, forbidden: readonly string[] = []): string | null {
  if (typeof raw !== 'string') return null
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? ''
  let t = line
    .replace(/^\s*(?:t[íi]tulo)\s*:\s*/iu, '')
    .replace(/^[\s"'“”«»*_`]+|[\s"'“”«»*_`]+$/gu, '')
    .replace(/^testimonio(?:\s+(?:sobre|de|acerca de))?\s*[:\-—–]?\s*/iu, '')
    .replace(/[\s.;:,]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t === '' || t.length > MAX_TITLE_CHARS) return null
  // 🔴 A placeholder, whole or cut, bracketed or not, never reaches a title.
  if (/[[\]]/.test(t) || PLACEHOLDER_WORDS.test(t)) return null
  t = t[0]!.toUpperCase() + t.slice(1)
  const ws = words(t)
  if (ws.length < MIN_TITLE_WORDS || ws.length > MAX_TITLE_WORDS) return null

  // 🔴 Forbidden spans: the whole span, or ANY ≥3-letter token of one, folded.
  const folded = foldTitle(t)
  if (forbidden.some((f) => f.trim() !== '' && folded.includes(foldTitle(f)))) return null
  const banned = new Set(forbidden.flatMap(letterTokens).filter((tok) => tok.length >= 3))
  if (letterTokens(t).some((tok) => banned.has(tok))) return null

  // 🔴 Proper nouns. Sentence case: a capital after the first word is one. The
  // first word is one when it is a person name, or when the source writes it
  // capitalised and never in lower case (not an ordinary opening word).
  // ⚠ RESIDUAL: a first word the source lacks and the name list lacks passes
  // ("Hablar", "Ir" open real titles). The model sees redacted text only, so
  // such a name would be invented, not leaked.
  const proper = ws.map((w, i) => {
    if (i > 0) return startsUpper(w)
    if (isPersonNameWord(w)) return true
    if (source === undefined) return false
    const b = bareWord(w)
    return !appearsIn(source, b.charAt(0).toLowerCase() + b.slice(1)) && appearsMidSentence(source, b)
  })
  for (let i = 0; i < ws.length; i += 1) {
    if (!proper[i]) continue
    // Without the source nothing proper can be checked: fail closed.
    if (source === undefined) return null
    // The run of proper words this one starts, connectors between ("San Juan de los Lagos").
    let j = i
    while (j + 1 < ws.length && (proper[j + 1] || (CONNECTORS.has(foldTitle(ws[j + 1]!)) && proper[j + 2]))) j += 1
    const run = bareWord(ws.slice(i, j + 1).join(' '))
    const each = ws.slice(i, j + 1).filter((_, k) => proper[i + k]).map(bareWord)
    if (!isShowablePlaceOrLanguage(run, source) && !each.every((w) => isShowablePlaceOrLanguage(w, source))) return null
    i = j
  }
  return t
}

/** The user prompt: the titles to avoid, then the capped redacted text. */
export function buildTitlePrompt(redactedText: string, avoid: readonly string[], retryNote?: string): string {
  const used = avoid.slice(0, TESTIMONIO_TITLE_AVOID_MAX)
  return [
    used.length ? `Títulos ya usados en este ecosistema:\n${used.map((u) => `- ${u}`).join('\n')}` : '',
    retryNote ?? '',
    `Testimonio:\n${redactedText.slice(0, TESTIMONIO_TITLE_INPUT_CHARS)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** The slice of `@edc/ai-client` this module uses. Same shape as the detector's. */
export interface TitleGenerator {
  generate: {
    sync(
      req: {
        unit: {
          unitKey: string
          unitType: string
          input: { userPrompt: string }
          systemPrompt?: string
          specOverride?: { promptTemplate: string }
        }
        effortLevel?: string
      },
      opts?: { timeoutMs?: number },
    ): Promise<{ text: string }>
  }
}

const RETRY_NOTE =
  'El título anterior no sirvió: repetía uno ya usado o rompía una regla. Escribe otro distinto.'

/**
 * One title for one redacted text, or `null`. Never throws.
 *
 * At most 2 model calls: the second only when the first answer broke a rule or
 * repeated a title in `avoid`. A transport failure is retried by
 * `withRateLimitRetry` (429/5xx, 2 attempts) inside each call.
 */
export async function generateTestimonioTitle(args: {
  client: TitleGenerator
  redactedText: string
  avoid: readonly string[]
  /** Spans that must not appear in the title (a hold's survivors). */
  forbidden?: readonly string[]
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<string | null> {
  const text = args.redactedText.trim()
  if (!text) return null
  const taken = new Set(args.avoid.map(foldTitle))
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let answer: string
    try {
      answer = (
        await withRateLimitRetry(
          async () => {
            await paceDetectCall(args.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))
            return args.client.generate.sync(
              {
                unit: {
                  unitKey: `testimonio-title-${randomUUID()}`,
                  unitType: TESTIMONIO_TITLE_UNIT_TYPE,
                  input: { userPrompt: buildTitlePrompt(text, args.avoid, attempt > 0 ? RETRY_NOTE : undefined) },
                  systemPrompt: TITLE_SYSTEM_PROMPT,
                  specOverride: { promptTemplate: PROMPT_TEMPLATE_USER_PROMPT },
                },
                effortLevel: 'quick',
              },
              { timeoutMs: args.timeoutMs ?? 30_000 },
            )
          },
          {
            attempts: 2,
            budgetMs: 30_000,
            label: 'testimonio-title',
            retryTransient: true,
            ...(args.sleep ? { sleep: args.sleep } : {}),
          },
        )
      ).text
    } catch {
      return null
    }
    const title = cleanTitle(answer, text, args.forbidden ?? [])
    if (title && !taken.has(foldTitle(title))) return title
  }
  return null
}

/** Which gate output the text is: the cleared `redactedText`, or a hold's `heldText`. */
export type TitleSource = 'redacted' | 'held'

/** Where titles are read and written. Production: {@link payloadTitleStore}. */
export interface TitleStore {
  /** Other testimonio titles in the ecosistema, newest first. */
  otherTitles(organizationId: number | string, excludeDocId: number | string): Promise<string[]>
  /**
   * Write `title` (NULL = fallback label), guarded on the row still being in
   * the state the text came from: `ready`/`approved` with that `redactedText`,
   * or (`source: 'held'`) `held` with that `heldText`. Rows changed.
   */
  write(docId: number | string, title: string | null, text: string, source?: TitleSource): Promise<number>
}

export type RefreshOutcome =
  | { status: 'written'; title: string }
  | { status: 'failed'; title: null }
  | { status: 'stale'; title: string | null }

/** Generate and store one testimonio's title. Never throws on a model failure. */
export async function refreshTestimonioTitle(args: {
  docId: number | string
  organizationId: number | string
  redactedText: string
  client: TitleGenerator
  store: TitleStore
  /** Default `redacted`. */
  source?: TitleSource
  forbidden?: readonly string[]
  sleep?: (ms: number) => Promise<void>
}): Promise<RefreshOutcome> {
  const avoid = await args.store.otherTitles(args.organizationId, args.docId)
  const title = await generateTestimonioTitle({
    client: args.client,
    redactedText: args.redactedText,
    avoid,
    ...(args.forbidden ? { forbidden: args.forbidden } : {}),
    ...(args.sleep ? { sleep: args.sleep } : {}),
  })
  const changed = await args.store.write(args.docId, title, args.redactedText, args.source ?? 'redacted')
  if (changed === 0) return { status: 'stale', title }
  return title ? { status: 'written', title } : { status: 'failed', title: null }
}

/** Structural: the live Payload handle has both. */
export interface TitleStorePayload {
  find(args: Record<string, unknown>): Promise<{ docs: Array<Record<string, unknown>> }>
  db: { drizzle: { execute(query: unknown): Promise<unknown> } }
}

export function payloadTitleStore(payload: TitleStorePayload): TitleStore {
  return {
    async otherTitles(organizationId, excludeDocId) {
      const res = await payload.find({
        collection: 'documents',
        where: {
          and: [
            { organization: { equals: organizationId } },
            { contentKind: { equals: 'testimonio' } },
            // 🔴 Only titles the ecosistema already shows: a held row's title
            // is made from text that may still carry what the gate flagged, and
            // it must not travel into another document's prompt.
            { anonymisationStatus: { in: ['ready', 'approved'] } },
            { publicationStatus: { equals: 'published' } },
            { testimonioTitle: { exists: true } },
            { id: { not_equals: excludeDocId } },
          ],
        },
        select: { testimonioTitle: true },
        sort: '-updatedAt',
        limit: TESTIMONIO_TITLE_AVOID_MAX,
        depth: 0,
        overrideAccess: true,
        pagination: false,
      })
      return res.docs
        .map((d) => d.testimonioTitle)
        .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    },
    async write(docId, title, text, source = 'redacted') {
      const { updateDocumentColumns } = await import('./documentColumns')
      return updateDocumentColumns(payload as never, {
        id: docId,
        data: { testimonioTitle: title },
        where:
          source === 'held'
            ? [
                { contentKind: { equals: 'testimonio' } },
                { anonymisationStatus: { equals: 'held' } },
                { heldText: { equals: text } },
              ]
            : [
                { contentKind: { equals: 'testimonio' } },
                { anonymisationStatus: { in: ['ready', 'approved'] } },
                { redactedText: { equals: text } },
              ],
      })
    },
  }
}

/**
 * 🔴 THE MODEL A TITLE IS ASKED OF: THE GATE DETECTOR'S BACKEND CHOICE.
 *
 * Same switches as `anonymise/detector.ts` (`aiServiceDetector`):
 *   · `ANONYMISE_DETECT_URL` set → the self-hosted box (the DGX Spark) first;
 *     when it is unavailable, the hosted model (ai-service) only if
 *     `ANONYMISE_DETECT_FALLBACK` is `hosted` (the default).
 *   · unset → the hosted model, unless `ANONYMISE_DETECT_FALLBACK=none`, which
 *     means "no text to a hosted model": no client, so no title.
 *   · 🔴 a HELD row (`source: 'held'`) NEVER reaches the hosted model: its text
 *     can still carry what verify flagged. Spark only, or no client.
 *   · a bad `ANONYMISE_DETECT_FALLBACK` value or Spark config fails closed: no
 *     hosted call. `null` = no title, the UI shows the fallback label.
 */
export function titleClientFromEnv(args: {
  organizationId: number | string
  source: TitleSource
  env?: Record<string, string | undefined>
  /** Test seam for the self-hosted box. */
  fetch?: typeof fetch
  /** The runtime switch (`lib/platformSettings.ts`), already resolved. Wins over env. */
  fallbackMode?: 'hosted' | 'none'
}): TitleGenerator | null {
  const env = args.env ?? process.env
  let mode: 'hosted' | 'none'
  try {
    mode = args.fallbackMode ?? fallbackModeFromEnv(env)
  } catch {
    mode = 'none'
  }
  if (args.source === 'held') mode = 'none'
  let spark: TitleGenerator | null = null
  try {
    spark = openaiCompatFromEnv(env, args.fetch ? { fetch: args.fetch } : {})?.generator ?? null
  } catch {
    // URL without a model, or a bad URL: a config bug. Fail closed.
    return null
  }
  const hosted = async (): Promise<TitleGenerator> => {
    const { getAppAIClient } = await import('./aiClient')
    return getAppAIClient(args.organizationId) as unknown as TitleGenerator
  }
  if (spark) {
    return mode === 'hosted' ? withHostedFallback(spark, hosted, { cooldownMs: cooldownMsFromEnv(env) }) : spark
  }
  if (mode === 'none') return null
  return { generate: { sync: async (req, opts) => (await hosted()).generate.sync(req, opts) } }
}

export function testimonioTitlesEnabled(): boolean {
  return !/^(off|0|false|no)$/i.test((process.env[TESTIMONIO_TITLES_VAR] ?? '').trim())
}

/**
 * 🔴 FIRE AND FORGET, AFTER THE GATE CLEARED A TESTIMONIO.
 *
 * Returns whether a run started. `run` is the test seam; production builds one
 * from `payload` and {@link titleClientFromEnv} (a hosted call goes through
 * `getAppAIClient`, `X-AI-Org: eco-<id>`, so it is booked to that budget).
 *
 * ⚠ `redactedText` must be the gate's output: `gated.text` on a `testimonio`
 * that passed, the approved text, or (`source: 'held'`) the hold's `heldText`
 * with its survivors as `forbidden`. See the header.
 */
export function scheduleTestimonioTitle(args: {
  contentKind: unknown
  docId: number | string
  organizationId: number | string
  redactedText: string
  /** `held`: `redactedText` is the hold's `heldText`. Default `redacted`. */
  source?: TitleSource
  /** Spans the title must not contain (a hold's survivors). */
  forbidden?: readonly string[]
  payload?: TitleStorePayload
  run?: () => Promise<RefreshOutcome>
}): boolean {
  if (!args.redactedText.trim()) return false
  if (args.contentKind !== 'testimonio') return false
  if (!testimonioTitlesEnabled()) return false
  const run =
    args.run ??
    (async () => {
      if (!args.payload) throw new Error('scheduleTestimonioTitle: no payload')
      // 🔴 Per-ecosistema switch (`lib/features.ts`). Off: no call, no write.
      const { featureEnabled } = await import('./features')
      if (!(await featureEnabled(args.payload as never, args.organizationId, 'testimonioTitles'))) {
        return { status: 'failed', title: null } as const
      }
      let fallbackMode: 'hosted' | 'none' | undefined
      try {
        const { detectorFallbackMode } = await import('./platformSettings')
        fallbackMode = await detectorFallbackMode()
      } catch {
        fallbackMode = 'none'
      }
      const client = titleClientFromEnv({
        organizationId: args.organizationId,
        source: args.source ?? 'redacted',
        fallbackMode,
      })
      // No allowed backend: no call, no write. The column is already NULL
      // (cleared by the gate's claim or the decision), so the fallback label.
      if (!client) return { status: 'failed', title: null } as const
      return refreshTestimonioTitle({
        docId: args.docId,
        organizationId: args.organizationId,
        redactedText: args.redactedText,
        client,
        store: payloadTitleStore(args.payload),
        ...(args.source ? { source: args.source } : {}),
        ...(args.forbidden ? { forbidden: args.forbidden } : {}),
      })
    })
  void (async () => {
    try {
      const out = await run()
      if (out.status !== 'written') {
        console.warn(`[testimonio-title] doc ${args.docId}: ${out.status} — the fallback label stays.`)
      }
    } catch (err) {
      // ⚠ The error NAME only: a transport message can carry a request body.
      console.warn(
        `[testimonio-title] doc ${args.docId}: ${err instanceof Error ? err.name : 'error'} — the fallback label stays.`,
      )
    }
  })()
  return true
}
