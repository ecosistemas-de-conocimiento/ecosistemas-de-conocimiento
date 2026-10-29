/**
 * 🔴 PAYLOAD'S OWN `payload-*` COLLECTIONS GET OUR ACCESS RULES TOO.
 *
 * Payload 3.88 adds `payload-locked-documents` and `payload-preferences` inside
 * `buildConfig`'s sanitize step, AFTER `collections` and `plugins` are read, and
 * offers no override option for either. Their stock rules:
 *
 *   · locks — `Boolean(user)` on read/create/update/delete. Any signed-in member
 *     could list every lock (who is editing which row, in every ecosistema) and
 *     create, move or delete locks on rows of an ecosistema they are not in
 *     (audit, measured on real Postgres, 2026-10-28).
 *   · preferences — read/delete owner-scoped, but `update` is `Boolean(user)`:
 *     a member could PATCH another person's row by id.
 *
 * So {@link lockDownPayloadInternals} runs on the SANITIZED config and replaces
 * those rules. `payloadInternals.pg.test.ts` proves each one.
 *
 * ── WHAT THE ADMIN PANEL NEEDS (read in @payloadcms/ui + payload 3.88) ──────
 *   · Lock writes go through `payload.db.*` (`handleFormStateLocking`,
 *     `checkDocumentLockStatus`), which skips access — locking keeps working.
 *   · `handleFormStateLocking` READS locks with `overrideAccess: false` and no
 *     try/catch. A `false` there throws Forbidden and breaks every edit form, so
 *     a member's read is a WHERE on their own rows, never `false`.
 *   · Leaving a document, the client DELETEs the lock it holds over REST. A
 *     member may delete their own rows; nobody else's.
 *   · The client's REST "take over" PATCH moves another person's lock: admins
 *     only. The panel's own take-over path goes through `payload.db.*` and
 *     skips that rule (see ⚠ below).
 *   · Preferences are written by the panel through the local API (access
 *     skipped) or the `/:key` endpoints (owner-scoped `payload.db` calls), so
 *     owner-only `update` costs it nothing.
 *
 * ⚠ A member who opens a row an admin is editing does not see the admin's lock
 * (they cannot read it), so the panel silently takes it over: no "being edited"
 * notice, and the member's save then deletes the admin's lock. Two people can
 * edit the same row; the last save wins. Owner accepted this (2026-10-28) as
 * the price of not telling members who is editing what.
 */

import type { Access, SanitizedConfig, Where } from 'payload'

import { isActiveUser, isAuthenticated, isPlatformAdmin, isPlatformAdminUser, principalId } from './index'

const LOCKS = 'payload-locked-documents'
const PREFERENCES = 'payload-preferences'

/** Rows whose `user` relationship is the caller. `false` for nobody / inactive. */
const ownRowsOnly: Access = ({ req }) => {
  const id = principalId(req)
  if (id === null || !isActiveUser(req.user)) return false
  const relationTo = (req.user as { collection?: string }).collection ?? 'users'
  const where: Where = { and: [{ 'user.value': { equals: id } }, { 'user.relationTo': { equals: relationTo } }] }
  return where
}

const adminOrOwnRows: Access = (args) => (isPlatformAdminUser(args.req.user) ? true : ownRowsOnly(args))

export function lockDownPayloadInternals(config: SanitizedConfig): SanitizedConfig {
  const find = (slug: string) => {
    const collection = config.collections.find((c) => c.slug === slug)
    // Fail loudly: a Payload upgrade that renames these must not silently
    // reopen them.
    if (!collection) throw new Error(`lockDownPayloadInternals: "${slug}" is missing from the config`)
    return collection
  }

  Object.assign(find(LOCKS).access, {
    read: adminOrOwnRows,
    create: isPlatformAdmin,
    update: isPlatformAdmin,
    delete: adminOrOwnRows,
  })
  // 🔴 Not a `payload-*` collection, but the same class of hole: Payload
  // defaults `access.unlock` to `Boolean(user)`. `Users.ts` sets it; this makes
  // losing it (a refactor, a spread that drops the key) a boot failure rather
  // than a silently reopened door (code audit 2026-10-28, item 5).
  if (find('users').access.unlock !== isPlatformAdmin) {
    throw new Error('lockDownPayloadInternals: users.access.unlock must be isPlatformAdmin')
  }

  Object.assign(find(PREFERENCES).access, {
    read: ownRowsOnly,
    // The `user` field's own hook stamps the caller on every write; a WHERE
    // means nothing on create, so this is just "an active account".
    create: isAuthenticated,
    update: ownRowsOnly,
    delete: ownRowsOnly,
  })
  return config
}
