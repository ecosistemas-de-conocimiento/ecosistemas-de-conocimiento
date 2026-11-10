/**
 * GRAPH SEEDS FROM A NOTE'S `[[wikilinks]]` (owner ruling Q7, 2026-10-28).
 *
 * An Obsidian-style note already says which topics it links to. For an
 * allowlisted ecosistema (`WIKILINK_SEED_ORGS` in `schedule.ts`) those links
 * add graph rows next to whatever the model extracts:
 *
 *   · a mention of each surviving link target's node;
 *   · a mention of the node for the note's own title;
 *   · one `relacionado_con` edge from the title to each link.
 *
 * 🔴 A SEED NEVER CREATES A NODE (audit 2026-10-28: `[[Juan Pérez]]` and a
 * note titled "Rosa Martínez" became temas). It attaches only to a key this
 * run's model labelled non-persona, or to a non-persona node a MODEL-WRITTEN
 * mention in ANOTHER document keeps alive now (`graph_mentions.seeded =
 * false`) — never an orphan left by an old run, never this note's own earlier
 * mention, never another note's seed (audits 2026-10-28). See
 * {@link mergeWikiSeeds} and {@link splitStoredSeedEntities}.
 *
 * Merged into the model's extraction BEFORE the writer's replace-all, so a
 * re-run never duplicates them, and identity is `canonicalKey` as everywhere.
 *
 * ── 🔴 WHAT A LINK MUST SURVIVE ─────────────────────────────────────────────
 *
 * A raw target is whatever the author typed, BEFORE the anonymisation gate.
 * It is kept only when ALL of these hold:
 *
 *   1. The document is a `documento`. Any other kind, null or unknown, gets no
 *      seeds — the same fail-closed comparison as the person rule.
 *   2. The target is at least {@link WIKILINK_MIN_CHARS} characters.
 *   3. It occurs as a WHOLE WORD in the corpus text (`corpusTextFor`: the
 *      REDACTED text for gated content). This one rule drops two leaks:
 *        · a name the gate redacted — it is no longer in the text;
 *        · an alias-hidden target — `[[María López|la vecina]]` shows only
 *          "la vecina", so the target was never visible.
 *      Whole word: "Ana" does not match inside "Mariana".
 *   4. It is not graph noise (a language name, a redaction placeholder).
 *   5. 🔴 NEVER A PERSONA. Dropped when the model typed the key `persona` in
 *      this run (kept or dropped by the person rule), when ANY stored node in
 *      the ecosistema with that key is a `persona`, when it is a kept public
 *      figure, or when {@link authorBlocker} matches the author kept visible. The ingest
 *      run looks the stored personas up (`writer.ts`
 *      `findSeedEntities`, split by {@link splitStoredSeedEntities}).
 *      There is no model-less path: every seed is judged in a model run of
 *      its own note.
 *   6. It attaches to an existing, live node (above). No match, no seed.
 *
 * Pure, no I/O (callers do the lookups). Unit-tested in `wikilinks.test.ts`.
 */

import { titleIsGated } from '../contentKind'
import { extractMarkdownLinks } from '../extract/markdown'

import { isGraphNoiseLabel } from './noise'
import { canonicalKey, displayLabel } from './normalise'
import { isGraphEntityType, type GraphEntityType, type GraphExtraction, type MergedEntity, type MergedRelation } from './types'

/** Targets shorter than this are dropped: "IA", "PP" match far too much. */
export const WIKILINK_MIN_CHARS = 3

/** A note linking to more than this is an index page; the rest are dropped. */
export const WIKILINK_MAX_LINKS = 50

/** One surviving link: its display label and how often it occurs in the text. */
export interface WikiSeedLink {
  label: string
  occurrences: number
}

export interface WikiSeeds {
  /** The note's title as a `tema`, or null when it may not be one. */
  title: string | null
  links: WikiSeedLink[]
}

/**
 * The label a raw target stands for: the page part (`T#H` → `T`), its last
 * path segment (`carpeta/T` → `T`), without a `.md` extension.
 */
export function wikiLinkLabel(raw: string): string {
  const page = String(raw ?? '').split('#')[0] ?? ''
  const last = page.split('/').pop() ?? ''
  return displayLabel(last.replace(/\.md$/i, ''))
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * How often `label` occurs in `text` as a whole word, case-insensitively.
 * A letter, digit or underscore on either side means "inside another word".
 */
export function wholeWordCount(label: string, text: string): number {
  const form = displayLabel(label)
  if (!form || !text) return 0
  const body = form.split(' ').map(escapeRegExp).join('\\s+')
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'giu')
  return text.normalize('NFC').match(re)?.length ?? 0
}

/**
 * 🔴 THE FILTER. Raw targets in, the ones that may become graph rows out
 * (labels, de-duplicated by `canonicalKey`, in order). See the header.
 */
export function safeWikiLinks(
  rawLinks: readonly string[] | null | undefined,
  corpusText: string,
  contentKind: string | null | undefined,
): WikiSeedLink[] {
  if (contentKind !== 'documento') return []
  const out: WikiSeedLink[] = []
  const seen = new Set<string>()
  for (const raw of rawLinks ?? []) {
    if (typeof raw !== 'string') continue
    const label = wikiLinkLabel(raw)
    const key = canonicalKey(label)
    if (!key || seen.has(key)) continue
    if (label.length < WIKILINK_MIN_CHARS) continue
    if (isGraphNoiseLabel(label)) continue
    const occurrences = wholeWordCount(label, corpusText)
    if (occurrences === 0) continue
    seen.add(key)
    out.push({ label, occurrences })
    if (out.length >= WIKILINK_MAX_LINKS) break
  }
  return out
}

/** Neutral titles `titleFor` hands out; never a topic. */
const NEUTRAL_TITLES = new Set(['documento', 'documento sin titulo', 'testimonio', 'conversacion'])

/**
 * The note's title as a seed `tema`, or null.
 *
 * 🔴 For a gated title (`gated`: {@link titleIsGated}, so `anonymise` NULL or
 * absent counts) the title is the uploader's free text and never went through
 * the gate, so it must pass the same whole-word test as a link. An ungated documento's name is
 * already its public title everywhere (`titleFor`).
 */
export function wikiSeedTitle(args: {
  contentKind: string | null | undefined
  name: string | null | undefined
  gated: boolean
  corpusText: string
}): string | null {
  if (args.contentKind !== 'documento') return null
  const label = wikiLinkLabel(typeof args.name === 'string' ? args.name : '')
  const key = canonicalKey(label)
  if (!key || label.length < WIKILINK_MIN_CHARS || NEUTRAL_TITLES.has(key)) return null
  if (isGraphNoiseLabel(label)) return null
  if (args.gated && wholeWordCount(label, args.corpusText) === 0) return null
  return label
}

/**
 * A node the ecosistema already stores, as `splitStoredSeedEntities` returns
 * it: the only kind of node a seed may attach to besides the model's own.
 */
export interface KnownSeedEntity {
  type: GraphEntityType
  label: string
  canonicalKey: string
}

export interface MergeWikiSeedsOptions {
  /** 🔴 Never a seed: stored persona keys and kept public figures. */
  personaLabels?: readonly string[]
  /** Stored NON-persona nodes for the seed keys (see {@link splitStoredSeedEntities}). */
  known?: readonly KnownSeedEntity[]
  /** 🔴 The author kept visible: never a seed, by {@link authorBlocker}. */
  authorNames?: readonly string[]
}

export interface MergedWikiSeeds {
  extraction: GraphExtraction
  /** The links that attached (what `documents.wikiLinks` stores), or null. */
  links: WikiSeedLink[] | null
}

/**
 * Fold seeds into a model extraction, by `canonicalKey`.
 *
 * 🔴 A SEED NEVER CREATES A NODE. A link (or the title) attaches only to:
 *   · a key THIS RUN's model labelled with a non-persona type, or
 *   · a non-persona node the ecosistema already stores (`known`).
 * Everything else is dropped. A link's text cannot tell a topic from a person
 * — `[[Juan Pérez]]`, a note titled "Rosa Martínez" — and a model that was
 * silent about a name (or whose window failed or was truncated) says nothing
 * either way, so silence is a drop, never a `tema`.
 *
 * 🔴 And never a persona: a key the model typed `persona` here — kept or
 * dropped by the person rule (`extraction.personaKeys`) — or one in
 * `personaLabels` (stored personas, kept public figures) is dropped even when
 * `known` lists a non-persona node with the same key.
 *
 * Edges are title → link, `relacionado_con`; the writer orders and
 * de-duplicates symmetric edges, so a model edge on the same pair is one row.
 * The input is not mutated.
 */
export function mergeWikiSeeds(
  extraction: GraphExtraction,
  seeds: WikiSeeds | null | undefined,
  opts: MergeWikiSeedsOptions = {},
): MergedWikiSeeds {
  if (!seeds || (seeds.links.length === 0 && !seeds.title)) return { extraction, links: null }
  const isPersona = personaBlocker(personaKeysOf(extraction, opts.personaLabels))
  const isAuthor = authorBlocker(opts.authorNames ?? [])
  const blocked = (key: string) => isPersona(key) || isAuthor(key)
  const present = new Set<string>()
  for (const e of extraction.entities) {
    if (e.type !== 'persona') present.add(e.canonicalKey || canonicalKey(e.label))
  }
  const known = new Map<string, KnownSeedEntity>()
  for (const k of opts.known ?? []) {
    if (k.type !== 'persona' && k.canonicalKey && !known.has(k.canonicalKey)) known.set(k.canonicalKey, k)
  }

  const entities: MergedEntity[] = [...extraction.entities]
  const attach = (label: string, occurrences: number): string | null => {
    const key = canonicalKey(label)
    if (!key || blocked(key)) return null
    if (present.has(key)) return key
    const stored = known.get(key)
    if (!stored) return null
    present.add(key)
    entities.push({
      type: stored.type,
      label: stored.label,
      canonicalKey: key,
      occurrences: Math.max(1, occurrences),
      aliases: [],
      snippet: null,
      seeded: true,
    })
    return key
  }

  const titleKey = seeds.title ? attach(seeds.title, 1) : null
  const relations: MergedRelation[] = [...extraction.relations]
  const links: WikiSeedLink[] = []
  for (const link of seeds.links) {
    const key = attach(link.label, link.occurrences)
    if (!key) continue
    links.push(link)
    if (titleKey && key !== titleKey) {
      relations.push({ fromKey: titleKey, toKey: key, type: 'relacionado_con' })
    }
  }
  return { extraction: { ...extraction, entities, relations }, links: links.length > 0 ? links : null }
}

/** A name's words, compared without case or accents. Anything but a letter splits. */
function nameWords(label: string): string[] {
  return canonicalKey(label).split(/\P{L}+/u).filter(Boolean)
}

/** True when `run` occurs in `words` as consecutive words. */
function containsWordRun(words: readonly string[], run: readonly string[]): boolean {
  for (let i = 0; i + run.length <= words.length; i++) {
    if (run.every((w, j) => words[i + j] === w)) return true
  }
  return false
}

/**
 * 🔴 WHAT COUNTS AS THE AUTHOR KEPT VISIBLE. The model reshapes the name, so a
 * label is the author when, for any of the names:
 *
 *   · it holds the whole name as consecutive words: "Seminario Ana María López
 *     Ruiz sobre semiosis", "Ana María López (autora)";
 *   · all its words come from the name: "Ana López", "López, Ana María", "Ruiz";
 *   · it ends in the surname: "Colonia Rentería". Fails closed, in this document.
 *
 * ⚠ NOT CAUGHT: part of the name inside a longer phrase that does not end in the
 * surname, "Seminario Ana López sobre semiosis". Those words alone cannot tell
 * it from "Seminario Ana sobre semiosis" or "López Mateos".
 */
export function authorBlocker(authorNames: readonly string[]): (label: string) => boolean {
  const authors = authorNames.map(nameWords).filter((a) => a.length > 0)
  return (label) => {
    const words = nameWords(label)
    if (words.length === 0) return false
    return authors.some((author) => {
      const surname = author[author.length - 1] ?? ''
      return (
        containsWordRun(words, author) ||
        words.every((w) => author.includes(w)) ||
        (surname.length >= WIKILINK_MIN_CHARS && words[words.length - 1] === surname)
      )
    })
  }
}

/**
 * 🔴 THE AUTHOR KEPT VISIBLE IS NO NODE (`documents.authorsKept`). The gate left
 * their whole name in the text, so the model can read it and call it anything:
 * a `tema`, an `organizacion`, a public `persona`. Being shown as the author of
 * this document does not make them a topic of the ecosistema. Every entity whose
 * label, key or alias {@link authorBlocker} matches goes, and so does every edge
 * with such an end. A node that stays loses a snippet holding the whole name.
 * The input is not mutated.
 */
export function dropKeptAuthors(extraction: GraphExtraction, authorNames: readonly string[]): GraphExtraction {
  const authors = authorNames.map(nameWords).filter((a) => a.length > 0)
  const blocked = authorBlocker(authorNames)
  const gone = new Set<string>()
  let changed = false
  const entities: MergedEntity[] = []
  for (const e of extraction.entities) {
    if ([e.label, e.canonicalKey, ...(e.aliases ?? [])].some((l) => blocked(l))) {
      gone.add(e.canonicalKey || canonicalKey(e.label))
      changed = true
    } else if (e.snippet && authors.some((a) => containsWordRun(nameWords(e.snippet ?? ''), a))) {
      entities.push({ ...e, snippet: null })
      changed = true
    } else {
      entities.push(e)
    }
  }
  const relations = extraction.relations.filter(
    (r) => !gone.has(r.fromKey) && !gone.has(r.toKey) && !blocked(r.fromKey) && !blocked(r.toKey),
  )
  if (!changed && relations.length === extraction.relations.length) return extraction
  return { ...extraction, entities, relations }
}

/** 🔴 The keys a seed may never take: the model's personas plus `personaLabels`. */
export function personaKeysOf(extraction: GraphExtraction, personaLabels: readonly string[] = []): Set<string> {
  const keys = new Set<string>(personaLabels.map((l) => canonicalKey(l)).filter(Boolean))
  for (const k of extraction.personaKeys ?? []) if (k) keys.add(k)
  for (const e of extraction.entities) {
    if (e.type === 'persona') keys.add(e.canonicalKey || canonicalKey(e.label))
  }
  return keys
}

/**
 * The forms a name is compared by: its canonical key and, for a name of two or
 * more words, its last word (the surname) when that is at least
 * {@link WIKILINK_MIN_CHARS} long. "Charles Peirce" → `charles peirce`,
 * `peirce`.
 */
export function nameForms(label: string): string[] {
  const key = canonicalKey(label)
  if (!key) return []
  const words = key.split(' ')
  const last = words[words.length - 1] ?? ''
  return words.length > 1 && last.length >= WIKILINK_MIN_CHARS ? [key, last] : [key]
}

/**
 * 🔴 ALIAS-AWARE PERSONA CHECK (audit 2026-10-28, item 3). A seed key is
 * blocked when any of its {@link nameForms} equals any form of a persona name:
 * the model typing "Peirce" a persona blocks `[[Charles Peirce]]`, and a stored
 * persona "Noam Chomsky" (alias "Chomsky") blocks `[[Chomsky]]`. Fails closed:
 * a topic whose last word is a persona's surname is dropped too.
 */
export function personaBlocker(personaNames: Iterable<string>): (key: string) => boolean {
  const forms = new Set<string>()
  for (const n of personaNames) for (const f of nameForms(n)) forms.add(f)
  return (key) => nameForms(key).some((f) => forms.has(f))
}

/**
 * Split the ecosistema's stored nodes for the seed keys into the two lists a
 * merge needs (the ingest run's `findSeedEntities`; there is no other caller):
 *   · 🔴 `personaKeys` — every key some stored row types `persona`, mentioned
 *     or not;
 *   · `known` — the NON-persona rows, in the order given (callers order by
 *     preference), minus any key in `personaKeys`, and 🔴 ONLY rows whose
 *     `mentionedElsewhere` is literally `true`: a MODEL-WRITTEN mention
 *     (`seeded = false`) in ANOTHER document exists now (`findSeedEntities`). Entities are never deleted (`writer.ts`), so an orphan `tema`
 *     "Pedro Ramírez" left by an old run, or this note's own earlier
 *     mislabel, is not evidence of a topic (re-audit 2026-10-28). Missing
 *     means no: fail closed.
 */
export function splitStoredSeedEntities<
  T extends { type: unknown; label: unknown; canonicalKey: unknown; aliases?: unknown; mentionedElsewhere?: unknown },
>(
  rows: readonly T[],
  /** More persona names (stored personas not among `rows`, with their aliases). */
  extraPersonaNames: readonly string[] = [],
): { personaKeys: string[]; known: (KnownSeedEntity & { row: T })[] } {
  const persona = new Set<string>(extraPersonaNames.map((n) => canonicalKey(n)).filter(Boolean))
  for (const r of rows) {
    if (r.type !== 'persona') continue
    if (typeof r.canonicalKey === 'string' && r.canonicalKey) persona.add(r.canonicalKey)
    if (Array.isArray(r.aliases)) {
      for (const a of r.aliases) if (typeof a === 'string' && canonicalKey(a)) persona.add(canonicalKey(a))
    }
  }
  const blocked = personaBlocker(persona)
  const known: (KnownSeedEntity & { row: T })[] = []
  for (const r of rows) {
    if (!isGraphEntityType(r.type) || typeof r.canonicalKey !== 'string' || !r.canonicalKey) continue
    // 🔴 THE NON-PERSONA FILTER, in one place: a persona row's key is in
    // `persona`, so this drops it AND any non-persona row sharing its key or
    // a surname/alias form of it.
    if (blocked(r.canonicalKey)) continue
    // 🔴 LIVE ELSEWHERE, or nothing.
    if (r.mentionedElsewhere !== true) continue
    known.push({ type: r.type, label: typeof r.label === 'string' ? r.label : r.canonicalKey, canonicalKey: r.canonicalKey, row: r })
  }
  return { personaKeys: [...persona], known }
}

/** The canonical keys a set of seeds would look up. */
export function seedKeys(seeds: WikiSeeds | null | undefined): string[] {
  if (!seeds) return []
  const out = new Set<string>()
  for (const l of [seeds.title, ...seeds.links.map((x) => x.label)]) {
    const k = typeof l === 'string' ? canonicalKey(l) : ''
    if (k) out.add(k)
  }
  return [...out]
}

/** An empty extraction (tests and callers with no model output). */
export function emptyExtraction(promptVersion: string): GraphExtraction {
  return { entities: [], relations: [], windows: 0, windowsFailed: 0, truncated: false, promptVersion }
}

/**
 * The seeds for one `documents` row, or null when it has none.
 *
 * Only a `kind: 'markdown'` row with a `bodyMarkdown` source has links.
 * ⚠ A Markdown FILE upload (`mediaFile`) is not read here: its bytes live in
 * storage and are extracted in the sandbox worker, which returns text only.
 *
 * `corpusText` is `corpusTextFor(row).text`.
 *
 * 🔴 The title follows the TITLE rule, {@link titleIsGated}: `anonymise` NULL
 * or absent is a gated title (audit 2026-11-10), even where the body's rule
 * (`rowMustPassGate`) reads NULL as open. Pass the row with `anonymise`.
 */
export function wikiSeedsForRow(
  row: {
    kind?: unknown
    contentKind?: unknown
    name?: unknown
    bodyMarkdown?: unknown
    anonymise?: unknown
  },
  corpusText: string,
): WikiSeeds | null {
  if (row.kind !== 'markdown' || typeof row.bodyMarkdown !== 'string' || !row.bodyMarkdown.trim()) return null
  const contentKind = typeof row.contentKind === 'string' ? row.contentKind : null
  const links = safeWikiLinks(extractMarkdownLinks(row.bodyMarkdown), corpusText, contentKind)
  if (links.length === 0) return { title: null, links }
  const title = wikiSeedTitle({
    contentKind,
    name: typeof row.name === 'string' ? row.name : null,
    gated: titleIsGated(row.anonymise),
    corpusText,
  })
  return { title, links }
}

/** The names on a keep log, `documents.publicFiguresKept` or `documents.authorsKept`. */
export function keptLogNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((e) => (e && typeof e === 'object' ? (e as { name?: unknown }).name : null))
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
}

/**
 * 🔴 EVERY NAME THE GATE LEFT VISIBLE AS AN AUTHOR: the document's own
 * (`authorsKept`) and the cited ones (`citedAuthorsKept`, owner decision
 * 2026-11-07). Each is fed to {@link authorBlocker}: being cited in a document
 * does not make someone a node of the ecosistema.
 */
export function blockedAuthorNames(row: { authorsKept?: unknown; citedAuthorsKept?: unknown }): string[] {
  // A cited entry may carry initials ("Quiroga, T."): the surname is what the
  // blocker must match, so "Teresa Quiroga" goes too (fails closed).
  const cited = keptLogNames(row.citedAuthorsKept).map((n) => n.replace(/,.*$/su, '').trim()).filter(Boolean)
  return [...new Set([...keptLogNames(row.authorsKept), ...cited])]
}
