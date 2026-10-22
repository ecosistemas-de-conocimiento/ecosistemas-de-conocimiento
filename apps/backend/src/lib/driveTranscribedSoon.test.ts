/**
 * The callback's immediate drive, and its race with the `ingestRecovery` sweep.
 *
 * ⚠ THE FAKE DATABASE HONOURS THE `where`, and each `update` runs with no await
 * inside it, so it is atomic the way one conditional UPDATE is. The ai-service
 * side is faked at `fetch`: the real `enqueueIngestForDoc`, the real gate and
 * the real paced detector run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))
import type { Payload } from 'payload'

vi.mock('@/lib/graph/schedule', () => ({ scheduleGraphExtraction: vi.fn() }))

import { _resetAIClientsForTests } from './aiClient'
import { _drainTranscribedDrives, driveTranscribedSoon } from './driveTranscribedSoon'
import { planIngestRetry } from '@/collections/Documents'
import { GATE_UNAVAILABLE_CODE } from './anonymiseDocument'
import {
  DEFAULT_GATE_RETRY_LIMIT,
  EXTRACTION_STALLED_CODE,
  HELD_CODE,
  driveTranscribedDocument,
  driveTranscribedDocuments,
  recoverAbandonedClaims,
  sweepStalledExtracting,
  sweepStalledHolds,
  sweepUnavailableGateRuns,
} from './ingestRecovery'

type Row = Record<string, unknown>
type Clause = Record<string, Record<string, unknown>>

const NOW = new Date('2026-10-22T12:00:00Z')
/** Far enough ahead that the sweep's age threshold passes every row. */
const LATER = new Date(NOW.getTime() + 10 * 60_000)

function matchesClause(row: Row, clause: Clause): boolean {
  return Object.entries(clause).every(([field, op]) => {
    const value = row[field]
    if ('equals' in op) return String(value ?? '') === String(op.equals)
    if ('like' in op) return String(value ?? '').toLowerCase().includes(String(op.like).toLowerCase())
    if ('in' in op) return (op.in as unknown[]).map(String).includes(String(value ?? ''))
    if ('not_in' in op) return value == null || !(op.not_in as unknown[]).map(String).includes(String(value))
    if ('exists' in op) return (value != null) === Boolean(op.exists)
    if ('less_than' in op) return Date.parse(String(value)) < Date.parse(String(op.less_than))
    throw new Error(`fake db: unsupported operator ${JSON.stringify(op)} on ${field}`)
  })
}
const matches = (row: Row, where: unknown): boolean =>
  (((where as { and?: Clause[] })?.and ?? []) as Clause[]).every((c) => matchesClause(row, c))

function fakeDb(rows: Row[]) {
  const store = rows.map((r) => ({ ...r }))
  /**
   * true: this update throws. 'hang': it never settles (the process died).
   * A promise: the update waits for it, then writes (a run that hung).
   */
  let failWrite: (data: Row) => boolean | 'hang' | Promise<void> = () => false
  const update = vi.fn(async (args: Record<string, unknown>) => {
    const data = args.data as Row
    const fail = failWrite(data)
    if (fail === 'hang') return new Promise<never>(() => {})
    if (fail instanceof Promise) await fail
    else
    if (fail) throw new Error('db hiccup')
    const hits =
      args.id !== undefined
        ? store.filter((r) => r.id === args.id)
        : store.filter((r) => matches(r, args.where))
    for (const r of hits) Object.assign(r, data, { updatedAt: NOW.toISOString() })
    return args.id !== undefined ? { ...hits[0] } : { docs: hits.map((r) => ({ ...r })) }
  })
  const find = vi.fn(async (args: Record<string, unknown>) => ({
    docs: store
      .filter((r) => matches(r, args.where))
      .sort((a, b) => Date.parse(String(a.updatedAt)) - Date.parse(String(b.updatedAt)))
      .slice(0, Number(args.limit ?? 500))
      .map((r) => ({ ...r })),
  }))
  const findByID = vi.fn(async (args: Record<string, unknown>) => {
    const hit = store.find((r) => r.id === args.id)
    if (!hit) throw Object.assign(new Error('Not Found'), { status: 404 })
    return { ...hit }
  })
  return {
    payload: { find, update, findByID, logger: { warn: vi.fn() } } as unknown as Pick<
      Payload,
      'find' | 'update' | 'findByID'
    >,
    row: (id: number) => store.find((r) => r.id === id)!,
    failWrites: (f: (data: Row) => boolean | 'hang' | Promise<void>) => {
      failWrite = f
    },
  }
}

const fetchCalls: Array<{ path: string; at: number }> = []
let generateInFlight = 0
let maxGenerateInFlight = 0
/** How long a fake detector call takes. */
let generateMs = 5

beforeEach(() => {
  fetchCalls.length = 0
  generateInFlight = 0
  maxGenerateInFlight = 0
  generateMs = 5
  _resetAIClientsForTests()
  vi.stubEnv('AI_SERVICE_URL', 'http://ai.test')
  vi.stubEnv('AI_SERVICE_API_KEY', 'app-key')
  vi.stubEnv('CALLBACK_SECRET', 'c'.repeat(64))
  vi.stubEnv('PUBLIC_BACKEND_URL', 'https://backend.test')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = new URL(String(url)).pathname
      fetchCalls.push({ path, at: Date.now() })
      if ((init.method ?? 'GET') === 'POST' && path === '/v1/ingest') {
        return Response.json({ ingestId: 'ing_t', corpusId: 'c1', totalDocs: 1 })
      }
      if (path.startsWith('/v1/generate')) {
        generateInFlight += 1
        maxGenerateInFlight = Math.max(maxGenerateInFlight, generateInFlight)
        await new Promise((r) => setTimeout(r, generateMs))
        generateInFlight -= 1
        // Not retryable: one detector call per document, then the gate gives up.
        return Response.json({ error: { code: 'bad_request', message: 'no' } }, { status: 400 })
      }
      return new Response('not stubbed', { status: 599 })
    }),
  )
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  _resetAIClientsForTests()
})

const transcribedRow = (over: Row = {}): Row => ({
  id: 42,
  kind: 'audio',
  contentKind: 'documento',
  name: 'Junta de agosto',
  organization: 10,
  uploadedBy: 3,
  publicationStatus: 'draft',
  anonymisationStatus: 'n/a',
  ingestStatus: 'transcribed',
  ingestId: null,
  extractedText: 'La junta empezó a las diez',
  // Just written by the callback: younger than the sweep's threshold.
  updatedAt: NOW.toISOString(),
  ...over,
})

const ingestPosts = () => fetchCalls.filter((c) => c.path === '/v1/ingest').length

describe('driveTranscribedSoon — the callback’s immediate drive', () => {
  it('🔴 drives a fresh transcript to `embedding` without waiting for the sweep', async () => {
    const db = fakeDb([transcribedRow()])
    driveTranscribedSoon(db.payload, 42)
    // Detached: nothing has happened when the call returns.
    expect(db.row(42).ingestStatus).toBe('transcribed')
    await new Promise((r) => setImmediate(r))
    await _drainTranscribedDrives()
    expect(db.row(42).ingestStatus).toBe('embedding')
    expect(ingestPosts()).toBe(1)
  })

  it('a failure before the claim (the re-read throws) leaves the row for the sweep', async () => {
    const db = fakeDb([transcribedRow()])
    db.payload.findByID = vi.fn(async () => {
      throw new Error('db down')
    }) as never
    driveTranscribedSoon(db.payload, 42)
    await new Promise((r) => setImmediate(r))
    await _drainTranscribedDrives()
    expect(db.row(42).ingestStatus).toBe('transcribed')
    expect(ingestPosts()).toBe(0)

    const swept = await driveTranscribedDocuments(db.payload, { now: LATER })
    expect(swept).toMatchObject({ driven: 1 })
    expect(ingestPosts()).toBe(1)
  })

  it('🔴 a failure after the claim hands the row back to `transcribed`, and the sweep drives it', async () => {
    const db = fakeDb([transcribedRow()])
    // `enqueueIngestForDoc`'s `embedding` write throws, once.
    let failed = false
    db.failWrites((data) => {
      if (data.ingestStatus === 'embedding' && !failed) return (failed = true)
      return false
    })
    driveTranscribedSoon(db.payload, 42)
    await new Promise((r) => setImmediate(r))
    await _drainTranscribedDrives()
    expect(db.row(42).ingestStatus).toBe('transcribed')
    expect(ingestPosts()).toBe(0)

    const swept = await driveTranscribedDocuments(db.payload, { now: LATER })
    expect(swept).toMatchObject({ driven: 1 })
    expect(db.row(42).ingestStatus).toBe('embedding')
    expect(ingestPosts()).toBe(1)
  })
})

describe('🔴 the claim: two runners, one drive', () => {
  it('the callback’s run and a sweep on the same row, at once: one ingest', async () => {
    const db = fakeDb([transcribedRow({ updatedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() })])
    driveTranscribedSoon(db.payload, 42)
    const [swept] = await Promise.all([
      driveTranscribedDocuments(db.payload, { now: NOW }),
      new Promise((r) => setImmediate(r)).then(() => _drainTranscribedDrives()),
    ])
    expect(swept.examined).toBe(1)
    expect(ingestPosts()).toBe(1)
    expect(db.row(42).ingestStatus).toBe('embedding')
  })

  it('two runners holding the SAME snapshot, in parallel: exactly one is driven', async () => {
    const db = fakeDb([transcribedRow()])
    const snapshot = { ...db.row(42) }
    const outcomes = await Promise.all([
      driveTranscribedDocument(db.payload, snapshot),
      driveTranscribedDocument(db.payload, snapshot),
    ])
    expect(outcomes.sort()).toEqual(['driven', 'skipped'])
    expect(ingestPosts()).toBe(1)
  })

  it('a stale snapshot arriving AFTER the first run finished is a no-op', async () => {
    // The shape the gate's own claim did not cover: it accepts `ready`, so a
    // second runner reading before the first started would gate and enqueue
    // again once the first had left `pending`.
    const db = fakeDb([transcribedRow()])
    const stale = { ...db.row(42) }
    expect(await driveTranscribedDocument(db.payload, stale)).toBe('driven')
    expect(await driveTranscribedDocument(db.payload, stale)).toBe('skipped')
    expect(ingestPosts()).toBe(1)
  })
})

describe('🔴 the hand-back after a throw touches only an unsent, ungated claim', () => {
  it('🔴 a row whose drive throws EVERY time is failed out, retryable, on the 3rd try', async () => {
    const db = fakeDb([transcribedRow()])
    db.failWrites((data) => data.ingestStatus === 'embedding')
    const statuses: unknown[] = []
    for (let i = 0; i < 5; i++) {
      await driveTranscribedDocument(db.payload, { ...db.row(42) })
      statuses.push(db.row(42).ingestStatus)
    }
    expect(statuses).toEqual(['transcribed', 'transcribed', 'failed', 'failed', 'failed'])
    expect(String(db.row(42).ingestError)).toMatch(new RegExp(`^${EXTRACTION_STALLED_CODE}:`))
    expect(planIngestRetry(db.row(42) as never)).not.toBeNull()
    expect(ingestPosts()).toBe(0)
  })

  it('a stale snapshot cannot reset the count: the hand-back re-asserts the `ingestError` it read', async () => {
    const db = fakeDb([transcribedRow({ ingestError: 'extracting_recovered: 1/3' })])
    db.failWrites((data) => {
      if (data.ingestStatus !== 'embedding') return false
      // Someone else counted a try while this run was in the gate.
      db.row(42).ingestError = 'extracting_recovered: 2/3'
      return true
    })
    await driveTranscribedDocument(db.payload, { ...db.row(42) })
    expect(db.row(42)).toMatchObject({ ingestStatus: 'extracting', ingestError: 'extracting_recovered: 2/3' })
  })

  it('a row already at `embedding` (the ingest may be at ai-service) is left there', async () => {
    const db = fakeDb([transcribedRow()])
    // The send succeeded; storing its id throws, and so does the `failed`
    // write in the catch, so the error leaves `enqueueIngestForDoc`.
    db.failWrites((data) => typeof data.ingestId === 'string' || data.ingestStatus === 'failed')
    expect(await driveTranscribedDocument(db.payload, { ...db.row(42) })).toBe('skipped')
    expect(ingestPosts()).toBe(1)
    expect(db.row(42).ingestStatus).toBe('embedding')

    // So no sweep can send it a second time.
    db.failWrites(() => false)
    expect(await driveTranscribedDocuments(db.payload, { now: LATER })).toMatchObject({ examined: 0 })
    expect(ingestPosts()).toBe(1)
  })

  it('a row the gate HELD (its `failed` write lost) is left at `extracting` + `held`', async () => {
    const db = fakeDb([transcribedRow({ contentKind: 'testimonio' })])
    // The gate's verdict lands, then the status write after it throws.
    db.failWrites((data) => {
      if (data.ingestStatus !== 'failed') return false
      db.row(42).anonymisationStatus = 'held'
      return true
    })
    expect(await driveTranscribedDocument(db.payload, { ...db.row(42) })).toBe('skipped')
    expect(db.row(42)).toMatchObject({ ingestStatus: 'extracting', anonymisationStatus: 'held' })
    expect(ingestPosts()).toBe(0)
  })
})

describe('🔴 a burst of callbacks keeps the detector pacing', () => {
  it('N simultaneous hand-offs: one document at a time, call starts ≥ ANONYMISE_DETECT_MIN_GAP_MS apart', async () => {
    const GAP = 60
    vi.stubEnv('ANONYMISE_DETECT_MIN_GAP_MS', String(GAP))
    // Longer than the gap, so two documents gated in parallel WOULD overlap.
    generateMs = 2 * GAP
    const N = 4
    const db = fakeDb(
      Array.from({ length: N }, (_, i) =>
        transcribedRow({ id: i + 1, contentKind: 'testimonio', extractedText: `Testimonio ${i + 1}` }),
      ),
    )
    for (let i = 1; i <= N; i++) driveTranscribedSoon(db.payload, i)
    await new Promise((r) => setImmediate(r))
    await _drainTranscribedDrives()

    const starts = fetchCalls.filter((c) => c.path.startsWith('/v1/generate')).map((c) => c.at)
    expect(starts.length).toBeGreaterThanOrEqual(N)
    for (let i = 1; i < starts.length; i++) {
      // setTimeout may fire a millisecond early on some hosts.
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(GAP - 2)
    }
    // Serialized: never two documents' detector calls in flight at once.
    expect(maxGenerateInFlight).toBe(1)
    // The gate could not run, so nothing reached the corpus; each row is
    // retryable through the unavailable-gate sweep.
    expect(ingestPosts()).toBe(0)
    for (let i = 1; i <= N; i++) {
      expect(db.row(i).ingestStatus).toBe('failed')
      expect(String(db.row(i).ingestError)).toMatch(/^anonymisation_unavailable: /)
    }
  })
})

// ── Abandoned claims and lost holds (the sweep's side) ─────────────────────

const minutesAfter = (n: number) => new Date(NOW.getTime() + n * 60_000)
const minutesBefore = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString()

/** A row a drive claimed `minutes` ago and nobody is running any more. */
const abandoned = (over: Row = {}): Row =>
  transcribedRow({ ingestStatus: 'extracting', updatedAt: minutesBefore(15), ...over })

describe('🔴 recoverAbandonedClaims — a claim with no live run goes back to `transcribed`', () => {
  it('a claimed-then-abandoned row is recovered, then driven once', async () => {
    const db = fakeDb([transcribedRow()])
    // The process dies inside the gate: the claim is written, nothing after it.
    let died = false
    db.failWrites((data) => (data.anonymisationStatus === 'n/a' ? ((died = true), 'hang') : false))
    void driveTranscribedDocument(db.payload, { ...db.row(42) })
    await vi.waitFor(() => expect(died).toBe(true))
    expect(db.row(42).ingestStatus).toBe('extracting')
    db.failWrites(() => false)

    // Young: a live run could still own it.
    expect(await recoverAbandonedClaims(db.payload, { now: minutesAfter(5) })).toMatchObject({ recovered: 0 })

    const res = await recoverAbandonedClaims(db.payload, { now: minutesAfter(11) })
    expect(res).toEqual({ examined: 1, recovered: 1, failed: 0 })
    expect(db.row(42)).toMatchObject({ ingestStatus: 'transcribed', ingestError: 'extracting_recovered: 1/3' })

    expect(await driveTranscribedDocuments(db.payload, { now: minutesAfter(20) })).toMatchObject({ driven: 1 })
    expect(db.row(42)).toMatchObject({ ingestStatus: 'embedding', ingestError: null })
    expect(ingestPosts()).toBe(1)
  })

  it('🔴 a hung run that wakes up after the hand-back sends nothing: its `embedding` write is a no-op', async () => {
    const db = fakeDb([transcribedRow()])
    let wake!: () => void
    const asleep = new Promise<void>((r) => (wake = r))
    let hung = false
    db.failWrites((data) => (data.anonymisationStatus === 'n/a' ? ((hung = true), asleep) : false))
    const run = driveTranscribedDocument(db.payload, { ...db.row(42) })
    await vi.waitFor(() => expect(hung).toBe(true))
    db.failWrites(() => false)

    expect(await recoverAbandonedClaims(db.payload, { now: minutesAfter(11) })).toMatchObject({ recovered: 1 })
    wake()
    await run
    expect(ingestPosts()).toBe(0)
    expect(db.row(42)).toMatchObject({ ingestStatus: 'transcribed', ingestError: 'extracting_recovered: 1/3' })

    // The next drive owns it and sends it once.
    expect(await driveTranscribedDocument(db.payload, { ...db.row(42) })).toBe('driven')
    expect(ingestPosts()).toBe(1)
  })

  it('leaves alone: a young claim, a sent row, a pdf, a held row', async () => {
    const db = fakeDb([
      abandoned({ id: 1, updatedAt: minutesBefore(5) }),
      abandoned({ id: 2, ingestId: 'ing_x' }),
      abandoned({ id: 3, kind: 'pdf' }),
      abandoned({ id: 4, anonymisationStatus: 'held' }),
    ])
    expect(await recoverAbandonedClaims(db.payload, { now: NOW })).toEqual({ examined: 0, recovered: 0, failed: 0 })
  })

  it('🔴 a gate run that never finished: back after 60 min, its token voided in the SAME write', async () => {
    const token = 'anonymisation_running: tok-1'
    const db = fakeDb([
      abandoned({ id: 1, anonymisationStatus: 'pending', anonymisationError: token, updatedAt: minutesBefore(61) }),
      abandoned({ id: 2, anonymisationStatus: 'pending', anonymisationError: token, updatedAt: minutesBefore(30) }),
    ])
    const res = await recoverAbandonedClaims(db.payload, { now: NOW })
    expect(res).toMatchObject({ recovered: 1 })
    expect(db.row(1)).toMatchObject({
      ingestStatus: 'transcribed',
      anonymisationStatus: 'n/a',
      anonymisationError: `${GATE_UNAVAILABLE_CODE}: stalled: the gate run did not finish`,
    })
    expect(db.row(2).ingestStatus).toBe('extracting')

    // The slow run wakes up and makes its final write, guarded on its token: no-op.
    const late = (await db.payload.update({
      collection: 'documents',
      where: {
        and: [
          { id: { equals: 1 } },
          { anonymisationStatus: { equals: 'pending' } },
          { anonymisationError: { equals: token } },
        ],
      },
      data: { anonymisationStatus: 'ready' },
    } as never)) as unknown as { docs: unknown[] }
    expect(late.docs).toHaveLength(0)
    expect(db.row(1).anonymisationStatus).toBe('n/a')
  })

  it('🔴 at the cap the row is failed out, retryable, and the pdf/docx stall sweep never fights it', async () => {
    const db = fakeDb([
      abandoned({ id: 1, ingestError: 'extracting_recovered: 3/3', updatedAt: minutesBefore(90) }),
      abandoned({ id: 2, ingestError: 'extracting_recovered: 1/3', updatedAt: minutesBefore(90) }),
    ])
    // The 60-min stall sweep runs first and still leaves audio claims alone.
    expect(await sweepStalledExtracting(db.payload, { now: NOW, deadlineMs: 60 * 60_000 })).toMatchObject({
      examined: 0,
    })
    const res = await recoverAbandonedClaims(db.payload, { now: NOW })
    expect(res).toEqual({ examined: 2, recovered: 1, failed: 1 })
    expect(db.row(1).ingestStatus).toBe('failed')
    expect(String(db.row(1).ingestError)).toMatch(new RegExp(`^${EXTRACTION_STALLED_CODE}:`))
    expect(planIngestRetry(db.row(1) as never)).not.toBeNull()
    expect(db.row(2)).toMatchObject({ ingestStatus: 'transcribed', ingestError: 'extracting_recovered: 2/3' })
  })

  it('recovers at most the per-pass limit, oldest first', async () => {
    const db = fakeDb(
      Array.from({ length: DEFAULT_GATE_RETRY_LIMIT + 2 }, (_, i) =>
        abandoned({ id: i + 1, updatedAt: minutesBefore(60 - i) }),
      ),
    )
    const res = await recoverAbandonedClaims(db.payload, { now: NOW })
    expect(res.recovered).toBe(DEFAULT_GATE_RETRY_LIMIT)
  })

  it('two sweeps at once recover a row once, and count one attempt', async () => {
    const db = fakeDb([abandoned()])
    const [a, b] = await Promise.all([
      recoverAbandonedClaims(db.payload, { now: NOW }),
      recoverAbandonedClaims(db.payload, { now: NOW }),
    ])
    expect(a.recovered + b.recovered).toBe(1)
    expect(db.row(42).ingestError).toBe('extracting_recovered: 1/3')
  })
})

describe('🔴 sweepStalledHolds — a hold whose `failed` write was lost', () => {
  it('stamps it failed with the hold code, keeps it `held` for review, and never re-drives it', async () => {
    const db = fakeDb([
      abandoned({ id: 1, anonymisationStatus: 'held' }),
      abandoned({ id: 2, anonymisationStatus: 'held', updatedAt: minutesBefore(5) }),
      abandoned({ id: 3, kind: 'pdf', anonymisationStatus: 'held' }),
    ])
    const res = await sweepStalledHolds(db.payload, { now: NOW })
    expect(res).toEqual({ examined: 2, stalled: 2 })
    expect(db.row(1)).toMatchObject({ ingestStatus: 'failed', anonymisationStatus: 'held' })
    expect(String(db.row(1).ingestError)).toMatch(new RegExp(`^${HELD_CODE}:`))
    expect(db.row(2).ingestStatus).toBe('extracting')

    // No automatic way back: neither the gate re-drive nor the claim recovery takes it.
    expect(await sweepUnavailableGateRuns(db.payload, { now: minutesAfter(60), deadlineMs: 0 })).toMatchObject({
      examined: 0,
    })
    expect(await recoverAbandonedClaims(db.payload, { now: minutesAfter(120) })).toMatchObject({ examined: 0 })
  })
})
