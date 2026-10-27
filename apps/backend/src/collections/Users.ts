import type { CollectionAfterMeHook, CollectionConfig } from 'payload'
import { ValidationError } from 'payload'

import { canAccessAdminPanel, isPlatformAdmin, isSelfOrPlatformAdmin, platformAdminFieldAccess } from '../access'
import { sessionMemberships } from '../lib/roles'

/**
 * A person. ONE account for the whole installation; which organizations they
 * can reach is decided by `memberships`, never by a field here.
 *
 * ── THE MERGE ────────────────────────────────────────────────────────────────
 * This collection is the reconciliation of two `Users.ts` files: the product
 * backend's (Payload auth + `displayName`, public sign-up, self-scoped access)
 * and the standalone identity provider's (`isPlatformAdmin`, `isActive`, email
 * normalization, admin-only creation, field-level self-escalation gate).
 *
 * What was taken from each, and why:
 *
 *   · `displayName` — KEPT from the product side, and it is the ONLY name
 *     field. The IdP carried `firstName`/`lastName`; the frontend already
 *     reads `displayName` and its register call sends it. Two competing name
 *     representations is exactly the kind of thing that ends with a UI showing
 *     a blank name because it read the wrong one. `lib/permissions.ts` and
 *     `endpoints/http.ts` were adapted to read `displayName`.
 *
 *   · SIGN-UP IS CLOSED (UX demo backlog #6, decided 2026-10-21). It used to
 *     be public (`create: () => true`, proxied by the SvelteKit app's
 *     `/api/auth/register`). A stranger who signed up got a login with no
 *     memberships — nothing to do and a confusing screen. Now only a platform
 *     admin creates accounts (Payload admin panel → Users → Create), then adds
 *     the person to an ecosistema (Memberships → Create). The web
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
 *   · `isPlatformAdmin` / `isActive` — KEPT from the IdP side. `isActive` is
 *     the revoke switch the resolver checks (`lib/permissions.ts`); Payload's
 *     own auth knows nothing about it, so it is enforced in `access/`.
 *
 *   · EMAIL NORMALIZATION — KEPT from the IdP side. Email is the join key
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
