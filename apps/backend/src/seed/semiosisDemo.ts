/**
 * THE SEMIOSIS DEMO — nine students with published work in ecosistema 8
 * ("Semiosis práctica"), so the student view and the teacher's Seguimiento
 * have something to show (owner decisions 2026-10-28).
 *
 *     pnpm --filter @edc/backend seed:semiosis-demo   # payload run src/seed/semiosisDemo.cli.ts
 *
 * What it converges, all in ecosistema 8:
 *  · 9 `estudiante` accounts, estudiante1..9@ecosistemas.test, with the invented
 *    names of `fixtures/semiosisTrabajos.ts` (estudiante1/2 are renamed; their
 *    passwords are kept). Credentials exactly as `seed/demoUsers.ts`: generated,
 *    written ONCE to the credentials file (0600), never to stdout.
 *  · each one's consent row: `shareWithPeers` and `shareActivity` on.
 *  · 1–2 suggestions each ("Sugerencias" in Seguimiento).
 *  · 1–2 titled, EMPTY conversations each: the teacher report counts
 *    conversations (`sessionCountOf`), titles never leave. No messages: a
 *    message is a conversation turn, which goes through the gate into the
 *    shared corpus (`lib/conversationIngest.ts`) — not cheap, not needed.
 *  · 2–3 trabajos each (22 in all), through the PRODUCT'S OWN PATH:
 *
 * ── 🔴 HOW A TRABAJO GETS PUBLISHED (no column is poked) ─────────────────────
 *
 *   1. Created AS THE STUDENT (`user` on the local API): a markdown documento
 *      with `bodyMarkdown` and `ingestStatus: 'pending'`, no `__skipDocsExtract`.
 *      The student's role makes the beforeValidate hook set `anonymise`
 *      (`anonymiseParticipantUpload`), and force `draft`.
 *   2. `extractAndIngestHook` (collections/Documents.ts) runs IN THIS PROCESS:
 *      extract from `bodyMarkdown` → the anonymisation gate (keeps public
 *      figures if ecosistema 8 has `keepPublicFigures`) → enqueue the draft
 *      ingest at ai-service → `scheduleGraphExtractionForDoc` (corpus graph,
 *      also in this process).
 *   3. ai-service's `ingest.completed` reaches the RUNNING SERVER's callback
 *      (`app/api/ai-service/callback/route.ts`), which calls
 *      `autoPublishParticipantDocument` (`lib/autoPublish.ts`) → `beginPublish`
 *      → a second ingest → its callback → `published`.
 *
 * So the CLI waits for (2) before it exits — `payload run` kills the process
 * as soon as the script resolves — and then polls a while for (3). Anything
 * left unfinished is finished by a RE-RUN, which re-plans every trabajo from
 * its row ({@link planTrabajo}): re-save a stalled draft, retry a failed
 * ingest (`planIngestRetry`), publish a cleared draft whose callback never
 * published it (`autoPublishParticipantDocument`, the callback's own step),
 * rebuild a missing graph (`scheduleGraphExtractionForDoc`, as the
 * graph-retry endpoint does). A held trabajo is reported and left for Revisión.
 * ⚠ A failed ingest is only REPORTED unless `SEMIOSIS_DEMO_RETRY=1`: a retry
 * re-runs the gate (2 model calls), and a cause like missing callbacks would
 * fail it again on every run ({@link retryAllowed}).
 *
 * ── REMOVAL ─────────────────────────────────────────────────────────────────
 *
 * `SEMIOSIS_DEMO_REMOVE=1` (or `--remove`) deletes the seed's own essays and
 * nothing else, through the product's delete path ({@link removeSemiosisDemoTrabajos}).
 * Operator steps: `semiosisDemo.cli.ts`.
 *
 * ── 🔴 REFUSES, BEFORE WRITING ANYTHING ──────────────────────────────────────
 *  · outside local/dev/demo-0 (`seed/env-gate.ts`);
 *  · ecosistema 8 missing, or its `studentView` / `autoPublishMembers` off;
 *  · ai-service callbacks or the admin key not configured, or GRAPH_EXTRACT
 *    off — the trabajos would never publish, or never reach the graph;
 *  · the credentials directory missing (as `seed/demoUsers.ts`).
 *
 * 🔴 PRIVACY: logs carry emails, statuses and counts. Never a password, never
 * a text.
 */

import type { Payload } from 'payload'

import { safeErrMessage } from '../lib/errorSummary'

import type { DemoUser, DemoUserResult } from './demoUsers'
import { generatePassword, missingOrganizations, seedDemoUsers, writeCredentials } from './demoUsers'
import { manualSeedAllowed, manualSeedGateReason } from './env-gate'
import { SEMIOSIS_STUDENTS, type SemiosisStudent } from './fixtures/semiosisTrabajos'

export const SEMIOSIS_ORG = 8

type Id = number | string
type Row = { id: Id } & Record<string, unknown>

/** The fixture's students as `seed/demoUsers.ts` accounts (no sample note). */
export function semiosisDemoUsers(students: readonly SemiosisStudent[] = SEMIOSIS_STUDENTS): DemoUser[] {
  return students.map((s) => ({
    key: s.key,
    email: s.email,
    displayName: s.displayName,
    memberships: [{ organization: SEMIOSIS_ORG, role: 'estudiante' }],
  }))
}

// ---------------------------------------------------------------------------
// What to do with one trabajo, from its row alone
// ---------------------------------------------------------------------------

export type TrabajoAction =
  /** No row yet: create it as the student. */
  | 'create'
  /** `pending` / `extracting` with no ingest, untouched for a while: the hook never ran (or died). */
  | 'resave'
  /** Ingest failed for a technical reason: `planIngestRetry`'s reset. */
  | 'retry-ingest'
  /** Cleared and ingested, still a draft: the callback's auto-publish step. */
  | 'publish'
  /** Ingested, graph missing or failed: `scheduleGraphExtractionForDoc`. */
  | 'graph'
  /** Something is in flight (ai-service, the publish move, a live graph run). */
  | 'wait'
  /** The gate held it, or a reviewer rejected it: Revisión decides. */
  | 'held'
  | 'done'

/** A row stuck at `pending` / `extracting` this long gets re-saved. */
export const STALLED_DRAFT_MS = 10 * 60_000

export interface TrabajoPlanDeps {
  now?: () => number
  /** `planIngestRetry` (collections/Documents.ts): the retry reset, or null. */
  planIngestRetry: (row: Record<string, unknown>) => Record<string, unknown> | null
  /** `planGraphRetry`: a reason to refuse, or null. */
  planGraphRetry: (row: Record<string, unknown>) => { reason: string } | null
  /** `autoPublishBlocker` (lib/autoPublish.ts): why not publishable, or null. */
  autoPublishBlocker: (row: Record<string, unknown>) => string | null
}

const age = (row: Record<string, unknown>, now: number): number => {
  const t = typeof row.updatedAt === 'string' ? Date.parse(row.updatedAt) : NaN
  return Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY
}

/** Graph rows this trabajo should have and does not. Never re-runs a `ready` or `skipped` graph. */
function graphMissing(row: Record<string, unknown>, deps: TrabajoPlanDeps): boolean {
  const g = row.graphStatus
  if (g === 'ready' || g === 'skipped') return false
  return deps.planGraphRetry(row) === null
}

/**
 * 🔴 PURE. One trabajo's next step, read off its row. The order matters: a
 * human decision first, then publication, then the graph.
 */
export function planTrabajo(row: Record<string, unknown> | null, deps: TrabajoPlanDeps): TrabajoAction {
  if (!row) return 'create'
  const now = (deps.now ?? Date.now)()
  if (row.anonymisationStatus === 'held' || row.anonymisationStatus === 'rejected') return 'held'

  const pub = row.publicationStatus
  if (pub === 'published') return graphMissing(row, deps) ? 'graph' : 'done'
  if (pub === 'publishing') return 'wait'

  // A draft.
  const ingest = row.ingestStatus
  if (ingest === 'failed') return deps.planIngestRetry(row) ? 'retry-ingest' : 'held'
  if (ingest === 'pending' || ingest === 'extracting') {
    return !row.ingestId && age(row, now) > STALLED_DRAFT_MS ? 'resave' : 'wait'
  }
  if (ingest === 'ready') {
    if (deps.autoPublishBlocker(row) === null) return 'publish'
    return graphMissing(row, deps) ? 'graph' : 'wait'
  }
  // `embedding`, `transcribed`, anything else: ai-service has it.
  return 'wait'
}

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

export interface SemiosisChecks {
  /** `missingCallbackConfig()` (lib/callbackConfig.ts). */
  missingCallbacks: () => string[] | Promise<string[]>
  /** null when the ai-service admin client builds for ecosistema 8. */
  aiProblem: () => string | null | Promise<string | null>
  /** `graphExtractDisabled()` (collections/Documents.ts). */
  graphDisabled: () => boolean | Promise<boolean>
}

export const realChecks: SemiosisChecks = {
  missingCallbacks: async () => (await import('../lib/callbackConfig')).missingCallbackConfig(),
  aiProblem: async () => {
    try {
      ;(await import('../lib/aiClient')).getAdminAIClient(SEMIOSIS_ORG)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : 'the ai-service admin client is not configured'
    }
  },
  graphDisabled: async () => (await import('../collections/Documents')).graphExtractDisabled(),
}

export interface SemiosisReadiness {
  /** Why the seed must not run, or null. */
  refusal: string | null
  /** Things that will make the demo poorer, not broken. */
  warnings: string[]
}

export async function semiosisDemoReadiness(
  payload: Payload,
  file: string,
  env: Record<string, string | undefined> = process.env,
  checks: SemiosisChecks = realChecks,
): Promise<SemiosisReadiness> {
  const warnings: string[] = []
  const refuse = (refusal: string): SemiosisReadiness => ({ refusal, warnings })
  if (!manualSeedAllowed(env)) return refuse(manualSeedGateReason(env))
  const { existsSync } = await import('node:fs')
  const path = await import('node:path')
  if (!existsSync(path.dirname(file))) return refuse(`the credentials directory ${path.dirname(file)} does not exist`)
  if ((await missingOrganizations(payload, semiosisDemoUsers())).length > 0) {
    return refuse(`ecosistema ${SEMIOSIS_ORG} does not exist`)
  }
  const { featuresFor, invalidateFeatures } = await import('../lib/features')
  invalidateFeatures(SEMIOSIS_ORG)
  const features = await featuresFor(payload, SEMIOSIS_ORG)
  if (!features.studentView) return refuse(`ecosistema ${SEMIOSIS_ORG} has studentView off — nobody would see the demo`)
  if (!features.autoPublishMembers) {
    return refuse(`ecosistema ${SEMIOSIS_ORG} has autoPublishMembers off — the trabajos would stay drafts`)
  }
  if (!features.keepPublicFigures) {
    warnings.push(
      `ecosistema ${SEMIOSIS_ORG} has keepPublicFigures off: the gate will redact the cited authors, ` +
        'so "Mis autores" stays empty. A platform admin can switch it on before seeding.',
    )
  }
  const missing = await checks.missingCallbacks()
  if (missing.length > 0) return refuse(`ai-service callbacks are not configured (${missing.join(', ')})`)
  const ai = await checks.aiProblem()
  if (ai) return refuse(`ai-service is not configured (${ai})`)
  if (await checks.graphDisabled()) return refuse('GRAPH_EXTRACT is off — the trabajos would never reach the graph')
  return { refusal: null, warnings }
}

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

async function findOne(payload: Payload, collection: string, where: object): Promise<Row | null> {
  const res = await payload.find({
    collection: collection as never,
    where: where as never,
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return (res.docs[0] ?? null) as unknown as Row | null
}

/** The user as `req.user`, so every hook sees the student upload it. */
async function actingAs(payload: Payload, email: string): Promise<Row> {
  const user = await findOne(payload, 'users', { email: { equals: email } })
  if (!user) throw new Error(`account ${email} is missing after the account step`)
  return { ...user, collection: 'users' }
}

export interface TrabajoState {
  email: string
  name: string
  id: Id | null
  action: TrabajoAction
}

export interface SemiosisSeedResult {
  accounts: DemoUserResult[]
  renamed: number
  profiles: { created: number; updated: number }
  suggestions: number
  conversations: number
  trabajos: TrabajoState[]
}

export interface SemiosisSeedOptions {
  reset?: boolean
  password?: () => string
  students?: readonly SemiosisStudent[]
  /** The CLI writes the credentials file here, before the first account write. */
  beforeWrite?: (planned: readonly DemoUserResult[]) => void | Promise<void>
  /**
   * 🔴 TESTS ONLY. `{ __skipDocsExtract: true }` keeps the pipeline (gate,
   * ingest, graph — all paid) off for rows the test creates. The CLI never
   * sets it.
   */
  docContext?: Record<string, unknown>
  /** Run the trabajo actions. Off in the account-only tests. */
  trabajos?: boolean
  /** Hold a created/re-saved trabajo's slot until its gate and enqueue ran. */
  awaitDrafts?: boolean
  /**
   * Execute `retry-ingest` (CLI: `SEMIOSIS_DEMO_RETRY=1`). Off: a failed ingest
   * is reported with its error code, not retried — see {@link retryAllowed}.
   */
  allowRetry?: boolean
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

export async function seedSemiosisDemo(payload: Payload, opts: SemiosisSeedOptions = {}): Promise<SemiosisSeedResult> {
  const students = opts.students ?? SEMIOSIS_STUDENTS
  const log = opts.log ?? (() => {})
  const accounts = await seedDemoUsers(payload, {
    users: semiosisDemoUsers(students),
    reset: opts.reset,
    password: opts.password ?? generatePassword,
    ...(opts.beforeWrite ? { beforeWrite: opts.beforeWrite } : {}),
  })

  const result: SemiosisSeedResult = {
    accounts,
    renamed: 0,
    profiles: { created: 0, updated: 0 },
    suggestions: 0,
    conversations: 0,
    trabajos: [],
  }

  const users = new Map<string, Row>()
  for (const s of students) {
    const user = await actingAs(payload, s.email)
    users.set(s.email, user)

    // Invented names, also on the two accounts `seed/demoUsers.ts` made first.
    if (user.displayName !== s.displayName) {
      await payload.update({
        collection: 'users',
        id: user.id as never,
        data: { displayName: s.displayName } as never,
        overrideAccess: true,
      })
      result.renamed += 1
    }
    const membership = await findOne(payload, 'memberships', {
      and: [{ user: { equals: user.id } }, { organization: { equals: SEMIOSIS_ORG } }],
    })
    if (membership && membership.personName !== s.displayName) {
      await payload.update({
        collection: 'memberships',
        id: membership.id as never,
        data: { personName: s.displayName } as never,
        overrideAccess: true,
      })
    }

    // Consent: both on. Keyed on (user, ecosistema), as the endpoint keys it.
    const profile = await findOne(payload, 'studentProfiles', {
      and: [{ user: { equals: user.id } }, { organization: { equals: SEMIOSIS_ORG } }],
    })
    if (!profile) {
      await payload.create({
        collection: 'studentProfiles' as never,
        data: { user: user.id, organization: SEMIOSIS_ORG, shareWithPeers: true, shareActivity: true } as never,
        overrideAccess: true,
      })
      result.profiles.created += 1
    } else if (profile.shareWithPeers !== true || profile.shareActivity !== true) {
      await payload.update({
        collection: 'studentProfiles' as never,
        id: profile.id as never,
        data: { shareWithPeers: true, shareActivity: true } as never,
        overrideAccess: true,
      })
      result.profiles.updated += 1
    }

    for (const sug of s.sugerencias) {
      const found = await findOne(payload, 'suggestions', {
        and: [
          { author: { equals: user.id } },
          { organization: { equals: SEMIOSIS_ORG } },
          { text: { equals: sug.text } },
        ],
      })
      if (!found) {
        await payload.create({
          collection: 'suggestions' as never,
          data: { author: user.id, organization: SEMIOSIS_ORG, kind: sug.kind, text: sug.text } as never,
          overrideAccess: true,
        })
        result.suggestions += 1
      }
    }

    for (const title of s.conversaciones) {
      const found = await findOne(payload, 'sessions', {
        and: [{ user: { equals: user.id } }, { organization: { equals: SEMIOSIS_ORG } }, { title: { equals: title } }],
      })
      if (!found) {
        await payload.create({
          collection: 'sessions',
          data: { title, organization: SEMIOSIS_ORG, kind: 'generales' } as never,
          user: user as never,
          overrideAccess: true,
        })
        result.conversations += 1
      }
    }
  }

  if (opts.trabajos === false) return result
  result.trabajos = await runTrabajos(payload, students, users, opts, log)
  return result
}

async function findTrabajo(payload: Payload, userId: Id, name: string): Promise<Row | null> {
  return findOne(payload, 'documents', {
    and: [
      { uploadedBy: { equals: userId } },
      { organization: { equals: SEMIOSIS_ORG } },
      { name: { equals: name } },
    ],
  })
}

async function planDeps(): Promise<TrabajoPlanDeps> {
  const docs = await import('../collections/Documents')
  const { autoPublishBlocker } = await import('../lib/autoPublish')
  return {
    planIngestRetry: (row) => docs.planIngestRetry(row as never),
    planGraphRetry: (row) => docs.planGraphRetry(row as never),
    autoPublishBlocker: (row) => autoPublishBlocker(row),
  }
}

/** Plan every trabajo, then act, throttled like `seed/corpus.ts`. */
async function runTrabajos(
  payload: Payload,
  students: readonly SemiosisStudent[],
  users: ReadonlyMap<string, Row>,
  opts: SemiosisSeedOptions,
  log: (line: string) => void,
): Promise<TrabajoState[]> {
  const deps = await planDeps()
  const { throttledEach, waitForDraftSettled } = await import('./throttle')

  type Item = { student: SemiosisStudent; user: Row; name: string; body: string; row: Row | null; state: TrabajoState }
  const items: Item[] = []
  for (const student of students) {
    const user = users.get(student.email)!
    for (const t of student.trabajos) {
      const row = await findTrabajo(payload, user.id, t.name)
      const action = planTrabajo(row, deps)
      items.push({
        student,
        user,
        name: t.name,
        body: t.body,
        row,
        state: { email: student.email, name: t.name, id: row?.id ?? null, action },
      })
    }
  }

  const settle = async (id: Id) => {
    if (!opts.awaitDrafts) return
    const ok = await waitForDraftSettled(
      async () =>
        (await payload.findByID({ collection: 'documents', id: id as never, depth: 0, overrideAccess: true })) as never,
      { pollMs: 2000, timeoutMs: 5 * 60_000, ...(opts.sleep ? { sleep: opts.sleep } : {}) },
    )
    if (!ok) log(`document ${id}: gate + enqueue not finished after 5 min — a re-run picks it up`)
  }

  let clients: { publish: (id: Id) => Promise<string>; graph: (row: Row) => Promise<void> } | null = null
  const live = async () => {
    if (clients) return clients
    const { getAdminAIClient } = await import('../lib/aiClient')
    const { ingestCallbackUrl } = await import('../lib/callbackConfig')
    const { autoPublishParticipantDocument } = await import('../lib/autoPublish')
    const { scheduleGraphExtractionForDoc } = await import('../collections/Documents')
    const callbackUrl = ingestCallbackUrl() ?? undefined
    clients = {
      publish: async (id) => {
        const out = await autoPublishParticipantDocument({
          payload,
          documentId: id,
          clientFor: (org) => getAdminAIClient(org) as never,
          ...(callbackUrl ? { callbackUrl } : {}),
        })
        return out.published ? 'publishing' : `not published (${out.reason})`
      },
      graph: async (row) => {
        await scheduleGraphExtractionForDoc({
          payload,
          docId: row.id,
          organizationId: SEMIOSIS_ORG,
          fresh: row as never,
        })
      },
    }
    return clients
  }

  const env = (name: string, fallback: number) => {
    const n = Number(process.env[name])
    return Number.isInteger(n) && n >= 0 && process.env[name]?.trim() ? n : fallback
  }
  const work = items.filter((i) => !['wait', 'held', 'done'].includes(i.state.action))
  await throttledEach(
    work,
    async (item) => {
      const { state, user } = item
      try {
        switch (state.action) {
          case 'create': {
            const doc = (await payload.create({
              collection: 'documents',
              data: {
                name: item.name,
                organization: SEMIOSIS_ORG,
                kind: 'markdown',
                contentKind: 'documento',
                bodyMarkdown: item.body,
                ingestStatus: 'pending',
              } as never,
              user: user as never,
              overrideAccess: true,
              ...(opts.docContext ? { context: opts.docContext } : {}),
            })) as unknown as Row
            state.id = doc.id
            await settle(doc.id)
            break
          }
          case 'retry-ingest':
            if (!opts.allowRetry) {
              // The code only (before the first ':'): the rest can quote the document.
              const code = String(item.row!.ingestError ?? 'unknown').split(':')[0]!.slice(0, 60)
              log(`document ${item.row!.id}: ingest failed (${code}) — not retried; SEMIOSIS_DEMO_RETRY=1 re-runs the gate`)
              break
            }
          // falls through
          case 'resave': {
            // Exactly the write `POST /api/documents/:id/retry` makes: no user,
            // access overridden. An empty `data` is an ordinary re-save.
            const data = state.action === 'resave' ? {} : (deps.planIngestRetry(item.row!) ?? {})
            await payload.update({
              collection: 'documents',
              id: item.row!.id as never,
              data: data as never,
              overrideAccess: true,
            })
            await settle(item.row!.id)
            break
          }
          case 'publish':
            log(`document ${item.row!.id}: ${await (await live()).publish(item.row!.id)}`)
            break
          case 'graph':
            await (await live()).graph(item.row!)
            break
        }
      } catch (err) {
        log(`document ${state.id ?? '(new)'} (${state.action}) failed: ${safeErrMessage(err)}`)
      }
    },
    {
      concurrency: env('SEED_INGEST_CONCURRENCY', 2),
      spacingMs: env('SEED_INGEST_SPACING_MS', 2000),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    },
  )
  return items.map((i) => i.state)
}

// ---------------------------------------------------------------------------
// Where things stand — read back through the SAME plan a re-run would follow
// ---------------------------------------------------------------------------

/** What a re-run would do with each trabajo, counted. `published` / `graphReady` are facts off the rows. */
export interface TrabajoTally {
  total: number
  published: number
  graphReady: number
  byAction: Record<TrabajoAction, number>
}

const ACTIONS: readonly TrabajoAction[] = ['create', 'resave', 'retry-ingest', 'publish', 'graph', 'wait', 'held', 'done']

/**
 * Would a re-run change anything? 🔴 Exactly {@link planTrabajo}'s answer: a
 * published row whose graph is `skipped` is `done`, a failure that cannot be
 * retried is `held` — neither asks for a re-run. `retry-ingest` counts only
 * when retries are allowed ({@link retryAllowed}).
 */
export function rerunWouldAct(t: TrabajoTally, allowRetry: boolean): boolean {
  const b = t.byAction
  return b.create + b.resave + b.publish + b.graph + b.wait + (allowRetry ? b['retry-ingest'] : 0) > 0
}

export async function tallyTrabajos(
  payload: Payload,
  students: readonly SemiosisStudent[] = SEMIOSIS_STUDENTS,
  deps?: TrabajoPlanDeps,
): Promise<{ all: TrabajoTally; byEmail: Map<string, TrabajoTally> }> {
  const plan = deps ?? (await planDeps())
  const zero = (): TrabajoTally => ({
    total: 0,
    published: 0,
    graphReady: 0,
    byAction: Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<TrabajoAction, number>,
  })
  const all = zero()
  const byEmail = new Map<string, TrabajoTally>()
  for (const s of students) {
    const mine = zero()
    const user = await findOne(payload, 'users', { email: { equals: s.email } })
    for (const t of s.trabajos) {
      const row = user ? await findTrabajo(payload, user.id, t.name) : null
      const action = planTrabajo(row, plan)
      for (const tally of [mine, all]) {
        tally.total += 1
        tally.byAction[action] += 1
        if (row?.publicationStatus === 'published') tally.published += 1
        if (row?.graphStatus === 'ready') tally.graphReady += 1
      }
    }
    byEmail.set(s.email, mine)
  }
  return { all, byEmail }
}

const tallyLine = (t: TrabajoTally) =>
  `${t.published}/${t.total} published, graph ready ${t.graphReady}/${t.total}; next: ` +
  ACTIONS.filter((a) => t.byAction[a] > 0)
    .map((a) => `${a} ${t.byAction[a]}`)
    .join(', ')

/**
 * 🔴 A RETRY RE-RUNS THE GATE. `planIngestRetry` clears `redactedText`, so the
 * next ingest pays the detector again (two model calls per document). A row
 * whose ingest failed because callbacks never reached the server would fail
 * the same way on every re-run, so the seed only REPORTS a failed ingest unless
 * the operator opts in: `SEMIOSIS_DEMO_RETRY=1`.
 */
export const retryAllowed = (env: Record<string, string | undefined> = process.env): boolean =>
  env.SEMIOSIS_DEMO_RETRY === '1'

// ---------------------------------------------------------------------------
// Removal — the seed's own essays, through the product's delete path
// ---------------------------------------------------------------------------

export interface RemovalResult {
  /** Essays found: uploader is one of the demo accounts AND the name is a fixture name. */
  found: number
  deleted: number
  failed: number
}

/**
 * 🔴 DELETES ONLY THE SEED'S ESSAYS: rows in ecosistema 8 whose uploader is one
 * of the fixture's accounts AND whose name is one of THAT student's fixture
 * names. Accounts, consent, suggestions, conversations and anything else the
 * students made stay.
 *
 * Each row goes through `payload.delete` — the path Mis documentos and the
 * admin panel take — so `retireDeletedDocumentHook` deletes it from ai-service
 * (draft and shared corpus) and the media cleanup runs. Its graph rows are
 * cleared first with `clearGraphRows` (`lib/graph/schedule.ts`, what the
 * graph pipeline itself uses), which also covers a FK that only nulls them.
 */
export async function removeSemiosisDemoTrabajos(
  payload: Payload,
  students: readonly SemiosisStudent[] = SEMIOSIS_STUDENTS,
  log: (line: string) => void = () => {},
): Promise<RemovalResult> {
  const { clearGraphRows } = await import('../lib/graph/schedule')
  const result: RemovalResult = { found: 0, deleted: 0, failed: 0 }
  for (const s of students) {
    const user = await findOne(payload, 'users', { email: { equals: s.email } })
    if (!user) continue
    for (const t of s.trabajos) {
      const row = await findTrabajo(payload, user.id, t.name)
      if (!row) continue
      result.found += 1
      try {
        await clearGraphRows(payload as never, row.id, SEMIOSIS_ORG)
        await payload.delete({ collection: 'documents', id: row.id as never, overrideAccess: true })
        result.deleted += 1
      } catch (err) {
        result.failed += 1
        log(`document ${row.id}: could not delete (${err instanceof Error ? err.name : 'error'})`)
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// CLI — operator steps are in `semiosisDemo.cli.ts`
// ---------------------------------------------------------------------------

export const removalRequested = (
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): boolean => env.SEMIOSIS_DEMO_REMOVE === '1' || argv.includes('--remove')

export async function runSemiosisDemoCli(): Promise<void> {
  const { getPayload } = await import('payload')
  const { default: config } = await import('@payload-config')
  const { DEFAULT_DEMO_USERS_FILE } = await import('./demoUsers')
  const payload = await getPayload({ config })
  const tag = '[seed-semiosis-demo]'

  if (removalRequested()) {
    // Only the env gate and the admin key: without the key the delete hook
    // cannot reach ai-service and the chunks would stay retrievable.
    if (!manualSeedAllowed()) {
      payload.logger.error(`${tag} refusing: ${manualSeedGateReason()}. Nothing was deleted.`)
      process.exit(1)
    }
    const ai = await realChecks.aiProblem()
    if (ai) {
      payload.logger.error(`${tag} refusing to remove: ai-service is not configured (${ai}). Nothing was deleted.`)
      process.exit(1)
    }
    const r = await removeSemiosisDemoTrabajos(payload, SEMIOSIS_STUDENTS, (l) => payload.logger.warn(`${tag} ${l}`))
    payload.logger.info(`${tag} removal: ${r.found} essays found, ${r.deleted} deleted, ${r.failed} failed.`)
    process.exit(r.failed > 0 ? 1 : 0)
  }

  const file = process.env.DEMO_USERS_FILE?.trim() || DEFAULT_DEMO_USERS_FILE
  const { refusal, warnings } = await semiosisDemoReadiness(payload, file)
  if (refusal) {
    payload.logger.error(`${tag} refusing: ${refusal}. Nothing was written.`)
    process.exit(1)
  }
  for (const w of warnings) payload.logger.warn(`${tag} ⚠ ${w}`)

  const reset = process.env.DEMO_USERS_RESET_PASSWORDS === '1'
  const allowRetry = retryAllowed()
  const res = await seedSemiosisDemo(payload, {
    reset,
    allowRetry,
    awaitDrafts: true,
    beforeWrite: (planned) => writeCredentials(file, planned),
    log: (line) => payload.logger.info(`${tag} ${line}`),
  })
  // 🔴 Emails and statuses only. The passwords are in `file`.
  for (const r of res.accounts) payload.logger.info(`${tag} ${r.email}: ${r.status}`)
  payload.logger.info(`${tag} credentials for new/reset accounts written to ${file} (0600).`)
  payload.logger.info(
    `${tag} renamed ${res.renamed}; consent rows created ${res.profiles.created}, updated ${res.profiles.updated}; ` +
      `suggestions +${res.suggestions}; conversations +${res.conversations}.`,
  )
  const actions = new Map<string, number>()
  for (const t of res.trabajos) actions.set(t.action, (actions.get(t.action) ?? 0) + 1)
  payload.logger.info(`${tag} trabajos this run: ${[...actions].map(([a, n]) => `${a} ${n}`).join(', ')}`)

  // 1. In-process graph runs: `payload run` exits when this function returns.
  const { graphQueueDepth } = await import('../lib/graph/schedule')
  const { waitUntilIdle } = await import('./throttle')
  const maxMs = Number(process.env.SEED_WAIT_MAX_MS) > 0 ? Number(process.env.SEED_WAIT_MAX_MS) : 30 * 60_000
  payload.logger.info(`${tag} waiting for in-process graph extraction…`)
  const idle = await waitUntilIdle(
    async () => {
      const q = graphQueueDepth()
      return q.running === 0 && q.queued === 0
    },
    { pollMs: 5000, timeoutMs: maxMs, quietPolls: 3 },
  )
  if (!idle) payload.logger.warn(`${tag} ⚠ graph extraction still running after ${maxMs}ms.`)

  // 2. Publication happens on the running server, through ai-service callbacks.
  //    Waits only while something is in flight (`wait`), never on rows a
  //    re-run alone can move.
  const deps = await planDeps()
  const publishWaitMs =
    Number(process.env.SEMIOSIS_DEMO_PUBLISH_WAIT_MS) >= 0 && process.env.SEMIOSIS_DEMO_PUBLISH_WAIT_MS?.trim()
      ? Number(process.env.SEMIOSIS_DEMO_PUBLISH_WAIT_MS)
      : 10 * 60_000
  payload.logger.info(`${tag} waiting up to ${publishWaitMs / 60_000} min for the server to publish…`)
  await waitUntilIdle(async () => (await tallyTrabajos(payload, SEMIOSIS_STUDENTS, deps)).all.byAction.wait === 0, {
    pollMs: 15_000,
    timeoutMs: publishWaitMs,
    quietPolls: 1,
  })

  const { all, byEmail } = await tallyTrabajos(payload, SEMIOSIS_STUDENTS, deps)
  for (const [email, t] of byEmail) payload.logger.info(`${tag} ${email}: ${tallyLine(t)}`)
  payload.logger.info(`${tag} TOTAL: ${tallyLine(all)}`)
  if (rerunWouldAct(all, allowRetry)) {
    payload.logger.warn(`${tag} not finished — run the seed again in a few minutes; it picks up where this left off.`)
  }
  if (!allowRetry && all.byAction['retry-ingest'] > 0) {
    payload.logger.warn(
      `${tag} ${all.byAction['retry-ingest']} ingest(s) failed and were NOT retried (each retry re-runs the gate: ` +
        '2 model calls). Check that ai-service callbacks reach this server, then re-run with SEMIOSIS_DEMO_RETRY=1.',
    )
  }
  if (all.byAction.held > 0) {
    payload.logger.warn(`${tag} ${all.byAction.held} trabajo(s) held by the gate or failed for good: see Revisión.`)
  }
  process.exit(0)
}
