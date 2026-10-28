/**
 * 🔴 STUDENT VIEW ACCESS AND SCOPING. Fake Payload + fake queries; the gates,
 * role checks and the consent filter are the real ones.
 *
 * Pinned:
 *   · every route 404s when `studentView` is off, for every role;
 *   · a non-member gets the same 404, never a 403 (no existence oracle);
 *   · student routes refuse non-students (403);
 *   · peers come only from opted-in students, as name + shared topics;
 *   · a report needs canAdminOrg AND the student's `shareActivity`;
 *   · writes are keyed on the session user, never on the body.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Endpoint, PayloadRequest } from 'payload'

import { invalidateFeatures } from '../lib/features'
import { TESTIMONIO_CONSENT_VERSION } from '../lib/student/testimonioConsent'
import type { Labelled, StudentRow } from '../lib/student/queries'
import { makeEstudianteEndpoints, type StudentQueries } from './estudiante'

const ORG = 8
type Membership = { user: number; organization: number; role: string }

interface World {
  features: Record<number, Record<string, boolean>>
  memberships: Membership[]
  profiles: Array<{ id: number; user: number; organization: number; shareWithPeers: boolean; shareActivity: boolean; shareTestimoniosAt?: string | null; shareTestimoniosVersion?: number | null }>
  suggestions: Array<Record<string, unknown>>
  writes: Array<{ op: string; collection: string; data: unknown }>
}

const world = (): World => ({
  features: { [ORG]: { studentView: true }, 9: {} },
  memberships: [
    { user: 1, organization: ORG, role: 'estudiante' },
    { user: 2, organization: ORG, role: 'estudiante' },
    { user: 3, organization: ORG, role: 'estudiante' },
    { user: 4, organization: ORG, role: 'owner' },
    { user: 5, organization: ORG, role: 'investigador' },
    { user: 6, organization: ORG, role: 'member' },
    { user: 1, organization: 9, role: 'estudiante' },
  ],
  profiles: [],
  suggestions: [],
  writes: [],
})

const T = (id: number, label: string): Labelled => ({ id, label, docs: 1 })

/** Peers 2 (opted in) and 3 (not) share topics with 1. */
function fakeQueries(w: World): StudentQueries & { calls: string[] } {
  const calls: string[] = []
  const topics: Record<number, Labelled[]> = {
    1: [T(10, 'semiosis'), T(11, 'signo')],
    2: [T(10, 'semiosis'), T(12, 'icono')],
    3: [T(10, 'semiosis'), T(11, 'signo')],
  }
  const consenting = (flag: 'share_with_peers' | 'share_activity'): StudentRow[] =>
    w.profiles
      .filter((p) => (flag === 'share_with_peers' ? p.shareWithPeers : p.shareActivity))
      .filter((p) => w.memberships.some((m) => m.user === p.user && m.organization === p.organization && m.role === 'estudiante'))
      .map((p) => ({ id: p.user, name: `Persona ${p.user}` }))
  const q = {
    calls,
    topicsByUser: async (_p: unknown, _o: number, ids: readonly number[], opts: { publishedOnly: boolean }) => {
      calls.push(`topics:${ids.join(',')}:${opts.publishedOnly}`)
      return new Map(ids.map((id) => [id, topics[id] ?? []]))
    },
    authorsOfUser: async () => [{ id: 50, label: 'Charles S. Peirce', docs: 2 }],
    authorsNearTopics: async () => [
      { id: 50, label: 'Charles S. Peirce', docs: 3 },
      { id: 51, label: 'Umberto Eco', docs: 2 },
    ],
    corpusTopTopics: async () => [T(10, 'semiosis'), T(13, 'abducción')],
    readingsForTopics: async (_p: unknown, _o: number, _t: readonly number[], exclude: number) => {
      calls.push(`readings:exclude=${exclude}`)
      return [{ id: 70, name: 'Lectura' }]
    },
    publishedDocumentoNames: async () => [{ id: 90, name: 'Autores/Umberto Eco' }],
    documentsOf: async (_p: unknown, _o: number, uid: number) => {
      calls.push(`docs:${uid}`)
      return [{ id: 100 + uid, name: `Trabajo ${uid}`, createdAt: '2026-10-01', status: 'draft', kind: 'documento' }]
    },
    ownTexts: async (_p: unknown, _o: number, uid: number) => {
      calls.push(`texts:${uid}`)
      return ['Como dice Lotman (1996), la semiosfera…']
    },
    publishedDocumentIdsOf: async (_p: unknown, _o: number, ids: readonly number[]) => {
      calls.push(`published:${ids.join(',')}`)
      return ids.map((id) => 200 + id)
    },
    sessionCountOf: async () => 4,
    testimoniosOf: async (_p: unknown, _o: number, uid: number) => {
      calls.push(`testimonios:${uid}`)
      return [{ id: 300, createdAt: '2026-10-02', status: 'approved', redactedText: 'Habló [Persona A].', title: null }]
    },
    consentingStudents: async (_p: unknown, _o: number, flag: 'share_with_peers' | 'share_activity') => consenting(flag),
  }
  return q as unknown as StudentQueries & { calls: string[] }
}

function fakePayload(w: World) {
  return {
    async find({ collection, where }: { collection: string; where: unknown }) {
      const flat = JSON.stringify(where)
      if (collection === 'memberships') {
        const uid = Number(/"user":\{"equals":(\d+)\}/.exec(flat)?.[1])
        return { docs: w.memberships.filter((m) => m.user === uid).map((m, i) => ({ id: i, ...m, isActive: true })) }
      }
      if (collection === 'organizations') return { docs: [{ id: ORG }, { id: 9 }] }
      if (collection === 'studentProfiles') {
        const uid = Number(/"user":\{"equals":(\d+)\}/.exec(flat)?.[1])
        const org = Number(/"organization":\{"equals":(\d+)\}/.exec(flat)?.[1])
        return { docs: w.profiles.filter((p) => p.user === uid && p.organization === org) }
      }
      if (collection === 'suggestions') return { docs: w.suggestions }
      return { docs: [] }
    },
    async findByID({ id }: { id: number }) {
      return { id, features: w.features[Number(id)] ?? null }
    },
    async create({ collection, data }: { collection: string; data: Record<string, unknown> }) {
      w.writes.push({ op: 'create', collection, data })
      if (collection === 'studentProfiles') w.profiles.push({ id: w.profiles.length + 1, ...(data as unknown as Omit<World['profiles'][number], 'id'>) })
      if (collection === 'suggestions') w.suggestions.push(data)
      return data
    },
    async update({ collection, id, data }: { collection: string; id: number; data: Record<string, unknown> }) {
      w.writes.push({ op: 'update', collection, data })
      const row = w.profiles.find((p) => p.id === id)
      if (row) Object.assign(row, data)
      return row
    },
    db: { drizzle: { execute: async () => ({ rows: [] }) } },
  }
}

const user = (id: number, extra: Record<string, unknown> = {}) => ({ id, email: `u${id}@example.test`, isActive: true, ...extra })

function setup(w = world()) {
  const Q = fakeQueries(w)
  const endpoints = makeEstudianteEndpoints(Q)
  const route = (method: string, path: string): Endpoint => {
    const e = endpoints.find((x) => x.method === method && x.path === path)
    if (!e) throw new Error(`no ${method} ${path}`)
    return e
  }
  const call = async (method: string, path: string, opts: { as: unknown; qs?: string; body?: unknown }) => {
    const req = {
      user: opts.as,
      payload: fakePayload(w),
      searchParams: new URL(`http://t/${path}?${opts.qs ?? ''}`).searchParams,
      headers: new Headers(),
      json: async () => opts.body ?? {},
    } as unknown as PayloadRequest
    const res = await route(method, path).handler(req)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { w, Q, call }
}

beforeEach(() => invalidateFeatures())

const ROUTES: Array<[string, string, { qs?: string; body?: unknown }]> = [
  ['get', '/estudiante/acceso', { qs: `organization=9` }],
  ['get', '/estudiante', { qs: `organization=9` }],
  ['patch', '/estudiante/perfil', { body: { organization: 9, shareWithPeers: true } }],
  ['get', '/estudiante/alcance', { qs: `organization=9&alcance=mios` }],
  ['post', '/sugerencias', { body: { organization: 9, kind: 'contenido', text: 'x' } }],
  ['get', '/sugerencias', { qs: `organization=9` }],
  ['get', '/estudiante/reportes', { qs: `organization=9` }],
  ['get', '/estudiante/reporte', { qs: `organization=9&user=1` }],
]

describe('studentView off', () => {
  it.each(ROUTES)('%s %s → 404 for a student, and nothing is read or written', async (method, path, opts) => {
    const w = world()
    w.memberships.push({ user: 4, organization: 9, role: 'owner' })
    const { call, Q } = setup(w)
    for (const as of [user(1), user(4), user(99, { isPlatformAdmin: true })]) {
      const res = await call(method, path, { as, ...opts })
      expect(res.status).toBe(404)
    }
    expect(Q.calls).toEqual([])
    expect(w.writes).toEqual([])
  })
})

describe('gates', () => {
  it('401 signed out', async () => {
    const { call } = setup()
    expect((await call('get', '/estudiante', { as: null, qs: `organization=${ORG}` })).status).toBe(401)
  })

  it('a non-member gets the same 404 as "off"', async () => {
    const { call } = setup()
    const res = await call('get', '/estudiante', { as: user(77), qs: `organization=${ORG}` })
    expect(res.status).toBe(404)
  })

  it.each([4, 5, 6])('user %i (not estudiante) → 403 on the student routes', async (uid) => {
    const { call, Q } = setup()
    expect((await call('get', '/estudiante', { as: user(uid), qs: `organization=${ORG}` })).status).toBe(403)
    expect((await call('get', '/estudiante/alcance', { as: user(uid), qs: `organization=${ORG}&alcance=mios` })).status).toBe(403)
    expect(Q.calls).toEqual([])
  })

  it('acceso tells the UI who is who', async () => {
    const { call } = setup()
    expect((await call('get', '/estudiante/acceso', { as: user(1), qs: `organization=${ORG}` })).body).toEqual({
      student: true,
      teacher: false,
      admin: false,
    })
    // `lib/roles.ts` (roles lane): `canAdminOrg` is owner OR investigador.
    expect((await call('get', '/estudiante/acceso', { as: user(5), qs: `organization=${ORG}` })).body).toMatchObject({
      teacher: true,
      admin: true,
    })
  })
})

describe('student scoping', () => {
  it('peers: only opted-in students, as name + shared topics; my texts are read only for me', async () => {
    const { w, call, Q } = setup()
    w.profiles.push({ id: 1, user: 2, organization: ORG, shareWithPeers: true, shareActivity: false })
    // 3 shares more topics but did not opt in.
    w.profiles.push({ id: 2, user: 3, organization: ORG, shareWithPeers: false, shareActivity: true })
    const res = await call('get', '/estudiante', { as: user(1), qs: `organization=${ORG}` })
    expect(res.status).toBe(200)
    expect(res.body.companeros).toEqual([{ name: 'Persona 2', topics: ['semiosis'] }])
    // Peer topics come from PUBLISHED documents only; mine from all of mine.
    expect(Q.calls).toContain('topics:1:false')
    expect(Q.calls).toContain('topics:2:true')
    expect(Q.calls.filter((c) => c.startsWith('texts:'))).toEqual(['texts:1'])
    expect(Q.calls.filter((c) => c.startsWith('docs:'))).toEqual(['docs:1'])
    expect(res.body.autores).toEqual([
      { name: 'Charles S. Peirce', docs: 2, page: null },
      { name: 'Lotman', docs: 1, page: null },
    ])
    expect(res.body.autoresParaLeer).toEqual([{ name: 'Umberto Eco', docs: 2, page: { id: 90, name: 'Autores/Umberto Eco' } }])
  })

  it('the profile write is keyed on the session user, not the body', async () => {
    const { w, call } = setup()
    const res = await call('patch', '/estudiante/perfil', {
      as: user(1),
      body: { organization: ORG, shareWithPeers: true, user: 2 },
    })
    expect(res.status).toBe(200)
    expect(res.body.perfil).toEqual({ shareWithPeers: true, shareActivity: false, shareTestimonios: false })
    expect(w.profiles).toEqual([{ id: 1, user: 1, organization: ORG, shareWithPeers: true, shareActivity: false }])
  })

  it('a non-boolean flag is refused', async () => {
    const { call } = setup()
    const res = await call('patch', '/estudiante/perfil', { as: user(1), body: { organization: ORG, shareWithPeers: 'yes' } })
    expect(res.status).toBe(400)
  })

  it('alcance: mios = my documents; compañeros = published docs of opted-in peers only', async () => {
    const { w, call, Q } = setup()
    w.profiles.push({ id: 1, user: 2, organization: ORG, shareWithPeers: true, shareActivity: false })
    w.profiles.push({ id: 2, user: 1, organization: ORG, shareWithPeers: true, shareActivity: false })
    expect((await call('get', '/estudiante/alcance', { as: user(1), qs: `organization=${ORG}&alcance=mios` })).body).toEqual({
      documentIds: [101],
    })
    expect((await call('get', '/estudiante/alcance', { as: user(1), qs: `organization=${ORG}&alcance=companeros` })).body).toEqual({
      documentIds: [202],
    })
    expect(Q.calls).toContain('published:2')
  })

  it('sugerencias: a student files one, stamped with the session user; staff read them; a student cannot', async () => {
    const { w, call } = setup()
    const filed = await call('post', '/sugerencias', {
      as: user(1),
      body: { organization: ORG, kind: 'interaccion', text: '  Más filtros  ', author: 4 },
    })
    expect(filed.status).toBe(201)
    expect(w.suggestions).toEqual([{ organization: ORG, author: 1, kind: 'interaccion', text: 'Más filtros' }])
    expect((await call('post', '/sugerencias', { as: user(1), body: { organization: ORG, kind: 'x', text: 'y' } })).status).toBe(400)
    expect((await call('get', '/sugerencias', { as: user(1), qs: `organization=${ORG}` })).status).toBe(403)
    expect((await call('get', '/sugerencias', { as: user(5), qs: `organization=${ORG}` })).status).toBe(200)
    expect((await call('get', '/sugerencias', { as: user(4), qs: `organization=${ORG}` })).status).toBe(200)
  })
})

describe('activity report', () => {
  it('canAdminOrg + consent → the report; never readings by the student themself', async () => {
    const { w, call, Q } = setup()
    w.profiles.push({ id: 1, user: 1, organization: ORG, shareWithPeers: false, shareActivity: true })
    const list = await call('get', '/estudiante/reportes', { as: user(4), qs: `organization=${ORG}` })
    expect(list.body).toEqual({ estudiantes: [{ id: 1, name: 'Persona 1' }] })
    const res = await call('get', '/estudiante/reporte', { as: user(4), qs: `organization=${ORG}&user=1` })
    expect(res.status).toBe(200)
    const r = res.body.reporte as Record<string, unknown>
    expect(r.topics).toEqual(['semiosis', 'signo'])
    expect(r.gaps).toEqual(['abducción'])
    // 🔴 Owner ruling Q23: the count, never a title.
    expect(r.summary).toMatchObject({ conversations: 4 })
    expect('chatThemes' in r).toBe(false)
    expect(r.readings).toEqual([{ id: 70, name: 'Lectura' }])
    expect(Q.calls).toContain('readings:exclude=1')
    // 🔴 The teacher sees topics from the student's PUBLISHED documentos only.
    expect(Q.calls).toContain('topics:1:true')
    expect(Q.calls).not.toContain('topics:1:false')
  })

  it('no consent → 404, same as no such student', async () => {
    const { w, call, Q } = setup()
    w.profiles.push({ id: 1, user: 2, organization: ORG, shareWithPeers: true, shareActivity: false })
    expect((await call('get', '/estudiante/reporte', { as: user(4), qs: `organization=${ORG}&user=2` })).status).toBe(404)
    expect((await call('get', '/estudiante/reporte', { as: user(4), qs: `organization=${ORG}&user=999` })).status).toBe(404)
    expect(Q.calls.filter((c) => c.startsWith('docs:'))).toEqual([])
  })

  it('an investigador (canAdminOrg per lib/roles.ts) may read a consented report', async () => {
    const { w, call } = setup()
    w.profiles.push({ id: 1, user: 1, organization: ORG, shareWithPeers: false, shareActivity: true })
    expect((await call('get', '/estudiante/reporte', { as: user(5), qs: `organization=${ORG}&user=1` })).status).toBe(200)
    expect((await call('get', '/estudiante/reportes', { as: user(5), qs: `organization=${ORG}` })).status).toBe(200)
  })

  it.each([1, 6])('user %i (not canAdminOrg) → 403', async (uid) => {
    const { w, call } = setup()
    w.profiles.push({ id: 1, user: 1, organization: ORG, shareWithPeers: false, shareActivity: true })
    expect((await call('get', '/estudiante/reporte', { as: user(uid), qs: `organization=${ORG}&user=1` })).status).toBe(403)
    expect((await call('get', '/estudiante/reportes', { as: user(uid), qs: `organization=${ORG}` })).status).toBe(403)
  })

  it('a platform admin who is not a member may read a consented report', async () => {
    const { w, call } = setup()
    w.profiles.push({ id: 1, user: 1, organization: ORG, shareWithPeers: false, shareActivity: true })
    const res = await call('get', '/estudiante/reporte', { as: user(99, { isPlatformAdmin: true }), qs: `organization=${ORG}&user=1` })
    expect(res.status).toBe(200)
  })

  it('🔴 studentTestimonios off (default): testimonios are never read, and the report has no such key', async () => {
    const { w, call, Q } = setup()
    w.profiles.push({ id: 1, user: 1, organization: ORG, shareWithPeers: false, shareActivity: true })
    const res = await call('get', '/estudiante/reporte', { as: user(4), qs: `organization=${ORG}&user=1` })
    expect(res.status).toBe(200)
    expect('testimonios' in (res.body.reporte as object)).toBe(false)
    expect(Q.calls.filter((c) => c.startsWith('testimonios:'))).toEqual([])
  })

  it('studentTestimonios on: the consenting student\'s testimonios, read for that student only', async () => {
    const { w, call, Q } = setup()
    w.features[ORG] = { studentView: true, studentTestimonios: true }
    w.profiles.push({ id: 1, user: 1, organization: ORG, shareWithPeers: false, shareActivity: true, shareTestimoniosAt: '2026-10-27T00:00:00.000Z', shareTestimoniosVersion: TESTIMONIO_CONSENT_VERSION })
    const res = await call('get', '/estudiante/reporte', { as: user(5), qs: `organization=${ORG}&user=1` })
    expect((res.body.reporte as { testimonios: unknown }).testimonios).toEqual([
      { id: 300, createdAt: '2026-10-02', state: 'visible', title: 'Testimonio', text: 'Habló [Persona A].' },
    ])
    expect(Q.calls.filter((c) => c.startsWith('testimonios:'))).toEqual(['testimonios:1'])
    // A student, even with the switch on, gets nothing.
    const asStudent = await call('get', '/estudiante/reporte', { as: user(2), qs: `organization=${ORG}&user=1` })
    expect(asStudent.status).toBe(403)
    expect(Q.calls.filter((c) => c.startsWith('testimonios:'))).toEqual(['testimonios:1'])
  })

  it('🔴 a testimonio consent given under an older wording (no version, or an old one) does not count', async () => {
    for (const version of [undefined, null, TESTIMONIO_CONSENT_VERSION - 1]) {
      const { w, call, Q } = setup()
      w.features[ORG] = { studentView: true, studentTestimonios: true }
      invalidateFeatures()
      w.profiles.push({ id: 1, user: 1, organization: ORG, shareWithPeers: false, shareActivity: true, shareTestimoniosAt: '2026-10-27T00:00:00.000Z', shareTestimoniosVersion: version })
      const res = await call('get', '/estudiante/reporte', { as: user(5), qs: `organization=${ORG}&user=1` })
      expect(res.status).toBe(200)
      expect('testimonios' in (res.body.reporte as object)).toBe(false)
      expect(Q.calls.filter((c) => c.startsWith('testimonios:'))).toEqual([])
      const mine = await call('get', '/estudiante', { as: user(1), qs: `organization=${ORG}` })
      expect((mine.body.perfil as { shareTestimonios: boolean }).shareTestimonios).toBe(false)
    }
  })

  it('🔴 accepting stores the wording version the page showed; any other version is refused', async () => {
    const { w, call } = setup()
    w.features[ORG] = { studentView: true, studentTestimonios: true }
    invalidateFeatures()
    for (const consentVersion of [undefined, TESTIMONIO_CONSENT_VERSION - 1, TESTIMONIO_CONSENT_VERSION + 1, '2']) {
      const res = await call('patch', '/estudiante/perfil', { as: user(1), body: { organization: ORG, shareTestimonios: true, consentVersion } })
      expect(res.status).toBe(409)
    }
    expect(w.profiles).toEqual([])
    const ok = await call('patch', '/estudiante/perfil', {
      as: user(1),
      body: { organization: ORG, shareTestimonios: true, consentVersion: TESTIMONIO_CONSENT_VERSION },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.perfil).toEqual({ shareWithPeers: false, shareActivity: true, shareTestimonios: true })
    expect(w.profiles[0]).toMatchObject({ shareTestimoniosVersion: TESTIMONIO_CONSENT_VERSION })
    const off = await call('patch', '/estudiante/perfil', { as: user(1), body: { organization: ORG, shareTestimonios: false } })
    expect(off.body.perfil).toMatchObject({ shareTestimonios: false })
    expect(w.profiles[0]).toMatchObject({ shareTestimoniosAt: null, shareTestimoniosVersion: null })
  })

  it('overview tells the student whether testimonios reach the report (for the consent wording)', async () => {
    const { w, call } = setup()
    expect((await call('get', '/estudiante', { as: user(1), qs: `organization=${ORG}` })).body.testimoniosEnReporte).toBe(false)
    w.features[ORG] = { studentView: true, studentTestimonios: true }
    invalidateFeatures()
    expect((await call('get', '/estudiante', { as: user(1), qs: `organization=${ORG}` })).body.testimoniosEnReporte).toBe(true)
  })
})
