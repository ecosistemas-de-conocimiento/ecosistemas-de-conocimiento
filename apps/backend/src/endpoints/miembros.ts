/**
 * `/api/miembros` — an ecosistema's people, managed by its responsable.
 *
 *   GET    /api/miembros?organization=<id>   list: membership id, email, name, role
 *   POST   /api/miembros                     { organization, email, name, role }
 *   PATCH  /api/miembros/:id                 { role }
 *   DELETE /api/miembros/:id
 *
 * ── 🔴 WHY A ROUTE, AND NOT THE COLLECTIONS OVER REST ───────────────────────
 *
 * `users.read` is self-only and `users.create` is platform-admin only
 * (`collections/Users.ts`), on purpose: the roster is not browsable. A
 * responsable still has to see who is in THEIR ecosistema and add people to it.
 * So this route reads users with `overrideAccess` and restates the rules:
 *
 *   · the caller must hold `members:manage` in the named ecosistema, or be a
 *     platform admin. Unknown ecosistema and "not yours" get the same 403;
 *   · it returns email and name of that ecosistema's members, and nothing else
 *     about anyone;
 *   · adding an EXISTING email links that account and says nothing about the
 *     person's other ecosistemas, nor touches their name or password;
 *   · 🔴 adding by email is NOT an "is this person on the platform?" oracle.
 *     Known and unknown emails get the same status, the same body shape (a
 *     member row plus a `temporaryPassword`) and the same cost (one pbkdf2
 *     hash). For a known account that password is a decoy that opens nothing;
 *     the shown name is always the one typed here (`personName`), never the
 *     account's own `displayName`. Name is required for both.
 *     ⚠ Residual: whoever holds the password can try it at sign-in, and only
 *     a new account's works. No mail provider means no way around that.
 *   · every membership write goes through the collection with
 *     `overrideAccess: false` and the caller's `req`, so the access rule and
 *     every hook in `collections/Memberships.ts` (self-assignment, foreign
 *     ecosistema, role ceiling, uniqueness) still decide.
 *
 * ⚠ A NEW PERSON GETS A ONE-TIME PASSWORD, RETURNED ONCE. There is no mail
 * provider on this installation (measured 2026-10-24: no `email` adapter in
 * `payload.config.ts`), so an invite link has nowhere to go. The password is
 * never stored in clear and never logged; the responsable hands it over.
 */

import { pbkdf2, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

import type { Endpoint, PayloadRequest } from 'payload'

import { isPlatformAdminUser } from '../access'
import {
  isOrgRole,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  roleInOrganization,
  type OrgRole,
} from '../lib/permissions'

import { errorResponse, getAuthenticatedUser, jsonResponse, queryParam, readJsonBody } from './http'

type Id = number | string

export interface MemberRow {
  id: string
  email: string
  name: string | null
  role: OrgRole
}

const NOT_YOURS = 'No administras este ecosistema.'
const NOT_FOUND = 'No encontramos a esa persona en tus ecosistemas.'

/** 18 random bytes → 24 url-safe characters. Shown once, never stored in clear. */
export function temporaryPassword(): string {
  return randomBytes(18).toString('base64url')
}

/**
 * The same work Payload does to store a new password (pbkdf2-sha256, 25 000
 * rounds, 512 bytes — `payload/dist/auth/strategies/local/generatePasswordSaltHash.js`,
 * read 2026-10-28), spent on the known-email path so both paths cost alike.
 */
const pbkdf2Async = promisify(pbkdf2)
async function hashLikeANewAccount(password: string): Promise<void> {
  await pbkdf2Async(password, randomBytes(32).toString('hex'), 25000, 512, 'sha256')
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function positiveInt(raw: unknown): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!/^\d{1,12}$/.test(text)) return null
  const n = Number(text)
  return n > 0 ? n : null
}

const relationId = (value: unknown): Id | null => {
  if (typeof value === 'number' || (typeof value === 'string' && value !== '')) return value
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'number' || typeof id === 'string') return id
  }
  return null
}

/**
 * The caller's role for managing `organizationId`, or a 401/403 response.
 * A platform admin manages every ecosistema as `owner`.
 */
async function authoriseManager(req: PayloadRequest, organizationId: Id): Promise<OrgRole | Response> {
  const user = getAuthenticatedUser(req)
  if (!user) return errorResponse(401, 'Necesitas iniciar sesión.')
  if (isPlatformAdminUser(req.user)) return 'owner'
  const role = await roleInOrganization(req.payload, user.id, organizationId)
  if (role === null || !ROLE_PERMISSIONS[role].includes(PERMISSIONS.membersManage)) {
    return errorResponse(403, NOT_YOURS)
  }
  return role
}

/** A Payload error → the response the UI shows. Spanish hook messages pass through. */
function writeError(err: unknown, req: PayloadRequest): Response {
  const e = err as { status?: unknown; message?: unknown; data?: { errors?: Array<{ message?: unknown }> } }
  const status = typeof e.status === 'number' ? e.status : 500
  const detail = e.data?.errors?.[0]?.message
  const message = typeof detail === 'string' ? detail : typeof e.message === 'string' ? e.message : ''
  if (status === 400 || status === 403 || status === 409) {
    return errorResponse(status, message || 'No se pudo guardar.')
  }
  req.payload.logger.error({ err }, '[miembros] write failed')
  return errorResponse(500, 'No se pudo guardar.')
}

async function memberRows(req: PayloadRequest, memberships: Array<Record<string, unknown>>): Promise<MemberRow[]> {
  const userIds = [...new Set(memberships.map((m) => relationId(m.user)).filter((id): id is Id => id !== null))]
  if (userIds.length === 0) return []
  const users = await req.payload.find({
    collection: 'users',
    where: { id: { in: userIds } },
    select: { email: true, displayName: true },
    depth: 0,
    pagination: false,
    overrideAccess: true,
    req,
  })
  const byId = new Map(
    (users.docs as Array<{ id: Id; email?: unknown; displayName?: unknown }>).map((u) => [String(u.id), u]),
  )
  const rows: MemberRow[] = []
  for (const m of memberships) {
    const user = byId.get(String(relationId(m.user)))
    if (!user || typeof user.email !== 'string') continue
    const personName = typeof m.personName === 'string' ? m.personName.trim() : ''
    const displayName = typeof user.displayName === 'string' ? user.displayName.trim() : ''
    rows.push({
      id: String(m.id),
      email: user.email,
      name: personName || displayName || null,
      role: isOrgRole(m.role) ? m.role : 'member',
    })
  }
  return rows.sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email, 'es'))
}

const listEndpoint: Endpoint = {
  path: '/miembros',
  method: 'get',
  handler: async (req) => {
    const organizationId = positiveInt(queryParam(req, 'organization'))
    if (organizationId === null) return errorResponse(400, 'Falta el ecosistema.')
    const myRole = await authoriseManager(req, organizationId)
    if (myRole instanceof Response) return myRole

    const memberships = await req.payload.find({
      collection: 'memberships',
      where: { and: [{ organization: { equals: organizationId } }, { isActive: { equals: true } }] },
      depth: 0,
      limit: 1000,
      pagination: false,
      overrideAccess: true,
      req,
    })
    const members = await memberRows(req, memberships.docs as unknown as Array<Record<string, unknown>>)
    return jsonResponse({ myRole, members }, { headers: { 'Cache-Control': 'no-store' } })
  },
}

const addEndpoint: Endpoint = {
  path: '/miembros',
  method: 'post',
  handler: async (req) => {
    const body = (await readJsonBody(req)) ?? {}
    const organizationId = positiveInt(body.organization)
    if (organizationId === null) return errorResponse(400, 'Falta el ecosistema.')
    const myRole = await authoriseManager(req, organizationId)
    if (myRole instanceof Response) return myRole

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : ''
    const role = body.role
    if (!EMAIL.test(email)) return errorResponse(400, 'Correo no válido.')
    if (!isOrgRole(role)) return errorResponse(400, 'Rol no válido.')
    // Before the lookup, so a missing name says nothing about the account.
    if (!name) return errorResponse(400, 'Falta el nombre.')

    const found = await req.payload.find({
      collection: 'users',
      where: { email: { equals: email } },
      select: { email: true },
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
    })
    let userId: Id | null = (found.docs[0] as { id?: Id } | undefined)?.id ?? null

    // An existing account: is it already here (active or revoked)?
    let existing: Record<string, unknown> | null = null
    if (userId !== null) {
      const rows = await req.payload.find({
        collection: 'memberships',
        where: { and: [{ user: { equals: userId } }, { organization: { equals: organizationId } }] },
        depth: 0,
        limit: 1,
        overrideAccess: true,
        req,
      })
      existing = (rows.docs[0] as unknown as Record<string, unknown> | undefined) ?? null
      // NULL is inactive, as everywhere else (`lib/permissions.ts`).
      if (existing && existing.isActive === true) {
        return errorResponse(409, 'Ya es miembro de este ecosistema.')
      }
    }

    // Every answer carries a password; only a new account's is real.
    const password = temporaryPassword()
    const isNew = userId === null
    if (!isNew) await hashLikeANewAccount(password)
    if (isNew) {
      try {
        const created = await req.payload.create({
          collection: 'users',
          data: { email, password, displayName: name } as never,
          overrideAccess: true,
          req,
        })
        userId = created.id as Id
      } catch (err) {
        return writeError(err, req)
      }
    }

    try {
      const membership = existing
        ? await req.payload.update({
            collection: 'memberships',
            id: existing.id as Id,
            data: { isActive: true, role, personName: name } as never,
            overrideAccess: false,
            req,
          })
        : await req.payload.create({
            collection: 'memberships',
            data: { user: userId, organization: organizationId, role, isActive: true, personName: name } as never,
            overrideAccess: false,
            req,
          })
      const [member] = await memberRows(req, [membership as unknown as Record<string, unknown>])
      return jsonResponse(
        { member, temporaryPassword: password },
        { status: 201, headers: { 'Cache-Control': 'no-store' } },
      )
    } catch (err) {
      // A refused grant must not leave a fresh account nobody can reach.
      if (isNew && userId !== null) {
        await req.payload
          .delete({ collection: 'users', id: userId, overrideAccess: true, req })
          .catch(() => undefined)
      }
      return writeError(err, req)
    }
  },
}

/** The membership `:id` names, if the caller manages its ecosistema. Otherwise one 404 for both. */
async function managedMembership(req: PayloadRequest): Promise<Record<string, unknown> | Response> {
  if (!getAuthenticatedUser(req)) return errorResponse(401, 'Necesitas iniciar sesión.')
  const id = positiveInt((req.routeParams as { id?: string } | undefined)?.id)
  if (id === null) return errorResponse(404, NOT_FOUND)
  const row = (await req.payload
    .findByID({ collection: 'memberships', id, depth: 0, overrideAccess: true, req })
    .catch(() => null)) as Record<string, unknown> | null
  const organizationId = row ? relationId(row.organization) : null
  if (!row || organizationId === null || row.isActive === false) return errorResponse(404, NOT_FOUND)
  const auth = await authoriseManager(req, organizationId)
  if (auth instanceof Response) return errorResponse(404, NOT_FOUND)
  return row
}

const changeRoleEndpoint: Endpoint = {
  path: '/miembros/:id',
  method: 'patch',
  handler: async (req) => {
    const row = await managedMembership(req)
    if (row instanceof Response) return row
    const body = (await readJsonBody(req)) ?? {}
    if (!isOrgRole(body.role)) return errorResponse(400, 'Rol no válido.')
    try {
      const updated = await req.payload.update({
        collection: 'memberships',
        id: row.id as Id,
        data: { role: body.role } as never,
        overrideAccess: false,
        req,
      })
      const [member] = await memberRows(req, [updated as unknown as Record<string, unknown>])
      return jsonResponse({ member }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (err) {
      return writeError(err, req)
    }
  },
}

const removeEndpoint: Endpoint = {
  path: '/miembros/:id',
  method: 'delete',
  handler: async (req) => {
    const row = await managedMembership(req)
    if (row instanceof Response) return row
    try {
      await req.payload.delete({ collection: 'memberships', id: row.id as Id, overrideAccess: false, req })
      return jsonResponse({ removed: String(row.id) })
    } catch (err) {
      return writeError(err, req)
    }
  },
}

export const miembrosEndpoints: Endpoint[] = [listEndpoint, addEndpoint, changeRoleEndpoint, removeEndpoint]
