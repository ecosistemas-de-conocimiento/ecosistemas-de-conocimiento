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
 * ── WHAT THIS REPLACED ───────────────────────────────────────────────────────
 * The seed this came from invented three teams, four projects and four
 * fictional PEOPLE with addresses at a real company, written into `memberships`
 * as directory entries with no accounts behind them. That shape is gone for two
 * reasons: `memberships` now carries ACCESS (it needs a real `user`), and a
 * dropped `seedFleet`/`catalog` pair that registered an app fleet has no
 * meaning in a single-product repo.
 *
 * The one membership created here is the real admin, as `owner`, so the seeded
 * organization is reachable by the account the installation already has.
 *
 * Idempotent by slug: re-running updates the existing rows in place. Safe to
 * run on every boot.
 */

import type { Payload } from 'payload'

import type { SeedTier } from './env-gate'
import {
  manualIgnoredOverrideWarning,
  resolveBootSeedDecision,
  resolveManualSeedDecision,
} from './env-gate'

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
async function linkAdminAsOwner(payload: Payload, organizationId: number): Promise<void> {
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
    return
  }

  const existing = await payload.find({
    collection: 'memberships',
    where: { and: [{ user: { equals: admin.id } }, { organization: { equals: organizationId } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  if (existing.docs.length > 0) return

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

  await linkAdminAsOwner(payload, orgId)

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
  process.exit(0)
}
