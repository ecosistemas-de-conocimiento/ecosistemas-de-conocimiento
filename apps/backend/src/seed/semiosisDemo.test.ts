/**
 * The Semiosis demo's fixture and its per-trabajo plan (`seed/semiosisDemo.ts`).
 * No database: the fixture's promises to the student view, and the re-run's
 * decisions, as pure checks.
 */

import { existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { planGraphRetry, planIngestRetry } from '../collections/Documents'
import { autoPublishBlocker } from '../lib/autoPublish'
import { gatedTextHash } from '../lib/gatedTextHash'
import { citedSurnames, fold } from '../lib/student/logic'
import { DEMO_USERS } from './demoUsers'
import { corpusVocabulary, foldWord, SEMIOTICA_CORPUS_DIR, spanishDictionary } from './fixtures/corpusVocabulary'
import { SEMIOSIS_STUDENTS, TEMAS, UNCITED_AUTHORS } from './fixtures/semiosisTrabajos'
import {
  planTrabajo,
  rerunWouldAct,
  retryAllowed,
  STALLED_DRAFT_MS,
  type TrabajoAction,
  type TrabajoPlanDeps,
  type TrabajoTally,
} from './semiosisDemo'

const all = SEMIOSIS_STUDENTS.flatMap((s) => s.trabajos.map((t) => ({ student: s, t })))
const words = (s: string) => s.split(/\s+/).filter(Boolean).length

describe('fixtures/semiosisTrabajos', () => {
  it('nine students, estudiante1..9, the first two being the existing demo accounts', () => {
    expect(SEMIOSIS_STUDENTS).toHaveLength(9)
    expect(SEMIOSIS_STUDENTS.map((s) => s.email)).toEqual(
      Array.from({ length: 9 }, (_, i) => `estudiante${i + 1}@ecosistemas.test`),
    )
    expect(SEMIOSIS_STUDENTS.map((s) => s.key)).toEqual(Array.from({ length: 9 }, (_, i) => `ESTUDIANTE${i + 1}`))
    for (const key of ['ESTUDIANTE1', 'ESTUDIANTE2']) {
      const old = DEMO_USERS.find((u) => u.key === key)!
      expect(SEMIOSIS_STUDENTS.find((s) => s.key === key)!.email).toBe(old.email)
    }
    expect(new Set(SEMIOSIS_STUDENTS.map((s) => s.displayName)).size).toBe(9)
  })

  it('2–3 trabajos each, 400–850 words, unique names per student', () => {
    for (const s of SEMIOSIS_STUDENTS) {
      expect(s.trabajos.length).toBeGreaterThanOrEqual(2)
      expect(s.trabajos.length).toBeLessThanOrEqual(3)
      expect(new Set(s.trabajos.map((t) => t.name)).size).toBe(s.trabajos.length)
    }
    for (const { t } of all) {
      expect(words(t.body), t.name).toBeGreaterThanOrEqual(400)
      expect(words(t.body), t.name).toBeLessThanOrEqual(850)
    }
    expect(all).toHaveLength(22)
  })

  it('every trabajo cites ≥2 authors that citedSurnames reads — exactly the declared ones', () => {
    for (const { t } of all) {
      const got = citedSurnames([t.body]).map((c) => fold(c.label)).sort()
      expect(got, t.name).toEqual([...t.cites].map(fold).sort())
      expect(t.cites.length).toBeGreaterThanOrEqual(2)
      expect(t.cites.length).toBeLessThanOrEqual(4)
    }
  })

  it('some corpus authors are cited by nobody ("Autores para leer")', () => {
    const cited = new Set(all.flatMap(({ t }) => t.cites.map(fold)))
    for (const a of UNCITED_AUTHORS) {
      expect(cited.has(fold(a))).toBe(false)
      for (const { t } of all) expect(t.body, `${t.name} names ${a}`).not.toMatch(new RegExp(`\\b${a}\\b`, 'u'))
    }
  })

  it('every declared tema is written about: its phrase is in the text', () => {
    for (const { t } of all) {
      expect(t.temas.length).toBeGreaterThanOrEqual(1)
      for (const tema of t.temas) expect(fold(t.body), `${t.name} / ${tema}`).toContain(fold(TEMAS[tema]))
    }
  })

  it('topics overlap: every student shares a tema with ≥2 others, and the overlap graph is connected', () => {
    const temasOf = SEMIOSIS_STUDENTS.map((s) => new Set(s.trabajos.flatMap((t) => t.temas)))
    const shares = (a: number, b: number) => [...temasOf[a]!].some((x) => temasOf[b]!.has(x))
    for (let i = 0; i < temasOf.length; i++) {
      const peers = temasOf.map((_, j) => j).filter((j) => j !== i && shares(i, j))
      expect(peers.length, SEMIOSIS_STUDENTS[i]!.email).toBeGreaterThanOrEqual(2)
    }
    const seen = new Set([0])
    const queue = [0]
    while (queue.length) {
      const i = queue.shift()!
      for (let j = 0; j < temasOf.length; j++) if (!seen.has(j) && shares(i, j)) (seen.add(j), queue.push(j))
    }
    expect(seen.size).toBe(9)
  })

  it('🔴 no capitalised roster name part in any text (the gate would redact it as a person)', () => {
    const parts = new Set(['Semiosis', 'Estudiante', 'Investigador', 'Dengue', 'Demo'])
    for (const s of SEMIOSIS_STUDENTS) for (const p of s.displayName.split(/\s+/)) parts.add(p)
    for (const { t } of all) {
      for (const p of parts) expect(t.body, `${t.name} contains "${p}"`).not.toMatch(new RegExp(`(?<![\\p{L}])${p}(?![\\p{L}])`, 'u'))
    }
  })

  it('1–2 suggestions and 1–2 conversations each', () => {
    for (const s of SEMIOSIS_STUDENTS) {
      expect(s.sugerencias.length).toBeGreaterThanOrEqual(1)
      expect(s.sugerencias.length).toBeLessThanOrEqual(2)
      expect(s.conversaciones.length).toBeGreaterThanOrEqual(1)
      expect(s.conversaciones.length).toBeLessThanOrEqual(2)
      for (const c of s.conversaciones) expect(c).not.toBe('New chat')
    }
    expect(new Set(SEMIOSIS_STUDENTS.flatMap((s) => s.sugerencias.map((x) => x.kind)))).toEqual(
      new Set(['contenido', 'arquitectura', 'interaccion']),
    )
  })
})

describe('planTrabajo — what a (re-)run does with one row', () => {
  const NOW = Date.parse('2026-10-28T12:00:00Z')
  const deps = (over: Partial<TrabajoPlanDeps> = {}): TrabajoPlanDeps => ({
    now: () => NOW,
    // Like the real one: refuses only `rejected`; a HELD row it would clear.
    planIngestRetry: (row) =>
      row.ingestStatus === 'failed' && row.anonymisationStatus !== 'rejected' ? { ingestStatus: 'pending' } : null,
    planGraphRetry: (row) =>
      (row.graphStatus === 'pending' || row.graphStatus === 'extracting') && row.updatedAt === recent
        ? { reason: 'in flight' }
        : null,
    autoPublishBlocker: (row) => (row.anonymisationStatus === 'ready' ? null : 'gate-not-cleared'),
    ...over,
  })
  const recent = new Date(NOW - 60_000).toISOString()
  const old = new Date(NOW - STALLED_DRAFT_MS - 1).toISOString()

  it('creates a missing trabajo', () => {
    expect(planTrabajo(null, deps())).toBe('create')
  })

  it('a hold or a rejection is Revisión’s, whatever else the row says', () => {
    expect(planTrabajo({ anonymisationStatus: 'held', ingestStatus: 'failed' }, deps())).toBe('held')
    expect(planTrabajo({ anonymisationStatus: 'rejected', publicationStatus: 'published' }, deps())).toBe('held')
  })

  it('published: done, or the graph when it is missing', () => {
    expect(planTrabajo({ publicationStatus: 'published', graphStatus: 'ready' }, deps())).toBe('done')
    expect(planTrabajo({ publicationStatus: 'published', graphStatus: 'skipped' }, deps())).toBe('done')
    expect(planTrabajo({ publicationStatus: 'published', graphStatus: 'failed' }, deps())).toBe('graph')
    expect(planTrabajo({ publicationStatus: 'published', graphStatus: 'pending', updatedAt: recent }, deps())).toBe('done')
  })

  it('publishing: wait for the callback', () => {
    expect(planTrabajo({ publicationStatus: 'publishing' }, deps())).toBe('wait')
  })

  it('a cleared, ingested draft is published through the auto-publish step', () => {
    expect(
      planTrabajo({ publicationStatus: 'draft', ingestStatus: 'ready', anonymisationStatus: 'ready' }, deps()),
    ).toBe('publish')
  })

  it('a technical ingest failure is retried; a stalled pending draft is re-saved; a fresh one waits', () => {
    expect(planTrabajo({ publicationStatus: 'draft', ingestStatus: 'failed', anonymisationStatus: 'n/a' }, deps())).toBe(
      'retry-ingest',
    )
    expect(planTrabajo({ publicationStatus: 'draft', ingestStatus: 'pending', updatedAt: old }, deps())).toBe('resave')
    expect(planTrabajo({ publicationStatus: 'draft', ingestStatus: 'extracting', updatedAt: recent }, deps())).toBe('wait')
    expect(
      planTrabajo({ publicationStatus: 'draft', ingestStatus: 'pending', updatedAt: old, ingestId: 'x' }, deps()),
    ).toBe('wait')
    expect(planTrabajo({ publicationStatus: 'draft', ingestStatus: 'embedding' }, deps())).toBe('wait')
  })

  it('🔴 a held row is never retried — with the REAL planIngestRetry, which would clear the hold', () => {
    const real: TrabajoPlanDeps = {
      planIngestRetry: (row) => planIngestRetry(row as never),
      planGraphRetry: (row) => planGraphRetry(row as never),
      autoPublishBlocker: (row) => autoPublishBlocker(row),
    }
    // A hold whose text changed since (`heldTextHash` of other words): the one
    // case `planIngestRetry` still accepts on a held row.
    const held = {
      kind: 'markdown', publicationStatus: 'draft', ingestStatus: 'failed', anonymisationStatus: 'held',
      extractedText: 'x', heldTextHash: gatedTextHash('y'),
    }
    // The precondition that makes the guard matter: retry WOULD act on it.
    expect(planIngestRetry(held as never)).not.toBeNull()
    expect(planTrabajo(held, real)).toBe('held')
    expect(planTrabajo({ ...held, anonymisationStatus: 'rejected' }, real)).toBe('held')
    // And a technical failure on an ungated-yet row is a retry.
    expect(planTrabajo({ ...held, anonymisationStatus: 'n/a' }, real)).toBe('retry-ingest')
  })
})

describe('the tally asks the same question as the plan', () => {
  const tally = (by: Partial<Record<TrabajoAction, number>>): TrabajoTally => ({
    total: 22,
    published: 0,
    graphReady: 0,
    byAction: { create: 0, resave: 0, 'retry-ingest': 0, publish: 0, graph: 0, wait: 0, held: 0, done: 0, ...by },
  })

  it('done and held (incl. a skipped graph, a failure that cannot be retried) never ask for a re-run', () => {
    expect(rerunWouldAct(tally({ done: 20, held: 2 }), true)).toBe(false)
  })

  it('in-flight or actionable rows do', () => {
    for (const a of ['create', 'resave', 'publish', 'graph', 'wait'] as const) {
      expect(rerunWouldAct(tally({ done: 21, [a]: 1 }), false), a).toBe(true)
    }
  })

  it('🔴 a failed ingest asks for a re-run only when retries are allowed (each re-runs the gate)', () => {
    expect(rerunWouldAct(tally({ done: 21, 'retry-ingest': 1 }), false)).toBe(false)
    expect(rerunWouldAct(tally({ done: 21, 'retry-ingest': 1 }), true)).toBe(true)
    expect(retryAllowed({})).toBe(false)
    expect(retryAllowed({ SEMIOSIS_DEMO_RETRY: '1' })).toBe(true)
  })
})

/**
 * 🔴 AUDIT OF e2eeb61, FINDING 1. Every name part joins org 8's roster, and the
 * gate redacts a roster part wherever it stands capitalised in a documento —
 * so no part may occur ANYWHERE in the Semiótica corpus, nor be a Spanish word.
 */
describe('🔴 the demo names collide with nothing', () => {
  const parts = [...new Set(SEMIOSIS_STUDENTS.flatMap((s) => s.displayName.split(/\s+/)))]

  it('27 distinct name parts, three per student', () => {
    expect(parts).toHaveLength(27)
    for (const s of SEMIOSIS_STUDENTS) expect(s.displayName.split(/\s+/)).toHaveLength(3)
  })

  it('no part is a Spanish dictionary word (/usr/share/dict/spanish)', (ctx) => {
    const dict = spanishDictionary()
    if (!dict) {
      console.warn('[semiosis names] /usr/share/dict/spanish absent — dictionary check SKIPPED')
      return ctx.skip()
    }
    expect(parts.filter((p) => dict.has(foldWord(p)))).toEqual([])
  })

  it('no part occurs in the local Semiótica corpus (whole word, accent- and case-blind)', async (ctx) => {
    if (!existsSync(SEMIOTICA_CORPUS_DIR)) {
      console.warn(`[semiosis names] ${SEMIOTICA_CORPUS_DIR} absent — corpus name check SKIPPED`)
      return ctx.skip()
    }
    const vocab = (await corpusVocabulary())!
    expect(vocab.words.size).toBeGreaterThan(100_000) // the PDFs were read, not just the .md
    // Sanity: the check sees the names the audit found.
    for (const known of ['Santiago', 'Joaquín', 'Diego', 'Echeverría', 'Tapia', 'Ibarra']) {
      expect(vocab.words.has(foldWord(known)), known).toBe(true)
    }
    expect(parts.filter((p) => vocab.words.has(foldWord(p)))).toEqual([])
  }, 300_000)
})
