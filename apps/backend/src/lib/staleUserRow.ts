import { sql } from '@payloadcms/db-postgres'
import type {
  BaseDatabaseAdapter,
  CollectionBeforeChangeHook,
  Config,
  PayloadRequest,
  UpdateOneArgs,
} from 'payload'

import { isPlatformAdminUser } from '../access'

/**
 * 🔴 A STALE USER ROW DOES NOT SWITCH A DEACTIVATED ACCOUNT BACK ON.
 *
 * Payload 3.88 writes the WHOLE user row it read earlier from several auth
 * paths, all through `payload.db.updateOne` and none under a row lock (quoted
 * from `dist/auth/`): logout (`operations/logout.js`), refresh, verifyEmail,
 * resetPassword, the session add and revoke (`sessions.js`) and the
 * wrong-password lockout (`strategies/local/incrementLoginAttempts.js`, which
 * also writes outside any transaction). A deactivation that committed between
 * the read and the write was overwritten: `isActive: true` and the sessions it
 * had removed came back (audit 2026-11-10).
 *
 * So every `users` write passes two rules here, below every Payload path:
 *
 *   · `isActive` is written only when it is an INTENDED change: a platform
 *     admin, or a server-side write with no user, moving it away from the
 *     value the operation read (`markIntendedIsActive`). Any other copy of it
 *     is dropped and the column keeps what is committed.
 *   · when the committed row is not active, `sessions` can only lose entries.
 *     It is read under `SELECT … FOR UPDATE` in the write's own transaction
 *     (or one opened here, for a write with none), so a deactivation that
 *     committed first is what it sees, and one that comes later waits for
 *     this write and lands after it.
 *
 * Raw SQL, a seed's `UPDATE` or a migration does not go through the adapter
 * and is untouched. `Users.loginRace.pg.test.ts`, `staleUserRow.test.ts`.
 */

const INTENDED = 'users.intendedIsActive'

type Ctx = Record<string, unknown> | undefined
type Session = { id?: unknown }
type Tx = { execute(q: ReturnType<typeof sql>): Promise<unknown> }
type Adapter = BaseDatabaseAdapter & { drizzle?: Tx; sessions?: Record<string, { db?: Tx }> }

/** Collection `beforeChange`, LAST in the list: `data` is what will be written. */
export const markIntendedIsActive: CollectionBeforeChangeHook = ({ data, operation, originalDoc, req }) => {
  if (operation !== 'update' || !data || !('isActive' in data)) return data
  if (req.user && !isPlatformAdminUser(req.user)) return data
  const id = (originalDoc as { id?: number | string } | undefined)?.id
  const before = (originalDoc as { isActive?: unknown } | undefined)?.isActive
  if (id !== undefined && id !== null && data.isActive !== before) {
    const marks = ((req.context as Record<string, unknown>)[INTENDED] ??= {}) as Record<string, boolean>
    marks[String(id)] = data.isActive === true
  }
  return data
}

const targetId = (args: UpdateOneArgs): number | string | undefined =>
  args.id ?? ((args.where as { id?: { equals?: number | string } } | undefined)?.id?.equals)

/** `is_active` under the row lock, and the session ids the row has now. */
async function committed(tx: Tx, id: number | string): Promise<{ active: boolean; sids: Set<unknown> }> {
  const rows = (r: unknown) => (r as { rows?: Array<Record<string, unknown>> }).rows ?? []
  const user = rows(await tx.execute(sql`SELECT is_active FROM users WHERE id = ${Number(id)} FOR UPDATE`))
  const sessions = rows(await tx.execute(sql`SELECT id FROM users_sessions WHERE _parent_id = ${Number(id)}`))
  return { active: user[0]?.is_active === true, sids: new Set(sessions.map((s) => s.id)) }
}

/** The adapter's `updateOne` with both rules applied for `users`. */
export function guardUserUpdateOne(adapter: Adapter, original: BaseDatabaseAdapter['updateOne']): BaseDatabaseAdapter['updateOne'] {
  return async (args) => {
    const data = args.data
    if (args.collection !== 'users' || !data || (!('isActive' in data) && !('sessions' in data))) return original(args)
    const id = targetId(args)
    const next: Record<string, unknown> = { ...data }

    if ('isActive' in next) {
      const marks = (args.req?.context as Ctx)?.[INTENDED] as Record<string, boolean> | undefined
      const key = String(id)
      if (id !== undefined && marks && key in marks && marks[key] === (next.isActive === true)) delete marks[key]
      else delete next.isActive
    }
    if (!Array.isArray(next.sessions) || id === undefined) return original({ ...args, data: next })

    const keepCommitted = async (tx: Tx | undefined) => {
      if (!tx) return
      const row = await committed(tx, id)
      if (!row.active) next.sessions = (next.sessions as Session[]).filter((s) => row.sids.has(s?.id))
    }

    const own = args.req?.transactionID
    const ownId = own instanceof Promise ? await own : own
    if (ownId) {
      await keepCommitted(adapter.sessions?.[String(ownId)]?.db ?? adapter.drizzle)
      return original({ ...args, data: next })
    }
    // No transaction (the lockout's writes): open one so the lock is held
    // until the write commits.
    const txId = await adapter.beginTransaction()
    if (!txId) {
      await keepCommitted(adapter.drizzle)
      return original({ ...args, data: next })
    }
    try {
      await keepCommitted(adapter.sessions?.[String(txId)]?.db)
      const req = { ...(args.req ?? {}), transactionID: txId } as Partial<PayloadRequest>
      const result = await original({ ...args, data: next, req })
      await adapter.commitTransaction(txId)
      return result
    } catch (err) {
      await adapter.rollbackTransaction(txId)
      throw err
    }
  }
}

/** Wraps `postgresAdapter(...)` in `payload.config.ts`. */
export function guardStaleUserRows(result: Config['db']): Config['db'] {
  return {
    ...result,
    init: (args) => {
      const adapter = result.init(args)
      adapter.updateOne = guardUserUpdateOne(adapter as Adapter, adapter.updateOne.bind(adapter))
      return adapter
    },
  }
}
