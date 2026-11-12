/**
 * 🔴 PAYLOAD'S OWN LOCK CHECK ASKS THE POOL FOR A SECOND CONNECTION.
 *
 * Every REST update and delete (`PATCH`/`DELETE /api/<slug>/:id` and the bulk
 * forms) runs with `overrideLock: false`, so Payload 3.88 reads
 * `payload-locked-documents` before the write
 * (`dist/utilities/checkDocumentLockStatus.js`). That read is
 * `payload.db.find` WITHOUT `req`: a second pool checkout while the write's
 * transaction holds the first, the deadlock `findAll` in
 * `lib/permissions.ts` describes. Measured 2026-11-10 by
 * `access/oneConnection.pg.test.ts`: every REST update and delete by id
 * failed on one free connection, in every collection. The local API defaults
 * to `overrideLock: true` and never reached it.
 *
 * So the same check runs here, through `req`, and `beforeOperation` sets
 * `overrideLock: true`: Payload skips its read and still clears the lock row
 * (that delete does pass `req`). Same rule as Payload's: the newest lock, held
 * by someone else and younger than the collection's lock duration, refuses the
 * write with `Locked` (423).
 *
 * 🔴 THE CHECK RUNS ONLY ON A ROW PAYLOAD HAS ALREADY LET THE CALLER WRITE, and
 * its message names no id. A check before access answered 423 on another
 * ecosistema's row, and a bulk `where` resolved without access listed every id
 * it matched: any field of any row could be tested yes/no (audit 2026-11-10,
 * `lockCheckOnReq.pg.test.ts`). So it runs per row, after Payload's own access:
 *  - update, by id and bulk: first in `beforeValidate`, which Payload calls per
 *    row after the access-narrowed fetch (`operations/utilities/update.js`);
 *  - bulk delete: first in `beforeDelete`, per row of the access-narrowed set
 *    (`operations/delete.js`). A refused row lands in the response's `errors`
 *    and the rest go through, as Payload's own check does. Unlike Payload's
 *    check, a refused bulk row LOSES the other person's lock: `overrideLock`
 *    makes Payload delete it before this hook throws, and the bulk commits.
 *    Accepted (audit 2026-11-11): only the admin panel writes in bulk, and
 *    `?overrideLock=true` already lets any writer skip a lock;
 *  - delete by id: Payload calls `beforeDelete` BEFORE its access check
 *    (`operations/deleteByID.js`), so `beforeOperation` runs that check itself
 *    first, the same way. A caller without access is left to Payload, which
 *    answers 403/404 before it would ever read a lock.
 * Payload clears a row's lock just before `beforeValidate`/`beforeDelete`, so
 * `beforeOperation` reads the collection's locks first (the locks table alone,
 * never the caller's `where`) and the per-row hook decides from that read.
 *
 * ⚠ `beforeValidate`/`beforeDelete` cannot tell a REST write from a local write
 * a hook makes on the same collection with the same `req` while it runs; those
 * nested writes get the same lock rule (Payload's local API would skip it).
 *
 * Globals are not covered: their REST update passes no `overrideLock`, which
 * defaults to `true`, so Payload never reads a global's lock there.
 *
 * Applied to every collection in `payload.config.ts` ({@link withLockCheckOnReq}),
 * so a new one cannot forget it.
 */

import type {
  CollectionAfterOperationHook,
  CollectionBeforeDeleteHook,
  CollectionBeforeOperationHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  CollectionSlug,
  PayloadRequest,
  SanitizedCollectionConfig,
  Where,
} from 'payload'
import { Locked, combineQueries, executeAccess } from 'payload'

/** Payload's default lock duration, in seconds (`checkDocumentLockStatus`). */
const DEFAULT_LOCK_SECONDS = 300

const LOCKED_MESSAGE = 'A document is currently locked by another user and cannot be modified.'

/**
 * `req.context` key: per REST write in flight that asked for the check
 * (`update:<slug>`/`delete:<slug>`), the collection's newest lock per row.
 */
const PENDING = 'lockCheckOnReq'

type Lock = { updatedAt?: string; user?: { value?: unknown }; document?: { value?: unknown } }
type LockArgs = { id?: number | string; overrideLock?: boolean; trash?: boolean }

const durationOf = (lockDocuments: unknown): number | null =>
  lockDocuments === false
    ? null
    : typeof lockDocuments === 'object' && lockDocuments !== null && 'duration' in lockDocuments
      ? Number((lockDocuments as { duration: unknown }).duration)
      : DEFAULT_LOCK_SECONDS

const pending = (req: PayloadRequest): Map<string, Map<string, Lock>> =>
  ((req.context as Record<string, unknown>)[PENDING] ??= new Map()) as Map<string, Map<string, Lock>>

/** Newest lock first, per row, read through `req`. */
async function locksOf(req: PayloadRequest, slug: string, id?: number | string): Promise<Map<string, Lock>> {
  const where: Where[] = [{ 'document.relationTo': { equals: slug } }]
  if (id !== undefined) where.push({ 'document.value': { equals: id } })
  const { docs } = await req.payload.db.find({
    collection: 'payload-locked-documents',
    where: { and: where },
    pagination: false,
    sort: '-updatedAt',
    req,
  })
  const newest = new Map<string, Lock>()
  for (const lock of docs as Lock[]) {
    const key = String(lock.document?.value)
    if (!newest.has(key)) newest.set(key, lock)
  }
  return newest
}

function refuseIfLockedByOther(req: PayloadRequest, lock: Lock | undefined, seconds: number): void {
  if (!lock || lock.user?.value === req.user?.id) return
  if (Date.now() - new Date(String(lock.updatedAt)).getTime() <= seconds * 1000) throw new Locked(LOCKED_MESSAGE)
}

/** Payload's own `deleteByID` access check, read-only: is this row the caller's to delete? */
async function mayDelete(req: PayloadRequest, collection: SanitizedCollectionConfig, args: LockArgs): Promise<boolean> {
  const access = await executeAccess({ id: args.id, req, disableErrors: true }, collection.access.delete)
  if (!access) return false
  let where: Where = combineQueries({ id: { equals: args.id } }, access)
  if (collection.trash && !args.trash) where = { and: [where, { deletedAt: { exists: false } }] }
  return Boolean(await req.payload.db.findOne({ collection: collection.slug as CollectionSlug, where, req }))
}

const takeOverLockCheck: CollectionBeforeOperationHook = async ({ args, collection, operation, req }) => {
  if (operation !== 'update' && operation !== 'delete') return args
  const a = args as LockArgs
  if (a.overrideLock !== false) return args
  const seconds = durationOf(collection.lockDocuments)
  if (seconds === null) return args
  if (operation === 'delete' && a.id !== undefined) {
    // No access: Payload refuses before its own lock read, so leave it be.
    if (!(await mayDelete(req, collection, a))) return args
    refuseIfLockedByOther(req, (await locksOf(req, collection.slug, a.id)).get(String(a.id)), seconds)
  } else pending(req).set(`${operation}:${collection.slug}`, await locksOf(req, collection.slug))
  return { ...args, overrideLock: true }
}

const checkUpdatedRow: CollectionBeforeValidateHook = ({ collection, data, operation, originalDoc, req }) => {
  const locks = operation === 'update' && originalDoc ? pending(req).get(`update:${collection.slug}`) : undefined
  if (locks) refuseIfLockedByOther(req, locks.get(String(originalDoc!.id)), durationOf(collection.lockDocuments)!)
  return data
}

const checkDeletedRow: CollectionBeforeDeleteHook = ({ collection, id, req }) => {
  const locks = pending(req).get(`delete:${collection.slug}`)
  if (locks) refuseIfLockedByOther(req, locks.get(String(id)), durationOf(collection.lockDocuments)!)
}

const donePending: CollectionAfterOperationHook = ({ collection, operation, req, result }) => {
  if (operation === 'update' || operation === 'updateByID') pending(req).delete(`update:${collection.slug}`)
  if (operation === 'delete') pending(req).delete(`delete:${collection.slug}`)
  return result
}

/** {@link takeOverLockCheck} last in `beforeOperation`; the per-row checks first in theirs. */
export function withLockCheckOnReq(collection: CollectionConfig): CollectionConfig {
  const hooks = collection.hooks ?? {}
  return {
    ...collection,
    hooks: {
      ...hooks,
      beforeOperation: [...(hooks.beforeOperation ?? []), takeOverLockCheck],
      beforeValidate: [checkUpdatedRow, ...(hooks.beforeValidate ?? [])],
      beforeDelete: [checkDeletedRow, ...(hooks.beforeDelete ?? [])],
      afterOperation: [...(hooks.afterOperation ?? []), donePending],
    },
  }
}
