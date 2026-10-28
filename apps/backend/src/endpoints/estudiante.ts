/**
 * THE STUDENT VIEW (owner 2026-10-27), only where `studentView` is on.
 *
 *   GET   /api/estudiante/acceso?organization=<id>     { student, teacher }
 *   GET   /api/estudiante?organization=<id>            my topics, peers, authors   estudiante
 *   PATCH /api/estudiante/perfil                       { organization, shareWithPeers?, shareActivity?, shareTestimonios? }  estudiante
 *   GET   /api/estudiante/alcance?organization=&alcance=mios|companeros   { documentIds }  estudiante
 *   POST  /api/sugerencias                             { organization, kind, text }  estudiante
 *   GET   /api/sugerencias?organization=<id>           investigador · responsable
 *   GET   /api/estudiante/reportes?organization=<id>   consenting students     canAdminOrg
 *   GET   /api/estudiante/reporte?organization=&user=  one student's report    canAdminOrg + consent
 *
 * 🔴 THE GATES, IN ORDER, ON EVERY ROUTE:
 *   1. signed in (401);
 *   2. an active member of that ecosistema, or a platform admin — else 404;
 *   3. `studentView` on there — else 404 (the same 404: off and "not yours"
 *      must look alike);
 *   4. the role the route needs (`lib/roles.ts`) — else 403.
 *
 * 🔴 SCOPING. A student reads only their own rows, plus the NAME and shared
 * TOPIC LABELS of students who switched `shareWithPeers` on. Never a peer's
 * text, never a peer's draft. A report needs `canAdminOrg` AND the student's
 * own `shareActivity`; without consent it is the same 404 as a stranger.
 * The ids every route acts on come from the session, never from the body.
 *
 * 🔴 THE REPORT AND TESTIMONIOS. Off by default (`studentTestimonios`): the
 * report lists documentos only, drafts unnamed (`buildReport`). On (platform
 * admin's switch): it adds the student's testimonios as the gate's output only
 * — `redactedText` and the neutral title when cleared, a status line otherwise
 * (`testimoniosOf`, `reportTestimonios`), PUBLISHED testimonios only, and only
 * for a student who gave the testimonio consent (`shareTestimoniosAt`, owner
 * ruling Q20; given only while the switch is on, cleared on withdrawal). "Their students" = the consenting
 * `estudiante` members of THIS ecosistema: the model has no teacher–student
 * link finer than the ecosistema. The overview tells the student whether the
 * switch is on (`testimoniosEnReporte`), so the consent wording can say so.
 */

import type { Endpoint, PayloadRequest } from 'payload'

import { SUGGESTION_KINDS, type SuggestionKind } from '../collections/Suggestions'
import { isPlatformAdminUser } from '../access'
import { featureEnabled } from '../lib/features'
import { canAdminOrg, isInvestigador, isStudent, type RoleUser } from '../lib/roles'
import { authorPage, buildReport, citedSurnames, fold, matchPeers, mergeAuthors } from '../lib/student/logic'
import * as realQueries from '../lib/student/queries'
import type { StudentDb } from '../lib/student/queries'

import { errorResponse, getAuthenticatedUser, jsonResponse, queryParam, readJsonBody } from './http'

export const STUDENT_VIEW_OFF = 'No disponible.'
const STUDENTS_ONLY = 'Solo para estudiantes.'
const STAFF_ONLY = 'Solo para investigadores y responsables.'
const NO_STORE = { 'Cache-Control': 'no-store' } as const
const ok = (body: unknown): Response => jsonResponse(body, { headers: NO_STORE })

export type StudentQueries = typeof realQueries

function positiveInt(raw: unknown): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!/^\d{1,12}$/.test(text)) return null
  const n = Number(text)
  return n > 0 ? n : null
}

type Row = Record<string, unknown>
const idOf = (v: unknown): string | null =>
  v == null ? null : typeof v === 'object' ? String((v as { id?: unknown }).id ?? '') : String(v)

/** The caller's active memberships in active ecosistemas, for `lib/roles.ts`. */
async function loadRoleUser(req: PayloadRequest, userId: number | string): Promise<RoleUser> {
  const ms = await req.payload.find({
    collection: 'memberships',
    where: { and: [{ user: { equals: userId } }, { isActive: { equals: true } }] },
    depth: 0,
    pagination: false,
    overrideAccess: true,
  })
  const rows = ms.docs as unknown as Row[]
  const orgIds = [...new Set(rows.map((m) => idOf(m.organization)).filter((x): x is string => !!x))]
  const orgs = orgIds.length
    ? await req.payload.find({
        collection: 'organizations',
        where: { and: [{ id: { in: orgIds } }, { isActive: { equals: true } }] },
        depth: 0,
        pagination: false,
        overrideAccess: true,
      })
    : { docs: [] }
  const live = new Set((orgs.docs as unknown as Row[]).map((o) => String(o.id)))
  return {
    isPlatformAdmin: isPlatformAdminUser(req.user),
    memberships: rows
      .filter((m) => live.has(idOf(m.organization) ?? ''))
      .map((m) => ({ organization: idOf(m.organization), role: String(m.role ?? ''), isActive: true })),
  }
}

type Need = 'any' | 'student' | 'staff' | 'admin'

interface Gate {
  userId: number
  organizationId: number
  roles: RoleUser
}

/** Gates 1–4. A `Response` means "stop and send this". */
async function gate(req: PayloadRequest, rawOrg: unknown, need: Need): Promise<Gate | Response> {
  const user = getAuthenticatedUser(req)
  if (!user) return errorResponse(401, 'Necesitas iniciar sesión.')
  const organizationId = positiveInt(rawOrg)
  if (organizationId === null) return errorResponse(400, 'Falta el ecosistema.')
  const roles = await loadRoleUser(req, user.id)
  const member = (roles.memberships ?? []).some((m) => String(m.organization) === String(organizationId))
  if (!member && roles.isPlatformAdmin !== true) return errorResponse(404, STUDENT_VIEW_OFF)
  if (!(await featureEnabled(req.payload, organizationId, 'studentView'))) return errorResponse(404, STUDENT_VIEW_OFF)
  const allowed =
    need === 'any' ||
    (need === 'student' && isStudent(roles, organizationId)) ||
    (need === 'staff' && (isInvestigador(roles, organizationId) || canAdminOrg(roles, organizationId))) ||
    (need === 'admin' && canAdminOrg(roles, organizationId))
  if (!allowed) return errorResponse(403, need === 'student' ? STUDENTS_ONLY : STAFF_ONLY)
  return { userId: Number(user.id), organizationId, roles }
}

const db = (req: PayloadRequest): StudentDb => req.payload as unknown as StudentDb

interface Profile {
  shareWithPeers: boolean
  shareActivity: boolean
  /** 🔴 The testimonio consent (owner ruling Q20): `shareTestimoniosAt` is set. */
  shareTestimonios: boolean
}

async function findProfile(
  req: PayloadRequest,
  g: { userId: number; organizationId: number },
): Promise<(Profile & { id?: unknown }) | null> {
  const res = await req.payload.find({
    collection: 'studentProfiles' as never,
    where: { and: [{ user: { equals: g.userId } }, { organization: { equals: g.organizationId } }] },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  const row = (res.docs as Row[])[0]
  if (!row) return null
  return {
    id: row.id,
    shareWithPeers: row.shareWithPeers === true,
    shareActivity: row.shareActivity === true,
    shareTestimonios: typeof row.shareTestimoniosAt === 'string' && row.shareTestimoniosAt !== '',
  }
}

const perfilBody = (p: Profile | null) => ({
  shareWithPeers: p?.shareWithPeers ?? false,
  shareActivity: p?.shareActivity ?? false,
  shareTestimonios: p?.shareTestimonios ?? false,
})

export function makeEstudianteEndpoints(Q: StudentQueries = realQueries): Endpoint[] {
  const acceso: Endpoint = {
    path: '/estudiante/acceso',
    method: 'get',
    handler: async (req) => {
      const g = await gate(req, queryParam(req, 'organization'), 'any')
      if (g instanceof Response) return g
      return ok({
        student: isStudent(g.roles, g.organizationId),
        teacher: canAdminOrg(g.roles, g.organizationId) || isInvestigador(g.roles, g.organizationId),
        admin: canAdminOrg(g.roles, g.organizationId),
      })
    },
  }

  const overview: Endpoint = {
    path: '/estudiante',
    method: 'get',
    handler: async (req) => {
      const g = await gate(req, queryParam(req, 'organization'), 'student')
      if (g instanceof Response) return g
      const p = db(req)
      const org = g.organizationId
      const [profile, mineMap, graphAuthors, texts, pages, candidates, docs, corpusTop, testimoniosEnReporte] = await Promise.all([
        findProfile(req, g),
        Q.topicsByUser(p, org, [g.userId], { publishedOnly: false }),
        Q.authorsOfUser(p, org, g.userId),
        Q.ownTexts(p, org, g.userId),
        Q.publishedDocumentoNames(p, org),
        Q.consentingStudents(p, org, 'share_with_peers'),
        Q.documentsOf(p, org, g.userId),
        Q.corpusTopTopics(p, org, 15),
        featureEnabled(req.payload, org, 'studentTestimonios'),
      ])
      const topics = mineMap.get(g.userId) ?? []
      const peersOnly = candidates.filter((c) => c.id !== g.userId)
      // 🔴 Peers' topics from PUBLISHED documents only.
      const peerTopics = await Q.topicsByUser(
        p,
        org,
        peersOnly.map((c) => c.id),
        { publishedOnly: true },
      )
      const autores = mergeAuthors(graphAuthors, citedSurnames(texts), pages)
      const near = await Q.authorsNearTopics(
        p,
        org,
        topics.slice(0, 15).map((t) => t.id),
      )
      // Same author by surname ("Lotman" cited, "Iuri Lotman" in the graph).
      const surname = (n: string) => fold(n).split(' ').pop() ?? ''
      const mineKeys = new Set(autores.map((a) => surname(a.name)))
      return ok({
        perfil: perfilBody(profile),
        temas: topics.slice(0, 15).map((t) => t.label),
        documentos: docs.map((d) => ({ id: d.id, name: d.name, status: d.status })),
        companeros: matchPeers(topics, peerTopics, peersOnly).map(({ name, topics: shared }) => ({ name, topics: shared })),
        autores,
        autoresParaLeer: near
          .filter((a) => !mineKeys.has(surname(a.label)))
          .slice(0, 10)
          .map((a) => ({ name: a.label, docs: a.docs, page: authorPage(a.label, pages) })),
        temasDelEcosistema: corpusTop.map((t) => t.label),
        testimoniosEnReporte,
      })
    },
  }

  const perfil: Endpoint = {
    path: '/estudiante/perfil',
    method: 'patch',
    handler: async (req) => {
      const body = (await readJsonBody(req)) ?? {}
      const g = await gate(req, body.organization, 'student')
      if (g instanceof Response) return g
      const patch: Record<string, unknown> = {}
      for (const k of ['shareWithPeers', 'shareActivity', 'shareTestimonios'] as const) {
        if (k in body && typeof body[k] !== 'boolean') return errorResponse(400, 'Valor no válido.')
      }
      if (typeof body.shareWithPeers === 'boolean') patch.shareWithPeers = body.shareWithPeers
      if (typeof body.shareActivity === 'boolean') {
        patch.shareActivity = body.shareActivity
        // 🔴 Withdrawing activity withdraws testimonios too; sharing it again
        // does not bring them back without the testimonio consent itself.
        if (body.shareActivity === false) patch.shareTestimoniosAt = null
      }
      if (body.shareTestimonios === true) {
        // 🔴 Only under the wording that names testimonios, i.e. switch on.
        if (!(await featureEnabled(req.payload, g.organizationId, 'studentTestimonios'))) {
          return errorResponse(400, 'No disponible.')
        }
        if (body.shareActivity === false) return errorResponse(400, 'Valor no válido.')
        patch.shareActivity = true
        patch.shareTestimoniosAt = new Date().toISOString()
      } else if (body.shareTestimonios === false) {
        patch.shareTestimoniosAt = null
      }
      if (Object.keys(patch).length === 0) return errorResponse(400, 'Nada que guardar.')
      const current = await findProfile(req, g)
      if (current?.id != null) {
        await req.payload.update({
          collection: 'studentProfiles' as never,
          id: current.id as number,
          data: patch as never,
          depth: 0,
          overrideAccess: true,
        })
      } else {
        await req.payload.create({
          collection: 'studentProfiles' as never,
          data: { user: g.userId, organization: g.organizationId, shareWithPeers: false, shareActivity: false, ...patch } as never,
          depth: 0,
          overrideAccess: true,
        })
      }
      const next = await findProfile(req, g)
      return ok({ perfil: perfilBody(next) })
    },
  }

  const alcance: Endpoint = {
    path: '/estudiante/alcance',
    method: 'get',
    handler: async (req) => {
      const g = await gate(req, queryParam(req, 'organization'), 'student')
      if (g instanceof Response) return g
      const which = queryParam(req, 'alcance')
      const p = db(req)
      if (which === 'mios') {
        const docs = await Q.documentsOf(p, g.organizationId, g.userId, 500)
        return ok({ documentIds: docs.map((d) => d.id) })
      }
      if (which === 'companeros') {
        const peers = (await Q.consentingStudents(p, g.organizationId, 'share_with_peers')).filter((c) => c.id !== g.userId)
        return ok({ documentIds: await Q.publishedDocumentIdsOf(p, g.organizationId, peers.map((c) => c.id)) })
      }
      return errorResponse(400, 'Alcance no válido.')
    },
  }

  const sugerir: Endpoint = {
    path: '/sugerencias',
    method: 'post',
    handler: async (req) => {
      const body = (await readJsonBody(req)) ?? {}
      const g = await gate(req, body.organization, 'student')
      if (g instanceof Response) return g
      const kind = body.kind
      if (typeof kind !== 'string' || !(SUGGESTION_KINDS as readonly string[]).includes(kind)) {
        return errorResponse(400, 'Elige un tipo.')
      }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text.length === 0) return errorResponse(400, 'Escribe tu sugerencia.')
      if (text.length > 2000) return errorResponse(400, 'Máximo 2000 caracteres.')
      await req.payload.create({
        collection: 'suggestions' as never,
        data: { organization: g.organizationId, author: g.userId, kind: kind as SuggestionKind, text } as never,
        depth: 0,
        overrideAccess: true,
      })
      return jsonResponse({ ok: true }, { status: 201, headers: NO_STORE })
    },
  }

  const sugerencias: Endpoint = {
    path: '/sugerencias',
    method: 'get',
    handler: async (req) => {
      const g = await gate(req, queryParam(req, 'organization'), 'staff')
      if (g instanceof Response) return g
      const res = await req.payload.find({
        collection: 'suggestions' as never,
        where: { organization: { equals: g.organizationId } },
        sort: '-createdAt',
        depth: 1,
        limit: 200,
        overrideAccess: true,
      })
      return ok({
        sugerencias: (res.docs as Row[]).map((s) => {
          const author = (s.author && typeof s.author === 'object' ? s.author : {}) as Row
          return {
            id: s.id,
            kind: s.kind,
            text: s.text,
            createdAt: s.createdAt,
            author: typeof author.displayName === 'string' && author.displayName.trim() ? author.displayName : 'Estudiante',
          }
        }),
      })
    },
  }

  const reportes: Endpoint = {
    path: '/estudiante/reportes',
    method: 'get',
    handler: async (req) => {
      const g = await gate(req, queryParam(req, 'organization'), 'admin')
      if (g instanceof Response) return g
      return ok({ estudiantes: await Q.consentingStudents(db(req), g.organizationId, 'share_activity') })
    },
  }

  const reporte: Endpoint = {
    path: '/estudiante/reporte',
    method: 'get',
    handler: async (req) => {
      const g = await gate(req, queryParam(req, 'organization'), 'admin')
      if (g instanceof Response) return g
      const studentId = positiveInt(queryParam(req, 'user'))
      if (studentId === null) return errorResponse(400, 'Falta el estudiante.')
      const p = db(req)
      const org = g.organizationId
      // 🔴 Consent: only a student who switched `shareActivity` on is listed.
      const student = (await Q.consentingStudents(p, org, 'share_activity')).find((s) => s.id === studentId)
      if (!student) return errorResponse(404, 'Sin reporte.')
      // 🔴 Switch on AND the student's own testimonio consent (owner ruling Q20).
      const withTestimonios =
        (await featureEnabled(req.payload, org, 'studentTestimonios')) &&
        (await findProfile(req, { userId: studentId, organizationId: org }))?.shareTestimonios === true
      const [topicsMap, docs, sessionTitles, corpusTop, testimonios] = await Promise.all([
        // 🔴 Published only: the teacher is not the uploader, so a draft's
        // topic labels stay the student's (`topicsByUser`'s own rule).
        Q.topicsByUser(p, org, [studentId], { publishedOnly: true }),
        Q.documentsOf(p, org, studentId),
        Q.sessionTitlesOf(p, org, studentId),
        Q.corpusTopTopics(p, org, 25),
        withTestimonios ? Q.testimoniosOf(p, org, studentId) : null,
      ])
      const topics = topicsMap.get(studentId) ?? []
      const readings = await Q.readingsForTopics(
        p,
        org,
        topics.slice(0, 10).map((t) => t.id),
        studentId,
      )
      return ok({ reporte: buildReport({ student, docs, topics, sessionTitles, corpusTop, readings, testimonios }) })
    },
  }

  return [acceso, overview, perfil, alcance, sugerir, sugerencias, reportes, reporte]
}

export const estudianteEndpoints: Endpoint[] = makeEstudianteEndpoints()
