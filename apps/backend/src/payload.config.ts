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
import { GraphEntities } from './collections/GraphEntities'
import { GraphMentions } from './collections/GraphMentions'
import { GraphRelations } from './collections/GraphRelations'
import { Media } from './collections/Media'
import { AiServiceCallbacks } from './collections/AiServiceCallbacks'
import { AnonymisationReviews } from './collections/AnonymisationReviews'
import { Organizations } from './collections/Organizations'
import { Teams } from './collections/Teams'
import { Projects } from './collections/Projects'
import { Memberships } from './collections/Memberships'

import { graphEndpoints } from './endpoints/graph'
import { lenguasEndpoint } from './endpoints/lenguas'
import { jwksEndpoint } from './endpoints/jwks'
import { meEndpoint } from './endpoints/me'
import { resolveEndpoint } from './endpoints/resolve'
import { tokenEndpoint } from './endpoints/token'

import { checkAIServiceCapabilities } from './lib/capabilityCheck'
import { checkCallbackConfig } from './lib/callbackConfig'
import { checkAudioServiceConfig } from './lib/audioClient'
import { startEmbeddingJanitor } from './lib/embeddingJanitor'
import { startPublishJanitor } from './lib/publishJanitor'
import { startSessionJanitor } from './lib/sessionJanitorScheduler'
import { startTranscriptionJanitor } from './lib/transcriptionJanitor'
import { describeStorageMode, resolveStorageMode } from './lib/storage/client'
import { ensureStorageBucketAtBoot } from './lib/storage/ensureBucket'
import { storagePlugins } from './lib/storage/plugin'
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
    // 🔴 The audit trail for every human override of the anonymisation gate.
    // Append-only; see the collection.
    AnonymisationReviews,
    /**
     * The corpus graph. Written ONLY by the extraction pipeline
     * (`lib/graph/writer.ts`); every create/update/delete access rule is
     * `() => false`, platform admins included. See `plan/adr-corpus-graph.md`.
     *
     * 🔴 Three compound UNIQUE indexes on these tables are HAND-WRITTEN into the
     * migration and are absent from the drizzle schema push diffs against — so a
     * `PAYLOAD_ALLOW_PUSH=1` boot can silently drop them, and de-duplication
     * goes back to being a check rather than a lock. Same trap as the four
     * baseline indexes; see `src/migrations/README.md`.
     */
    GraphEntities,
    GraphMentions,
    GraphRelations,
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
   *
   * 🔴 `graphEndpoints` (`/api/graph/*`) IS THE ONLY READ PATH TO THE GRAPH. The
   * three collections above are `read: () => false` for everyone, because
   * Payload access control can express one of ADR §6's three gates and the other
   * two are a JOIN to `documents` and a `HAVING`. Both live in SQL in
   * `lib/graph/queries.ts`, which is what these three routes call. Re-opening
   * `read` on a graph collection would restore the side door those routes exist
   * to close.
   */
  endpoints: [
    jwksEndpoint,
    meEndpoint,
    resolveEndpoint,
    tokenEndpoint,
    ...graphEndpoints,
    // `/api/lenguas` — read its header for why `lengua` needs its own route.
    lenguasEndpoint,
  ],
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
  /**
   * WHERE UPLOADED FILES GO. Empty when no `S3_*` variables are set, and that
   * empty list IS the local-disk fallback: with no plugin, Payload leaves
   * `media` on `./media/` exactly as before. See `lib/storage/plugin.ts` — and
   * read the access-control contract at the top of it before changing anything
   * there, because the plugin can be configured to hand out presigned URLs and
   * that would bypass every rule in `collections/Media.ts`.
   */
  plugins: storagePlugins(),
  onInit: async (payload) => {
    // 0. SAY WHICH STORAGE MODE THIS PROCESS CAME UP IN, first, before anything
    //    can write a file. "Did this put my upload on disk or in the bucket"
    //    must be answerable from the boot log alone. A PARTIAL S3 config logs at
    //    ERROR here: it silently falls back to a container filesystem the next
    //    redeploy throws away, which is the one failure nobody notices.
    const storageMode = resolveStorageMode()
    const storageLog = describeStorageMode(storageMode)
    payload.logger[storageLog.level](storageLog.message)

    // 0b. Make sure the bucket exists. Idempotent and re-runnable BY DESIGN —
    //     RustFS keeps its IAM store on the data volume and no env var seeds it,
    //     so provisioning is an operation that repeats, never an init container
    //     that exits. Skips entirely on local disk; retries through the window
    //     where RustFS's control plane is up but its storage layer still 503s;
    //     then logs at ERROR and CONTINUES. It never throws — gating boot on
    //     storage crash-loops every replica and takes down the admin panel you
    //     would use to fix it. /api/health/ready carries that signal instead.
    await ensureStorageBucketAtBoot(payload.logger)

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

    // 7. Stalled-PUBLISH sweep. Same shape and same philosophy as (6): ON by
    //    default, writes one text field, never deletes and never re-drives.
    //
    //    🔴 It covers the second non-terminal state this backend has, and the
    //    one nothing was watching. A 250-document seed left 145 rows in
    //    `publicationStatus: 'publishing'` — 99 of them with no error and no
    //    ingest id at all, frozen for 25+ minutes because the ai-service rate
    //    limiter refused the enqueue after the row had already been flipped to
    //    the in-flight state.
    //
    //    ⚠ It does NOT re-publish anything. The outcome of an accepted ingest
    //    is unknowable from here, and a sweep that re-enqueued 145 documents on
    //    a timer would recreate the very rate-limit burst it is cleaning up
    //    after. See lib/publishJanitor.ts.
    startPublishJanitor(payload)

    // 8. Stalled-EMBEDDING sweep. Same shape and philosophy again: ON by
    //    default, never re-drives, never deletes.
    //
    //    🔴 It closes the LAST of the three states nothing was watching, and
    //    the one this file's own boot check (1) already warns about: when the
    //    callback round-trip is half-configured, ai-service embeds the document
    //    and has nowhere to report it, so the row sits in
    //    `ingestStatus: 'embedding'` with no error and looks, to the uploader,
    //    exactly like an upload still in progress.
    //
    //    ⚠ Unlike the publish sweep, this one DOES change the status — to
    //    `failed`. That is not a stronger claim about the document, it is the
    //    gate `planIngestRetry` checks: a row left at `embedding` with a message
    //    on it would tell the user to retry next to a button the API 409s. A
    //    late callback still writes `ready` and clears the message, so a false
    //    positive heals itself. See lib/embeddingJanitor.ts.
    startEmbeddingJanitor(payload)
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
     * ⚠ SCHEMA PUSH IS OFF UNLESS YOU ASK FOR IT. The gate is opt-IN, so the
     * safe behaviour is what you get by forgetting.
     *
     * The baseline migration exists (`src/migrations/`), so migrations — not
     * push — create and advance the schema everywhere, local included. Both
     * container entrypoints run `payload migrate` first: `pnpm start` in the
     * production image, and the `CMD` in `Dockerfile.dev`. Nothing needs push
     * to get a schema any more.
     *
     * 🔴 WHY THIS GATE IS OPT-IN RATHER THAN OPT-OUT. The baseline carries four
     * indexes that are hand-written and therefore absent from the drizzle
     * schema Payload diffs against — including the three compound UNIQUE
     * indexes that are the only real lock behind the `beforeValidate`
     * de-duplication hooks (`ratings`, `memberships`, `ai_service_callbacks`).
     * Push reconciles the database toward that schema, so a push-enabled boot
     * can remove them. Nothing errors; the ratings table just starts accepting
     * duplicate rows again, and every average computed over it is quietly
     * wrong. See the comment block in the baseline migration.
     *
     * A fail-open gate meant one forgotten variable in one environment was
     * enough to lose those locks silently. That is the wrong direction to fail
     * in, so an environment that wants push must now say so out loud.
     *
     * ⚠ Setting `PAYLOAD_ALLOW_PUSH=1` is for iterating on the schema locally.
     * When you do, expect the four hand-written indexes to disappear, and cut
     * a new migration rather than leaving the database in that state.
     */
    push: process.env.NODE_ENV !== 'test' && process.env.PAYLOAD_ALLOW_PUSH === '1',
  }),
})
