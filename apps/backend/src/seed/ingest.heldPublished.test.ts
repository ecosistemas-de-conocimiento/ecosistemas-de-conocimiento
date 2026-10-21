/**
 * 🔴 A HELD TESTIMONIO IS NEVER PUBLISHED — the dev incident of 2026-10-21.
 *
 * Measured on dev (runbook `infra/fleet/edc-1.md` §4p): 13 testimonios ended
 * `anonymisation_status = held` + `publication_status = published`, indexed in
 * the shared corpus. Root cause: `payload run src/seed/demo.cli.ts` boots
 * Payload, whose boot seed starts `ingestSeededDocuments` detached, and the CLI
 * then runs it again in the same process. Both runs read the rows up front. Run
 * A gated a row `ready` and published it; run B, holding its stale snapshot,
 * gated the same row again, the model answered differently, and B wrote `held`
 * over a row already in the shared corpus.
 *
 * The real `ingestSeededDocuments`, `anonymiseDocumentText`, gate and
 * `beginPublish` run. Faked: the ai-service client, the detector (no model is
 * called) and the column writer, replayed as `payload.update` against ONE row
 * that honours each write's `where` — the guards are the fix, so the fake must
 * evaluate them rather than ignore them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DetectorFinding, PersonDetector } from '@/lib/anonymise/types'

const enqueue = vi.fn()
const setDocumentValidity = vi.fn()
vi.mock('@/lib/aiClient', () => ({
  getAdminAIClient: () => ({ ingest: { enqueue }, admin: { setDocumentValidity } }),
}))
vi.mock('@/lib/callbackConfig', () => ({ ingestCallbackUrl: () => null }))
vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

let detector: PersonDetector
vi.mock('@/lib/anonymise', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/anonymise')>()),
  aiServiceDetector: () => detector,
}))

const { ingestSeededDocuments } = await import('./corpus')
const { anonymiseDocumentText } = await import('@/lib/anonymiseDocument')
const { beginPublish, confirmPublish, NotPublishableError } = await import('@/lib/publishDocument')

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined }

const TEXT = 'Me llamo Camilo Bautista Flores y vivo en Xoxocotla, Morelos, desde niño.'
const FINDINGS: DetectorFinding[] = [{ text: 'Camilo Bautista Flores', type: 'persona' }]

type Row = Record<string, unknown>
type Clause = Record<string, Record<string, unknown>>

function matchesClause(row: Row, clause: Clause): boolean {
  return Object.entries(clause).every(([field, op]) => {
    const value = row[field]
    if ('equals' in op) return String(value ?? '') === String(op.equals)
    if ('in' in op) return value != null && (op.in as unknown[]).map(String).includes(String(value))
    if ('not_in' in op) return value == null || !(op.not_in as unknown[]).map(String).includes(String(value))
    if ('exists' in op) return (value != null && value !== '') === Boolean(op.exists)
    throw new Error(`fake row: unsupported operator ${JSON.stringify(op)} on ${field}`)
  })
}

/** One row. Every write applies to it; a guarded write applies only when its guards match. */
function oneRow(row: Row) {
  const live: Row = { ...row }
  const payload = {
    logger: silentLogger,
    find: async () => ({ docs: [{ ...live }] }),
    findByID: async () => ({ ...live }),
    update: async (args: { data: Row; where?: { and?: Clause[] } }) => {
      if (args.where) {
        const ok = (args.where.and ?? []).every((c) => ('id' in c ? true : matchesClause(live, c)))
        if (!ok) return { docs: [] }
        Object.assign(live, args.data)
        return { docs: [{ ...live }] }
      }
      Object.assign(live, args.data)
      return { ...live }
    },
  }
  return { payload: payload as never, live }
}

function seededDraft(over: Row = {}): Row {
  return {
    id: 30,
    organization: 1,
    uploadedBy: 2,
    contentKind: 'testimonio',
    kind: 'pdf',
    name: 'Carta de presentación — traducción en salud (01)',
    tema: 'traduccion',
    extractedText: TEXT,
    publicationStatus: 'draft',
    anonymisationStatus: null,
    ...over,
  }
}

const run = (payload: never) =>
  ingestSeededDocuments(payload, 1, { sleep: async () => undefined, spacingMs: 0 })

/** Clears on the first document, holds on every later one: a model that changes its mind. */
function clearsOnceThenHolds(): { detector: PersonDetector; calls: () => number } {
  let n = 0
  return {
    calls: () => n,
    detector: {
      name: 'clears-once',
      async detect() {
        n += 1
        // Calls 1–2 are run one (content, verify): clean. From call 3 on, verify finds a name.
        if (n <= 2) return n === 1 ? FINDINGS : []
        return n % 2 === 1 ? [] : FINDINGS
      },
    },
  }
}

beforeEach(() => {
  enqueue.mockReset()
  enqueue.mockResolvedValue({ ingestId: 'ing-1' })
  setDocumentValidity.mockReset()
  setDocumentValidity.mockResolvedValue({})
})

describe('🔴 two seed ingests in one process gate a row once (the dev incident)', () => {
  it('the second call waits for the first; the row is gated once and published once', async () => {
    const model = clearsOnceThenHolds()
    detector = model.detector
    const { payload, live } = oneRow(seededDraft())

    // The boot seed's detached run and the CLI's own run, started together.
    const [boot, cli] = await Promise.all([run(payload), run(payload)])

    expect(model.calls()).toBe(2)
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(boot).toEqual(cli)
    expect(live).toMatchObject({ anonymisationStatus: 'ready', publicationStatus: 'publishing' })
  })
})

describe('🔴 the gate never re-runs on a row in the shared corpus (GATE_CLAIM_GUARD)', () => {
  for (const publicationStatus of ['publishing', 'published', 'unpublishing']) {
    it(`a stale snapshot cannot re-gate a ${publicationStatus} row into "held"`, async () => {
      const model = clearsOnceThenHolds()
      detector = model.detector
      const { payload, live } = oneRow(
        seededDraft({ publicationStatus, anonymisationStatus: 'ready', redactedText: 'Me llamo [Persona A].' }),
      )

      const result = await anonymiseDocumentText({
        payload: payload as never,
        docId: 30,
        contentKind: 'testimonio',
        text: TEXT,
        detector,
      })

      expect(result).toMatchObject({ ok: false, busy: true })
      expect(model.calls()).toBe(0)
      expect(live).toMatchObject({ anonymisationStatus: 'ready', redactedText: 'Me llamo [Persona A].' })
    })
  }

  for (const anonymisationStatus of ['pending', 'held', 'rejected', 'approved']) {
    it(`a row at "${anonymisationStatus}" is not claimed`, async () => {
      const model = clearsOnceThenHolds()
      detector = model.detector
      const { payload, live } = oneRow(seededDraft({ anonymisationStatus }))

      const result = await anonymiseDocumentText({
        payload: payload as never,
        docId: 30,
        contentKind: 'testimonio',
        text: TEXT,
        detector,
      })

      expect(result).toMatchObject({ ok: false, busy: true })
      expect(model.calls()).toBe(0)
      expect(live.anonymisationStatus).toBe(anonymisationStatus)
    })
  }

  it('the seed counts a busy row as skipped, not held and not failed', async () => {
    const model = clearsOnceThenHolds()
    detector = model.detector
    // A snapshot that says "not gated yet" while the stored row is mid-gate.
    const { payload, live } = oneRow(seededDraft({ anonymisationStatus: 'pending' }))
    ;(payload as unknown as { find: () => Promise<unknown> }).find = async () => ({
      docs: [{ ...live, anonymisationStatus: 'n/a' }],
    })

    const result = await run(payload)

    expect(result).toEqual({ enqueued: 0, failed: 0, held: 0 })
    expect(model.calls()).toBe(0)
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('🔴 beginPublish fails closed on the STORED row, not on the caller\'s copy', () => {
  const deps = (payload: never) => ({
    payload,
    client: { ingest: { enqueue }, admin: { setDocumentValidity } } as never,
    retry: { attempts: 1, sleep: async () => undefined },
  })

  it('a stale "ready" copy of a row that is now held is refused, and nothing is enqueued', async () => {
    const { payload, live } = oneRow(seededDraft({ anonymisationStatus: 'held', redactedText: null }))
    const staleCopy = seededDraft({ anonymisationStatus: 'ready', redactedText: 'Me llamo [Persona A].' })

    await expect(beginPublish(staleCopy as never, deps(payload))).rejects.toBeInstanceOf(NotPublishableError)
    expect(enqueue).not.toHaveBeenCalled()
    expect(live.publicationStatus).toBe('draft')
  })

  it('a row that is ready in the database publishes as before', async () => {
    const row = seededDraft({ anonymisationStatus: 'ready', redactedText: 'Me llamo [Persona A].' })
    const { payload, live } = oneRow(row)

    await beginPublish(row as never, deps(payload))

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0]![0].documents[0].text).toBe('Me llamo [Persona A].')
    expect(live.publicationStatus).toBe('publishing')
  })
})

describe('🔴 confirmPublish never flips a row that is no longer cleared to "published"', () => {
  it('retires the shared copy and puts the row back to a draft, still held', async () => {
    const row = seededDraft({
      publicationStatus: 'publishing',
      anonymisationStatus: 'held',
      redactedText: null,
      heldText: 'Me llamo [Persona A].',
    })
    const { payload, live } = oneRow(row)

    await confirmPublish(row as never, { payload, client: { ingest: { enqueue }, admin: { setDocumentValidity } } as never })

    expect(setDocumentValidity).toHaveBeenCalledTimes(1)
    expect(setDocumentValidity.mock.calls[0]![0]).toBe('eco-1')
    expect(live).toMatchObject({ publicationStatus: 'draft', anonymisationStatus: 'held' })
    expect(String(live.publicationError)).toMatch(/No se publicó/)
  })
})

describe('🔴 a stale gate run cannot overwrite a newer one (per-run claim token)', () => {
  it('a run whose row was swept and re-claimed meanwhile writes nothing', async () => {
    const { payload, live } = oneRow(seededDraft())
    let calls = 0
    detector = {
      name: 'slow-then-held',
      async detect() {
        calls += 1
        if (calls === 1) {
          // While this run waits on the model: the lost-gate sweep resets the
          // row, and a newer run claims it and clears it.
          Object.assign(live, { anonymisationStatus: 'n/a', anonymisationError: 'gate_unavailable: stalled' })
          Object.assign(live, { anonymisationStatus: 'ready', anonymisationError: null, redactedText: 'Me llamo [Persona A].' })
          return []
        }
        return FINDINGS // the stale run's verify would HOLD
      },
    }

    const result = await anonymiseDocumentText({
      payload: payload as never,
      docId: 30,
      contentKind: 'testimonio',
      text: TEXT,
      detector,
    })

    expect(result).toMatchObject({ ok: false, busy: true })
    expect(live).toMatchObject({ anonymisationStatus: 'ready', redactedText: 'Me llamo [Persona A].' })
  })

  it('the claim writes a token, and the run\'s own final write clears it', async () => {
    detector = { name: 'clean', detect: async () => [] }
    const { payload, live } = oneRow(seededDraft())
    const result = await anonymiseDocumentText({
      payload: payload as never,
      docId: 30,
      contentKind: 'testimonio',
      text: TEXT,
      detector: { name: 'peek', detect: async () => (expect(String(live.anonymisationError)).toMatch(/^gate_running: /), []) },
    })
    expect(result.ok).toBe(true)
    expect(live).toMatchObject({ anonymisationStatus: 'ready', anonymisationError: null })
  })
})

describe('onlyIds — the targeted re-gate of place-only holds', () => {
  it('leaves every row outside the set alone, and gates the row inside it', async () => {
    const model = clearsOnceThenHolds()
    detector = model.detector
    const { payload, live } = oneRow(seededDraft())

    const outside = await ingestSeededDocuments(payload, 1, { spacingMs: 0, onlyIds: new Set(['99']) })
    expect(outside).toEqual({ enqueued: 0, failed: 0, held: 0 })
    expect(model.calls()).toBe(0)

    const inside = await ingestSeededDocuments(payload, 1, { spacingMs: 0, onlyIds: new Set(['30']) })
    expect(inside).toEqual({ enqueued: 1, failed: 0, held: 0 })
    expect(live.publicationStatus).toBe('publishing')
  })
})
