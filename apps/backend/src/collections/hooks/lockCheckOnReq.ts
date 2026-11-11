/**
 * 🔴 PAYLOAD'S OWN LOCK CHECK ASKS THE POOL FOR A SECOND CONNECTION.
 *
 * Every REST update and delete (`PATCH`/`DELETE /api/<slug>/:id`, the bulk
 * forms, `POST /api/globals/<slug>`) runs with `overrideLock: false`, so
 * Payload 3.88 reads `payload-locked-documents` before the write
 * (`dist/utilities/checkDocumentLockStatus.js`). That read is
 * `payload.db.find` WITHOUT `req`: a second pool checkout while the write's
 * transaction holds the first, the deadlock `findAll` in
 * `lib/permissions.ts` describes. Measured 2026-11-10 by
 * `access/oneConnection.pg.test.ts`: every REST update and delete by id
 * failed on one free connection, in every collection. The local API defaults
 * to `overrideLock: true` and never reached it.
 *
 * So the same check runs here, in `beforeOperation`, through `req`, and then
 * sets `overrideLock: true`: Payload skips its read and still clears the lock
 * row (that delete does pass `req`). Same rule as Payload's: a lock held by
 * someone else and younger than the collection's lock duration refuses the
 * write with `Locked` (423).
 *
 * ⚠ A BULK write is refused as a whole when any row it matches is locked by
 * someone else; Payload refused only that row. Nothing in the app writes in
 * bulk over REST, the admin panel's bulk edit aside.
 *
 * Applied to every collection and global in `payload.config.ts`
 * ({@link withLockCheckOnReq}), so a new one cannot forget it.
 */

import type {
  CollectionBeforeOperationHook,
  CollectionConfig,
  GlobalBeforeOperationHook,
  GlobalConfig,
  PayloadRequest,
  Where,
} from 'payload'
import { Locked } from 'payload'

/** Payload's default lock duration, in seconds (`checkDocumentLockStatus`). */
const DEFAULT_LOCK_SECONDS = 300

type LockArgs = { id?: number | string; where?: Where; overrideLock?: boolean }

const durationOf = (lockDocuments: unknown): number | null =>
  lockDocuments === false
    ? null
    : typeof lockDocuments === 'object' && lockDocuments !== null && 'duration' in lockDocuments
      ? Number((lockDocuments as { duration: unknown }).duration)
      : DEFAULT_LOCK_SECONDS

async function refuseIfLockedByOther(req: PayloadRequest, where: Where, seconds: number, message: string): Promise<void> {
  const locks = await req.payload.db.find({
    collection: 'payload-locked-documents',
    where,
    pagination: false,
    sort: '-updatedAt',
    req,
  })
  const now = Date.now()
  for (const lock of locks.docs as Array<{ updatedAt?: string; user?: { value?: unknown } }>) {
    const fresh = now - new Date(String(lock.updatedAt)).getTime() <= seconds * 1000
    if (fresh && lock.user?.value !== req.user?.id) throw new Locked(message)
  }
}

const checkCollectionLocks: CollectionBeforeOperationHook = async ({ args, collection, operation, req }) => {
  if (operation !== 'update' && operation !== 'delete') return args
  const a = args as LockArgs
  if (a.overrideLock !== false) return args
  const seconds = durationOf(collection.lockDocuments)
  if (seconds === null) return args
  const slug = collection.slug
  let ids: Array<number | string>
  if (a.id !== undefined) ids = [a.id]
  else {
    const matched = await req.payload.find({
      collection: slug,
      where: a.where ?? {},
      depth: 0,
      pagination: false,
      overrideAccess: true,
      select: {},
      req,
    })
    ids = matched.docs.map((d) => d.id)
  }
  if (ids.length > 0) {
    await refuseIfLockedByOther(
      req,
      { and: [{ 'document.relationTo': { equals: slug } }, { 'document.value': { in: ids } }] },
      seconds,
      `Document with ID ${ids.length === 1 ? ids[0] : ids.join(', ')} is currently locked by another user and cannot be modified.`,
    )
  }
  return { ...args, overrideLock: true }
}

const checkGlobalLock: GlobalBeforeOperationHook = async ({ args, global, req }) => {
  const a = args as LockArgs
  if (a.overrideLock !== false) return args
  const seconds = durationOf(global.lockDocuments)
  if (seconds === null) return args
  await refuseIfLockedByOther(
    req,
    { globalSlug: { equals: global.slug } },
    seconds,
    `Global document with slug "${global.slug}" is currently locked by another user and cannot be modified.`,
  )
  return { ...args, overrideLock: true }
}

/** {@link checkCollectionLocks}, last in `beforeOperation`. */
export function withLockCheckOnReq(collection: CollectionConfig): CollectionConfig {
  return {
    ...collection,
    hooks: { ...collection.hooks, beforeOperation: [...(collection.hooks?.beforeOperation ?? []), checkCollectionLocks] },
  }
}

/** {@link checkGlobalLock}, last in `beforeOperation`. */
export function withGlobalLockCheckOnReq(global: GlobalConfig): GlobalConfig {
  return {
    ...global,
    hooks: { ...global.hooks, beforeOperation: [...(global.hooks?.beforeOperation ?? []), checkGlobalLock] },
  }
}
