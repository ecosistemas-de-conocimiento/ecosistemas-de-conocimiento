/**
 * THE HTTP SURFACE OF THE CORPUS GRAPH.
 *
 * `queries.test.ts` proves the SQL carries ADR §6's three gates. This file
 * proves the ROUTES in front of it cannot be talked out of them:
 *
 *   · nobody unauthenticated reads a graph;
 *   · nobody reads an ecosistema they do not belong to, and cannot tell
 *     "not yours" from "does not exist";
 *   · the organization id that reaches SQL is the one the ROUTE authorised,
 *     never one a query string smuggled past it;
 *   · a hidden node is a 404, not a 403 — because a 403 would confirm it exists.
 *
 * The database is faked. What is real is the handler, `authoriseOrganization`,
 * the membership resolver it calls, and the SQL it hands down — which is
 * inspected here rather than executed.
 */

import { describe, expect, it } from 'vitest'
import type { PayloadRequest } from 'payload'

import {
  authoriseOrganization,
  graphEndpoints,
  graphEntityEndpoint,
  graphRetrieveEndpoint,
  graphViewEndpoint,
} from './graph'

// ---------------------------------------------------------------------------
// A fake request, and a fake database behind it
// ---------------------------------------------------------------------------

interface FakeOptions {
  user?: Record<string, unknown> | null
  /** Organization ids the caller is an active member of. */
  memberOf?: number[]
  /** Canned `db.drizzle.execute` results, in call order. */
  rows?: Record<string, unknown>[][]
  routeParams?: Record<string, string>
  body?: unknown
}

interface FakeRequest {
  req: PayloadRequest
  /** The raw SQL text of every statement the handler ran. */
  sql: string[]
}

const MEMBER = { id: 1, email: 'ana@example.test', isActive: true }
const ADMIN = { id: 2, email: 'root@example.test', isActive: true, isPlatformAdmin: true }

function fakeRequest(url: string, options: FakeOptions = {}): FakeRequest {
  const sql: string[] = []
  const rows = options.rows ?? []
  let call = 0

  const memberOf = options.memberOf ?? []
  const payload = {
    // `organizationIdsForUser` asks for memberships, then for the organizations
    // they point at. Both must come back ACTIVE for the caller to be a member.
    async find({ collection }: { collection: string }) {
      if (collection === 'memberships') {
        return { docs: memberOf.map((id) => ({ id, organization: id, role: 'member', isActive: true })) }
      }
      if (collection === 'organizations') {
        return { docs: memberOf.map((id) => ({ id, name: `Eco ${id}`, isActive: true })) }
      }
      return { docs: [] }
    },
    db: {
      drizzle: {
        async execute(query: unknown) {
          sql.push(renderText(query))
          return { rows: rows[call++] ?? [] }
        },
      },
    },
  }

  const req = {
    user: options.user === undefined ? MEMBER : options.user,
    payload,
    searchParams: new URL(url, 'http://test.local').searchParams,
    routeParams: options.routeParams ?? {},
    headers: new Headers(),
    json: async () => options.body ?? {},
  } as unknown as PayloadRequest

  return { req, sql }
}

/** Same walk as `queries.test.ts`; only the text is needed here. */
function renderText(query: unknown): string {
  let n = 0
  const walk = (node: { queryChunks: unknown[] }): string =>
    node.queryChunks
      .map((chunk) => {
        const name = (chunk as { constructor?: { name?: string } })?.constructor?.name
        if (name === 'StringChunk') return (chunk as { value: string[] }).value.join('')
        if (name === 'SQL') return walk(chunk as { queryChunks: unknown[] })
        n += 1
        return `$${n}`
      })
      .join('')
  return walk(query as { queryChunks: unknown[] })
}

const body = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>

const firstError = async (res: Response): Promise<string> => {
  const parsed = (await body(res)) as { errors?: { message?: string }[] }
  return parsed.errors?.[0]?.message ?? ''
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('the endpoints Payload mounts', () => {
  it('exposes exactly three routes, at the paths the web layer calls', () => {
    expect(graphEndpoints.map((e) => `${e.method.toUpperCase()} ${e.path}`)).toEqual([
      'GET /graph/view',
      'GET /graph/entity/:id',
      'POST /graph/retrieve',
    ])
  })

  it('🔴 asks for the question in a POST body, not a query string', () => {
    // A condensed question from a corpus of testimonies must not end up in
    // access logs, proxy logs or a `Referer` header.
    expect(graphRetrieveEndpoint.method).toBe('post')
  })
})

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

describe('🔴 authorisation — gate 1, at the door', () => {
  it('401s an anonymous caller', async () => {
    const { req } = fakeRequest('/?organization=7', { user: null })
    const res = (await authoriseOrganization(req, '7')) as Response
    expect(res.status).toBe(401)
    expect(await firstError(res)).toMatch(/iniciar sesión/i)
  })

  it('401s a deactivated account holding a valid session', async () => {
    // Payload's own auth knows nothing about `isActive`; `getAuthenticatedUser`
    // is where the flag is enforced on this surface.
    const { req } = fakeRequest('/?organization=7', {
      user: { ...MEMBER, isActive: false },
      memberOf: [7],
    })
    const res = (await authoriseOrganization(req, '7')) as Response
    expect(res.status).toBe(401)
  })

  it('400s when `organization` is missing or is not a positive integer', async () => {
    for (const raw of [undefined, null, '', '  ', 'abc', '0', '-3', '1.5', '12abc']) {
      const { req } = fakeRequest('/', { memberOf: [7] })
      const res = (await authoriseOrganization(req, raw)) as Response
      expect(res.status).toBe(400)
      expect(await firstError(res)).toMatch(/ecosistema/i)
    }
  })

  it('403s a caller who belongs to a DIFFERENT ecosistema', async () => {
    const { req } = fakeRequest('/?organization=8', { memberOf: [7] })
    const res = (await authoriseOrganization(req, '8')) as Response
    expect(res.status).toBe(403)
    expect(await firstError(res)).toMatch(/No perteneces a este ecosistema/)
  })

  it('403s a caller with no memberships at all', async () => {
    const { req } = fakeRequest('/?organization=7', { memberOf: [] })
    expect(((await authoriseOrganization(req, '7')) as Response).status).toBe(403)
  })

  it('🔴 gives the SAME answer for "not yours" and "does not exist"', async () => {
    // Different answers would turn the parameter into an existence oracle over
    // every tenant on the installation.
    const mine = fakeRequest('/', { memberOf: [7] })
    const notMine = (await authoriseOrganization(mine.req, '8')) as Response
    const nowhere = (await authoriseOrganization(mine.req, '999999')) as Response
    expect(notMine.status).toBe(nowhere.status)
    expect(await firstError(notMine)).toBe(await firstError(nowhere))
  })

  it('lets a member through, with the id normalised to a number', async () => {
    const { req } = fakeRequest('/?organization=7', { memberOf: [7] })
    expect(await authoriseOrganization(req, '7')).toEqual({ organizationId: 7 })
  })

  it('lets a platform admin name any ecosistema — scope selection, not content', async () => {
    // ADR §7.1. They see the same rows under the same thresholds; there is no
    // unfiltered view of this graph anywhere in the product.
    const { req } = fakeRequest('/?organization=42', { user: ADMIN, memberOf: [] })
    expect(await authoriseOrganization(req, '42')).toEqual({ organizationId: 42 })
  })

  it('does not let a DEACTIVATED platform admin through', async () => {
    const { req } = fakeRequest('/?organization=42', {
      user: { ...ADMIN, isActive: false },
      memberOf: [],
    })
    expect(((await authoriseOrganization(req, '42')) as Response).status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// GET /graph/view
// ---------------------------------------------------------------------------

describe('GET /api/graph/view', () => {
  it('answers with entities, hidden, minSupport and publishedDocuments', async () => {
    const { req } = fakeRequest('/?organization=7', {
      memberOf: [7],
      rows: [
        [
          { id: 5, type: 'tema', label: 'Consulta previa', support: 4, hidden: 9, total: 2 },
          { id: 6, type: 'lugar', label: 'Oaxaca', support: 3, hidden: 9, total: 2 },
        ],
        [{ n: 14 }],
        [{ from_id: 5, to_id: 6, kind: 'relation', support: 3, co_mentions: 4, relation_type: 'ocurre_en', direction: 'out' }],
      ],
    })
    const res = await graphViewEndpoint.handler(req)
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({
      entities: [
        { id: 5, type: 'tema', label: 'Consulta previa', support: 4 },
        { id: 6, type: 'lugar', label: 'Oaxaca', support: 3 },
      ],
      hidden: 9,
      total: 2,
      minSupport: 1,
      minEdgeSupport: 1,
      publishedDocuments: 14,
      // The whole-graph edges among the listed entities (backlog #3).
      edges: [
        { from: 5, to: 6, kind: 'relation', support: 3, coMentions: 4, relationType: 'ocurre_en', direction: 'out' },
      ],
    })
  })

  it('🔴 tells a young ecosistema apart from a thresholded one', async () => {
    // Nothing published at all: the UI says "todavía no hay documentos
    // publicados". `hidden: 0` here is a fact, not an omission.
    const young = fakeRequest('/?organization=7', {
      memberOf: [7],
      rows: [[], [{ n: 2 }]],
    })
    expect(await body(await graphViewEndpoint.handler(young.req))).toEqual({
      entities: [],
      hidden: 0,
      total: 0,
      minSupport: 1,
      minEdgeSupport: 1,
      publishedDocuments: 2,
      edges: [],
    })

    // Published, but every entity is below the threshold: the UI says
    // "aún no hay suficientes documentos publicados para mostrar conexiones".
    const thresholded = fakeRequest('/?organization=7', {
      memberOf: [7],
      rows: [[{ id: null, type: null, label: null, support: null, hidden: 31, total: 0 }], [{ n: 2 }]],
    })
    expect(await body(await graphViewEndpoint.handler(thresholded.req))).toEqual({
      entities: [],
      hidden: 31,
      total: 0,
      minSupport: 1,
      minEdgeSupport: 1,
      publishedDocuments: 2,
      edges: [],
    })
  })

  it('400s an unknown `type`, naming the five that exist', async () => {
    const { req } = fakeRequest('/?organization=7&type=animal', { memberOf: [7] })
    const res = await graphViewEndpoint.handler(req)
    expect(res.status).toBe(400)
    expect(await firstError(res)).toContain('organizacion')
  })

  it('accepts each of the five node types', async () => {
    for (const type of ['tema', 'lugar', 'evento', 'organizacion', 'persona']) {
      const { req, sql } = fakeRequest(`/?organization=7&type=${type}`, {
        memberOf: [7],
        rows: [[], [{ n: 0 }]],
      })
      expect((await graphViewEndpoint.handler(req)).status).toBe(200)
      expect(sql[0]).toContain('AND e.type = $')
    }
  })

  it('never caches a per-tenant answer in a shared proxy', async () => {
    const { req } = fakeRequest('/?organization=7', { memberOf: [7], rows: [[], [{ n: 0 }]] })
    const res = await graphViewEndpoint.handler(req)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('refuses before it queries anything', async () => {
    const { req, sql } = fakeRequest('/?organization=8', { memberOf: [7] })
    expect((await graphViewEndpoint.handler(req)).status).toBe(403)
    expect(sql).toEqual([])
  })

  it('🔴 sends every gate down to SQL on the real route', async () => {
    const { req, sql } = fakeRequest('/?organization=7&q=agua', {
      memberOf: [7],
      rows: [[], [{ n: 0 }]],
    })
    await graphViewEndpoint.handler(req)
    expect(sql[0]).toContain('d.organization_id = $')
    expect(sql[0]).toContain("d.publication_status = 'published'")
    expect(sql[0]).toContain('WHERE support >= $')
  })
})

// ---------------------------------------------------------------------------
// GET /graph/entity/:id
// ---------------------------------------------------------------------------

describe('GET /api/graph/entity/:id', () => {
  it('returns the entity, its one-hop neighbours and its documents', async () => {
    const { req } = fakeRequest('/?organization=7', {
      memberOf: [7],
      routeParams: { id: '5' },
      rows: [
        [{ id: 5, type: 'tema', label: 'Consulta previa', support: 4 }],
        [
          {
            id: 6,
            type: 'lugar',
            label: 'Oaxaca',
            support: 3,
            relation_type: 'ocurre_en',
            edge_support: 3,
          },
        ],
        [{ id: 88, name: 'informe.pdf', content_kind: 'documento', snippet: 'la consulta' }],
        [
          {
            neighbour_id: 6,
            relation_type: 'ocurre_en',
            id: 88,
            name: 'informe.pdf',
            content_kind: 'documento',
          },
        ],
      ],
    })
    const res = await graphEntityEndpoint.handler(req)
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({
      entity: { id: 5, type: 'tema', label: 'Consulta previa', support: 4 },
      neighbours: [
        {
          entity: { id: 6, type: 'lugar', label: 'Oaxaca', support: 3 },
          relationType: 'ocurre_en',
          support: 3,
          pairSupport: 3,
          direction: 'both',
          // 🔴 The documents that EVIDENCE this edge, straight out of
          // `graph_relations` — not the intersection of two entity lists the
          // surface used to approximate it with.
          documents: [{ id: 88, title: 'informe.pdf', contentKind: 'documento' }],
        },
      ],
      documents: [
        { id: 88, title: 'informe.pdf', contentKind: 'documento', snippet: 'la consulta' },
      ],
    })
  })

  it('🔴 sends the per-edge evidence query down with all three gates', async () => {
    const { req, sql } = fakeRequest('/?organization=7', {
      memberOf: [7],
      routeParams: { id: '5' },
      rows: [[{ id: 5, type: 'tema', label: 'X', support: 3 }], [], [], []],
    })
    await graphEntityEndpoint.handler(req)
    // One detail statement, then three run concurrently. A dedicated
    // `/api/graph/edge/…` route would instead have cost one request per edge.
    expect(sql).toHaveLength(4)
    const edges = sql.find((s) => s.includes('ROW_NUMBER() OVER ('))
    expect(edges).toBeDefined()
    expect(edges).toContain('r.organization_id = $')
    expect(edges).toContain('d.organization_id = $')
    expect(edges).toContain("d.publication_status = 'published'")
    expect(edges).toContain('HAVING COUNT(DISTINCT r.document_id) >= $')
    // The evidence list is not a place for a verbatim quotation.
    expect(edges).not.toContain('snippet')
  })

  it('🔴 masks a testimonio title on the EDGE list too, on the wire', async () => {
    const { req } = fakeRequest('/?organization=7', {
      memberOf: [7],
      routeParams: { id: '5' },
      rows: [
        [{ id: 5, type: 'tema', label: 'Desplazamiento', support: 3 }],
        [
          {
            id: 6,
            type: 'lugar',
            label: 'Oaxaca',
            support: 3,
            relation_type: 'ocurre_en',
            edge_support: 3,
          },
        ],
        [],
        [
          {
            neighbour_id: 6,
            relation_type: 'ocurre_en',
            id: 90,
            name: 'Testimonio de María López.mp3',
            content_kind: 'testimonio',
          },
        ],
      ],
    })
    const raw = await (await graphEntityEndpoint.handler(req)).text()
    expect(raw).not.toContain('María')
    expect(JSON.parse(raw).neighbours[0].documents).toEqual([
      { id: 90, title: 'Testimonio', contentKind: 'testimonio' },
    ])
  })

  it('🔴 masks a testimonio title and drops its snippet, on the wire', async () => {
    const { req } = fakeRequest('/?organization=7', {
      memberOf: [7],
      routeParams: { id: '5' },
      rows: [
        [{ id: 5, type: 'tema', label: 'Desplazamiento', support: 3 }],
        [],
        [
          {
            id: 90,
            name: 'Testimonio de María López.mp3',
            content_kind: 'testimonio',
            snippet: 'me llamo María y vivo en …',
          },
        ],
      ],
    })
    const raw = await (await graphEntityEndpoint.handler(req)).text()
    expect(raw).not.toContain('María')
    expect(JSON.parse(raw).documents).toEqual([
      { id: 90, title: 'Testimonio', contentKind: 'testimonio', snippet: null },
    ])
  })

  it('🔴 404s a node the threshold hides — never 403, which would confirm it exists', async () => {
    const { req, sql } = fakeRequest('/?organization=7', {
      memberOf: [7],
      routeParams: { id: '5' },
      rows: [[]],
    })
    const res = await graphEntityEndpoint.handler(req)
    expect(res.status).toBe(404)
    expect(await firstError(res)).toMatch(/no existe en este ecosistema/i)
    // And it stops there: no neighbour or document query is paid for.
    expect(sql).toHaveLength(1)
  })

  it('400s an id that is not a positive integer', async () => {
    for (const id of ['', 'abc', '0', '-1', '1;DROP TABLE documents']) {
      const { req } = fakeRequest('/?organization=7', { memberOf: [7], routeParams: { id } })
      expect((await graphEntityEndpoint.handler(req)).status).toBe(400)
    }
  })

  it('🔴 scopes by the AUTHORISED organization, not by the entity id', async () => {
    const { req, sql } = fakeRequest('/?organization=7', {
      memberOf: [7],
      routeParams: { id: '5' },
      rows: [[{ id: 5, type: 'tema', label: 'X', support: 3 }], [], []],
    })
    await graphEntityEndpoint.handler(req)
    // ⚠ FOUR, not three: the per-edge evidence statement joined the route. This
    // loop is the reason the count is asserted at all — every statement the
    // route runs has to carry the tenant, so a new one must show up here rather
    // than be added quietly.
    expect(sql).toHaveLength(4)
    for (const statement of sql) {
      // Whichever graph table the statement reads names the tenant itself…
      expect(statement).toMatch(/[emr]\.organization_id = \$/)
      // …and so does the join that makes it published-only.
      expect(statement).toContain('d.organization_id = $')
      expect(statement).toContain("d.publication_status = 'published'")
    }
  })
})

// ---------------------------------------------------------------------------
// POST /graph/retrieve
// ---------------------------------------------------------------------------

describe('POST /api/graph/retrieve', () => {
  it('matches, expands one hop and returns expansion terms', async () => {
    const { req } = fakeRequest('/', {
      memberOf: [7],
      body: { organization: 7, query: '¿qué dice sobre la consulta previa?' },
      rows: [
        [
          {
            id: 1,
            type: 'tema',
            label: 'Consulta previa',
            canonical_key: 'consulta previa',
            support: 5,
          },
        ],
        [
          {
            relation_type: 'ocurre_en',
            support: 3,
            from_id: 1,
            from_type: 'tema',
            from_label: 'Consulta previa',
            from_support: 5,
            to_id: 2,
            to_type: 'lugar',
            to_label: 'Oaxaca',
            to_support: 4,
          },
        ],
        [{ id: 88, name: 'informe.pdf', content_kind: 'documento' }],
      ],
    })
    const res = await graphRetrieveEndpoint.handler(req)
    expect(res.status).toBe(200)
    const parsed = await body(res)
    expect(parsed.entities).toEqual([
      { id: 1, type: 'tema', label: 'Consulta previa', support: 5 },
    ])
    expect(parsed.terms).toEqual(['Oaxaca'])
    expect(parsed.documents).toEqual([{ id: 88, title: 'informe.pdf', contentKind: 'documento' }])
  })

  it('⚠ carries NO snippet, for any content kind — these rows feed a prompt', async () => {
    const { req, sql } = fakeRequest('/', {
      memberOf: [7],
      body: { organization: 7, query: 'consulta previa' },
      rows: [
        [{ id: 1, type: 'tema', label: 'Consulta previa', canonical_key: 'consulta previa', support: 5 }],
        [],
        [{ id: 88, name: 'informe.pdf', content_kind: 'documento', snippet: 'no debería salir' }],
      ],
    })
    const raw = await (await graphRetrieveEndpoint.handler(req)).text()
    expect(raw).not.toContain('snippet')
    expect(raw).not.toContain('no debería salir')
    for (const statement of sql) expect(statement).not.toContain('snippet')
  })

  it('returns four empty collections when the query names nothing', async () => {
    // The silent fallback ADR §8.2 expects: no chunks, no block, an ordinary
    // answer, and no message to the user.
    const { req } = fakeRequest('/', {
      memberOf: [7],
      body: { organization: 7, query: 'hola, buenos días' },
      rows: [[{ id: 1, type: 'tema', label: 'Agua', canonical_key: 'agua', support: 5 }]],
    })
    expect(await body(await graphRetrieveEndpoint.handler(req))).toEqual({
      entities: [],
      edges: [],
      documents: [],
      terms: [],
    })
  })

  it('400s a missing, blank or non-string query', async () => {
    for (const query of [undefined, null, '', '   ', 42, { q: 'x' }]) {
      const { req } = fakeRequest('/', { memberOf: [7], body: { organization: 7, query } })
      const res = await graphRetrieveEndpoint.handler(req)
      expect(res.status).toBe(400)
      expect(await firstError(res)).toMatch(/query/)
    }
  })

  it('403s an ecosistema the caller does not belong to, before any query', async () => {
    const { req, sql } = fakeRequest('/', {
      memberOf: [7],
      body: { organization: 8, query: 'consulta previa' },
    })
    expect((await graphRetrieveEndpoint.handler(req)).status).toBe(403)
    expect(sql).toEqual([])
  })

  it('accepts the organization as a number or as a string', async () => {
    for (const organization of [7, '7']) {
      const { req } = fakeRequest('/', {
        memberOf: [7],
        body: { organization, query: 'agua' },
        rows: [[]],
      })
      expect((await graphRetrieveEndpoint.handler(req)).status).toBe(200)
    }
  })

  it('survives a body that is not JSON at all', async () => {
    const req = {
      user: MEMBER,
      payload: { async find() { return { docs: [] } } },
      searchParams: new URLSearchParams(),
      routeParams: {},
      headers: new Headers(),
      json: async () => {
        throw new Error('not json')
      },
    } as unknown as PayloadRequest
    // No body means no `organization`, which is a 400 — not a 500.
    expect((await graphRetrieveEndpoint.handler(req)).status).toBe(400)
  })

  it('🔴 applies the SAME threshold as the view, so retrieval is not a side door', async () => {
    const { req, sql } = fakeRequest('/', {
      memberOf: [7],
      body: { organization: 7, query: 'agua' },
      rows: [[]],
    })
    await graphRetrieveEndpoint.handler(req)
    expect(sql[0]).toMatch(/HAVING COUNT\(DISTINCT m\.document_id\) >= \$/)
    expect(sql[0]).toContain("d.publication_status = 'published'")
    expect(sql[0]).toContain('e.organization_id = $')
  })

  it('caps a pathologically long query rather than sending it to the database', async () => {
    const { req } = fakeRequest('/', {
      memberOf: [7],
      body: { organization: 7, query: 'a'.repeat(50_000) },
      rows: [[]],
    })
    expect((await graphRetrieveEndpoint.handler(req)).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

describe('Spanish copy', () => {
  /**
   * ⚠ Asserted verbatim, not by a heuristic. A 4xx body from these routes
   * reaches the UI unmodified, so the copy IS the contract with the web lane —
   * and it is the difference between a person understanding a refusal and
   * seeing an English stack-trace fragment.
   */
  it('answers every refusal in Spanish, in words a member can act on', async () => {
    const messages = await Promise.all(
      [
        (await authoriseOrganization(fakeRequest('/', { user: null }).req, '7')) as Response,
        (await authoriseOrganization(fakeRequest('/', { memberOf: [7] }).req, null)) as Response,
        (await authoriseOrganization(fakeRequest('/', { memberOf: [7] }).req, '8')) as Response,
        await graphEntityEndpoint.handler(
          fakeRequest('/?organization=7', { memberOf: [7], routeParams: { id: 'x' } }).req,
        ),
        await graphEntityEndpoint.handler(
          fakeRequest('/?organization=7', {
            memberOf: [7],
            routeParams: { id: '5' },
            rows: [[]],
          }).req,
        ),
        await graphRetrieveEndpoint.handler(
          fakeRequest('/', { memberOf: [7], body: { organization: 7 } }).req,
        ),
        await graphViewEndpoint.handler(
          fakeRequest('/?organization=7&type=animal', { memberOf: [7] }).req,
        ),
      ].map(firstError),
    )

    expect(messages).toEqual([
      'Necesitas iniciar sesión.',
      'Falta el parámetro `organization` (el id del ecosistema).',
      'No perteneces a este ecosistema.',
      'Id de nodo inválido.',
      'Ese nodo no existe en este ecosistema.',
      'Falta `query`: el texto a buscar en el grafo.',
      'El parámetro `type` debe ser uno de: tema, lugar, evento, organizacion, persona.',
    ])

    // Nothing English leaks through from the helpers in `http.ts`.
    for (const message of messages) {
      expect(message).not.toMatch(/\b(required|missing|invalid|authentication|forbidden)\b/i)
    }
  })
})
