/**
 * 🔴 THE AUTHORIZATION MATRIX for `estudiante` and `investigador` (owner ruling
 * 2026-10-27), against a real Postgres (every migration, including the one that
 * adds `estudiante`) and the real Payload config.
 *
 *   investigador = admin powers inside the ecosistemas they are assigned to,
 *                  /ajustes for those, members up to their own rank — and
 *                  nothing outside them, never the platform.
 *   estudiante   = member-level; never Revisión, never others' drafts.
 *
 * ⚠ No docker → the suite SKIPS.
 */

import { sql } from '@payloadcms/db-postgres'
import type { Endpoint, Payload, PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { funcionesEndpoints } from '../endpoints/funciones'
import { miembrosEndpoints } from '../endpoints/miembros'
import { invalidateFeatures } from './features'
import { resolvePrincipal } from './permissions'
import { canAdminOrg, isInvestigador, isStudent, type RoleUser } from './roles'
import { bootPayload, dockerOk, rowsOf, shutdown, startRealPostgres, type RealPostgres } from './testing/realPostgres'

if (!dockerOk) console.warn('[roles.matrix.pg.test] docker is not usable — the real-Postgres tests SKIP.')

const ROOT = 1
const OWNER8 = 2
const INV8 = 3
const INV67 = 4
const ADMIN8 = 5
const MEMBER8 = 6
const EST1 = 7
const EST2 = 8
const NEWBIE = 9 // no memberships yet; target of grants
const ALL = [ROOT, OWNER8, INV8, INV67, ADMIN8, MEMBER8, EST1, EST2, NEWBIE]

const SLUG: Record<number, string> = { 6: 'dengue-a', 7: 'dengue-b', 8: 'semiosis', 9: 'ajeno' }

// documents
const DRAFT_EST1 = 100
const DRAFT_EST2 = 101
const PUB_8 = 102
const PUB_9 = 103

let pg: RealPostgres
let payload: Payload

const userDoc = async (id: number) =>
  ({ ...(await payload.findByID({ collection: 'users', id, overrideAccess: true })), collection: 'users' }) as never

async function callEndpoint(
  endpoints: Endpoint[],
  method: 'get' | 'patch' | 'post' | 'delete',
  path: string,
  as: number,
  opts: { query?: Record<string, string>; body?: Record<string, unknown>; routeParams?: Record<string, string> } = {},
): Promise<number> {
  const found = endpoints.find((e) => e.method === method && e.path === path)
  if (!found) throw new Error(`no ${method} ${path}`)
  const { createLocalReq } = await import('payload')
  const req = (await createLocalReq({ user: await userDoc(as) }, payload)) as PayloadRequest
  const url = new URL(`http://test.local/api${path}`)
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)
  Object.assign(req, { searchParams: url.searchParams, routeParams: opts.routeParams ?? {}, json: async () => opts.body ?? {} })
  return (await found.handler(req)).status
}

const flip = (as: number, organization: number) =>
  callEndpoint(funcionesEndpoints, 'patch', '/funciones', as, { body: { organization, features: { graph3d: false } } })

/** The session payload `/api/users/me` returns, through the real `afterMe` hook. */
async function sessionUser(id: number): Promise<RoleUser> {
  const hook = payload.collections.users.config.hooks.afterMe?.[0]
  if (!hook) throw new Error('users.afterMe is not wired')
  const { createLocalReq } = await import('payload')
  const req = (await createLocalReq({}, payload)) as PayloadRequest
  const user = await payload.findByID({ collection: 'users', id, overrideAccess: true })
  const out = (await hook({ collection: payload.collections.users.config, context: {}, req, response: { user } } as never)) as {
    user: RoleUser
  }
  return out.user
}

const asUser = async (id: number) => payload.findByID({ collection: 'users', id, overrideAccess: true })

const tryWrite = async (p: Promise<unknown>): Promise<'ok' | 'refused'> => {
  try {
    await p
    return 'ok'
  } catch {
    return 'refused'
  }
}

const createMembership = async (as: number, organization: number, role: string, user = NEWBIE) =>
  tryWrite(
    payload.create({
      collection: 'memberships',
      data: { user, organization, role } as never,
      overrideAccess: false,
      user: await asUser(as),
    }),
  )

const membershipId = async (user: number, org: number) =>
  Number((await rowsOf(pg.db, sql.raw(`SELECT id FROM memberships WHERE user_id = ${user} AND organization_id = ${org}`)))[0]?.id)

const readableDocIds = async (as: number): Promise<number[]> => {
  const res = await payload.find({
    collection: 'documents',
    overrideAccess: false,
    user: await asUser(as),
    depth: 0,
    pagination: false,
    select: { id: true, contentKind: true, uploadedBy: true } as never,
  })
  return res.docs.map((d) => Number((d as { id: unknown }).id)).sort((a, b) => a - b)
}

describe.skipIf(!dockerOk)('roles: estudiante + investigador authorization matrix (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-roles-matrix-pg-${process.pid}`, 'roles_matrix_test')
    payload = await bootPayload(pg.url, 'roles-matrix-secret')
    const users = ALL.map((id) => `(${id}, 'u${id}@example.invalid', ${id === ROOT})`).join(', ')
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, is_platform_admin) VALUES ${users};
      SELECT setval('users_id_seq', 100);
      INSERT INTO organizations (id, name, slug, features) VALUES
        (6, 'Dengue A', 'dengue-a', NULL), (7, 'Dengue B', 'dengue-b', NULL),
        (8, 'Semiosis práctica', 'semiosis', '{"studentView": true}'), (9, 'Ajeno', 'ajeno', NULL);
      SELECT setval('organizations_id_seq', 100);
      INSERT INTO memberships (user_id, organization_id, role) VALUES
        (${OWNER8}, 8, 'owner'), (${INV8}, 8, 'investigador'), (${INV67}, 6, 'investigador'),
        (${INV67}, 7, 'investigador'), (${ADMIN8}, 8, 'admin'), (${MEMBER8}, 8, 'member'),
        (${EST1}, 8, 'estudiante'), (${EST2}, 8, 'estudiante');
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise, anonymisation_status, extracted_text, name)
        VALUES (${DRAFT_EST1}, 8, ${EST1}, 'draft', 'pdf', 'documento', false, 'n/a', 'est1 private', 'e1'),
               (${DRAFT_EST2}, 8, ${EST2}, 'draft', 'pdf', 'documento', false, 'n/a', 'est2 private', 'e2'),
               (${PUB_8}, 8, ${OWNER8}, 'published', 'pdf', 'documento', false, 'n/a', 'shared 8', 'p8'),
               (${PUB_9}, 9, ${ROOT}, 'published', 'pdf', 'documento', false, 'n/a', 'shared 9', 'p9');
    `))
  })

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('session payload: /api/users/me carries memberships[].role, and the helpers read it', async () => {
    const inv67 = await sessionUser(INV67)
    expect(inv67.memberships).toEqual([
      { organization: '6', slug: 'dengue-a', role: 'investigador' },
      { organization: '7', slug: 'dengue-b', role: 'investigador' },
    ])
    expect([6, 7, 8, 9].map((o) => canAdminOrg(inv67, o))).toEqual([true, true, false, false])
    expect(isInvestigador(inv67, 6)).toBe(true)

    const est1 = await sessionUser(EST1)
    expect(isStudent(est1, 8)).toBe(true)
    expect(canAdminOrg(est1, 8)).toBe(false)

    expect(canAdminOrg(await sessionUser(OWNER8), 8)).toBe(true)
    expect(canAdminOrg(await sessionUser(ADMIN8), 8)).toBe(false)
    expect(canAdminOrg(await sessionUser(ROOT), 9)).toBe(true)
  })

  it('wire grants: Revisión and /ajustes follow the role, per ecosistema', async () => {
    const grants = async (id: number) => (await resolvePrincipal(payload, `u${id}@example.invalid`))!.projects
    const inv67 = await grants(INV67)
    expect(Object.keys(inv67).sort()).toEqual(['dengue-a', 'dengue-b'])
    for (const slug of ['dengue-a', 'dengue-b']) {
      expect(inv67[slug]!.permissions).toEqual(
        expect.arrayContaining(['holds:review', 'members:manage', 'ratings:read-comments']),
      )
      // 🔴 2026-11-10: /ajustes is the responsable's, not the investigador's.
      expect(inv67[slug]!.permissions).not.toContain('organization:manage')
    }
    expect((await grants(OWNER8))[SLUG[8]!]!.permissions).toContain('organization:manage')
    const est = (await grants(EST1))[SLUG[8]!]!
    expect(est.roles).toEqual(['estudiante'])
    expect(est.permissions).not.toContain('holds:review')
    expect(est.permissions).not.toContain('ratings:read-comments')
    expect((await grants(ADMIN8))[SLUG[8]!]!.permissions).not.toContain('organization:manage')
  })

  it('🔴 /api/funciones (ajustes): the responsable in their own ecosistema, never the investigador (2026-11-10); never the platform', async () => {
    const cases: Array<[number, number, number]> = [
      [ROOT, 9, 200],
      [OWNER8, 8, 200],
      [INV8, 8, 403],
      [INV67, 6, 403],
      [INV67, 7, 403],
      [INV8, 6, 403],
      [INV8, 9, 403],
      [INV67, 8, 403],
      [ADMIN8, 8, 403],
      [MEMBER8, 8, 403],
      [EST1, 8, 403],
    ]
    for (const [as, org, want] of cases) {
      invalidateFeatures()
      expect([as, org, await flip(as, org)]).toEqual([as, org, want])
    }
    for (const as of [INV8, INV67, OWNER8]) {
      const status = await callEndpoint(funcionesEndpoints, 'patch', '/plataforma', as, { body: { detectorFallback: 'none' } })
      expect([as, status]).toEqual([as, 403])
    }
  }, 60_000)

  it('🔴 organizations: only the responsable (or a platform admin) updates their ecosistema (2026-11-10)', async () => {
    expect(
      await tryWrite(
        payload.update({
          collection: 'organizations',
          id: 8,
          data: { name: 'Semiosis (inv)', description: 'x', features: { liveMic: true } } as never,
          overrideAccess: false,
          user: await asUser(INV8),
        }),
      ),
    ).toBe('refused')
    await payload.update({
      collection: 'organizations',
      id: 8,
      data: { name: 'Semiosis (resp)' } as never,
      overrideAccess: false,
      user: await asUser(OWNER8),
    })
    const row = (await rowsOf(pg.db, sql.raw(`SELECT name, slug, is_active, features FROM organizations WHERE id = 8`)))[0]!
    expect(row).toMatchObject({ name: 'Semiosis (resp)', slug: 'semiosis', is_active: true })
    expect((row.features as Record<string, unknown> | null)?.liveMic).toBeUndefined()

    expect(
      await tryWrite(
        payload.update({ collection: 'organizations', id: 6, data: { name: 'x' } as never, overrideAccess: false, user: await asUser(INV8) }),
      ),
    ).toBe('refused')
    expect(
      await tryWrite(
        payload.update({ collection: 'organizations', id: 8, data: { name: 'y' } as never, overrideAccess: false, user: await asUser(ADMIN8) }),
      ),
    ).toBe('refused')
  }, 30_000)

  it('🔴 memberships: the role ceiling and the tenant boundary', async () => {
    // investigador of 8: up to investigador, inside 8 only.
    expect(await createMembership(INV8, 8, 'estudiante')).toBe('ok')
    await pg.db.execute(sql.raw(`DELETE FROM memberships WHERE user_id = ${NEWBIE}`))
    expect(await createMembership(INV8, 8, 'admin')).toBe('ok')
    await pg.db.execute(sql.raw(`DELETE FROM memberships WHERE user_id = ${NEWBIE}`))
    expect(await createMembership(INV8, 8, 'investigador')).toBe('ok')
    await pg.db.execute(sql.raw(`DELETE FROM memberships WHERE user_id = ${NEWBIE}`))
    expect(await createMembership(INV8, 8, 'owner')).toBe('refused')
    expect(await createMembership(INV8, 6, 'member')).toBe('refused')
    expect(await createMembership(INV67, 8, 'member')).toBe('refused')
    // admin cannot grant investigador; estudiante and member grant nothing.
    expect(await createMembership(ADMIN8, 8, 'investigador')).toBe('refused')
    expect(await createMembership(EST1, 8, 'estudiante')).toBe('refused')
    expect(await createMembership(MEMBER8, 8, 'estudiante')).toBe('refused')
    expect(await rowsOf(pg.db, sql.raw(`SELECT id FROM memberships WHERE user_id = ${NEWBIE}`))).toEqual([])

    // investigador cannot touch the owner's row, can re-role an admin.
    const inv = await asUser(INV8)
    expect(
      await tryWrite(payload.update({ collection: 'memberships', id: await membershipId(OWNER8, 8), data: { role: 'member' } as never, overrideAccess: false, user: inv })),
    ).toBe('refused')
    expect(
      await tryWrite(payload.delete({ collection: 'memberships', id: await membershipId(OWNER8, 8), overrideAccess: false, user: inv })),
    ).toBe('refused')
    expect(
      await tryWrite(payload.update({ collection: 'memberships', id: await membershipId(ADMIN8, 8), data: { role: 'estudiante' } as never, overrideAccess: false, user: inv })),
    ).toBe('ok')
    await pg.db.execute(sql.raw(`UPDATE memberships SET role = 'admin' WHERE user_id = ${ADMIN8}`))
    // nor promote themselves past owner, nor sideways into 6.
    expect(
      await tryWrite(payload.update({ collection: 'memberships', id: await membershipId(INV8, 8), data: { role: 'owner' } as never, overrideAccess: false, user: inv })),
    ).toBe('refused')
  }, 60_000)

  it('/api/miembros list: investigador in their ecosistemas, nobody below admin', async () => {
    const list = (as: number, org: number) =>
      callEndpoint(miembrosEndpoints, 'get', '/miembros', as, { query: { organization: String(org) } })
    expect(await list(INV8, 8)).toBe(200)
    expect(await list(INV67, 7)).toBe(200)
    expect(await list(INV8, 6)).toBe(403)
    expect(await list(INV67, 8)).toBe(403)
    expect(await list(EST1, 8)).toBe(403)
    expect(await list(MEMBER8, 8)).toBe(403)
  }, 30_000)

  it('🔴 documents: an estudiante sees their own draft and the shared corpus — never a classmate\'s draft', async () => {
    expect(await readableDocIds(EST1)).toEqual([DRAFT_EST1, PUB_8])
    expect(await readableDocIds(EST2)).toEqual([DRAFT_EST2, PUB_8])
    // Drafts stay "solo tú lo ves" for staff too; the investigador sees 8's corpus, not 9's.
    expect(await readableDocIds(INV8)).toEqual([PUB_8])
    expect(await readableDocIds(INV67)).toEqual([])
  }, 30_000)
})
