/**
 * Tests for the session janitor.
 *
 * Two layers (both pure / offline — no DB, no ai-service):
 *   - SELECTION: `staleCutoff` + `staleWhere` produce the right cutoff and the
 *     right Payload `where`, i.e. the timestamp + TTL logic picks exactly the
 *     stale sessions and spares the fresh ones (validated against an in-memory
 *     session table the fake `payload.find` filters).
 *   - CASCADE: deleting a stale session goes through `payload.delete` rather
 *     than raw SQL, so any `Sessions.afterDelete` hook fires for a reaped
 *     session exactly as it does for a manual delete.
 *
 * 🔴 AND ONE THING THAT MUST *NOT* HAPPEN: reaping a session must never delete
 * a corpus. It used to, back when there was one corpus per conversation. Under
 * the ecosistema model the corpora are `eco-{orgId}` and
 * `eco-{orgId}-draft-{userId}`, SHARED across every session — so a janitor
 * sweep that still called `deleteCorpus` would wipe an entire ecosistema's
 * knowledgebase on a schedule, quietly, at 3am. The test below is a regression
 * guard for exactly that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The underlying `@edc/ai-client` is mocked so that IF anything in the delete
// path ever reached `deleteCorpus`, this spy would see it. That is the point:
// the assertion is that it stays at zero.
const deleteCorpus = vi.fn(async (_corpus: string) => ({ deleted: true }))
vi.mock('@edc/ai-client', () => ({
  AIClient: class {
    admin = { deleteCorpus }
  },
}))

import type { Payload } from 'payload'
import {
  __resetJanitorLock,
  DEFAULTS,
  janitorConfigFromEnv,
  janitorEnabled,
  janitorIntervalMs,
  runSessionJanitor,
  staleCutoff,
  staleWhere,
  type JanitorConfig,
} from './sessionJanitor'

const DAY_MS = 24 * 60 * 60 * 1000

interface Row {
  id: number
  lastUsedAt?: string | null
  updatedAt: string
  createdAt: string
}

/**
 * A minimal in-memory Payload stand-in. `find` honours the janitor's
 * `staleWhere` shape (lastUsedAt<cutoff OR (lastUsedAt null AND updatedAt<
 * cutoff)) so selection is exercised end-to-end; `delete` removes the row and
 * fires the supplied afterDelete hook(s). `logger` is a no-op.
 */
function fakePayload(
  rows: Row[],
  afterDelete: Array<(args: { id: number }) => unknown> = [],
): { payload: Payload; rows: Row[] } {
  const table = [...rows]

  const matches = (r: Row, cutoffIso: string): boolean => {
    if (r.lastUsedAt != null) return r.lastUsedAt < cutoffIso
    return r.updatedAt < cutoffIso
  }

  // Parse the where the janitor passes in. It is either the bare `staleWhere`
  // ({ or: [...] }) or `staleWhereExcluding` ({ and: [staleWhere, {id:{not_in}}] }).
  const parseWhere = (where: unknown): { cutoff: string; excluded: Set<number> } => {
    const w = where as {
      or?: Array<{ lastUsedAt?: { less_than: string } }>
      and?: Array<{
        or?: Array<{ lastUsedAt?: { less_than: string } }>
        id?: { not_in?: number[] }
      }>
    }
    if (w.or) {
      const iso = w.or[0]?.lastUsedAt?.less_than
      if (!iso) throw new Error('unexpected where shape')
      return { cutoff: iso, excluded: new Set() }
    }
    if (w.and) {
      const iso = w.and[0]?.or?.[0]?.lastUsedAt?.less_than
      const not = w.and[1]?.id?.not_in ?? []
      if (!iso) throw new Error('unexpected where shape')
      return { cutoff: iso, excluded: new Set(not) }
    }
    throw new Error('unexpected where shape')
  }

  const payload = {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    find: async ({ where, limit }: { where: unknown; limit: number }) => {
      const { cutoff, excluded } = parseWhere(where)
      const all = table
        .filter((r) => matches(r, cutoff) && !excluded.has(r.id))
        .sort((a, b) => a.id - b.id)
      const docs = all.slice(0, limit)
      return {
        docs,
        totalDocs: all.length,
        totalPages: Math.max(1, Math.ceil(all.length / limit)),
        page: 1,
      }
    },
    delete: async ({ id }: { id: number }) => {
      const idx = table.findIndex((r) => r.id === id)
      if (idx === -1) throw new Error(`no such session ${id}`)
      const [removed] = table.splice(idx, 1)
      for (const hook of afterDelete) await hook({ id })
      return removed
    },
  } as unknown as Payload

  return { payload, rows: table }
}

function cfg(over: Partial<JanitorConfig> = {}): JanitorConfig {
  return { ...DEFAULTS, ...over }
}

const NOW = new Date('2026-06-10T00:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS).toISOString()

beforeEach(() => {
  __resetJanitorLock()
  deleteCorpus.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('staleCutoff', () => {
  it('subtracts ttlDays from now', () => {
    expect(staleCutoff(NOW, 90).toISOString()).toBe(daysAgo(90))
    expect(staleCutoff(NOW, 1).toISOString()).toBe(daysAgo(1))
  })
})

describe('staleWhere', () => {
  it('builds an OR over lastUsedAt<cutoff and (lastUsedAt null AND updatedAt<cutoff)', () => {
    const cutoff = staleCutoff(NOW, 90)
    const where = staleWhere(cutoff) as {
      or: Array<Record<string, unknown>>
    }
    expect(where.or).toHaveLength(2)
    expect(where.or[0]).toEqual({ lastUsedAt: { less_than: cutoff.toISOString() } })
    expect(where.or[1]).toMatchObject({
      and: [{ lastUsedAt: { exists: false } }, { updatedAt: { less_than: cutoff.toISOString() } }],
    })
  })
})

describe('runSessionJanitor — selection', () => {
  it('deletes only sessions idle beyond the TTL (lastUsedAt path)', async () => {
    const rows: Row[] = [
      { id: 1, lastUsedAt: daysAgo(120), updatedAt: daysAgo(120), createdAt: daysAgo(200) }, // stale
      { id: 2, lastUsedAt: daysAgo(91), updatedAt: daysAgo(91), createdAt: daysAgo(200) }, // stale
      { id: 3, lastUsedAt: daysAgo(89), updatedAt: daysAgo(89), createdAt: daysAgo(200) }, // fresh
      { id: 4, lastUsedAt: daysAgo(1), updatedAt: daysAgo(1), createdAt: daysAgo(200) }, // fresh
    ]
    const { payload, rows: table } = fakePayload(rows)
    const res = await runSessionJanitor(payload, cfg({ ttlDays: 90 }), NOW)

    expect(res.deleted).toBe(2)
    expect(res.failed).toBe(0)
    expect(table.map((r) => r.id).sort()).toEqual([3, 4])
  })

  it('falls back to updatedAt when lastUsedAt is null', async () => {
    const rows: Row[] = [
      { id: 1, lastUsedAt: null, updatedAt: daysAgo(120), createdAt: daysAgo(200) }, // stale via updatedAt
      { id: 2, lastUsedAt: null, updatedAt: daysAgo(10), createdAt: daysAgo(200) }, // fresh via updatedAt
      // lastUsedAt recent but updatedAt old: lastUsedAt wins → fresh
      { id: 3, lastUsedAt: daysAgo(2), updatedAt: daysAgo(300), createdAt: daysAgo(300) },
    ]
    const { payload, rows: table } = fakePayload(rows)
    const res = await runSessionJanitor(payload, cfg({ ttlDays: 90 }), NOW)

    expect(res.deleted).toBe(1)
    expect(table.map((r) => r.id).sort()).toEqual([2, 3])
  })

  it('pages through more stale rows than one batch', async () => {
    const rows: Row[] = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      lastUsedAt: daysAgo(200),
      updatedAt: daysAgo(200),
      createdAt: daysAgo(300),
    }))
    const { payload, rows: table } = fakePayload(rows)
    const res = await runSessionJanitor(payload, cfg({ ttlDays: 90, batchSize: 3 }), NOW)

    expect(res.deleted).toBe(7)
    expect(table).toHaveLength(0)
  })

  it('respects maxDeletesPerRun as a defensive cap', async () => {
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      lastUsedAt: daysAgo(200),
      updatedAt: daysAgo(200),
      createdAt: daysAgo(300),
    }))
    const { payload, rows: table } = fakePayload(rows)
    const res = await runSessionJanitor(
      payload,
      cfg({ ttlDays: 90, batchSize: 50, maxDeletesPerRun: 4 }),
      NOW,
    )

    expect(res.deleted).toBe(4)
    expect(table).toHaveLength(6)
  })
})

describe('runSessionJanitor — dry run', () => {
  it('counts candidates but deletes nothing', async () => {
    const rows: Row[] = [
      { id: 1, lastUsedAt: daysAgo(120), updatedAt: daysAgo(120), createdAt: daysAgo(200) },
      { id: 2, lastUsedAt: daysAgo(1), updatedAt: daysAgo(1), createdAt: daysAgo(200) },
    ]
    const { payload, rows: table } = fakePayload(rows)
    const res = await runSessionJanitor(payload, cfg({ ttlDays: 90, dryRun: true }), NOW)

    expect(res.dryRun).toBe(true)
    expect(res.deleted).toBe(1) // "would delete" count
    expect(table).toHaveLength(2) // nothing actually removed
    expect(deleteCorpus).not.toHaveBeenCalled()
  })
})

describe('runSessionJanitor — error isolation', () => {
  it('continues past a per-session delete failure and counts it', async () => {
    const rows: Row[] = [
      { id: 1, lastUsedAt: daysAgo(200), updatedAt: daysAgo(200), createdAt: daysAgo(300) },
      { id: 2, lastUsedAt: daysAgo(200), updatedAt: daysAgo(200), createdAt: daysAgo(300) },
      { id: 3, lastUsedAt: daysAgo(200), updatedAt: daysAgo(200), createdAt: daysAgo(300) },
    ]
    const { payload } = fakePayload(rows)
    // Make session 2's delete throw once.
    const p = payload as unknown as { delete: (a: { id: number }) => Promise<unknown> }
    const orig = p.delete.bind(p)
    p.delete = async (args: { id: number }) => {
      if (args.id === 2) throw new Error('boom')
      return orig(args)
    }

    const res = await runSessionJanitor(payload, cfg({ ttlDays: 90, batchSize: 50 }), NOW)
    expect(res.failed).toBe(1)
    expect(res.deleted).toBe(2)
  })
})

describe('runSessionJanitor — overlap lock', () => {
  it('skips a concurrent run while one is in flight', async () => {
    const rows: Row[] = [
      { id: 1, lastUsedAt: daysAgo(200), updatedAt: daysAgo(200), createdAt: daysAgo(300) },
    ]
    const { payload } = fakePayload(rows)

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const realDelete = (payload as unknown as { delete: (a: { id: number }) => Promise<unknown> })
      .delete
    const slow = {
      ...payload,
      delete: async (args: { id: number }) => {
        await gate
        return realDelete(args)
      },
    } as unknown as Payload

    const first = runSessionJanitor(slow, cfg({ ttlDays: 90 }), NOW)
    // Second call while first holds the lock.
    const second = await runSessionJanitor(payload, cfg({ ttlDays: 90 }), NOW)
    expect(second.skippedLocked).toBe(true)
    expect(second.deleted).toBe(0)

    release()
    await first
  })
})

describe('🔴 reaping a session must NOT delete any corpus', () => {
  it('never calls deleteCorpus, however many sessions it sweeps', async () => {
    vi.stubEnv('AI_SERVICE_URL', 'http://ai-service.test')
    vi.stubEnv('AI_SERVICE_ADMIN_API_KEY', 'test-admin-key')

    // Wire whatever `Sessions.afterDelete` hooks exist into the fake delete, so
    // this test sees the real behaviour rather than an empty stand-in.
    const { Sessions } = await import('../collections/Sessions')
    const hooks = (Sessions.hooks?.afterDelete ?? []) as unknown as Array<
      (args: { id: number }) => unknown
    >

    const rows: Row[] = [
      { id: 11, lastUsedAt: daysAgo(200), updatedAt: daysAgo(200), createdAt: daysAgo(300) },
      { id: 22, lastUsedAt: daysAgo(200), updatedAt: daysAgo(200), createdAt: daysAgo(300) },
    ]
    const { payload } = fakePayload(rows, hooks)
    const res = await runSessionJanitor(payload, cfg({ ttlDays: 90 }), NOW)

    expect(res.deleted).toBe(2)

    // Any cleanup would be fire-and-forget behind its own dynamic import, so
    // drain a few macrotasks before concluding that nothing happened.
    await new Promise((resolve) => setTimeout(resolve, 20))

    // ⚠ The corpora are shared across every session in an ecosistema. One call
    // here is an entire knowledgebase gone.
    expect(deleteCorpus).not.toHaveBeenCalled()
  })
})

describe('env config', () => {
  it('uses defaults when env is empty', () => {
    expect(janitorConfigFromEnv({})).toEqual(DEFAULTS)
    expect(janitorEnabled({})).toBe(false)
    expect(janitorIntervalMs({})).toBe(1440 * 60 * 1000)
  })

  it('parses overrides and tolerates junk', () => {
    expect(
      janitorConfigFromEnv({
        SESSION_TTL_DAYS: '30',
        SESSION_JANITOR_BATCH: '100',
        SESSION_JANITOR_DRY_RUN: 'true',
        SESSION_JANITOR_MAX: '500',
      }),
    ).toEqual({ ttlDays: 30, batchSize: 100, dryRun: true, maxDeletesPerRun: 500 })

    expect(janitorEnabled({ SESSION_JANITOR_ENABLED: '1' })).toBe(true)
    expect(janitorEnabled({ SESSION_JANITOR_ENABLED: 'yes' })).toBe(true)
    expect(janitorEnabled({ SESSION_JANITOR_ENABLED: 'nope' })).toBe(false)

    // junk falls back to defaults
    expect(janitorConfigFromEnv({ SESSION_TTL_DAYS: 'abc' }).ttlDays).toBe(DEFAULTS.ttlDays)
    expect(janitorConfigFromEnv({ SESSION_TTL_DAYS: '-5' }).ttlDays).toBe(DEFAULTS.ttlDays)
    // maxDeletesPerRun allows 0 (= unlimited)
    expect(janitorConfigFromEnv({ SESSION_JANITOR_MAX: '0' }).maxDeletesPerRun).toBe(0)
  })
})
