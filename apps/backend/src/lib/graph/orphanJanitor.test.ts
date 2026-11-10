/**
 * C-05 (audit 2026-11-10): the orphan sweep runs on its own, daily, one
 * ecosistema at a time.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  GRAPH_ORPHAN_JANITOR_DEFAULT_MIN,
  startGraphOrphanJanitor,
  stopGraphOrphanJanitor,
  sweepGraphOrphans,
} from './orphanJanitor'

const OLD = new Date(Date.now() - 86_400_000).toISOString()

/** Two ecosistemas; entity 1 (org 1) is an orphan, entity 2 (org 2) is referenced. */
function fake(opts: { failOrg?: number } = {}) {
  const deleted: unknown[] = []
  const payload = {
    async find(args: Record<string, unknown>) {
      const where = JSON.stringify(args.where ?? {})
      if (args.collection === 'organizations') return { docs: [{ id: 1 }, { id: 2 }] }
      if (args.collection === 'graphEntities') {
        if (opts.failOrg != null && where.includes(`"equals":${opts.failOrg}}`)) throw new Error('boom')
        const org = where.includes('"equals":1}') ? 1 : 2
        return { docs: [{ id: org, createdAt: OLD, updatedAt: OLD }] }
      }
      if (args.collection === 'graphMentions') return { docs: where.includes('"entity":{"equals":2}') ? [{ id: 9 }] : [] }
      return { docs: [] }
    },
    async delete(args: Record<string, unknown>) {
      deleted.push(args.id)
      return {}
    },
    async update() {
      return {}
    },
    async create() {
      return {}
    },
    db: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  return { payload, deleted }
}

afterEach(() => {
  stopGraphOrphanJanitor()
  vi.useRealTimers()
  delete process.env.GRAPH_ORPHAN_JANITOR_ENABLED
  delete process.env.GRAPH_ORPHAN_JANITOR_INTERVAL_MIN
})

describe('sweepGraphOrphans', () => {
  it('deletes the orphan in every ecosistema and keeps the referenced one', async () => {
    const { payload, deleted } = fake()
    expect(await sweepGraphOrphans(payload as never)).toEqual({ organizations: 2, deleted: 1, failed: 0 })
    expect(deleted).toEqual([1])
  })

  it('one failing ecosistema does not stop the others', async () => {
    const { payload, deleted } = fake({ failOrg: 1 })
    expect(await sweepGraphOrphans(payload as never)).toEqual({ organizations: 2, deleted: 0, failed: 1 })
    expect(deleted).toEqual([])
  })
})

describe('startGraphOrphanJanitor', () => {
  it('🔴 is on by default, daily, and sweeps when the interval elapses (not at boot)', async () => {
    expect(GRAPH_ORPHAN_JANITOR_DEFAULT_MIN).toBe(1440)
    vi.useFakeTimers()
    const { payload, deleted } = fake()
    expect(startGraphOrphanJanitor(payload as never)).toBe(true)
    expect(payload.logger.info).toHaveBeenCalledWith({ intervalMinutes: 1440 }, '[graph-orphan-janitor] armed')
    await vi.advanceTimersByTimeAsync(1439 * 60_000)
    expect(deleted).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deleted).toEqual([1])
  })

  it('GRAPH_ORPHAN_JANITOR_INTERVAL_MIN sets the interval', async () => {
    process.env.GRAPH_ORPHAN_JANITOR_INTERVAL_MIN = '5'
    vi.useFakeTimers()
    const { payload, deleted } = fake()
    startGraphOrphanJanitor(payload as never)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(deleted).toEqual([1])
  })

  it('GRAPH_ORPHAN_JANITOR_ENABLED=false disarms it and says so', () => {
    process.env.GRAPH_ORPHAN_JANITOR_ENABLED = 'false'
    const { payload } = fake()
    expect(startGraphOrphanJanitor(payload as never)).toBe(false)
    expect(String(payload.logger.info.mock.calls[0]?.[0])).toContain('GRAPH_ORPHAN_JANITOR_ENABLED')
  })
})
