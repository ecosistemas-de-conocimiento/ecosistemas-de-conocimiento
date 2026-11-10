import { sql } from '@payloadcms/db-postgres'
import type { CollectionAfterMeHook, CollectionBeforeChangeHook, CollectionBeforeLoginHook, CollectionConfig } from 'payload'
import { AuthenticationError, ValidationError } from 'payload'

import {
  canAccessAdminPanel,
  isPlatformAdmin,
  isPlatformAdminUser,
  isSelfOrPlatformAdmin,
  platformAdminFieldAccess,
} from '../access'
import { transactionHandle } from '../lib/conversationUploads'
import { loginRateLimitHooks } from '../lib/loginRateLimit'
import { sessionMemberships } from '../lib/roles'
import { markIntendedIsActive } from '../lib/staleUserRow'

/**
 * A person. ONE account for the whole installation; which organizations they
 * can reach is decided by `memberships`, never by a field here.
 *
 * ── THE FIELDS AND THE RULES ─────────────────────────────────────────────────
 *   · `displayName` is the ONLY name field. The frontend reads `displayName`
 *     and its register call sends it. Two competing name
 *     representations is exactly the kind of thing that ends with a UI showing
 *     a blank name because it read the wrong one. `lib/permissions.ts` and
 *     `endpoints/http.ts` read `displayName` too.
 *
 *   · SIGN-UP IS CLOSED (UX demo backlog #6, decided 2026-10-21). It used to
 *     be public (`create: () => true`, proxied by the SvelteKit app's
 *     `/api/auth/register`). A stranger who signed up got a login with no
 *     memberships — nothing to do and a confusing screen. Now a platform
 *     admin creates accounts (Payload admin panel → Users → Create), and so
 *     does anyone who manages members, through `/miembros`. The web
 *     `/api/auth/register` route answers 403 and `/sign-up` redirects to
 *     `/sign-in`.
 *
 *     ⚠ THE FIELD-LEVEL GATES BELOW STAY MANDATORY. `update` is still
 *     self-scoped, so `isPlatformAdmin` writable at document level would let
 *     any account promote itself. `platformAdminFieldAccess` is what stops it.
 *     Do not relax it, and do not add another privilege-bearing field without
 *     the same gate.
 *
 *     ⚠ A brand-new account still resolves to NOTHING: no memberships, so no
 *     organizations, so no documents and no sessions, until an admin adds it.
 *     `IDENTITY_ALLOWED_EMAIL_DOMAIN` still fences which addresses may be
 *     created, if a deployment wants that.
 *
 *   · `isPlatformAdmin` / `isActive` — `isActive` is
 *     the revoke switch the resolver checks (`lib/permissions.ts`); Payload's
 *     own auth knows nothing about it, so it is enforced in `access/`, at
 *     login (`refuseInactiveLogin`), on the open sessions (`dropSessionsOnDeactivate`)
 *     and against stale writes (`pinIsActiveForOthers`, and below every Payload
 *     auth path in `lib/staleUserRow.ts`).
 *
 *   · `email` — only a platform admin changes it. See the field.
 *
 *   · EMAIL NORMALIZATION — Email is the join key
 *     between this backend and anything that verifies its tokens, so
 *     `Ana@Example.org ` and `ana@example.org` must never become two accounts
 *     with two different sets of access.
 *
 * ── COOKIES ──────────────────────────────────────────────────────────────────
 * In production the SvelteKit frontend and this server sit on different
 * subdomains, so the auth cookie needs `SameSite=None; Secure`. Local dev (both
 * on http://localhost) keeps `Lax`, because `Secure` would forbid the cookie
 * over plain HTTP. In practice the frontend proxies through its own server
 * routes, so the token travels frontend → backend server-to-server and the
 * browser only ever sees the frontend's own cookie.
 */
const isProductionAuth = process.env.NODE_ENV === 'production'

/** See `hooks.afterMe` below. A failed read leaves the list empty: no grant. */
export const attachMemberships: CollectionAfterMeHook = async ({ req, response }) => {
  const body = response as { user?: { id?: number | string } | null } | null | undefined
  const user = body?.user
  if (!body || !user || user.id === undefined || user.id === null) return response
  const memberships = await sessionMemberships(req.payload, user.id).catch(() => [])
  return { ...body, user: { ...user, memberships } } as typeof response
}

/**
 * 🔴 A DEACTIVATED ACCOUNT DOES NOT SIGN IN. Runs after the password check, so
 * it answers exactly what a wrong password answers: same error, same 401, no
 * hint that the address exists or was switched off. Payload revokes the
 * session it just added when this throws. Anything but `true` (a NULL
 * included) is off.
 *
 * 🔴 IT READS THE COMMITTED ROW, NOT THE `user` IT IS HANDED. Payload 3.88's
 * login reads the row before the password check, then `addSessionToUser`
 * writes that WHOLE copy back (`payload.db.updateOne({ data: user })`,
 * `dist/auth/sessions.js`) before this hook runs (`dist/auth/operations/login.js`).
 * A deactivation that committed in between was overwritten with
 * `isActive: true`, and the stale copy passed this check (audit 2026-11-10,
 * reproduced 3 of 3 runs). The read goes through the login's own transaction
 * (`req`): `guardStaleUserRows` (`lib/staleUserRow.ts`) took the row under
 * `SELECT … FOR UPDATE` and dropped the stale `isActive` from that write, so
 * what the transaction sees is the committed value. The throw rolls the
 * session write back.
 *
 * ⚠ NEVER WITHOUT `req`. A read on a second connection while the login holds
 * its first exhausted the pool: 20 concurrent logins hung for good on the
 * default 10 connections (re-audit 2026-11-10, measured;
 * `Users.concurrentLogins.pg.test.ts`).
 *
 * ⚠ LOCK ORDER. The login's `updateOne` holds the row lock until it commits.
 * A deactivation that committed before it is what this read sees. One that had
 * the lock first made the login's `updateOne` wait for its commit, so it is
 * seen too. One that comes later waits on the login's lock and writes after
 * it, sessions included (`dropSessionsOnDeactivate`): the row ends off with no
 * session. `Users.loginRace.pg.test.ts`.
 */
export const refuseInactiveLogin: CollectionBeforeLoginHook = async ({ req, user }) => {
  const committed = await req.payload.db
    .findOne({
      collection: 'users',
      where: { id: { equals: (user as { id: number | string }).id } },
      select: { isActive: true },
      req,
    })
    .catch(() => null)
  if ((committed as { isActive?: unknown } | null)?.isActive !== true) {
    throw new AuthenticationError(req.t)
  }
  return user
}

/**
 * 🔴 ONLY A PLATFORM ADMIN MOVES `isActive`, AND A STALE WRITE CANNOT MOVE IT
 * BACK. Payload's update writes the whole row it read (`originalDoc` merged
 * with the body), and field access only keeps the body's `isActive` out. A
 * self-PATCH that read the row before a deactivation committed wrote
 * `isActive: true` back on top of it.
 *
 * So any other signed-in write takes the committed value under `SELECT … FOR UPDATE`, in
 * the update's own transaction: a deactivation that committed first is what it
 * reads, and one that comes later waits for this write and lands after it.
 * Without a transaction handle it reads committed, which narrows the window
 * instead of closing it. `Users.loginRace.pg.test.ts`.
 */
export const pinIsActiveForOthers: CollectionBeforeChangeHook = async ({ data, operation, originalDoc, req }) => {
  if (operation !== 'update' || !data || !req.user || isPlatformAdminUser(req.user)) return data
  const id = (originalDoc as { id?: number | string } | undefined)?.id
  if (id === undefined || id === null) return data
  const tx = await transactionHandle(req)
  let committed: unknown
  if (tx) {
    const res = (await tx.execute(sql`SELECT is_active FROM users WHERE id = ${Number(id)} FOR UPDATE`)) as {
      rows?: Array<{ is_active: unknown }>
    }
    committed = res.rows?.[0]?.is_active
  } else {
    const row = await req.payload.db.findOne({ collection: 'users', where: { id: { equals: id } }, select: { isActive: true } })
    committed = (row as { isActive?: unknown } | null)?.isActive
  }
  return { ...data, isActive: committed === true }
}

/**
 * 🔴 SWITCHING AN ACCOUNT OFF EMPTIES ITS SESSIONS. With `useSessions` (on by
 * default in Payload 3.88, quoted from `dist/collections/config/defaults.js`)
 * a JWT is only honoured while its `sid` is on the row, so this ends every
 * token already handed out instead of letting it live out its 2 h (the default
 * `tokenExpiration`, 7200 s, quoted from the same file).
 *
 * ⚠ HERE, NOT IN A FIELD HOOK: `sessions` is `update: false` at field level,
 * and Payload applies field access before the collection `beforeChange` runs.
 */
export const dropSessionsOnDeactivate: CollectionBeforeChangeHook = ({ data, operation }) => {
  if (operation !== 'update' || !data || !('isActive' in data) || data.isActive === true) return data
  return { ...data, sessions: [] }
}

export const Users: CollectionConfig = {
  slug: 'users',
  auth: {
    cookies: {
      sameSite: isProductionAuth ? 'None' : 'Lax',
      secure: isProductionAuth,
    },
  },
  admin: {
    useAsTitle: 'email',
    defaultColumns: ['email', 'displayName', 'isPlatformAdmin', 'isActive'],
  },
  access: {
    // Closed sign-up: only a platform admin creates accounts. See the header.
    create: isPlatformAdmin,
    // Self-scoped for a normal account (a WHERE constraint, not a boolean — so
    // the roster is not browsable), unrestricted for a platform admin.
    read: isSelfOrPlatformAdmin,
    update: isSelfOrPlatformAdmin,
    delete: isPlatformAdmin,
    // 🔴 Payload's stock rule is `Boolean(user)`: any signed-in account could
    // reset anyone's login lockout via `POST /api/users/unlock`, and 200 vs 403
    // told it which emails exist (code audit 2026-10-28, item 5). A `false`
    // here is a 403 before the email is looked up, so no oracle either.
    // `lockDownPayloadInternals` refuses to boot without this rule.
    unlock: isPlatformAdmin,
    // The panel is where a person edits their own profile, so any active
    // account may open it. What they can SEE there is decided by `read`.
    admin: canAccessAdminPanel,
  },
  hooks: {
    /**
     * `/api/users/me` carries `user.memberships` — `[{ organization, slug,
     * role }]`, active memberships of active ecosistemas only — so the web can
     * ask `isStudent` / `isInvestigador` / `canAdminOrg` (`lib/roles.ts`)
     * without a second round trip. It is the caller's OWN list, from the same
     * resolver access control uses. Presentation for the web; every server
     * gate re-asks.
     */
    afterMe: [attachMemberships],
    ...loginRateLimitHooks,
    beforeLogin: [refuseInactiveLogin],
    // `markIntendedIsActive` last: it reads the `data` that will be written.
    beforeChange: [pinIsActiveForOthers, dropSessionsOnDeactivate, markIntendedIsActive],
    beforeValidate: [
      ({ data, operation, req }) => {
        const next = { ...(data ?? {}) } as Record<string, unknown>

        // ⚠ EMAIL IS THE USER KEY — the `sub` of every token this backend
        // mints and the join key any consumer uses. Normalized here so casing
        // and stray whitespace cannot fork one person into two accounts.
        if (typeof next.email === 'string') next.email = next.email.trim().toLowerCase()

        // Optional domain fence on account creation. Empty/unset env =
        // no check, which is what a test database and a local sandbox want.
        const domain = (process.env.IDENTITY_ALLOWED_EMAIL_DOMAIN ?? '').trim().toLowerCase()
        if (operation === 'create' && domain && typeof next.email === 'string' && next.email) {
          if (!next.email.endsWith(`@${domain}`)) {
            throw new ValidationError({
              collection: 'users',
              errors: [{ path: 'email', message: `Only @${domain} addresses may sign up.` }],
              req,
            })
          }
        }

        return next
      },
    ],
  },
  fields: [
    {
      // 🔴 ONLY A PLATFORM ADMIN CHANGES AN EMAIL. It is the key `/miembros`
      // matches a new member on: an account that could rename itself to the
      // address of someone about to be added would be handed that person's
      // membership and role. Payload strips an unauthorized write (the PATCH
      // succeeds, the address stays). Merged over Payload's own `email` field,
      // which keeps its validation and uniqueness. Verifying a new address is
      // not built.
      name: 'email',
      type: 'email',
      access: { update: platformAdminFieldAccess },
    },
    {
      name: 'displayName',
      type: 'text',
      admin: { description: 'Shown in the UI and carried as the `name` claim on issued tokens.' },
    },
    {
      name: 'avatarUrl',
      type: 'text',
      admin: { description: 'Link to a profile picture. Empty = initials.' },
    },
    {
      name: 'locale',
      type: 'select',
      defaultValue: 'es',
      options: [
        { label: 'Español', value: 'es' },
        { label: 'English', value: 'en' },
      ],
    },
    {
      // ⚠ THE ONE FIELD THAT CAN GIVE AWAY THE WHOLE INSTALLATION.
      //
      // A person may update their own row (and sign-up was public until
      // 2026-10-21), so without this field-level gate that update could carry
      // `isPlatformAdmin: true`. `platformAdminFieldAccess` makes reading AND
      // writing it admin-only: Payload STRIPS the field from an unauthorized
      // write rather than failing it, so the attempt simply does nothing.
      //
      // The first admin is created by `seed/admin.ts` with
      // `overrideAccess: true`. That bootstrap is the only path around this.
      name: 'isPlatformAdmin',
      type: 'checkbox',
      defaultValue: false,
      index: true,
      label: 'Platform administrator',
      access: {
        create: platformAdminFieldAccess,
        read: platformAdminFieldAccess,
        update: platformAdminFieldAccess,
      },
      admin: {
        position: 'sidebar',
        description:
          'Full access to every organization. Only another platform admin can grant or revoke it.',
      },
    },
    {
      // Deactivating a person has to actually take their access away, so every
      // access helper AND the permission resolver check this. Deleting the row
      // would work too, but it takes their sessions and ratings with it.
      name: 'isActive',
      type: 'checkbox',
      defaultValue: true,
      index: true,
      label: 'Account active',
      access: {
        // Nobody deactivates — or reactivates — themselves.
        create: platformAdminFieldAccess,
        update: platformAdminFieldAccess,
      },
      admin: { position: 'sidebar' },
    },
  ],
}
