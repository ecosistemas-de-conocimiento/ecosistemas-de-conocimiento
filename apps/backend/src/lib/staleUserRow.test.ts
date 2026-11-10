/**
 * 🔴 `lib/staleUserRow.ts`: a `users` write keeps `isActive` only when it is an
 * intended change, and cannot put back sessions on an inactive row. The races
 * themselves run against a real Postgres in `Users.loginRace.pg.test.ts`.
 */

import type { BaseDatabaseAdapter, UpdateOneArgs } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { guardUserUpdateOne, markIntendedIsActive } from './staleUserRow'

/** A fake adapter: `execute` answers the `users` lock, then the session ids. */
function fake(committed: { active: unknown; sids: string[] }, opts: { tx?: boolean; canBegin?: boolean } = {}) {
  const execute = vi.fn(async () => ({ rows: [] as unknown[] }))
  execute
    .mockResolvedValueOnce({ rows: [{ is_active: committed.active }] })
    .mockResolvedValueOnce({ rows: committed.sids.map((id) => ({ id })) })
  const db = { execute }
  const adapter = {
    sessions: opts.tx ? { t1: { db } } : {},
    drizzle: db,
    beginTransaction: vi.fn(async () => {
      if (opts.canBegin === false) return null
      ;(adapter.sessions as Record<string, unknown>).own = { db }
      return 'own'
    }),
    commitTransaction: vi.fn(async () => {}),
    rollbackTransaction: vi.fn(async () => {}),
  }
  const original = vi.fn(async (args: UpdateOneArgs) => args)
  const guarded = guardUserUpdateOne(adapter as unknown as BaseDatabaseAdapter as never, original as never)
  return { adapter, execute, original, guarded, written: () => original.mock.calls[0]?.[0] as UpdateOneArgs }
}

const sessions = (...ids: string[]) => ids.map((id) => ({ id, createdAt: 'x', expiresAt: 'y' }))

describe('guardUserUpdateOne', () => {
  it('drops an unmarked isActive', async () => {
    const f = fake({ active: false, sids: [] })
    await f.guarded({ collection: 'users', id: 1, data: { isActive: true, displayName: 'Ana' } })
    expect(f.written().data).toEqual({ displayName: 'Ana' })
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('keeps a marked isActive once, then drops a second copy', async () => {
    const f = fake({ active: false, sids: [] })
    const req = { context: { 'users.intendedIsActive': { '1': true } } }
    await f.guarded({ collection: 'users', id: 1, data: { isActive: true }, req: req as never })
    await f.guarded({ collection: 'users', id: 1, data: { isActive: true }, req: req as never })
    expect(f.original.mock.calls.map(([a]) => a.data)).toEqual([{ isActive: true }, {}])
  })

  it('drops a marked isActive whose value differs from the mark', async () => {
    const f = fake({ active: true, sids: [] })
    const req = { context: { 'users.intendedIsActive': { '1': false } } }
    await f.guarded({ collection: 'users', id: 1, data: { isActive: true }, req: req as never })
    expect(f.written().data).toEqual({})
  })

  it('an inactive row only loses sessions, read in the write’s own transaction', async () => {
    const f = fake({ active: false, sids: ['a'] }, { tx: true })
    await f.guarded({ collection: 'users', id: 1, data: { sessions: sessions('a', 'b') }, req: { transactionID: 't1' } as never })
    expect(f.written().data).toEqual({ sessions: sessions('a') })
    expect(f.adapter.beginTransaction).not.toHaveBeenCalled()
  })

  it('a NULL is_active counts as off', async () => {
    const f = fake({ active: null, sids: [] }, { tx: true })
    await f.guarded({ collection: 'users', id: 1, data: { sessions: sessions('b') }, req: { transactionID: 't1' } as never })
    expect(f.written().data).toEqual({ sessions: [] })
  })

  it('an active row writes its sessions as given (a login adds one)', async () => {
    const f = fake({ active: true, sids: ['a'] }, { tx: true })
    await f.guarded({ collection: 'users', id: 1, data: { sessions: sessions('a', 'new') }, req: { transactionID: 't1' } as never })
    expect(f.written().data).toEqual({ sessions: sessions('a', 'new') })
  })

  it('a write without a transaction gets one, held across the write, then committed', async () => {
    const f = fake({ active: false, sids: [] })
    await f.guarded({ collection: 'users', id: 1, data: { sessions: sessions('a') } })
    expect(f.written().req).toEqual({ transactionID: 'own' })
    expect(f.written().data).toEqual({ sessions: [] })
    expect(f.adapter.commitTransaction).toHaveBeenCalledWith('own')
  })

  it('rolls its own transaction back when the write throws', async () => {
    const f = fake({ active: true, sids: [] })
    f.original.mockRejectedValueOnce(new Error('boom'))
    await expect(f.guarded({ collection: 'users', id: 1, data: { sessions: [] } })).rejects.toThrow('boom')
    expect(f.adapter.rollbackTransaction).toHaveBeenCalledWith('own')
    expect(f.adapter.commitTransaction).not.toHaveBeenCalled()
  })

  it('resolves the id from `where`', async () => {
    const f = fake({ active: false, sids: [] }, { tx: true })
    await f.guarded({ collection: 'users', where: { id: { equals: 1 } }, data: { sessions: sessions('a') }, req: { transactionID: 't1' } as never })
    expect(f.written().data).toEqual({ sessions: [] })
  })

  it('leaves other collections and other users fields alone', async () => {
    const f = fake({ active: false, sids: [] })
    await f.guarded({ collection: 'documents', id: 1, data: { isActive: true, sessions: [] } })
    await f.guarded({ collection: 'users', id: 1, data: { loginAttempts: 3 } })
    expect(f.original.mock.calls.map(([a]) => a.data)).toEqual([{ isActive: true, sessions: [] }, { loginAttempts: 3 }])
    expect(f.execute).not.toHaveBeenCalled()
  })
})

describe('markIntendedIsActive', () => {
  const run = (user: unknown, data: Record<string, unknown>, before: unknown) => {
    const req = { user, context: {} as Record<string, unknown> }
    markIntendedIsActive({ data, operation: 'update', originalDoc: { id: 7, isActive: before }, req } as never)
    return req.context['users.intendedIsActive']
  }

  it('marks a platform admin’s change and a server-side one', () => {
    expect(run({ id: 1, isPlatformAdmin: true, isActive: true }, { isActive: false }, true)).toEqual({ '7': false })
    expect(run(undefined, { isActive: true }, false)).toEqual({ '7': true })
  })

  it('does not mark another account, or a value that did not change', () => {
    expect(run({ id: 7, isPlatformAdmin: false, isActive: true }, { isActive: false }, true)).toBeUndefined()
    expect(run(undefined, { isActive: true }, true)).toBeUndefined()
  })
})
