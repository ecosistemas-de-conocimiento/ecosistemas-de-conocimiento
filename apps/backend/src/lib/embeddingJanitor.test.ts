/**
 * 🔴 THE SWEEP FOR THE STATE TWO FILES DISAGREE ABOUT.
 *
 * `collections/Documents.ts` says every non-terminal `ingestStatus` has
 * something that will move it, and names the ai-service callback as what moves
 * `embedding`. `lib/callbackConfig.ts` says *"Nothing polls `ingest.status`, so
 * `embedding` is a terminal state in practice."* The second one is right
 * whenever the callback round-trip is half-configured, the AI client is
 * unconfigured, or the process dies between the status write and the enqueue.
 *
 * These tests pin down what the janitor writes AND what it refuses to do:
 *   · it makes an invisible stall visible AND retryable — `ingestStatus:
 *     'failed'` is not decoration, it is the gate `planIngestRetry` checks;
 *   · it never re-enqueues. Re-driving a backlog on a timer would recreate the
 *     rate-limit burst that produces these rows;
 *   · it cannot stamp a document whose callback lands while the sweep is running;
 *   · and a full page of work does not starve a newer stall — the bug the
 *     publish sweep shipped with, and whose comment argued it had not.
 *
 * ⚠ THE FAKE DATABASE HONOURS THE `where`. That is the point of it: assertions
 * about a query's SHAPE cannot tell a condition that is enforced from one that
 * is merely present, and the starvation trap is exactly a question of WHERE a
 * condition is enforced.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))
import type { Payload } from 'payload'

// Documents.ts is imported for `planIngestRetry` alone — the rule that decides
// whether `POST /api/documents/:id/retry` accepts what this sweep writes.
// Mocked so an accidental ai-service call from that module graph would throw
// rather than reach the network.
vi.mock('@/lib/aiClient', () => ({
  getAppAIClient: () => {
    throw new Error('the embedding janitor must never reach ai-service')
  },
}))

import { planIngestRetry } from '@/collections/Documents'
import {
  DEFAULT_STUCK_MIN,
  EMBEDDING_JANITOR_ENABLED_VAR,
  EMBEDDING_JANITOR_INTERVAL_MIN_VAR,
  EMBEDDING_JANITOR_STUCK_MIN_VAR,
  DEFAULT_PENDING_STUCK_MIN,
  NEVER_STARTED_CODE,
  PENDING_SWEEP_KINDS,
  PENDING_JANITOR_STUCK_MIN_VAR,
  STALLED_EMBED_CODE,
  neverStartedReason,
  pendingStuckAfterMs,
  sweepStalledPending,
  embeddingJanitorEnabled,
  embeddingJanitorIntervalMs,
  embeddingStuckAfterMs,
  stalledEmbeddingReason,
  startEmbeddingJanitor,
  stopEmbeddingJanitor,
  sweepStalledEmbeddings,
} from './embeddingJanitor'

const NOW = new Date('2026-09-04T12:00:00Z')
const DEADLINE_MS = 30 * 60_000

/** Minutes before NOW, as the ISO string Payload stores. */
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString()

type Row = Record<string, unknown>
type Clause = Record<string, Record<string, unknown>>

/**
 * A `where` evaluator over plain objects, supporting exactly the operators this
 * module uses. Anything else THROWS rather than silently matching everything —
 * a fake that quietly ignores a condition would make the starvation test pass
 * against the very bug it exists to catch.
 */
function matchesClause(row: Row, clause: Clause): boolean {
  return Object.entries(clause).every(([field, op]) => {
    const value = row[field]
    if ('equals' in op) return String(value ?? '') === String(op.equals)
    if ('in' in op) return (op.in as unknown[]).map(String).includes(String(value ?? ''))
    // Payload compiles `exists: false` to `IS NULL`: an absent key or a null.
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

/**
 * A minimal Payload stand-in whose `find` and `update` both APPLY the `where`,
 * sort oldest-first, and honour `limit`. `update` also bumps `updatedAt`, like
 * the real thing — which is what makes the guarded write's deadline clause do
 * real work here.
 */
function fakeDb(rows: Row[], opts: { beforeUpdate?: (rows: Row[]) => void } = {}) {
  const store = rows.map((r) => ({ ...r }))

  const find = vi.fn(async (args: Record<string, unknown>) => {
    const hits = store
      .filter((r) => matches(r, args.where))
      .sort(
        (a, b) =>
          new Date(String(a.updatedAt)).getTime() - new Date(String(b.updatedAt)).getTime(),
      )
      .slice(0, Number(args.limit ?? 500))
    return { docs: hits.map((r) => ({ ...r })) }
  })

  const update = vi.fn(async (args: Record<string, unknown>) => {
    opts.beforeUpdate?.(store)
    const hits = store.filter((r) => matches(r, args.where))
    for (const r of hits) {
      Object.assign(r, args.data as Row, { updatedAt: NOW.toISOString() })
    }
    return { docs: hits.map((r) => ({ ...r })) }
  })

  return {
    store,
    find,
    update,
    payload: { find, update } as unknown as Pick<Payload, 'find' | 'update'>,
    row: (id: number | string) => store.find((r) => r.id === id),
    /** The flattened list of `where` clauses on the nth update call. */
    whereOf(n: number): Array<Record<string, unknown>> {
      const w = update.mock.calls[n]![0].where as { and?: Array<Record<string, unknown>> }
      return w?.and ?? []
    },
  }
}

afterEach(() => {
  delete process.env[EMBEDDING_JANITOR_ENABLED_VAR]
  delete process.env[EMBEDDING_JANITOR_INTERVAL_MIN_VAR]
  delete process.env[EMBEDDING_JANITOR_STUCK_MIN_VAR]
  delete process.env[PENDING_JANITOR_STUCK_MIN_VAR]
  stopEmbeddingJanitor()
})

describe('stalledEmbeddingReason — the two stalls are not the same story', () => {
  it('🔴 says nothing was sent when the enqueue never landed', () => {
    const reason = stalledEmbeddingReason({ ingestStatus: 'embedding' }, 30)
    expect(reason).toContain(STALLED_EMBED_CODE)
    expect(reason).toContain('No se envió nada')
    expect(reason).toContain('volver a intentarlo')
    expect(reason).toContain('30')
    // Shown verbatim under "Detalle", so: Spanish, and inside the field.
    expect(reason).toMatch(/servicio de IA/)
    expect(reason.length).toBeLessThanOrEqual(500)
    // An empty id is "never sent", not an id.
    expect(stalledEmbeddingReason({ ingestId: '' }, 30)).toContain('No se envió nada')
  })

  it('🔴 does NOT claim nothing happened when ai-service accepted the ingest', () => {
    // It may have finished, and the corpus has no per-document delete. Telling
    // the user "nothing was sent" here invites a duplicate embed.
    const reason = stalledEmbeddingReason({ ingestStatus: 'embedding', ingestId: 'ing-1' }, 30)
    expect(reason).not.toContain('No se envió nada')
    expect(reason).toContain('Puede haber terminado sin avisar')
    expect(reason).toContain('antes de repetir el envío')
    expect(reason).toMatch(/servicio de IA/)
    expect(reason.length).toBeLessThanOrEqual(500)
  })
})

describe('sweepStalledEmbeddings', () => {
  it('🔴 fails the row out with a Spanish reason, and writes NOTHING else', async () => {
    const db = fakeDb([{ id: 1, ingestStatus: 'embedding', updatedAt: minutesAgo(60) }])

    const result = await sweepStalledEmbeddings(db.payload, { now: NOW, deadlineMs: DEADLINE_MS })

    expect(result).toEqual({ examined: 1, stalled: 1, neverSent: 1, recovered: 0 })
    const data = db.update.mock.calls[0]![0].data as Record<string, unknown>
    // The restraint asserted: two fields, and neither of them touches the corpus
    // join-back key or any text on the row.
    expect(Object.keys(data).sort()).toEqual(['ingestError', 'ingestStatus'])
    expect(data.ingestStatus).toBe('failed')
    expect(String(data.ingestError)).toContain(STALLED_EMBED_CODE)
    expect(db.row(1)!.ingestStatus).toBe('failed')
  })

  it('🔴 leaves the row retryable — `planIngestRetry` accepts exactly what it wrote', async () => {
    // This is why the sweep changes the status at all. `planIngestRetry` opens
    // with `if (doc.ingestStatus !== 'failed') return null`, so a row stamped
    // with a message and left at `embedding` would show the user "vuelve a
    // intentarlo" next to a button the API answers 409 to.
    const db = fakeDb([
      { id: 1, kind: 'pdf', ingestStatus: 'embedding', extractedText: 'texto', updatedAt: minutesAgo(60) },
    ])
    await sweepStalledEmbeddings(db.payload, { now: NOW, deadlineMs: DEADLINE_MS })

    const stamped = db.row(1) as Record<string, string>
    const plan = planIngestRetry(stamped)
    expect(plan).not.toBeNull()
    expect(plan!.ingestStatus).toBe('pending')
    // The retry clears the message this sweep wrote, so a successful second
    // attempt does not keep showing why the first one was given up on.
    expect(plan!.ingestError).toBeNull()
  })

  it('🔴 never re-drives the ingest, and suppresses the extract hook that would', async () => {
    // The sweep takes only `find` and `update`: no ai-service client is
    // reachable from its signature. `__skipDocsExtract` closes the other door —
    // without it the status write re-fires the afterChange hook and the sweep
    // that must not re-enqueue would re-enqueue on every pass.
    const db = fakeDb([
      { id: 1, ingestStatus: 'embedding', ingestId: 'ing-9', updatedAt: minutesAgo(60) },
    ])
    await sweepStalledEmbeddings(db.payload, { now: NOW, deadlineMs: DEADLINE_MS })

    expect(db.update).toHaveBeenCalledTimes(1)
    expect(db.update.mock.calls[0]![0].context).toEqual({ __skipDocsExtract: true })
    expect(db.row(1)!.ingestId).toBe('ing-9')
  })

  it('🔴 a row that is NOT stranded is left completely alone', async () => {
    // Paired with the first test on purpose. Everything here is old enough to
    // be swept and is spared for some OTHER reason, so only the genuinely stuck
    // row may be written.
    //
    // ⚠ THE OTHER NON-TERMINAL STATES ARE IN THIS LIST DELIBERATELY. `pending`
    // and `transcribed` strand a row the same way, but each needs its own
    // message and its own deadline. A sweep that quietly grew to cover them is
    // how a janitor starts writing errors onto rows that are fine.
    const db = fakeDb([
      { id: 1, ingestStatus: 'embedding', updatedAt: minutesAgo(5) }, // inside the deadline
      { id: 2, ingestStatus: 'ready', updatedAt: minutesAgo(999) },
      { id: 3, ingestStatus: 'embedding', updatedAt: minutesAgo(99) }, // the only stranded one
      { id: 4, ingestStatus: 'pending', updatedAt: minutesAgo(999) },
      { id: 5, ingestStatus: 'transcribed', updatedAt: minutesAgo(999) },
      { id: 6, ingestStatus: 'transcribing', updatedAt: minutesAgo(999) },
      { id: 7, ingestStatus: 'failed', updatedAt: minutesAgo(999) },
      // ⚠ An unreadable timestamp reads as NOT stranded. Failing a document
      // because we could not parse its clock is acting on a data-shape bug.
      { id: 8, ingestStatus: 'embedding', updatedAt: 'not a date' },
      { id: 9, ingestStatus: 'embedding', updatedAt: null },
    ])

    const result = await sweepStalledEmbeddings(db.payload, { now: NOW, deadlineMs: DEADLINE_MS })

    expect(result).toEqual({ examined: 1, stalled: 1, neverSent: 1, recovered: 0 })
    expect(db.row(3)!.ingestStatus).toBe('failed')
    for (const id of [1, 2, 4, 5, 6, 7, 8, 9]) {
      expect(db.row(id)!.ingestError).toBeUndefined()
    }
    expect(db.row(1)!.ingestStatus).toBe('embedding')
    expect(db.row(2)!.ingestStatus).toBe('ready')
  })

  it('counts the never-sent ones separately — they are the safely retryable ones', async () => {
    const db = fakeDb([
      { id: 1, ingestStatus: 'embedding', updatedAt: minutesAgo(60) },
      { id: 2, ingestStatus: 'embedding', ingestId: 'ing-2', updatedAt: minutesAgo(60) },
    ])
    const result = await sweepStalledEmbeddings(db.payload, { now: NOW, deadlineMs: DEADLINE_MS })
    expect(result).toEqual({ examined: 2, stalled: 2, neverSent: 1, recovered: 0 })
    expect(String(db.row(1)!.ingestError)).toContain('No se envió nada')
    expect(String(db.row(2)!.ingestError)).toContain('Puede haber terminado sin avisar')
  })

  it('🔴 THE RACE: a callback that lands mid-sweep is not overwritten', async () => {
    // The 30-minute deadline is sized for a badly backed-up ai-service queue,
    // which is precisely when a completion callback arrives around the deadline.
    // Lose this race with an unguarded write and a document that embedded
    // perfectly wears a permanent `embedding_stalled` failure.
    const db = fakeDb([{ id: 7, ingestStatus: 'embedding', updatedAt: minutesAgo(60) }], {
      beforeUpdate: (store) => {
        // `ingest.completed` arrives between the read and the write.
        Object.assign(store[0]!, {
          ingestStatus: 'ready',
          ingestError: null,
          updatedAt: NOW.toISOString(),
        })
      },
    })

    const result = await sweepStalledEmbeddings(db.payload, { now: NOW, deadlineMs: DEADLINE_MS })

    // The guarded update matched nothing, so nothing was written AND nothing is
    // reported — a phantom in the ERROR log is a call-out operators would act on.
    expect(result).toEqual({ examined: 1, stalled: 0, neverSent: 0, recovered: 0 })
    expect(db.row(7)!.ingestStatus).toBe('ready')
    expect(db.row(7)!.ingestError).toBeNull()
  })

  it('the guard is both conditions, so any concurrent write to the row wins', async () => {
    const db = fakeDb([{ id: 7, ingestStatus: 'embedding', updatedAt: minutesAgo(60) }])
    await sweepStalledEmbeddings(db.payload, { now: NOW, deadlineMs: DEADLINE_MS })

    const clauses = db.whereOf(0)
    expect(clauses).toContainEqual({ id: { equals: 7 } })
    expect(clauses).toContainEqual({ ingestStatus: { equals: 'embedding' } })
    // ⚠ Every write bumps `updatedAt`, so re-asserting the cutoff at write time
    // is what makes "nobody has touched this row since we read it" a condition
    // the database checks.
    expect(clauses).toContainEqual({
      updatedAt: { less_than: new Date(NOW.getTime() - DEADLINE_MS).toISOString() },
    })
  })

  it('🔴 STARVATION: a full page of work does not hide a newer stall', async () => {
    // The bug the publish sweep shipped with, and whose comment argued it had
    // not: rows the sweep handles keep their OLD `updatedAt`, so oldest-first
    // sorting puts them FIRST. If any condition were applied in JS instead of in
    // SQL, those rows would fill the page on every pass and the newer stall
    // below would never be examined — not late, NEVER.
    //
    // Every condition is in the `where`, so each pass DRAINS its page: the rows
    // it stamps leave `embedding` and stop being candidates.
    const db = fakeDb([
      { id: 1, ingestStatus: 'embedding', ingestError: 'ingest_enqueue_failed: Rate limit exceeded', updatedAt: minutesAgo(600) },
      { id: 2, ingestStatus: 'embedding', ingestError: 'ingest_enqueue_failed: Rate limit exceeded', updatedAt: minutesAgo(599) },
      { id: 3, ingestStatus: 'embedding', updatedAt: minutesAgo(45) },
    ])

    // A page of two, so the two oldest rows fill it completely.
    const first = await sweepStalledEmbeddings(db.payload, {
      now: NOW,
      deadlineMs: DEADLINE_MS,
      limit: 2,
    })
    expect(first.examined).toBe(2)
    expect(first.stalled).toBe(2)
    expect(db.row(3)!.ingestStatus).toBe('embedding') // not reached yet — the page was full

    // The next pass reaches it, because the previous page is no longer a candidate.
    const second = await sweepStalledEmbeddings(db.payload, {
      now: NOW,
      deadlineMs: DEADLINE_MS,
      limit: 2,
    })
    expect(second.stalled).toBe(1)
    expect(db.row(3)!.ingestStatus).toBe('failed')
    expect(String(db.row(3)!.ingestError)).toContain(STALLED_EMBED_CODE)
  })

  it('warns when the page was full, so a truncated count is not read as the total', async () => {
    const warn = vi.fn()
    const db = fakeDb(
      Array.from({ length: 3 }, (_, i) => ({
        id: i + 1,
        ingestStatus: 'embedding',
        updatedAt: minutesAgo(60 + i),
      })),
    )
    await sweepStalledEmbeddings(db.payload, {
      now: NOW,
      deadlineMs: DEADLINE_MS,
      limit: 3,
      log: { warn },
    })
    expect(warn.mock.calls.some((c) => String(c[1]).includes('page was full'))).toBe(true)
  })

  it('one bad row does not abandon the rest', async () => {
    const warn = vi.fn()
    const db = fakeDb([
      { id: 1, ingestStatus: 'embedding', updatedAt: minutesAgo(61) },
      { id: 2, ingestStatus: 'embedding', updatedAt: minutesAgo(60) },
    ])
    db.update.mockImplementationOnce(async () => {
      throw new Error('row vanished mid-sweep')
    })

    const result = await sweepStalledEmbeddings(db.payload, {
      now: NOW,
      deadlineMs: DEADLINE_MS,
      log: { warn },
    })

    expect(result.stalled).toBe(1)
    expect(db.row(2)!.ingestStatus).toBe('failed')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('survives a find that returns nothing at all', async () => {
    const db = fakeDb([])
    await expect(sweepStalledEmbeddings(db.payload, { now: NOW })).resolves.toEqual({
      examined: 0,
      stalled: 0,
      neverSent: 0,
      recovered: 0,
    })
    expect(db.update).not.toHaveBeenCalled()
  })
})

describe('sweepStalledEmbeddings — rescue from the ai-service job status', () => {
  /**
   * 🔴 WHY: the callback-before-ingestId race left rows at `embedding` whose
   * ai-service job had in fact COMPLETED. Stamping those `failed` tells the
   * user to retry, and a retry embeds the document a second time into a corpus
   * with no per-document delete. The job status is the truth; read it first.
   */
  const stuck = (over: Row = {}) => ({
    id: 1,
    organization: 10,
    ingestStatus: 'embedding',
    ingestId: 'ing-1',
    updatedAt: minutesAgo(60),
    ...over,
  })

  it('🔴 a completed job is marked `ready`, with no error', async () => {
    const db = fakeDb([stuck({ ingestError: null })])
    const readIngestStatus = vi.fn(async () => 'completed' as const)

    const result = await sweepStalledEmbeddings(db.payload, {
      now: NOW,
      deadlineMs: DEADLINE_MS,
      readIngestStatus,
    })

    expect(readIngestStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 1, ingestId: 'ing-1' }))
    expect(db.row(1)).toMatchObject({ ingestStatus: 'ready', ingestError: null })
    expect(result).toMatchObject({ recovered: 1, stalled: 0 })
    expect(db.update.mock.calls[0]![0].context).toEqual({ __skipDocsExtract: true })
  })

  it('🔴 a failed job is marked `failed` with the job status as the reason', async () => {
    const db = fakeDb([stuck()])
    await sweepStalledEmbeddings(db.payload, {
      now: NOW,
      deadlineMs: DEADLINE_MS,
      readIngestStatus: async () => 'failed',
    })
    expect(db.row(1)!.ingestStatus).toBe('failed')
    expect(String(db.row(1)!.ingestError)).toContain('ingest_failed')
    // Still retryable through the one explicit path.
    expect(planIngestRetry({ ...(db.row(1) as Record<string, string>), kind: 'pdf', extractedText: 'x' })).not.toBeNull()
  })

  it('a job still processing, or an unreadable status, falls back to the stall stamp', async () => {
    const db = fakeDb([stuck({ id: 1 }), stuck({ id: 2, ingestId: 'ing-2' })])
    await sweepStalledEmbeddings(db.payload, {
      now: NOW,
      deadlineMs: DEADLINE_MS,
      readIngestStatus: async (doc) => {
        if (doc.id === 1) return 'processing'
        throw new Error('404')
      },
    })
    expect(String(db.row(1)!.ingestError)).toContain(STALLED_EMBED_CODE)
    expect(String(db.row(2)!.ingestError)).toContain(STALLED_EMBED_CODE)
  })

  it('never asks about a row with no ingest id — nothing was sent', async () => {
    const db = fakeDb([stuck({ ingestId: null })])
    const readIngestStatus = vi.fn(async () => 'completed' as const)
    await sweepStalledEmbeddings(db.payload, { now: NOW, deadlineMs: DEADLINE_MS, readIngestStatus })
    expect(readIngestStatus).not.toHaveBeenCalled()
    expect(db.row(1)!.ingestStatus).toBe('failed')
  })

  it('🔴 the rescue write is guarded too: a callback that lands first wins', async () => {
    const db = fakeDb([stuck()], {
      beforeUpdate: (rows) => Object.assign(rows[0]!, { ingestStatus: 'failed', ingestError: 'real' }),
    })
    await sweepStalledEmbeddings(db.payload, {
      now: NOW,
      deadlineMs: DEADLINE_MS,
      readIngestStatus: async () => 'completed',
    })
    expect(db.row(1)).toMatchObject({ ingestStatus: 'failed', ingestError: 'real' })
  })

  it('caps status reads per sweep and leaves the rest for the next pass, unstamped', async () => {
    // ai-service's /v1 cap is per IP and shared by every consumer.
    const db = fakeDb([stuck({ id: 1 }), stuck({ id: 2, updatedAt: minutesAgo(50) })])
    const readIngestStatus = vi.fn(async () => 'completed' as const)
    await sweepStalledEmbeddings(db.payload, {
      now: NOW,
      deadlineMs: DEADLINE_MS,
      readIngestStatus,
      maxStatusReads: 1,
    })
    expect(readIngestStatus).toHaveBeenCalledTimes(1)
    expect(db.row(1)!.ingestStatus).toBe('ready')
    expect(db.row(2)!.ingestStatus).toBe('embedding')
  })
})

describe('scheduling', () => {
  it('is ON by default — it only makes an invisible state visible', () => {
    expect(embeddingJanitorEnabled()).toBe(true)
    expect(embeddingStuckAfterMs()).toBe(DEFAULT_STUCK_MIN * 60_000)
  })

  it('can be switched off, and says what that costs', () => {
    const logger = { info: vi.fn(), error: vi.fn() }
    process.env[EMBEDDING_JANITOR_ENABLED_VAR] = 'false'
    expect(embeddingJanitorEnabled()).toBe(false)
    expect(startEmbeddingJanitor({ logger } as unknown as Payload)).toBe(false)
    expect(String(logger.info.mock.calls[0]![0])).toContain('indefinitely')
  })

  it('honours the interval and deadline overrides, with a one-minute floor', () => {
    process.env[EMBEDDING_JANITOR_INTERVAL_MIN_VAR] = '0'
    expect(embeddingJanitorIntervalMs()).toBe(15 * 60_000) // 0 is not > 0 → default
    process.env[EMBEDDING_JANITOR_INTERVAL_MIN_VAR] = '0.1'
    expect(embeddingJanitorIntervalMs()).toBe(60_000)
    process.env[EMBEDDING_JANITOR_STUCK_MIN_VAR] = '90'
    expect(embeddingStuckAfterMs()).toBe(90 * 60_000)
  })

  it('arming is idempotent and does not sweep on the spot', () => {
    const find = vi.fn(async () => ({ docs: [] }))
    const payload = { logger: { info: vi.fn(), error: vi.fn() }, find, update: vi.fn() }
    expect(startEmbeddingJanitor(payload as unknown as Payload)).toBe(true)
    expect(startEmbeddingJanitor(payload as unknown as Payload)).toBe(true)
    // The first sweep is one interval away, so a deploy never fails anything
    // the instant it boots.
    expect(find).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The stale-`pending` sweep
// ---------------------------------------------------------------------------

/**
 * A row this sweep exists for: an ordinary upload whose background extract was
 * lost (a `setImmediate` with no durable queue dies with the process), so the
 * row never left `pending` and never got an ingest id.
 */
const strandedPending = (over: Row = {}): Row => ({
  id: 1,
  kind: 'pdf',
  contentKind: 'documento',
  anonymisationStatus: 'n/a',
  publicationStatus: 'draft',
  ingestStatus: 'pending',
  extractedText: 'texto',
  updatedAt: minutesAgo(999),
  ...over,
})

describe('sweepStalledPending — the lost background extract', () => {
  const PENDING_DEADLINE_MS = 60 * 60_000

  it('🔴 fails the row out with a Spanish reason, writes nothing else, and leaves it retryable', async () => {
    const db = fakeDb([strandedPending()])

    const result = await sweepStalledPending(db.payload, {
      now: NOW,
      deadlineMs: PENDING_DEADLINE_MS,
    })

    expect(result).toEqual({ examined: 1, stalled: 1 })
    const call = db.update.mock.calls[0]![0]
    const data = call.data as Record<string, unknown>
    expect(Object.keys(data).sort()).toEqual(['ingestError', 'ingestStatus'])
    expect(data.ingestStatus).toBe('failed')
    expect(String(data.ingestError)).toContain(NEVER_STARTED_CODE)
    // Same reason as the embed sweep: the status write must not re-fire the
    // hook, or the sweep that never re-drives would re-drive on every pass.
    expect(call.context).toEqual({ __skipDocsExtract: true })

    // 🔴 The whole point of `failed`: the existing retry path now accepts it.
    const plan = planIngestRetry(db.row(1) as Record<string, string>)
    expect(plan).not.toBeNull()
    expect(plan!.ingestStatus).toBe('pending')
    expect(plan!.ingestError).toBeNull()
  })

  it('🔴 never touches a hold, a gated row, or a row whose retry would misfire', async () => {
    // Every row here is old enough and `pending` with no ingest id. Each one is
    // spared for a reason that is NOT "it might still be running".
    const spared: Row[] = [
      // Inside the deadline.
      strandedPending({ id: 2, updatedAt: minutesAgo(5) }),
      // ai-service accepted something — the embed sweep's territory, not this.
      strandedPending({ id: 3, ingestId: 'ing-3' }),
      // 🔴 A HOLD waiting for a reviewer. `seed/review.ts` writes exactly this
      // shape, and `failed` would put a retry button on a human decision.
      strandedPending({ id: 4, contentKind: 'testimonio', anonymisationStatus: 'held' }),
      // 🔴 A seeded Voz that has never been through the gate.
      strandedPending({ id: 5, contentKind: 'testimonio', anonymisationStatus: 'n/a' }),
      // The gate is running (or died running) — the gate owns this row.
      strandedPending({ id: 6, contentKind: 'testimonio', anonymisationStatus: 'pending' }),
      // A reviewer released it (`holdReview.ts` re-enters at `pending`).
      // This rule only takes `documento`; released holds (approved + redactedText)
      // have their own sweep below, where `planIngestRetry` accepts them.
      strandedPending({ id: 7, contentKind: 'testimonio', anonymisationStatus: 'approved' }),
      strandedPending({ id: 8, contentKind: 'testimonio', anonymisationStatus: 'rejected' }),
      strandedPending({ id: 9, contentKind: 'conversacion' }),
      // Fails closed on an unknown content kind, like `mustPassAnonymisationGate`.
      strandedPending({ id: 10, contentKind: null }),
      // Published rows belong to the publish path and the repair script: a
      // retry would re-ingest into the uploader's DRAFT corpus.
      strandedPending({ id: 11, publicationStatus: 'published' }),
      strandedPending({ id: 12, publicationStatus: 'publishing' }),
      // `planIngestRetry` refuses a kind with no pipeline.
      strandedPending({ id: 13, kind: 'chat' }),
      // Not `pending` at all.
      strandedPending({ id: 14, ingestStatus: 'embedding', updatedAt: minutesAgo(10) }),
      strandedPending({ id: 15, ingestStatus: 'ready' }),
    ]
    const db = fakeDb([strandedPending({ id: 1 }), ...spared])

    const result = await sweepStalledPending(db.payload, {
      now: NOW,
      deadlineMs: PENDING_DEADLINE_MS,
    })

    expect(result).toEqual({ examined: 1, stalled: 1 })
    expect(db.row(1)!.ingestStatus).toBe('failed')
    for (const row of spared) {
      const after = db.row(row.id as number)!
      expect(after.ingestStatus, `row ${row.id}`).toBe(row.ingestStatus)
      expect(after.ingestError, `row ${row.id}`).toBeUndefined()
    }
  })

  it('🔴 sweeps a reviewer’s release whose ingest was lost, and leaves it retryable', async () => {
    // `holdReview.ts` re-enters an approved hold at `pending`. A lost hook run
    // (a restart, or a read that never saw the approval commit) stranded it there.
    const released = strandedPending({
      id: 21,
      contentKind: 'testimonio',
      anonymisationStatus: 'approved',
      redactedText: 'Mi nombre es [Persona A].',
    })
    const db = fakeDb([released])

    const result = await sweepStalledPending(db.payload, { now: NOW, deadlineMs: PENDING_DEADLINE_MS })

    expect(result).toEqual({ examined: 1, stalled: 1 })
    expect(db.row(21)!.ingestStatus).toBe('failed')
    // The decision survives the sweep.
    expect(db.row(21)!.anonymisationStatus).toBe('approved')
    const plan = planIngestRetry(db.row(21) as Record<string, string>)
    expect(plan).toEqual({ ingestStatus: 'pending', ingestError: null, ingestId: null })
  })

  it('🔴 THE RACE: a row that moves between the read and the write is left alone', async () => {
    // A user pressing retry, or a late hook run, moves the row to `extracting`.
    const db = fakeDb([strandedPending({ id: 7 })], {
      beforeUpdate: (store) => {
        Object.assign(store[0]!, { ingestStatus: 'extracting', updatedAt: NOW.toISOString() })
      },
    })

    const result = await sweepStalledPending(db.payload, {
      now: NOW,
      deadlineMs: PENDING_DEADLINE_MS,
    })

    expect(result).toEqual({ examined: 1, stalled: 0 })
    expect(db.row(7)!.ingestStatus).toBe('extracting')
    expect(db.row(7)!.ingestError).toBeUndefined()
  })

  it('the guarded write re-asserts every condition, the gate ones included', async () => {
    const db = fakeDb([strandedPending({ id: 7 })])
    await sweepStalledPending(db.payload, { now: NOW, deadlineMs: PENDING_DEADLINE_MS })

    const clauses = db.whereOf(0)
    expect(clauses).toContainEqual({ id: { equals: 7 } })
    expect(clauses).toContainEqual({ ingestStatus: { equals: 'pending' } })
    expect(clauses).toContainEqual({ ingestId: { exists: false } })
    expect(clauses).toContainEqual({ anonymisationStatus: { equals: 'n/a' } })
    expect(clauses).toContainEqual({ contentKind: { equals: 'documento' } })
    expect(clauses).toContainEqual({
      updatedAt: { less_than: new Date(NOW.getTime() - PENDING_DEADLINE_MS).toISOString() },
    })
  })

  it('sweeps exactly the kinds `planIngestRetry` will retry — the two lists cannot drift', () => {
    for (const kind of ['pdf', 'docx', 'xlsx', 'csv', 'html', 'audio', 'markdown', 'chat', 'unknown']) {
      const retryable =
        planIngestRetry({ kind, ingestStatus: 'failed', extractedText: 't', anonymisationStatus: 'n/a' }) !== null
      expect((PENDING_SWEEP_KINDS as readonly string[]).includes(kind), kind).toBe(retryable)
    }
  })

  it('the reason says nothing was sent and that retrying is safe', () => {
    const reason = neverStartedReason(60)
    expect(reason).toContain(NEVER_STARTED_CODE)
    expect(reason).toContain('60')
    expect(reason).toContain('volver a intentarlo')
    expect(reason.length).toBeLessThanOrEqual(500)
  })

  it('has its own deadline, longer than the embed one, and it is configurable', () => {
    expect(pendingStuckAfterMs()).toBe(DEFAULT_PENDING_STUCK_MIN * 60_000)
    expect(DEFAULT_PENDING_STUCK_MIN).toBeGreaterThanOrEqual(DEFAULT_STUCK_MIN)
    process.env[PENDING_JANITOR_STUCK_MIN_VAR] = '120'
    expect(pendingStuckAfterMs()).toBe(120 * 60_000)
    process.env[PENDING_JANITOR_STUCK_MIN_VAR] = 'nope'
    expect(pendingStuckAfterMs()).toBe(DEFAULT_PENDING_STUCK_MIN * 60_000)
  })

  it('🔴 the scheduled janitor runs this sweep too — not just the embed one', async () => {
    vi.useFakeTimers()
    try {
      const find = vi.fn(async () => ({ docs: [] }))
      const payload = { logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, find, update: vi.fn() }
      startEmbeddingJanitor(payload as unknown as Payload)
      await vi.advanceTimersByTimeAsync(embeddingJanitorIntervalMs() + 1)

      const states = find.mock.calls.map((c) => {
        const and = ((c as unknown[])[0] as { where: { and: Clause[] } }).where.and
        return and.find((cl) => 'ingestStatus' in cl)!.ingestStatus!.equals
      })
      expect(states).toContain('embedding')
      expect(states).toContain('pending')
    } finally {
      stopEmbeddingJanitor()
      vi.useRealTimers()
    }
  })
})
