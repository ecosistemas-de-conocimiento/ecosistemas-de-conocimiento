/**
 * 🔴 UPGRADE TRIPWIRE for `currentTxid` in `conversationUploads.ts`.
 *
 * The post-commit cleanup learns its transaction's id by reaching into
 * `@payloadcms/drizzle`'s private session registry:
 * `payload.db.sessions[transactionID].db` is the transaction's own drizzle
 * handle (3.88.0 `transactions/beginTransaction.js`). If an upgrade changes
 * that shape, `currentTxid` returns null and every upload cleanup is skipped:
 * no wrongful deletion, but every file becomes an orphan.
 *
 * The real-Postgres suite proves it end to end, but it SKIPS without docker.
 * This file runs everywhere: it reads the installed adapter's source and
 * checks the one assignment we depend on, and it pins `currentTxid` against
 * that shape.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { currentTxid } from './conversationUploads'

describe('the @payloadcms/drizzle transaction registry `currentTxid` reads', () => {
  it('still stores each transaction as sessions[id] = { db: <tx>, … }', () => {
    // pnpm keeps @payloadcms/drizzle private to @payloadcms/db-postgres, so
    // resolve it from there.
    const fromHere = createRequire(import.meta.url)
    const fromPostgres = createRequire(fromHere.resolve('@payloadcms/db-postgres'))
    const drizzleEntry = fromPostgres.resolve('@payloadcms/drizzle')
    const source = readFileSync(
      path.join(path.dirname(drizzleEntry), 'transactions', 'beginTransaction.js'),
      'utf8',
    )

    // If this fails after an upgrade: re-read beginTransaction.js and fix
    // `currentTxid` before changing this assertion.
    expect(source).toMatch(/this\.sessions\[id\]\s*=\s*\{\s*db:\s*transaction/)
  })

  it('currentTxid reads txid_current() through that handle', async () => {
    const execute = vi.fn(async () => ({ rows: [{ xid: '4242' }] }))
    const req = {
      transactionID: 'tx-1',
      payload: { db: { sessions: { 'tx-1': { db: { execute } } } }, logger: { error: vi.fn() } },
    }

    await expect(currentTxid(req as never)).resolves.toBe('4242')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('says so LOUDLY when there is a transaction but no handle', async () => {
    const error = vi.fn()
    const req = { transactionID: 'tx-1', payload: { db: { sessions: {} }, logger: { error } } }

    await expect(currentTxid(req as never)).resolves.toBeNull()
    expect(error).toHaveBeenCalledWith(
      { transactionID: 'tx-1' },
      expect.stringContaining('will NOT be cleaned up'),
    )
  })

  it('is quietly null with no transaction at all (autocommit)', async () => {
    const error = vi.fn()

    await expect(currentTxid({ payload: { logger: { error } } } as never)).resolves.toBeNull()
    expect(error).not.toHaveBeenCalled()
  })
})
