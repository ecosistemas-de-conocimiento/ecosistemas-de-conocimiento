import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Users } from './collections/Users'
import { Sessions } from './collections/Sessions'
import { Messages } from './collections/Messages'
import { Ratings } from './collections/Ratings'
import { Documents } from './collections/Documents'
import { Media } from './collections/Media'
import { AiServiceCallbacks } from './collections/AiServiceCallbacks'
import { Organizations } from './collections/Organizations'
import { Teams } from './collections/Teams'
import { Projects } from './collections/Projects'
import { Memberships } from './collections/Memberships'

import { jwksEndpoint } from './endpoints/jwks'
import { meEndpoint } from './endpoints/me'
import { resolveEndpoint } from './endpoints/resolve'
import { tokenEndpoint } from './endpoints/token'

import { checkAIServiceCapabilities } from './lib/capabilityCheck'
import { checkCallbackConfig } from './lib/callbackConfig'
import { checkAudioServiceConfig } from './lib/audioClient'
import { startSessionJanitor } from './lib/sessionJanitorScheduler'
import { startTranscriptionJanitor } from './lib/transcriptionJanitor'
import { seedAdmin } from './seed/admin'
import { seedDemo } from './seed/demo'
import { bootIgnoredOverrideWarning, resolveBootSeedDecision } from './seed/env-gate'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

/**
 * THE BACKEND, AND THE IDENTITY PROVIDER. One Payload app, two jobs.
 *
 * Domain: organizations, their people, their documents, the chat sessions over
 * those documents and the star ratings of the answers.
 *
 * Identity: this app also signs the access tokens and publishes the JWK Set
 * peers verify them against (`endpoints/`, `lib/jwt/`). It was merged in from a
 * separate Payload app; `lib/permissions.ts` explains what survived that merge
 * and what did not.
 */

// Local dev origins for the SvelteKit frontend (5173) plus preview / test
// ports. Production origins come from ALLOWED_ORIGINS.
const LOCAL_DEV_ORIGINS = [
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]

const envOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0)

const allowedOrigins = envOrigins.length > 0 ? envOrigins : LOCAL_DEV_ORIGINS

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  cors: {
    origins: allowedOrigins,
    headers: ['authorization', 'content-type', 'x-csrf-token'],
  },
  csrf: allowedOrigins,
  collections: [
    // Identity + tenancy
    Users,
    Organizations,
    Memberships,
    // Domain structure
    Teams,
    Projects,
    // Knowledgebase + chat
    Documents,
    Media,
    Sessions,
    Messages,
    Ratings,
    // Plumbing
    AiServiceCallbacks,
  ],
  /**
   * The identity surface. Payload prefixes custom endpoints with `routes.api`,
   * so these answer at `/api/v1/identity/*`.
   *
   * ⚠ JWKS IS THE ONE EXCEPTION. It is registered here as
   * `/.well-known/jwks.json` and therefore really serves at
   * `/api/.well-known/jwks.json`; `next.config.ts` rewrites the bare root path
   * onto it, because every JWT verifier fetches exactly the root URL. That
   * rewrite is load-bearing — deleting it breaks verification everywhere.
   */
  endpoints: [jwksEndpoint, meEndpoint, resolveEndpoint, tokenEndpoint],
  editor: lexicalEditor(),
  /**
   * ⚠ THIS HOOK IS THE BOOT TIER. Everything here fires AUTOMATICALLY on every
   * start, on every environment, including stage and prod. Anything demo- or
   * fixture-shaped added here must go through `seed/env-gate.ts` and must log
   * its decision either way.
   *
   * Every step below is non-fatal by design: a boot that dies on a
   * configuration problem takes the admin panel down with it, and the admin
   * panel is where you would fix the problem.
   */
  onInit: async (payload) => {
    // 1. Is the ai-service ingest-callback round-trip actually configured HERE?
    //    The failure this catches is silent and total: documents are enqueued,
    //    nothing ever calls back, and every upload sits in `embedding` forever
    //    with no error anywhere. Runs FIRST so an operator sees it even if the
    //    capability check below throws. Never throws itself.
    checkCallbackConfig(payload.logger)

    // 1b. Is audio transcription configured? Audio rides the SAME callback
    //     round-trip (audio-service signs with the ai-service scheme on
    //     purpose), so this only checks the two audio-specific vars. Unlike the
    //     check above, a missing audio config is loud at runtime too — the row
    //     fails visibly rather than hanging — but an operator should learn about
    //     it at boot, not from a user. Never throws.
    checkAudioServiceConfig(payload.logger)

    // 2. Does the ai-service in THIS environment have what this build needs?
    //    Ask before anything uses it, so a wrong promotion order fails at
    //    deploy time rather than leaving uploads stuck in `embedding`.
    await checkAIServiceCapabilities(payload.logger)

    // 3. The bootstrap admin. Deliberately OUTSIDE both seed tiers — stage and
    //    prod need an administrator. Its brakes are "no default password" and
    //    "never throw"; see seed/admin.ts.
    await seedAdmin(payload)

    // 4. Demo content: one organization, its teams and projects, owned by the
    //    admin. BOOT TIER — gated to EDC_ENV in {local, dev}. The gate is an
    //    ALLOWLIST and fails CLOSED; SEED_DOMAIN can only NARROW it, never
    //    widen it. `demo-0` is deliberately NOT in this tier: it can be seeded
    //    by an explicit CLI run, never by a redeploy.
    //
    //    Decided at boot rather than at import, so the log reflects the
    //    environment the process actually came up in.
    const demoDecision = resolveBootSeedDecision()
    // A SEED_DOMAIN set while EDC_ENV sits outside the allowlist is the
    // misconfiguration people actually hit. Say so — silence would hide it.
    if (demoDecision.overrideIgnored) {
      payload.logger.warn(`[seed-demo] ${bootIgnoredOverrideWarning()}`)
    }
    // Log the decision EITHER WAY: a boot log must answer "did this seed, and
    // why / why not", naming the observed EDC_ENV.
    payload.logger.info(`[seed-demo] ${demoDecision.reason}`)
    if (demoDecision.seed) {
      try {
        // tier: 'boot' re-asserts the NARROW list inside seedDemo itself, so
        // "a redeploy can never seed demo-0" does not rest on this `if` alone.
        const res = await seedDemo(payload, { tier: 'boot' })
        if (res) {
          payload.logger.info(
            { orgId: res.orgId, teams: res.teamIds.length, projects: res.projectIds.length },
            '[seed-demo] bootstrapped the demo organization',
          )
        }
      } catch (err) {
        payload.logger.warn(
          { err: (err as Error).message },
          '[seed-demo] failed to bootstrap the demo organization (continuing)',
        )
      }
    }

    // 5. Session janitor: arm the recurring stale-session reaper. Disabled by
    //    default (SESSION_JANITOR_ENABLED); the first sweep is one interval
    //    away so a deploy never reaps data the instant it boots.
    startSessionJanitor(payload)

    // 6. Stalled-transcription sweep. ON by default, unlike the session
    //    janitor: it only turns an invisible stuck state into a visible,
    //    retryable failure — it never deletes anything.
    //
    //    🔴 It covers the one audio failure mode NO health check can see: if
    //    audio-service's callback-worker container is not running, every
    //    transcription succeeds and not one webhook is ever delivered, so the
    //    document waits in `transcribing` forever and looks exactly like one
    //    that is still working. See lib/transcriptionJanitor.ts.
    startTranscriptionJanitor(payload)
  },
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URI || '',
    },
    /**
     * ⚠ SCHEMA PUSH IS ON BY DEFAULT, AND THAT IS DELIBERATE *FOR NOW*.
     *
     * This repo has NO baseline migration yet — see `src/migrations/README.md`.
     * Until one is generated, push is the only thing that creates the schema,
     * so turning it off leaves every environment with an empty database.
     *
     * 🔴 The moment a baseline exists, flip this to migrations-only
     * (`PAYLOAD_DISABLE_PUSH=1` in every deployed environment) and make `start`
     * run `payload migrate` first. Push against a real database is how columns
     * get dropped without anyone approving it.
     */
    push: process.env.NODE_ENV !== 'test' && process.env.PAYLOAD_DISABLE_PUSH !== '1',
  }),
})
