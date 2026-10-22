/**
 * The recovery sweeps for the states nothing else moved (audit 2026-10-17).
 *
 * ⚠ THE FAKE DATABASE HONOURS THE `where`, as in `embeddingJanitor.test.ts`:
 * a predicate is only tested if the fake can say no to it. The ai-service side
 * is faked at `fetch`, so the real ai-client, the real `enqueueIngestForDoc`
 * and the real corpus naming run. The corpus-graph scheduler is mocked: it is a
 * separate pipeline that arms a `setImmediate`, and this file only checks that
 * the drive calls it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))
import type { Payload } from 'payload'

const scheduleGraphExtraction = vi.fn()
vi.mock('@/lib/graph/schedule', () => ({
  scheduleGraphExtraction: (...a: unknown[]) => scheduleGraphExtraction(...a),
}))

import { planIngestRetry } from '@/collections/Documents'
import { _resetAIClientsForTests } from './aiClient'
import {
  EXTRACTION_STALLED_CODE,
  GATE_STALLED_CODE,
  MESSAGE_STALLED_CODE,
  NO_TENANT_CODE,
  driveTranscribedDocuments,
  messageJobStatusReader,
  runIngestRecoveryPass,
  sweepLostGateRuns,
  sweepStalledExtracting,
  sweepStalledMessages,
  sweepUnavailableGateRuns,
} from './ingestRecovery'

const NOW = new Date('2026-10-17T12:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString()

type Row = Record<string, unknown>
type Clause = Record<string, Record<string, unknown>>

function matchesClause(row: Row, clause: Clause): boolean {
  return Object.entries(clause).every(([field, op]) => {
    const value = row[field]
    if ('equals' in op) return String(value ?? '') === String(op.equals)
    if ('like' in op) return String(value ?? '').toLowerCase().includes(String(op.like).toLowerCase())
    if ('in' in op) return (op.in as unknown[]).map(String).includes(String(value ?? ''))
    // NULL-safe, like `documentColumns.ts`: an unset column is "not in".
    if ('not_in' in op) return value == null || !(op.not_in as unknown[]).map(String).includes(String(value))
    if ('exists' in op) return (value != null) === Boolean(op.exists)
    if ('less_than' in op) {
      const t = new Date(String(value)).getTime()
      return Number.isFinite(t) && t < new Date(String(op.less_than)).getTime()
    }
    throw new Error(`fake db: unsupported operator ${JSON.stringify(op)} on ${field}`)
  })
}
const matches = (row: Row, where: unknown): boolean =>
  (((where as { and?: Clause[] })?.and ?? []) as Clause[]).every((c) => matchesClause(row, c))

/** Collections keyed by slug. `update` takes a `where` OR an `id`, like Payload. */
function fakeDb(collections: Record<string, Row[]>) {
  const store: Record<string, Row[]> = {}
  for (const [k, rows] of Object.entries(collections)) store[k] = rows.map((r) => ({ ...r }))
  const rowsOf = (c: unknown) => (store[String(c)] ??= [])

  const find = vi.fn(async (args: Record<string, unknown>) => ({
    docs: rowsOf(args.collection)
      .filter((r) => matches(r, args.where))
      .sort((a, b) => Date.parse(String(a.updatedAt)) - Date.parse(String(b.updatedAt)))
      .slice(0, Number(args.limit ?? 500))
      .map((r) => ({ ...r })),
  }))
  const update = vi.fn(async (args: Record<string, unknown>) => {
    const hits =
      args.id !== undefined
        ? rowsOf(args.collection).filter((r) => r.id === args.id)
        : rowsOf(args.collection).filter((r) => matches(r, args.where))
    for (const r of hits) Object.assign(r, args.data as Row, { updatedAt: NOW.toISOString() })
    return args.id !== undefined ? { ...hits[0] } : { docs: hits.map((r) => ({ ...r })) }
  })
  const findByID = vi.fn(async (args: Record<string, unknown>) => {
    const hit = rowsOf(args.collection).find((r) => r.id === args.id)
    if (!hit) throw Object.assign(new Error('Not Found'), { status: 404 })
    return { ...hit }
  })
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    store,
    update,
    payload: { find, update, findByID, logger } as unknown as Pick<
      Payload,
      'find' | 'update' | 'findByID'
    > & { logger: Payload['logger'] },
    row: (c: string, id: number | string) => rowsOf(c).find((r) => r.id === id)!,
  }
}

/** ai-service at the fetch boundary. */
const fetchCalls: Array<{ url: string; method: string; body: unknown }> = []
let ingestStatusFor: (id: string) => Response
function stubAIService() {
  vi.stubEnv('AI_SERVICE_URL', 'http://ai.test')
  vi.stubEnv('AI_SERVICE_API_KEY', 'app-key')
  vi.stubEnv('CALLBACK_SECRET', 'c'.repeat(64))
  vi.stubEnv('PUBLIC_BACKEND_URL', 'https://backend.test')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      fetchCalls.push({ url: String(url), method, body: init.body ? JSON.parse(String(init.body)) : null })
      const u = new URL(String(url))
      if (method === 'POST' && u.pathname === '/v1/ingest') {
        return Response.json({ ingestId: 'ing_t', corpusId: 'c1', totalDocs: 1 })
      }
      const m = /^\/v1\/ingest\/(.+)$/.exec(u.pathname)
      if (method === 'GET' && m) return ingestStatusFor(decodeURIComponent(m[1]!))
      return new Response('not stubbed', { status: 599 })
    }),
  )
}

const jobStatus = (status: string) =>
  Response.json({ ingestId: 'x', totalDocs: 1, completedDocs: 1, failedDocs: 0, status })

beforeEach(() => {
  fetchCalls.length = 0
  scheduleGraphExtraction.mockClear()
  ingestStatusFor = () => jobStatus('processing')
  _resetAIClientsForTests()
  stubAIService()
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
  updatedAt: minutesAgo(5),
  ...over,
})

// ── 1. `transcribed` → the gate and the enqueue ─────────────────────────────

describe('driveTranscribedDocuments', () => {
  it('🔴 enqueues the transcript into the UPLOADER’S PRIVATE DRAFT corpus and ends at embedding', async () => {
    const db = fakeDb({ documents: [transcribedRow()] })

    const result = await driveTranscribedDocuments(db.payload, { now: NOW, deadlineMs: 60_000 })

    expect(result).toEqual({ examined: 1, driven: 1, failed: 0 })
    const ingest = fetchCalls.find((c) => c.method === 'POST')!
    expect(ingest.url).toBe('http://ai.test/v1/ingest')
    const body = ingest.body as { corpus: string; documents: Array<{ id: string; text: string }> }
    expect(body.corpus).toBe('eco-10-draft-3')
    expect(body.documents[0]).toMatchObject({ id: '42', text: 'La junta empezó a las diez' })
    expect(db.row('documents', 42)).toMatchObject({ ingestStatus: 'embedding', ingestId: 'ing_t' })
    // The audio path's corpus-graph trigger moved here with the enqueue.
    expect(scheduleGraphExtraction).toHaveBeenCalledOnce()
  })

  it('derives the tenant from the ROW', async () => {
    const db = fakeDb({ documents: [transcribedRow({ organization: 77, uploadedBy: 9 })] })
    await driveTranscribedDocuments(db.payload, { now: NOW, deadlineMs: 60_000 })
    expect((fetchCalls[0]!.body as { corpus: string }).corpus).toBe('eco-77-draft-9')
  })

  it('leaves a row younger than the threshold, a lost gate run, and a published row alone', async () => {
    const db = fakeDb({
      documents: [
        transcribedRow({ id: 1, updatedAt: minutesAgo(0.5) }),
        // A gate that is running or was lost: re-driving would bill it in a loop.
        transcribedRow({ id: 2, anonymisationStatus: 'pending' }),
        transcribedRow({ id: 3, publicationStatus: 'published' }),
        transcribedRow({ id: 4, ingestId: 'ing_old' }),
      ],
    })
    const result = await driveTranscribedDocuments(db.payload, { now: NOW, deadlineMs: 60_000 })
    expect(result.examined).toBe(0)
    expect(fetchCalls).toHaveLength(0)
  })

  it('fails a row with no uploader rather than guessing a corpus — and the retry accepts it', async () => {
    const db = fakeDb({ documents: [transcribedRow({ uploadedBy: null })] })
    const result = await driveTranscribedDocuments(db.payload, { now: NOW, deadlineMs: 60_000 })
    expect(result).toEqual({ examined: 1, driven: 0, failed: 1 })
    expect(fetchCalls).toHaveLength(0)
    const row = db.row('documents', 42)
    expect(row.ingestStatus).toBe('failed')
    expect(String(row.ingestError)).toMatch(new RegExp(`^${NO_TENANT_CODE}:`))
    expect(planIngestRetry(row as never)).not.toBeNull()
  })

  it('🔴 runs the anonymisation gate for a testimonio before anything reaches the ingest', async () => {
    // The gate's detector is a model call at ai-service. Answer it with an
    // error: the gate must refuse, and nothing may be enqueued.
    const db = fakeDb({ documents: [transcribedRow({ contentKind: 'testimonio' })] })
    await driveTranscribedDocuments(db.payload, { now: NOW, deadlineMs: 60_000 })
    expect(fetchCalls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/ingest'))).toBe(false)
    const row = db.row('documents', 42)
    // 🔴 The model never answered: retryable, NOT a Revisión hold (2026-10-21).
    expect(row.anonymisationStatus).toBe('n/a')
    expect(row.ingestStatus).toBe('failed')
    expect(String(row.ingestError)).toMatch(/^anonymisation_unavailable: /)

    // …and the unavailable-gate sweep picks it up after its cooldown.
    const later = new Date(NOW.getTime() + 20 * 60_000)
    const redrive = await sweepUnavailableGateRuns(db.payload, { now: later, deadlineMs: 15 * 60_000 })
    expect(redrive).toEqual({ examined: 1, redriven: 1 })
    expect(db.row('documents', 42).ingestStatus).toBe('pending')
  })
})

// ── 2. `extracting` past its deadline ──────────────────────────────────────

describe('sweepStalledExtracting', () => {
  const extracting = (over: Row = {}): Row => ({
    id: 1,
    kind: 'pdf',
    contentKind: 'documento',
    publicationStatus: 'draft',
    anonymisationStatus: 'n/a',
    ingestStatus: 'extracting',
    ingestId: null,
    updatedAt: minutesAgo(90),
    ...over,
  })

  it('fails an old row out with a retryable reason', async () => {
    const db = fakeDb({ documents: [extracting()] })
    const result = await sweepStalledExtracting(db.payload, { now: NOW, deadlineMs: 60 * 60_000 })
    expect(result).toEqual({ examined: 1, stalled: 1 })
    const row = db.row('documents', 1)
    expect(row.ingestStatus).toBe('failed')
    expect(String(row.ingestError)).toMatch(new RegExp(`^${EXTRACTION_STALLED_CODE}:`))
    expect(planIngestRetry(row as never)).not.toBeNull()
  })

  it('leaves a young row, a published row and a reviewer-approved row alone', async () => {
    const db = fakeDb({
      documents: [
        extracting({ id: 1, updatedAt: minutesAgo(10) }),
        extracting({ id: 2, publicationStatus: 'published' }),
        // Not this sweep's: `planIngestRetry` accepts only approved rows that
        // have redactedText, and the stale-pending sweep owns those.
        extracting({ id: 3, anonymisationStatus: 'approved' }),
      ],
    })
    const result = await sweepStalledExtracting(db.payload, { now: NOW, deadlineMs: 60 * 60_000 })
    expect(result).toEqual({ examined: 0, stalled: 0 })
  })

  it('does not stamp a row that moved between the read and the write', async () => {
    const db = fakeDb({ documents: [extracting()] })
    const realUpdate = db.update.getMockImplementation()!
    db.update.mockImplementationOnce(async (args) => {
      Object.assign(db.row('documents', 1), { ingestStatus: 'embedding' })
      return realUpdate(args)
    })
    const result = await sweepStalledExtracting(db.payload, { now: NOW, deadlineMs: 60 * 60_000 })
    expect(result.stalled).toBe(0)
    expect(db.row('documents', 1).ingestStatus).toBe('embedding')
  })
})

// ── 3. A lost gate run ─────────────────────────────────────────────────────

describe('sweepLostGateRuns', () => {
  // The shape measured on the local DB: 8 testimonio rows since 2026-09-08.
  const lostGate = (over: Row = {}): Row => ({
    id: 1,
    kind: 'pdf',
    contentKind: 'testimonio',
    publicationStatus: 'draft',
    anonymisationStatus: 'pending',
    ingestStatus: 'pending',
    ingestId: null,
    extractedText: 'texto',
    updatedAt: '2026-09-08T14:16:45.762Z',
    ...over,
  })

  it('🔴 fails out the measured shape, and the retry clears the gate state', async () => {
    const db = fakeDb({ documents: [lostGate(), lostGate({ id: 2, ingestStatus: 'transcribed', kind: 'audio' })] })
    const result = await sweepLostGateRuns(db.payload, { now: NOW, deadlineMs: 60 * 60_000 })
    expect(result).toEqual({ examined: 2, stalled: 2 })
    const row = db.row('documents', 1)
    expect(row.ingestStatus).toBe('failed')
    expect(String(row.ingestError)).toMatch(new RegExp(`^${GATE_STALLED_CODE}:`))
    expect(planIngestRetry(row as never)).toMatchObject({ anonymisationStatus: 'n/a', ingestStatus: 'pending' })
  })

  it('🔴 resets the gate state from pending, so a seed re-run can claim the row again', async () => {
    const db = fakeDb({ documents: [lostGate()] })
    await sweepLostGateRuns(db.payload, { now: NOW, deadlineMs: 60 * 60_000 })
    const row = db.row('documents', 1)
    expect(row.anonymisationStatus).toBe('n/a')
    expect(String(row.anonymisationError)).toMatch(/^gate_unavailable: /)
  })

  it('leaves held, approved, settled-n/a, young and published rows alone', async () => {
    const db = fakeDb({
      documents: [
        lostGate({ id: 1, anonymisationStatus: 'held' }),
        lostGate({ id: 2, anonymisationStatus: 'approved' }),
        lostGate({ id: 3, anonymisationStatus: 'n/a' }),
        lostGate({ id: 4, updatedAt: minutesAgo(5) }),
        lostGate({ id: 5, publicationStatus: 'published' }),
        lostGate({ id: 6, kind: 'markdown' }),
      ],
    })
    const result = await sweepLostGateRuns(db.payload, { now: NOW, deadlineMs: 60 * 60_000 })
    expect(result).toEqual({ examined: 0, stalled: 0 })
  })
})

// ── 5. A gate that could not RUN (model never answered) ──────────────────────

describe('sweepUnavailableGateRuns — 🔴 re-drives the gate, never touches a content hold', () => {
  const unavailable = (over: Row = {}): Row => ({
    id: 1,
    kind: 'pdf',
    contentKind: 'testimonio',
    publicationStatus: 'draft',
    anonymisationStatus: 'n/a',
    anonymisationError: 'gate_unavailable: content: La revisión automática no pudo terminar (transporte).',
    ingestStatus: 'failed',
    ingestError: 'anonymisation_unavailable: content: La revisión automática no pudo terminar (transporte).',
    ingestId: null,
    extractedText: 'texto',
    updatedAt: minutesAgo(30),
    ...over,
  })

  it('🔴 resets the row to `pending` through the HOOK (no __skipDocsExtract), so the gate runs again', async () => {
    const db = fakeDb({ documents: [unavailable()] })
    const result = await sweepUnavailableGateRuns(db.payload, { now: NOW, deadlineMs: 15 * 60_000 })
    expect(result).toEqual({ examined: 1, redriven: 1 })
    expect(db.row('documents', 1)).toMatchObject({ ingestStatus: 'pending', ingestError: null })
    const call = db.update.mock.calls[0]![0] as { context?: unknown }
    expect(call.context).toBeUndefined()
  })

  it('leaves content holds, other failures, young and published rows alone', async () => {
    const db = fakeDb({
      documents: [
        unavailable({
          id: 1,
          anonymisationStatus: 'held',
          ingestError: 'anonymisation_held: verify: encontró 2 datos',
        }),
        unavailable({ id: 2, ingestError: 'extraction_failed: boom' }),
        unavailable({ id: 3, updatedAt: minutesAgo(5) }),
        unavailable({ id: 4, publicationStatus: 'published' }),
        unavailable({ id: 5, anonymisationStatus: 'rejected' }),
      ],
    })
    const result = await sweepUnavailableGateRuns(db.payload, { now: NOW, deadlineMs: 15 * 60_000 })
    expect(result).toEqual({ examined: 0, redriven: 0 })
  })
})

// ── 4. Chat turns at `embedding` ───────────────────────────────────────────

describe('sweepStalledMessages', () => {
  const turn = (over: Row = {}): Row => ({
    id: 7,
    session: 5,
    corpusStatus: 'embedding',
    corpusIngestId: 'ing_m',
    updatedAt: minutesAgo(60),
    ...over,
  })
  const collections = (msgs: Row[]) => ({
    messages: msgs,
    sessions: [{ id: 5, organization: 10 }],
  })
  const run = (db: ReturnType<typeof fakeDb>, over: Record<string, unknown> = {}) =>
    sweepStalledMessages(db.payload, {
      now: NOW,
      deadlineMs: 30 * 60_000,
      readIngestStatus: messageJobStatusReader(db.payload),
      ...over,
    })

  it('🔴 reads the job status on the turn’s ecosistema key and marks a completed job ingested', async () => {
    ingestStatusFor = () => jobStatus('completed')
    const db = fakeDb(collections([turn()]))
    const result = await run(db)
    expect(result).toEqual({ examined: 1, stalled: 0, recovered: 1 })
    expect(fetchCalls[0]!.url).toBe('http://ai.test/v1/ingest/ing_m')
    expect(db.row('messages', 7)).toMatchObject({ corpusStatus: 'ingested', corpusError: null })
    const write = db.update.mock.calls[0]![0] as { context?: Row }
    expect(write.context).toEqual({ __skipConversationIngest: true })
  })

  it('a failed job → failed, and the id is cleared like the callback does', async () => {
    ingestStatusFor = () => jobStatus('failed')
    const db = fakeDb(collections([turn()]))
    await run(db)
    expect(db.row('messages', 7)).toMatchObject({ corpusStatus: 'failed', corpusIngestId: null })
  })

  it('leaves a job still processing at embedding', async () => {
    const db = fakeDb(collections([turn()]))
    const result = await run(db)
    expect(result).toEqual({ examined: 1, stalled: 0, recovered: 0 })
    expect(db.row('messages', 7).corpusStatus).toBe('embedding')
  })

  it('an unreadable job (404) is stamped failed and KEEPS its id, so a late callback still lands', async () => {
    ingestStatusFor = () => Response.json({ error: 'NotFound' }, { status: 404 })
    const db = fakeDb(collections([turn()]))
    const result = await run(db)
    expect(result.stalled).toBe(1)
    const row = db.row('messages', 7)
    expect(row.corpusStatus).toBe('failed')
    expect(row.corpusIngestId).toBe('ing_m')
    expect(String(row.corpusError)).toMatch(new RegExp(`^${MESSAGE_STALLED_CODE}:`))
  })

  it('a turn claimed but never enqueued (no id) is stamped without a read', async () => {
    const db = fakeDb(collections([turn({ corpusIngestId: null })]))
    const result = await run(db)
    expect(result.stalled).toBe(1)
    expect(fetchCalls).toHaveLength(0)
  })

  it('caps the reads per pass and skips — does not stamp — the rest', async () => {
    const db = fakeDb(collections([turn({ id: 1 }), turn({ id: 2 }), turn({ id: 3 })]))
    await run(db, { maxStatusReads: 1 })
    expect(fetchCalls).toHaveLength(1)
    expect(db.row('messages', 3).corpusStatus).toBe('embedding')
  })

  it('leaves a young turn alone', async () => {
    const db = fakeDb(collections([turn({ updatedAt: minutesAgo(5) })]))
    expect((await run(db)).examined).toBe(0)
  })
})

// ── One pass ───────────────────────────────────────────────────────────────

describe('runIngestRecoveryPass', () => {
  it('runs every sweep, and one throwing does not skip the others', async () => {
    const db = fakeDb({
      documents: [transcribedRow({ updatedAt: minutesAgo(5) })],
      messages: [{ id: 7, session: 5, corpusStatus: 'embedding', corpusIngestId: null, updatedAt: minutesAgo(600) }],
      sessions: [{ id: 5, organization: 10 }],
    })
    // The extracting sweep's query blows up; the sweeps after it still run.
    const find = db.payload.find as unknown as ReturnType<typeof vi.fn>
    const realFind = find.getMockImplementation()!
    find.mockImplementation(async (args: Record<string, unknown>) => {
      // Only the pdf/docx stall sweep's query: it is the one that names "docx".
      const w = JSON.stringify(args.where)
      if (w.includes('"extracting"') && w.includes('"docx"')) throw new Error('db down')
      return realFind(args)
    })
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    try {
      const results = await runIngestRecoveryPass(db.payload)
      expect(results).toMatchObject({
        transcribed: { driven: 1 },
        gate: { examined: 0 },
        messages: { stalled: 1 },
      })
      expect(results).not.toHaveProperty('extracting')
      expect(db.payload.logger.error).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
