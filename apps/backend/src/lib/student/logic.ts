/**
 * The student view's pure half: peer similarity, cited-author extraction,
 * linking an author to the ecosistema's own author page, and the activity
 * report. No I/O; `endpoints/estudiante.ts` feeds it rows from `./queries`.
 */

import { titleFor } from '../contentKind'

import type { DocRef, Labelled, OwnDoc, StudentRow, TestimonioRow } from './queries'

export interface Peer {
  id: number
  name: string
  /** Topics we share, most-documented first. Entity id + label only. */
  topics: Array<{ id: number; label: string }>
  score: number
}

/**
 * Peers ranked by Jaccard similarity of their `tema` sets to mine.
 * Only `candidates` (opted-in students) can appear; zero overlap is dropped.
 */
export function matchPeers(
  mine: readonly Labelled[],
  topicsOf: ReadonlyMap<number, readonly Labelled[]>,
  candidates: readonly StudentRow[],
  limit = 10,
): Peer[] {
  const myIds = new Set(mine.map((t) => t.id))
  if (myIds.size === 0) return []
  const out: Peer[] = []
  for (const c of candidates) {
    const theirs = topicsOf.get(c.id) ?? []
    const shared = theirs.filter((t) => myIds.has(t.id))
    if (shared.length === 0) continue
    const union = new Set([...myIds, ...theirs.map((t) => t.id)]).size
    out.push({
      id: c.id,
      name: c.name,
      topics: shared.slice(0, 3).map((t) => ({ id: t.id, label: t.label })),
      score: Math.round((shared.length / union) * 1000) / 1000,
    })
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit)
}

/** Accent- and case-folded, single-spaced. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const NOT_SURNAMES = new Set(
  'en el la los las de del y a por para con como ver vease cf ibid idem op cap pag p pp vol fig tabla seccion'.split(' '),
)

const SURNAME = "[A-ZÁÉÍÓÚÑÜ][\\p{L}'’-]{1,40}"
const YEAR = '(?:1[5-9]|20)\\d{2}[a-z]?'
/** Each `;`-part of a parenthetical: `Peirce, 1903`, `Eco y Sebeok 1983: 12`, `Lotman et al., 1996`. */
const CITATION_PART = new RegExp(`^\\s*(${SURNAME}(?:\\s+(?:y|e|&)\\s+${SURNAME})?)(?:\\s+et\\s+al\\.)?,?\\s+${YEAR}`, 'u')
const PARENS = /\(([^()]{1,300})\)/gu
/** `Peirce (1903)` in running text. */
const NARRATIVE = new RegExp(`(${SURNAME})(?:\\s+et\\s+al\\.)?\\s+\\((?:1[5-9]|20)\\d{2}[a-z]?[),:;]`, 'gu')

/**
 * Surnames cited author-date style in the student's own texts, most cited
 * first. A lightweight extraction for when the graph has no `persona` row.
 */
export function citedSurnames(texts: readonly string[], limit = 30): Array<{ label: string; count: number }> {
  const counts = new Map<string, { label: string; count: number }>()
  const add = (raw: string) => {
    for (const part of raw.split(/\s+(?:y|e|&)\s+/u)) {
      const label = part.trim()
      const key = fold(label)
      if (!key || NOT_SURNAMES.has(key)) continue
      const hit = counts.get(key)
      if (hit) hit.count++
      else counts.set(key, { label, count: 1 })
    }
  }
  for (const text of texts) {
    for (const g of text.matchAll(PARENS)) {
      for (const part of g[1]!.split(';')) {
        const m = CITATION_PART.exec(part)
        if (m) add(m[1]!)
      }
    }
    for (const m of text.matchAll(NARRATIVE)) add(m[1]!)
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, limit)
}

/**
 * The ecosistema's own page for an author (Semiosis keeps an "Autores" page
 * per author): a published documento whose name is the author's name, or a
 * short name (≤ 6 words, e.g. "Peirce, Charles S.") that contains the
 * author's surname as a word.
 */
export function authorPage(author: string, pages: readonly DocRef[]): DocRef | null {
  const full = fold(author)
  if (!full) return null
  const surname = full.split(' ').pop()!
  let loose: DocRef | null = null
  for (const page of pages) {
    const name = fold(page.name.split('/').pop() ?? page.name)
    if (name === full || name === `autores ${full}`) return page
    const words = name.split(' ')
    if (!loose && surname.length > 2 && words.length <= 6 && words.includes(surname)) loose = page
  }
  return loose
}

export interface Author {
  name: string
  docs: number
  page: DocRef | null
}

/** Graph authors first; a cited surname already covered by one is dropped. */
export function mergeAuthors(
  graph: readonly Labelled[],
  cited: ReadonlyArray<{ label: string; count: number }>,
  pages: readonly DocRef[],
  limit = 20,
): Author[] {
  const out: Author[] = graph.map((g) => ({ name: g.label, docs: g.docs, page: authorPage(g.label, pages) }))
  const covered = new Set(graph.map((g) => fold(g.label).split(' ').pop()))
  for (const c of cited) {
    const key = fold(c.label)
    if (covered.has(key)) continue
    covered.add(key)
    out.push({ name: c.label, docs: c.count, page: authorPage(c.label, pages) })
  }
  return out.slice(0, limit)
}

/** One testimonio in the teacher report: the gate's output, or a status line. */
export type ReportTestimonio =
  | { id: number; createdAt: string; state: 'visible'; title: string; text: string }
  | { id: number; createdAt: string; state: 'held' | 'rejected' | 'pending' }

export interface ActivityReport {
  student: { id: number; name: string }
  summary: { documents: number; published: number; topics: number; conversations: number }
  /** 🔴 `documento` only; a draft's `name` is null. */
  uploads: Array<{ id: number; name: string | null; createdAt: string; status: string; kind: string }>
  topics: string[]
  /** The ecosistema's most-documented topics this student has not touched. */
  gaps: string[]
  readings: DocRef[]
  /** Only when `studentTestimonios` is on; absent otherwise. */
  testimonios?: ReportTestimonio[]
}

const CLEARED = new Set(['ready', 'approved'])

/**
 * 🔴 WHAT A TEACHER SEES OF A STUDENT'S TESTIMONIO. Cleared by the gate
 * (`ready` / `approved`) with text: the redacted text and the neutral title
 * (`testimonioTitle`, else `titleFor('testimonio')`). Anything else — held,
 * rejected, pending, an unknown status, a cleared row with no text — is a
 * status line with no text and no title. Fails closed on the status, even
 * though `testimoniosOf` already nulls the text in SQL.
 */
export function reportTestimonios(rows: readonly TestimonioRow[]): ReportTestimonio[] {
  return rows.map((r) => {
    const text = typeof r.redactedText === 'string' ? r.redactedText.trim() : ''
    if (CLEARED.has(r.status) && text !== '') {
      const own = typeof r.title === 'string' ? r.title.trim() : ''
      return { id: r.id, createdAt: r.createdAt, state: 'visible', title: own || titleFor('testimonio'), text }
    }
    const state = r.status === 'held' || r.status === 'rejected' ? r.status : 'pending'
    return { id: r.id, createdAt: r.createdAt, state }
  })
}

export function buildReport(input: {
  student: StudentRow
  docs: readonly OwnDoc[]
  topics: readonly Labelled[]
  /** Conversations in this ecosistema. 🔴 A count, never titles (owner ruling Q23). */
  sessionCount: number
  corpusTop: readonly Labelled[]
  readings: readonly DocRef[]
  /** `studentTestimonios` on: the rows; off: null / absent, and no key in the report. */
  testimonios?: readonly TestimonioRow[] | null
}): ActivityReport {
  const mine = new Set(input.topics.map((t) => t.id))
  // 🔴 Documentos only: a testimonio's or a conversation's `name` never went
  // through the gate. A draft is the student's own: it shows as a draft, unnamed.
  const docs = input.docs.filter((d) => d.kind === 'documento')
  const report: ActivityReport = {
    student: { id: input.student.id, name: input.student.name },
    summary: {
      documents: docs.length,
      published: docs.filter((d) => d.status === 'published').length,
      topics: input.topics.length,
      conversations: input.sessionCount,
    },
    // 🔴 The gated title (R4-03): the teacher is not the uploader.
    uploads: docs.slice(0, 30).map(({ title, ...d }) => ({ ...d, name: d.status === 'published' ? title : null })),
    topics: input.topics.slice(0, 15).map((t) => t.label),
    gaps: input.corpusTop.filter((t) => !mine.has(t.id)).slice(0, 6).map((t) => t.label),
    readings: [...input.readings],
  }
  if (input.testimonios) report.testimonios = reportTestimonios(input.testimonios)
  return report
}
