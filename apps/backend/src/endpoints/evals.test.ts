/**
 * `/api/evals/*` — access (platform admin only, fail closed), the gate route
 * returning term verdicts and never the text, and the starter seed.
 * Fake Payload; the access checks, the scorer and the starter data are real.
 */
import { describe, expect, it } from 'vitest'
import type { Endpoint, PayloadRequest } from 'payload'

import { EvalItems } from '../collections/EvalItems'
import { EvalRuns } from '../collections/EvalRuns'
import { makeEvalEndpoints, type GateRunArgs } from './evals'

const ADMIN = { id: 1, email: 'a@x.mx', isPlatformAdmin: true, isActive: true }
const OWNER = { id: 2, email: 'o@x.mx', isPlatformAdmin: false, isActive: true }
const INACTIVE_ADMIN = { id: 3, email: 'i@x.mx', isPlatformAdmin: true, isActive: false }
/** A truthy non-boolean flag must not open anything. */
const STRINGY = { id: 4, email: 's@x.mx', isPlatformAdmin: 'true', isActive: true }

const TEXT = 'Doña Herminia Salas fue al PILARES con su nieto Brandon. El DIF ayudó. Herminia volvió.'

interface World {
  items: Array<Record<string, unknown>>
  created: Array<{ collection: string; data: Record<string, unknown> }>
  docs: Array<{ id: number; name: string; organization: number }>
  orgs: Array<{ id: number; slug: string }>
  runs: Array<Record<string, unknown>>
  updated: Array<{ collection: string; id: number; data: Record<string, unknown> }>
}

function fakePayload(w: World) {
  return {
    findByID: async ({ collection, id }: { collection: string; id: number }) => {
      if (collection === 'organizations') return w.orgs.find((o) => o.id === id) ?? null
      if (collection === 'eval-items') return w.items.find((i) => i.id === id) ?? null
      if (collection === 'eval-runs') return w.runs.find((r) => r.id === id) ?? null
      return null
    },
    update: async ({ collection, id, data }: { collection: string; id: number; data: Record<string, unknown> }) => {
      w.updated.push({ collection, id, data })
      return { id, ...data }
    },
    count: async ({ where }: { where: { organization: { equals: number } } }) => ({
      totalDocs: w.items.filter((i) => i.organization === where.organization.equals).length,
    }),
    find: async ({ where }: { where: { and: [{ organization: { equals: number } }, { name: { in: string[] } }] } }) => ({
      docs: w.docs.filter((d) => d.organization === where.and[0].organization.equals && where.and[1].name.in.includes(d.name)),
    }),
    create: async ({ collection, data }: { collection: string; data: Record<string, unknown> }) => {
      w.created.push({ collection, data })
      return { id: 900 + w.created.length, ...data }
    },
  }
}

function world(): World {
  return {
    items: [
      {
        id: 10,
        organization: 7,
        kind: 'privacidad',
        text: TEXT,
        gateKind: 'documento',
        privateNames: ['Herminia', 'Salas', 'Brandon'],
        publicNames: ['PILARES', 'DIF'],
      },
      { id: 11, organization: 7, kind: 'pregunta', question: '¿Qué?' },
    ],
    created: [],
    docs: [{ id: 391, name: 'Bertrand Russell', organization: 8 }, { id: 392, name: 'Bertrand Russell', organization: 8 }],
    orgs: [{ id: 7, slug: 'discapacidad' }, { id: 8, slug: 'semiosis-practica' }, { id: 9, slug: 'sin-set' }],
    runs: [
      { id: 50, organization: 7, status: 'running', triggeredBy: 1 },
      { id: 51, organization: 7, status: 'done', triggeredBy: 1 },
      { id: 52, organization: 7, status: 'queued', triggeredBy: 1 },
      { id: 53, organization: 7, status: 'running', triggeredBy: 99 },
      { id: 54, organization: 7, status: 'running', triggeredBy: 1, sessionId: '777' },
    ],
    updated: [],
  }
}

function call(
  endpoints: Endpoint[],
  path: string,
  opts: { as: unknown; body?: unknown; w: World },
): Promise<Response> {
  const route = endpoints.find((e) => e.path === path)!
  const req = { user: opts.as, payload: fakePayload(opts.w), json: async () => opts.body ?? {} }
  return route.handler(req as unknown as PayloadRequest) as Promise<Response>
}

const gateCalls: GateRunArgs[] = []
const endpoints = makeEvalEndpoints({
  runGate: async (_req, args) => {
    gateCalls.push(args)
    return {
      detector: 'fake',
      result: {
        status: 'ready',
        // Brandon survives (a leak); DIF is hidden (over-redaction).
        redactedText: 'Doña [Persona A] [Persona A] fue al PILARES con su nieto Brandon. El [Dato omitido] ayudó. [Persona A] volvió.',
        report: { stages: [], pseudonyms: 1, model: 'qwen-fake' },
      },
    }
  },
})

describe('access: platform admin only, fail closed', () => {
  for (const path of ['/evals/session', '/evals/gate', '/evals/seed']) {
    it(`${path}: 401 anonymous, 403 for an owner, an inactive admin and a non-boolean flag`, async () => {
      const w = world()
      expect((await call(endpoints, path, { as: null, w, body: { organization: 7, item: 10, run: 50 } })).status).toBe(401)
      for (const as of [OWNER, INACTIVE_ADMIN, STRINGY]) {
        const res = await call(endpoints, path, { as, w, body: { organization: 7, item: 10, run: 50 } })
        expect([401, 403]).toContain(res.status)
        if (as !== INACTIVE_ADMIN) expect(res.status).toBe(403)
      }
      expect(w.created).toEqual([])
    })
  }

  it('both collections allow every operation to a platform admin only', () => {
    for (const c of [EvalItems, EvalRuns]) {
      for (const op of ['read', 'create', 'update', 'delete'] as const) {
        const access = c.access![op] as (a: { req: { user: unknown } }) => unknown
        expect(access({ req: { user: ADMIN } })).toBe(true)
        for (const u of [null, OWNER, INACTIVE_ADMIN, STRINGY]) expect(access({ req: { user: u } })).toBe(false)
      }
    }
  })
})

describe('POST /api/evals/gate', () => {
  it('scores the planted terms and never returns the text', async () => {
    const w = world()
    const res = await call(endpoints, '/evals/gate', { as: ADMIN, w, body: { item: 10 } })
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain('Doña')
    expect(raw).not.toContain('[Persona')
    const body = JSON.parse(raw)
    expect(body.status).toBe('ready')
    expect(body.model).toBe('qwen-fake')
    const byTerm = Object.fromEntries(body.terms.map((t: { term: string; ok: boolean }) => [t.term, t.ok]))
    expect(byTerm).toEqual({ Herminia: true, Salas: true, Brandon: false, PILARES: true, DIF: false })
    expect(gateCalls.at(-1)).toEqual({ organizationId: 7, contentKind: 'documento', text: TEXT })
  })

  it('a hold scores nothing', async () => {
    const held = makeEvalEndpoints({
      runGate: async () => ({
        detector: 'fake',
        result: { status: 'hold', stage: 'verify', reason: 'x', report: { stages: [], pseudonyms: 0 }, redactedText: TEXT },
      }),
    })
    const body = await (await call(held, '/evals/gate', { as: ADMIN, w: world(), body: { item: 10 } })).json()
    expect(body).toMatchObject({ status: 'hold', stage: 'verify', terms: [] })
    expect(JSON.stringify(body)).not.toContain('Herminia')
  })

  it('a chat item or an unknown id is a 404; a gate crash is a 502 naming no text', async () => {
    const w = world()
    expect((await call(endpoints, '/evals/gate', { as: ADMIN, w, body: { item: 11 } })).status).toBe(404)
    expect((await call(endpoints, '/evals/gate', { as: ADMIN, w, body: { item: 99 } })).status).toBe(404)
    const crash = makeEvalEndpoints({
      runGate: async () => {
        throw new Error(`boom ${TEXT}`)
      },
    })
    const res = await call(crash, '/evals/gate', { as: ADMIN, w, body: { item: 10 } })
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('Herminia')
  })
})

describe('POST /api/evals/session', () => {
  it('creates a generales conversation for a RUNNING run the admin started, bound to that run', async () => {
    const w = world()
    const res = await call(endpoints, '/evals/session', { as: ADMIN, w, body: { run: 50 } })
    expect(res.status).toBe(201)
    expect(w.created).toEqual([
      { collection: 'sessions', data: { user: 1, organization: 7, kind: 'generales', title: 'Evaluación', evalRun: 50 } },
    ])
    expect(w.updated).toEqual([{ collection: 'eval-runs', id: 50, data: { sessionId: '901' } }])
  })

  it('🔴 R77: no running run of the caller, no conversation (an admin cannot use it to chat freely)', async () => {
    const w = world()
    for (const body of [{}, { organization: 7 }, { run: 404 }, { run: 51 }, { run: 52 }, { run: 53 }, { run: 54 }]) {
      const res = await call(endpoints, '/evals/session', { as: ADMIN, w, body })
      expect([400, 403, 404, 409], JSON.stringify(body)).toContain(res.status)
    }
    expect(w.created).toEqual([])
    expect(w.updated).toEqual([])
  })
})

describe('POST /api/evals/seed', () => {
  it('loads the starter set, resolving every document with the expected title', async () => {
    const w = world()
    const res = await call(endpoints, '/evals/seed', { as: ADMIN, w, body: { organization: 8 } })
    expect(res.status).toBe(201)
    const russell = w.created.find((c) => String(c.data.question).includes('Russell'))!
    expect(russell.data.expectedDocIds).toEqual([391, 392])
    // Not on this fake: the title lands in the notes, no id is invented.
    const greimas = w.created.find((c) => String(c.data.question).includes('Greimas'))!
    expect(greimas.data.expectedDocIds).toEqual([])
    expect(greimas.data.notes).toContain('Algirdas Julien Greimas')
    const refuse = w.created.filter((c) => c.data.shouldRefuse === true)
    expect(refuse.length).toBe(2)
    expect(w.created.some((c) => c.data.kind === 'privacidad')).toBe(true)
  })

  it('refuses an ecosistema that already has items (409) or has no starter set (404)', async () => {
    const w = world()
    expect((await call(endpoints, '/evals/seed', { as: ADMIN, w, body: { organization: 7 } })).status).toBe(409)
    expect((await call(endpoints, '/evals/seed', { as: ADMIN, w, body: { organization: 9 } })).status).toBe(404)
    expect(w.created).toEqual([])
  })
})
