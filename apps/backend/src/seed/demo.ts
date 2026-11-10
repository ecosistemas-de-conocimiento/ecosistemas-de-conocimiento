/**
 * The demo tenant. ONE organization, a little structure, and the bootstrap
 * admin as its owner — enough that a fresh database is a working product rather
 * than an empty login screen.
 *
 *   Organización: Ecosistemas de Conocimiento  (slug: `demo`)
 *     Equipo: Investigación
 *       Proyecto: Repositorio documental
 *     Equipo: Operación
 *       Proyecto: Base de conocimiento
 *
 * ⚠ THIS IS FICTION, AND IT IS GATED. `./env-gate.ts` allows it on `local` and
 * `dev` automatically and on `demo-0` only by hand. On stage or prod it writes
 * nothing, by either path. Read that file before changing anything here — the
 * assistant answers FROM these rows, so a demo organization on a real
 * deployment means the product confidently describing teams that do not exist.
 *
 * `memberships` carries ACCESS (it needs a real `user`), so no fictional people
 * go in it. The one membership created here is the real admin, as `owner`, so
 * the seeded organization is reachable by the account the installation already has.
 *
 * Idempotent by slug: re-running updates the existing rows in place. Safe to
 * run on every boot.
 *
 * ── WHAT IS IN IT NOW ────────────────────────────────────────────────────────
 *
 * The structure above was, for a long time, ALL of it: an ecosistema with an
 * empty library, an empty graph and a retrieval feature with nothing to
 * retrieve. Three more pieces now come with it, each in its own file:
 *
 *   `./corpus.ts`  250 documents read IN PLACE out of `../corpus-generativo`
 *                  (never vendored; `CORPUS_DIR` overrides). 🔴 Rows only —
 *                  nothing is embedded unless `SEED_CORPUS_INGEST=1`. Read that
 *                  file's header for the cost argument and for what a demo
 *                  without embeddings can and cannot show.
 *   `./review.ts`  an Investigador account and two held documents, so
 *                  `/revision` has something in it.
 *
 * ⚠ ALL OF IT DEGRADES. No corpus next door ⇒ the ecosistema is created and the
 * library is empty, with one log line saying why. No platform admin ⇒ no
 * documents at all, because every row needs an `uploadedBy`. Neither case
 * fails the boot, and neither half-seeds.
 */

import type { Payload } from 'payload'

import { corpusIngestRequested, ingestSeededDocuments, seedCorpusDocuments } from './corpus'
import type { SeedTier } from './env-gate'
import {
  manualIgnoredOverrideWarning,
  resolveBootSeedDecision,
  resolveManualSeedDecision,
} from './env-gate'
import { seedHeldDocuments, seedInvestigador } from './review'
import { safeErrMessage } from '../lib/errorSummary'

interface SeedTeam {
  slug: string
  name: string
  mission: string
  projects: Array<{
    slug: string
    name: string
    status: 'planning' | 'active' | 'paused' | 'done'
    summary: string
  }>
}

const ORG = {
  slug: 'demo',
  name: 'Organización Demo',
  description:
    'Organización de demostración para el repositorio de conocimiento: sube documentos, ' +
    'haz preguntas sobre ellos y califica las respuestas del asistente.',
}

const TEAMS: SeedTeam[] = [
  {
    slug: 'investigacion',
    name: 'Investigación',
    mission:
      'El equipo de Investigación reúne, depura y documenta las fuentes que alimentan la ' +
      'base de conocimiento.',
    projects: [
      {
        slug: 'repositorio-documental',
        name: 'Repositorio documental',
        status: 'active',
        summary:
          'Acervo de documentos de la organización: informes, políticas y notas técnicas. ' +
          'Cada documento se procesa y se indexa para poder consultarlo en lenguaje natural.',
      },
    ],
  },
  {
    slug: 'operacion',
    name: 'Operación',
    mission:
      'El equipo de Operación atiende las consultas cotidianas y detecta qué documentación ' +
      'hace falta a partir de las preguntas que no se pueden responder.',
    projects: [
      {
        slug: 'base-de-conocimiento',
        name: 'Base de conocimiento',
        status: 'active',
        summary:
          'Conversaciones sobre el acervo documental. Las respuestas se califican de 1 a 5 ' +
          'estrellas, y esas calificaciones señalan dónde falta o falla la documentación.',
      },
    ],
  },
]

type Id = number | string

async function upsertBySlug(
  payload: Payload,
  collection: 'organizations' | 'teams' | 'projects',
  slug: string,
  data: Record<string, unknown>,
): Promise<number> {
  const existing = await payload.find({
    collection,
    where: { slug: { equals: slug } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const found = existing.docs[0] as { id: Id } | undefined
  if (found) {
    await payload.update({
      collection,
      id: found.id as never,
      data: data as never,
      overrideAccess: true,
    })
    return Number(found.id)
  }
  const created = (await payload.create({
    collection,
    data: data as never,
    overrideAccess: true,
  })) as { id: Id }
  return Number(created.id)
}

/**
 * Make the installation's admin an OWNER of the demo organization.
 *
 * ⚠ Best-effort by design. A seeded organization nobody can reach is useless,
 * but failing the whole seed because no admin exists yet would be worse — the
 * admin bootstrap (`./admin.ts`) skips when `SEED_ADMIN_PASSWORD` is unset, and
 * that is a legitimate state. So: if there is a platform admin, give them the
 * membership; if not, say so and carry on.
 */
async function linkAdminAsOwner(payload: Payload, organizationId: number): Promise<number | null> {
  const admins = await payload.find({
    collection: 'users',
    where: { isPlatformAdmin: { equals: true } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const admin = admins.docs[0] as { id: Id; email?: string } | undefined
  if (!admin) {
    payload.logger.warn(
      '[seed-demo] no platform admin exists yet, so the demo organization has no members. ' +
        'Set SEED_ADMIN_PASSWORD and restart, or add a membership by hand in /admin.',
    )
    return null
  }

  const existing = await payload.find({
    collection: 'memberships',
    where: { and: [{ user: { equals: admin.id } }, { organization: { equals: organizationId } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  if (existing.docs.length > 0) return Number(admin.id)

  await payload.create({
    collection: 'memberships',
    data: {
      user: admin.id,
      organization: organizationId,
      role: 'owner',
      isActive: true,
      personName: 'Admin',
    } as never,
    overrideAccess: true,
  })
  payload.logger.info(
    { email: admin.email },
    '[seed-demo] linked the platform admin as owner of the demo organization',
  )
  return Number(admin.id)
}

export interface SeedDemoOptions {
  /**
   * WHICH PATH IS THIS? Required — there is deliberately no default.
   *
   *   'boot'   — an automatic path (onInit, a cron, a release script). Gated by
   *              BOOT_SEED_ENVS {local, dev}. Can never write on demo-0.
   *   'manual' — a human deliberately invoked this. Gated by MANUAL_SEED_ENVS
   *              {local, dev, demo-0}.
   *
   * ⚠ Making this REQUIRED is the structural half of the two-tier rule. While
   * it had a default, "a redeploy can never re-invent an organization on
   * demo-0" rested on a single `if` in `payload.config.ts`, and any future
   * automatic caller reaching this function directly would have written there
   * with no human involved. Now the type system forces every new caller to
   * answer the question.
   */
  tier: SeedTier
  /** Re-apply the upserts even on an already-populated database. */
  force?: boolean
}

export async function seedDemo(
  payload: Payload,
  opts: SeedDemoOptions,
): Promise<{ orgId: number; teamIds: number[]; projectIds: number[] } | null> {
  // 🔴 ENVIRONMENT GATE — the shared FLOOR under every entry point, re-checked
  // here against THE CALLER'S OWN TIER.
  //
  // This is defence in depth, not the only check: both current callers gate
  // before calling. Re-checking HERE makes the rule structural — demo content
  // cannot be written outside the caller's tier no matter who calls, so a
  // future caller (an API route, a release script) is born gated instead of
  // reopening the hole.
  //
  // `force: true` does NOT bypass this, and it honours a narrowing
  // SEED_DOMAIN=0, so an operator who declared "no demo content here" is obeyed
  // even by a caller that forgot to check.
  //
  // ⚠ A future HTTP caller needs MORE than this floor: tier permission is
  // necessary, not sufficient. It must also authenticate and carry an explicit
  // opt-in parameter — a bare GET, a crawler or a health probe must never seed.
  const decision = opts.tier === 'manual' ? resolveManualSeedDecision() : resolveBootSeedDecision()
  if (!decision.seed) {
    payload.logger.warn(`[seed-demo] refused (tier=${opts.tier}) — ${decision.reason}`)
    return null
  }

  // Gate on an empty `organizations` table so a populated database is a true
  // no-op (zero writes per boot) and operator edits to the seeded rows are
  // never clobbered. `force: true` (the CLI) re-runs the upserts regardless.
  if (!opts.force) {
    const existing = await payload.count({ collection: 'organizations' })
    if (existing.totalDocs > 0) return null
  }

  const orgId = await upsertBySlug(payload, 'organizations', ORG.slug, {
    name: ORG.name,
    slug: ORG.slug,
    description: ORG.description,
    isActive: true,
  })

  const teamIds: number[] = []
  const projectIds: number[] = []

  for (const team of TEAMS) {
    const teamId = await upsertBySlug(payload, 'teams', team.slug, {
      name: team.name,
      slug: team.slug,
      organization: orgId,
      mission: team.mission,
    })
    teamIds.push(teamId)

    for (const project of team.projects) {
      const projectId = await upsertBySlug(payload, 'projects', project.slug, {
        name: project.name,
        slug: project.slug,
        team: teamId,
        status: project.status,
        summary: project.summary,
      })
      projectIds.push(projectId)
    }
  }

  const adminId = await linkAdminAsOwner(payload, orgId)

  /**
   * 🔴 THE LIBRARY, AND THE REVIEW QUEUE. Everything below needs a real user to
   * hang `uploadedBy` off, so it is skipped — not failed — when the admin
   * bootstrap did not run. `seed/admin.ts` legitimately skips when
   * `SEED_ADMIN_PASSWORD` is unset, and an ecosistema with structure and no
   * documents is the state this seed produced for its whole life before now.
   */
  if (adminId != null) {
    // The Investigador first: a Voz is filed by whoever holds `voces:upload`,
    // and the corpus seed wants that id for its `testimonio` rows.
    const investigadorId = await seedInvestigador(payload, orgId)

    await seedCorpusDocuments(payload, {
      organizationId: orgId,
      uploaderId: adminId,
      investigadorId: investigadorId ?? undefined,
    })

    // ⚠ AFTER the corpus, and deliberately independent of it. These two rows
    // are what makes `/revision` demonstrable, and they must exist on a
    // checkout with no corpus next door.
    await seedHeldDocuments(payload, {
      organizationId: orgId,
      uploadedById: investigadorId ?? adminId,
    })

    // 🔴 THE EXPENSIVE HALF, AND ONLY IF ASKED. See `seed/corpus.ts`: 250
    // documents means 250 ai-service jobs plus two model calls per Voz, and
    // nobody's first `docker compose up` should block on that.
    //
    // ⚠ THROTTLED (`seed/corpus.ts`), so it takes minutes: 250 starts at the
    // default 2 s spacing is ~8 min (inferred). The manual CLI awaits it, gate
    // included. Boot does NOT: `onInit` blocking that long would hold the
    // server off its port. Boot runs it detached; the server process stays up.
    if (corpusIngestRequested()) {
      if (opts.tier === 'manual') {
        await ingestSeededDocuments(payload, orgId, { awaitDrafts: true })
      } else {
        // 🔴 `awaitDrafts` HERE TOO. Without it a draft's slot ends at the
        // re-save, and its gate (a `setImmediate` in the hook) runs detached —
        // so `SEED_INGEST_CONCURRENCY` bounded the saves, not the model calls.
        // The whole call is already detached from boot, so waiting costs the
        // server nothing.
        void ingestSeededDocuments(payload, orgId, { awaitDrafts: true }).catch((err) => {
          payload.logger.warn(
            `[seed-demo] background corpus ingest failed: ${safeErrMessage(err)}`,
          )
        })
      }
    }
  }

  return { orgId, teamIds, projectIds }
}

/**
 * THE MANUAL ENTRY POINT.  `pnpm seed:demo`
 * (which is `payload run src/seed/demo.cli.ts` — see that file for why the
 * runnable half lives in its own module).
 *
 * 🔴 GATED on the MANUAL tier ({local, dev, demo-0}) — this IS the manual path.
 * A human typed the command, so `demo-0` is reachable here and only here; the
 * `onInit` boot path passes tier 'boot' and can never seed demo-0.
 *
 * This is the more dangerous of the two entry points: it passes `force: true`,
 * so it writes into a database that is already populated — no "empty table"
 * safety net. A human pointing this at a hosted `DATABASE_URI` is the realistic
 * accident, and stage/prod are refused here exactly as on boot.
 *
 * 🔴 Exits 1 on refusal, so a wrapper script cannot mistake a refusal for a
 * success. A silent no-op on a gated command is its own bug.
 */
export async function runDemoSeedCli(): Promise<void> {
  const decision = resolveManualSeedDecision()
  if (decision.overrideIgnored) {
    console.warn(`[seed:demo] ${manualIgnoredOverrideWarning()}`)
  }
  if (!decision.seed) {
    console.error(`[seed:demo] REFUSED — ${decision.reason}`)
    process.exit(1)
  }

  const { getPayload } = await import('payload')
  const config = (await import('@payload-config')).default
  const payload = await getPayload({ config })
  payload.logger.info(`[seed:demo] ${decision.reason}`)
  const res = await seedDemo(payload, { tier: 'manual', force: true })
  payload.logger.info(
    res
      ? `[seed:demo] org=${res.orgId} teams=${res.teamIds.join(',')} projects=${res.projectIds.join(',')}`
      : '[seed:demo] no-op (demo already seeded)',
  )

  /**
   * 🔴 WAIT FOR THIS PROCESS'S OWN WORK BEFORE EXITING. `seedDemo` returns with
   * every draft past its gate and enqueue (`awaitDrafts`), but each enqueue arms
   * a graph extraction in THIS process (`lib/graph/schedule.ts`, a
   * `setImmediate` queue). `process.exit(0)` below, like `payload run`'s own,
   * would kill it mid-flight — the same top-level-await lesson `demo.cli.ts`
   * documents. Bounded by `SEED_WAIT_MAX_MS` (default 60 min).
   */
  if (res && corpusIngestRequested()) {
    const { graphQueueDepth } = await import('@/lib/graph/schedule')
    const { waitUntilIdle } = await import('./throttle')
    const maxMs = Number(process.env.SEED_WAIT_MAX_MS) > 0 ? Number(process.env.SEED_WAIT_MAX_MS) : 60 * 60_000
    payload.logger.info('[seed:demo] waiting for in-process graph extraction to finish…')
    const idle = await waitUntilIdle(
      async () => {
        const q = graphQueueDepth()
        return q.running === 0 && q.queued === 0
      },
      { pollMs: 5000, timeoutMs: maxMs, quietPolls: 3 },
    )
    payload.logger.info(
      idle
        ? '[seed:demo] in-process work done. Rows at `publishing` wait on ai-service callbacks to the running server.'
        : `[seed:demo] ⚠ gave up waiting after ${maxMs}ms — graph extraction may still have been in flight.`,
    )
  }
  process.exit(0)
}
