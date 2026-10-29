/**
 * 🔴 R77 — an eval conversation (`sessions.evalRun` set by `/api/evals/session`)
 * takes turns ONLY while its run is `running`. Before, after, or with a run
 * that is gone, a platform admin must not be able to use it to chat freely.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PayloadRequest } from 'payload'

import { protectMessageCorpusState } from './Messages'

const ADMIN = 1
const sessions: Record<string, Record<string, unknown>> = {
  100: { user: ADMIN, organization: 7, evalRun: 50 },
  101: { user: ADMIN, organization: 7, evalRun: 51 },
  102: { user: ADMIN, organization: 7, evalRun: 404 },
  103: { user: ADMIN, organization: 7, evalRun: null },
}
const runs: Record<string, Record<string, unknown>> = {
  50: { status: 'running' },
  51: { status: 'done' },
}

/** Users / memberships / organizations reads of `assertSessionOwnedBy`. */
let adminFlag = true
const find = vi.fn(async ({ collection, where }: { collection: string; where: { and: Array<Record<string, { equals?: unknown; in?: unknown[] }>> } }) => {
  const first = where.and[0] ?? {}
  if (collection === 'users') return { docs: [{ id: first.id?.equals, isActive: true, isPlatformAdmin: adminFlag }] }
  // The admin is a member of nothing; ordinary session 103 is checked against this.
  if (collection === 'memberships') return { docs: [] }
  return { docs: [] }
})

const req = {
  user: { id: ADMIN, isActive: true, isPlatformAdmin: true },
  context: {},
  payload: {
    find,
    findByID: vi.fn(async ({ collection, id }: { collection: string; id: number | string }) => {
      const row = (collection === 'sessions' ? sessions : collection === 'eval-runs' ? runs : {})[String(id)]
      if (!row) throw new Error('NotFound')
      return { id, ...row }
    }),
  },
} as unknown as PayloadRequest

const turn = (session: number, operation: 'create' | 'update' = 'create') =>
  protectMessageCorpusState({
    data: { session, role: 'user', content: 'hola' },
    operation,
    originalDoc: operation === 'update' ? { session, role: 'user', content: 'antes', corpusStatus: 'pending' } : undefined,
    req,
    collection: undefined,
    context: {},
  } as never)

/** The message a refusal carries (a ValidationError keeps it in `data.errors`). */
async function refusal(session: number): Promise<string> {
  try {
    await turn(session)
  } catch (err) {
    return (err as { data?: { errors?: Array<{ message?: string }> } }).data?.errors?.[0]?.message ?? String(err)
  }
  throw new Error('expected a refusal')
}

describe('🔴 R77: turns on an eval conversation', () => {
  it('are allowed while its run is running', async () => {
    await expect(turn(100)).resolves.toMatchObject({ session: 100 })
  })

  it('are refused once the run is not running, or is gone', async () => {
    await expect(turn(101)).rejects.toMatchObject({ status: 403 })
    await expect(turn(102)).rejects.toMatchObject({ status: 403 })
    await expect(turn(101, 'update')).rejects.toMatchObject({ status: 403 })
  })

  it('an account that is no longer platform admin loses its eval conversation', async () => {
    adminFlag = false
    try {
      expect(await refusal(100)).toMatch(/No such conversation/)
    } finally {
      adminFlag = true
    }
  })

  it('an ordinary conversation keeps the membership rule (a non-member admin is refused)', async () => {
    expect(await refusal(103)).toMatch(/No such conversation/)
  })
})
