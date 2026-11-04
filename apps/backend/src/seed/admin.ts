import type { Payload } from 'payload'

// ⚠ EXTENSIONLESS ON PURPOSE — do not "fix" this to './env-gate.js'.
//
// This file is the only one in src/seed/ that Next BUNDLES: payload.config.ts
// imports it for `onInit`, so it lands in the bundler's module graph, and the
// bundler does not map a `.js` specifier onto a `.ts` file. The rest of
// src/seed/ is reached only through the Payload CLI.
import { currentAppEnv } from './env-gate'

/**
 * THE BOOTSTRAP ADMIN. On first boot, if there are ZERO users, create one from
 * `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`. Any existing user short-circuits
 * it, so this is a no-op on every subsequent start and never clobbers a real
 * account.
 *
 * Two rules this file exists to enforce:
 *
 *  1. 🔴 NO DEFAULT PASSWORD. NONE, not even for local development. This
 *     backend is the identity provider — it holds the signing key and mints
 *     tokens for every organization — so a committed credential here is a total
 *     compromise, not a local inconvenience. An unset `SEED_ADMIN_PASSWORD`
 *     means "skip, loudly", never "invent one".
 *
 *     ⚠ NO DEFAULT KEYED ON `NODE_ENV !== 'production'` EITHER. It is not
 *     survivable for an identity provider, and "deployed dev runs
 *     NODE_ENV=production" is exactly the kind of assumption
 *     that turns "local only" into "on the internet". Set the variable — see
 *     `.env.example`.
 *
 *  2. 🔴 NEVER THROW. It runs inside `onInit`, so a throw takes the whole app
 *     down at boot — including the admin panel you would use to fix it. The
 *     recovery path when this skips is Payload's own create-first-user flow at
 *     `/admin`, which is available precisely because the table is empty.
 *
 * ⚠ DELIBERATELY NOT ENVIRONMENT-GATED, by EITHER seed tier, and it must stay
 * that way. `./env-gate.ts` keeps demo content off stage and prod. This is not
 * demo content: it is the account the installation needs in order to be
 * administered at all. Stage and prod need an admin; an environment with no way
 * in is a worse outcome than one with demo data. Its brakes are the two rules
 * above, not the environment.
 *
 * It does read `EDC_ENV`, but only to LOG it: a boot log has to answer "was an
 * admin created here, and where is 'here'?" without anyone re-deriving it.
 * Do not turn that read into a gate.
 */

/**
 * Used when `SEED_ADMIN_EMAIL` is unset. An address, never a credential.
 *
 * 🔴 NOT `admin@localhost`, which is what this used to be. Payload's `email`
 * field validation REJECTS a bare hostname, so on a fresh database with
 * `SEED_ADMIN_PASSWORD` set but no `SEED_ADMIN_EMAIL`, the admin was never
 * created — measured, HTTP 400 "Please enter a valid email address". And
 * because every seeded document needs an `uploadedBy`, nothing else got seeded
 * either. The failure looked like an empty demo, not like a bad default.
 *
 * `.test` is reserved by RFC 2606 and can never be a real domain, so this
 * cannot accidentally address a live mailbox.
 */
export const DEFAULT_SEED_ADMIN_EMAIL = 'admin@ecosistemas.test'

export async function seedAdmin(payload: Payload): Promise<void> {
  // Observed for the log only. NOT consulted in any decision below.
  const appEnv = currentAppEnv() ?? '<unset>'

  try {
    const email = process.env.SEED_ADMIN_EMAIL?.trim() || DEFAULT_SEED_ADMIN_EMAIL
    const password = process.env.SEED_ADMIN_PASSWORD

    if (!password) {
      payload.logger.warn(
        { appEnv },
        `[seed-admin] EDC_ENV=${appEnv} — SEED_ADMIN_PASSWORD is not set, so refusing to ` +
          'create a platform admin with a default or empty password. SKIPPING; no user was ' +
          'created. Set SEED_ADMIN_PASSWORD (and SEED_ADMIN_EMAIL) and restart, or create ' +
          'the first user through /admin.',
      )
      return
    }

    const existing = await payload.count({ collection: 'users' })
    if (existing.totalDocs > 0) {
      payload.logger.info(
        { appEnv },
        `[seed-admin] EDC_ENV=${appEnv} — a user already exists; skipping admin seed.`,
      )
      return
    }

    await payload.create({
      collection: 'users',
      // ⚠ `overrideAccess: true` is what lets this write `isPlatformAdmin`. That
      // field is gated to existing platform admins (collections/Users.ts), and
      // on an empty database there are none — so this bootstrap is the ONLY
      // path around the gate, and it is deliberately the only one.
      data: {
        email,
        password,
        displayName: 'Admin',
        isPlatformAdmin: true,
        isActive: true,
      },
      overrideAccess: true,
    })

    payload.logger.info(
      { email, appEnv },
      `[seed-admin] platform admin created on EDC_ENV=${appEnv} ` +
        '(service account — deliberately not environment-gated).',
    )
  } catch (err) {
    payload.logger.error(
      { err, appEnv },
      '[seed-admin] failed to seed the platform admin. Continuing boot — fix the cause and ' +
        'restart, or create the first user through /admin.',
    )
  }
}
