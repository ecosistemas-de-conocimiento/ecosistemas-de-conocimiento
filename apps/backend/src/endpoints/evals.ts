/**
 * `/api/evals/*` — the backend half of the evals dashboard (`/admin/evals`).
 *
 * 🔴 EVERY ROUTE IS PLATFORM ADMIN ONLY, FAIL CLOSED: 401 without a session,
 * 403 for anyone whose account is not active with `isPlatformAdmin === true`.
 * No membership role opens any of them.
 *
 *   · `POST /api/evals/session` `{ organization }` — a conversation in that
 *     ecosistema owned by the caller, for the run's chat turns. A platform
 *     admin is never a member (owner ruling: "admin es admin… no deberá
 *     poderse asignar"), so `Sessions.beforeValidate` would refuse the REST
 *     create; this route creates it through the local API instead, and only
 *     for a platform admin. The runner deletes it when the run ends, which
 *     retires its turns from the corpus (`Sessions` cascade).
 *   · `POST /api/evals/gate` `{ item }` — runs ONE privacy item through the
 *     production anonymisation gate (`runAnonymisationGate` +
 *     `aiServiceDetector({ organizationId })` + `documentoGateOptions`, exactly
 *     what `anonymiseDocumentText` calls) and returns the term verdicts.
 *     🔴 The text and the gate's output never leave this handler: not in the
 *     response, not in a log, not in a row.
 *   · `POST /api/evals/seed` `{ organization }` — loads the starter set
 *     (`lib/evals/starter.ts`) into an ecosistema that has no items yet.
 */
import type { Endpoint, PayloadRequest } from 'payload'

import { isPlatformAdminUser } from '../access'
import { docIdList, nameList } from '../collections/EvalItems'
import type { GateContentKind, GateResult } from '../lib/anonymise/types'
import { scoreGateTerms, type GateTermVerdict } from '../lib/evals/gateScore'
import { STARTER_SETS } from '../lib/evals/starter'
import { errorResponse, getAuthenticatedUser, jsonResponse, readJsonBody } from './http'

export interface GateRunArgs {
  organizationId: number
  contentKind: GateContentKind
  text: string
}

export interface GateRunOutcome {
  result: GateResult
  detector: string
}

export interface EvalEndpointDeps {
  /** The production gate. Injected in tests. */
  runGate: (req: PayloadRequest, args: GateRunArgs) => Promise<GateRunOutcome>
}

/** Exactly the calls `anonymiseDocumentText` makes, without its row writes. */
async function productionGate(req: PayloadRequest, args: GateRunArgs): Promise<GateRunOutcome> {
  const { documentoGateOptions } = await import('../lib/publicFigures')
  const { runAnonymisationGate, aiServiceDetector } = await import('../lib/anonymise')
  const options = await documentoGateOptions(req.payload, args.organizationId, { contentKind: args.contentKind })
  const detector = aiServiceDetector({ organizationId: args.organizationId })
  const result = await runAnonymisationGate(
    { contentKind: args.contentKind, text: args.text, roster: options.roster, keepPublicFigures: options.keepPublicFigures },
    { detector },
  )
  return { result, detector: detector.name }
}

function positiveInt(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** 401 / 403 / null (= a platform admin, go on). */
function refuse(req: PayloadRequest): Response | null {
  if (!getAuthenticatedUser(req)) return errorResponse(401, 'Necesitas iniciar sesión.')
  if (!isPlatformAdminUser(req.user)) return errorResponse(403, 'Solo administración de la plataforma.')
  return null
}

async function organizationExists(req: PayloadRequest, id: number): Promise<{ id: number; slug?: unknown } | null> {
  return (await req.payload
    .findByID({ collection: 'organizations', id, depth: 0, overrideAccess: true, select: { slug: true } as never })
    .catch(() => null)) as { id: number; slug?: unknown } | null
}

export interface GateVerdictBody {
  status: 'ready' | 'hold'
  stage?: string
  retryable?: boolean
  detector: string
  model: string | null
  terms: GateTermVerdict[]
}

export function makeEvalEndpoints(deps: EvalEndpointDeps = { runGate: productionGate }): Endpoint[] {
  const session: Endpoint = {
    path: '/evals/session',
    method: 'post',
    handler: async (req) => {
      const denied = refuse(req)
      if (denied) return denied
      const body = (await readJsonBody(req)) ?? {}
      const organizationId = positiveInt(body.organization)
      if (organizationId === null || !(await organizationExists(req, organizationId))) {
        return errorResponse(400, 'Falta el ecosistema.')
      }
      const user = getAuthenticatedUser(req)!
      // No `req`: the local API runs with no user, so `stampOwnerAndEcosystem`
      // keeps the owner and ecosistema given here (both checked above).
      const doc = (await req.payload.create({
        collection: 'sessions',
        data: { user: user.id, organization: organizationId, kind: 'generales', title: 'Evaluación' } as never,
        overrideAccess: true,
        depth: 0,
      })) as { id: number | string }
      return jsonResponse({ id: doc.id }, { status: 201 })
    },
  }

  const gate: Endpoint = {
    path: '/evals/gate',
    method: 'post',
    handler: async (req) => {
      const denied = refuse(req)
      if (denied) return denied
      const body = (await readJsonBody(req)) ?? {}
      const itemId = positiveInt(body.item)
      if (itemId === null) return errorResponse(400, 'Falta el ítem.')
      const item = (await req.payload
        .findByID({ collection: 'eval-items', id: itemId, depth: 0, overrideAccess: true })
        .catch(() => null)) as Record<string, unknown> | null
      if (!item || item.kind !== 'privacidad' || typeof item.text !== 'string' || !item.text.trim()) {
        return errorResponse(404, 'No existe ese ítem de privacidad.')
      }
      const organizationId = positiveInt(
        typeof item.organization === 'object' && item.organization
          ? (item.organization as { id?: unknown }).id
          : item.organization,
      )
      if (organizationId === null) return errorResponse(404, 'No existe ese ítem de privacidad.')
      const contentKind: GateContentKind = item.gateKind === 'testimonio' ? 'testimonio' : 'documento'
      let outcome: GateRunOutcome
      try {
        outcome = await deps.runGate(req, { organizationId, contentKind, text: item.text })
      } catch (err) {
        // Name only: a message could quote the text.
        return errorResponse(502, `El filtro falló (${err instanceof Error ? err.name : 'error'}).`)
      }
      const { result, detector } = outcome
      const model = result.report?.model ?? null
      const verdict: GateVerdictBody =
        result.status === 'ready'
          ? {
              status: 'ready',
              detector,
              model,
              terms: scoreGateTerms(item.text, result.redactedText, nameList(item.privateNames), nameList(item.publicNames)),
            }
          : {
              status: 'hold',
              stage: result.stage,
              ...(result.retryable ? { retryable: true } : {}),
              detector,
              model,
              terms: [],
            }
      return jsonResponse(verdict)
    },
  }

  const seed: Endpoint = {
    path: '/evals/seed',
    method: 'post',
    handler: async (req) => {
      const denied = refuse(req)
      if (denied) return denied
      const body = (await readJsonBody(req)) ?? {}
      const organizationId = positiveInt(body.organization)
      const org = organizationId === null ? null : await organizationExists(req, organizationId)
      if (organizationId === null || !org) return errorResponse(400, 'Falta el ecosistema.')
      const set = typeof org.slug === 'string' ? STARTER_SETS[org.slug] : undefined
      if (!set) return errorResponse(404, 'No hay un set inicial para este ecosistema.')
      const existing = await req.payload.count({
        collection: 'eval-items',
        where: { organization: { equals: organizationId } },
        overrideAccess: true,
      })
      if (existing.totalDocs > 0) return errorResponse(409, 'Este ecosistema ya tiene preguntas.')

      const titles = [...new Set(set.questions.flatMap((q) => q.expectedTitles))]
      const found = titles.length
        ? ((
            await req.payload.find({
              collection: 'documents',
              where: { and: [{ organization: { equals: organizationId } }, { name: { in: titles } }] },
              depth: 0,
              limit: 200,
              pagination: false,
              overrideAccess: true,
              select: { name: true } as never,
            })
          ).docs as unknown as Array<{ id: number; name: string }>)
        : []
      const idsFor = (title: string) => found.filter((d) => d.name === title).map((d) => d.id)

      let created = 0
      for (const q of set.questions) {
        const ids = q.expectedTitles.flatMap(idsFor)
        const missing = q.expectedTitles.filter((t) => idsFor(t).length === 0)
        await req.payload.create({
          collection: 'eval-items',
          data: {
            organization: organizationId,
            kind: 'pregunta',
            question: q.question,
            expectedDocIds: docIdList(ids),
            shouldRefuse: q.shouldRefuse === true,
            ...(missing.length ? { notes: `No encontrado: ${missing.join(' · ')}` } : {}),
          } as never,
          overrideAccess: true,
          depth: 0,
        })
        created += 1
      }
      for (const p of set.privacy) {
        await req.payload.create({
          collection: 'eval-items',
          data: { organization: organizationId, kind: 'privacidad', ...p } as never,
          overrideAccess: true,
          depth: 0,
        })
        created += 1
      }
      return jsonResponse({ created }, { status: 201 })
    },
  }

  return [session, gate, seed]
}

export const evalEndpoints = makeEvalEndpoints()
