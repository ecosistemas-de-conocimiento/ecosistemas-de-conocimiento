/**
 * Feature switches, per ecosistema and for the platform (owner ruling
 * 2026-10-27; backlog #39).
 *
 *   GET   /api/funciones?organization=<id>   { features }        member · platform admin
 *   GET   /api/funciones/editables           { ecosistemas, plataforma }
 *   PATCH /api/funciones                     { organization, features }   responsable · platform admin
 *   PATCH /api/plataforma                    { detectorFallback }         platform admin
 *
 * 🔴 WHO MAY FLIP WHAT:
 *   · platform admin — every ecosistema, and the platform switches;
 *   · responsable (`owner` in that ecosistema) — that ecosistema only, never
 *     the platform;
 *   · anyone else — nothing. Reading is for members, so the UI (and the future
 *     student view, `studentView`) can ask.
 * Unknown ecosistema and "not yours" get the same 403.
 *
 * Writes go through Payload with the caller's `req` and `overrideAccess: false`,
 * so the collection/global access rules decide a second time.
 */

import type { Endpoint, PayloadRequest } from 'payload'

import { isPlatformAdminUser } from '../access'
import { fallbackModeFromEnv } from '../lib/anonymise/fallbackGenerator'
import { featuresFor, invalidateFeatures, parseFeaturesPatch, resolveFeatures } from '../lib/features'
import { organizationIdsForUser, organizationIdsForUserWithMinRole, roleInOrganization } from '../lib/permissions'
import { invalidatePlatformSettings, isFallbackMode, storedDetectorFallback } from '../lib/platformSettings'

import { errorResponse, getAuthenticatedUser, jsonResponse, queryParam, readJsonBody } from './http'

const NO_STORE = { 'Cache-Control': 'no-store' } as const
const NOT_YOURS = 'No administras este ecosistema.'
const ADMINS_ONLY = 'Solo para administradores de la plataforma.'

const ok = (body: unknown): Response => jsonResponse(body, { headers: NO_STORE })

function positiveInt(raw: unknown): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!/^\d{1,12}$/.test(text)) return null
  const n = Number(text)
  return n > 0 ? n : null
}

const sameId = (ids: Array<number | string>, id: number): boolean => ids.some((x) => String(x) === String(id))

async function mayEdit(req: PayloadRequest, organizationId: number): Promise<boolean> {
  if (isPlatformAdminUser(req.user)) return true
  const user = getAuthenticatedUser(req)
  if (!user) return false
  return (await roleInOrganization(req.payload, user.id, organizationId)) === 'owner'
}

function envFallback(): 'hosted' | 'none' | 'invalid' {
  try {
    return fallbackModeFromEnv()
  } catch {
    return 'invalid'
  }
}

async function platformView() {
  const stored = await storedDetectorFallback()
  const env = envFallback()
  return { detectorFallback: stored, detectorFallbackEnv: env, detectorFallbackEffective: stored ?? env }
}

const readEndpoint: Endpoint = {
  path: '/funciones',
  method: 'get',
  handler: async (req) => {
    const user = getAuthenticatedUser(req)
    if (!user) return errorResponse(401, 'Necesitas iniciar sesión.')
    const organizationId = positiveInt(queryParam(req, 'organization'))
    if (organizationId === null) return errorResponse(400, 'Falta el ecosistema.')
    if (!isPlatformAdminUser(req.user) && !sameId(await organizationIdsForUser(req.payload, user.id), organizationId)) {
      return errorResponse(403, 'No perteneces a este ecosistema.')
    }
    return ok({ features: await featuresFor(req.payload, organizationId) })
  },
}

const editablesEndpoint: Endpoint = {
  path: '/funciones/editables',
  method: 'get',
  handler: async (req) => {
    const user = getAuthenticatedUser(req)
    if (!user) return errorResponse(401, 'Necesitas iniciar sesión.')
    const admin = isPlatformAdminUser(req.user)
    const ids = admin ? null : await organizationIdsForUserWithMinRole(req.payload, user.id, 'owner')
    if (ids !== null && ids.length === 0) return errorResponse(403, NOT_YOURS)
    const orgs = await req.payload.find({
      collection: 'organizations',
      ...(ids ? { where: { id: { in: ids } } } : {}),
      select: { name: true, slug: true, features: true } as never,
      sort: 'name',
      depth: 0,
      limit: 1000,
      pagination: false,
      overrideAccess: true,
    })
    const ecosistemas = (orgs.docs as Array<Record<string, unknown>>).map((o) => ({
      id: String(o.id),
      name: typeof o.name === 'string' ? o.name : '',
      slug: typeof o.slug === 'string' ? o.slug : '',
      features: resolveFeatures(o.features),
    }))
    return ok({ ecosistemas, plataforma: admin ? await platformView() : null })
  },
}

const writeEndpoint: Endpoint = {
  path: '/funciones',
  method: 'patch',
  handler: async (req) => {
    const user = getAuthenticatedUser(req)
    if (!user) return errorResponse(401, 'Necesitas iniciar sesión.')
    const body = (await readJsonBody(req)) ?? {}
    const organizationId = positiveInt(body.organization)
    if (organizationId === null) return errorResponse(400, 'Falta el ecosistema.')
    if (!(await mayEdit(req, organizationId))) return errorResponse(403, NOT_YOURS)
    const patch = parseFeaturesPatch(body.features)
    if (typeof patch === 'string') return errorResponse(400, patch)

    const current = (await req.payload
      .findByID({
        collection: 'organizations',
        id: organizationId,
        depth: 0,
        overrideAccess: true,
        select: { features: true } as never,
      })
      .catch(() => null)) as { features?: unknown } | null
    if (!current) return errorResponse(403, NOT_YOURS)
    const stored =
      current.features && typeof current.features === 'object' && !Array.isArray(current.features)
        ? (current.features as Record<string, unknown>)
        : {}
    try {
      await req.payload.update({
        collection: 'organizations',
        id: organizationId,
        data: { features: { ...parseOrEmpty(stored), ...patch } } as never,
        depth: 0,
        overrideAccess: false,
        user: req.user,
        req,
      })
    } catch (err) {
      const status = (err as { status?: unknown }).status
      if (status === 403) return errorResponse(403, NOT_YOURS)
      req.payload.logger.error({ err }, '[funciones] write failed')
      return errorResponse(500, 'No se pudo guardar.')
    }
    invalidateFeatures(organizationId)
    return ok({ features: await featuresFor(req.payload, organizationId) })
  },
}

/** A stored object with junk in it (hand-edited) must not block a save. */
function parseOrEmpty(stored: Record<string, unknown>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  const resolved = resolveFeatures(stored)
  for (const k of Object.keys(stored)) {
    if (k in resolved && typeof stored[k] === 'boolean') out[k] = stored[k] as boolean
  }
  return out
}

const platformEndpoint: Endpoint = {
  path: '/plataforma',
  method: 'patch',
  handler: async (req) => {
    if (!getAuthenticatedUser(req)) return errorResponse(401, 'Necesitas iniciar sesión.')
    if (!isPlatformAdminUser(req.user)) return errorResponse(403, ADMINS_ONLY)
    const body = (await readJsonBody(req)) ?? {}
    const value = body.detectorFallback
    // `null` = back to the env value.
    if (value !== null && !isFallbackMode(value)) return errorResponse(400, 'Valor no válido.')
    try {
      await req.payload.updateGlobal({
        slug: 'platform-settings',
        data: { detectorFallback: value } as never,
        depth: 0,
        overrideAccess: false,
        user: req.user,
        req,
      })
    } catch (err) {
      const status = (err as { status?: unknown }).status
      if (status === 403) return errorResponse(403, ADMINS_ONLY)
      req.payload.logger.error({ err }, '[plataforma] write failed')
      return errorResponse(500, 'No se pudo guardar.')
    }
    invalidatePlatformSettings()
    return ok(await platformView())
  },
}

export const funcionesEndpoints: Endpoint[] = [readEndpoint, editablesEndpoint, writeEndpoint, platformEndpoint]
