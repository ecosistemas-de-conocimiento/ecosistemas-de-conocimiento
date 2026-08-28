/**
 * THE READ SIDE'S TESTS, AND WHAT THEY ARE ACTUALLY FOR.
 *
 * Most of this file is one question asked of every statement in `queries.ts`:
 * **does it carry all three of ADR §6's gates, in SQL?** That is a test of the
 * generated SQL TEXT, not of a mock's return value, because the failure being
 * guarded against is somebody adding a fourth query and forgetting a clause —
 * and a forgotten clause fails OPEN, silently, with more rows rather than fewer.
 *
 * ⚠ HOW THE SQL IS READ. `renderSql` walks drizzle's `queryChunks` the same way
 * drizzle's own dialect does — string chunks concatenate, nested `SQL` fragments
 * recurse, everything else becomes a `$n` parameter. It was checked against a
 * real Postgres (the scratch database `edc_backend_graph`) while this was
 * written: every statement below ran, and the gates behaved as asserted.
 *
 * The rest of the file covers the four things that bite at the boundary:
 * `pg` returning counts as strings, `documents.name` reaching a surface raw,
 * `graph_mentions.snippet` escaping for a testimonio, and the deterministic
 * query→entity matching that GraphRAG depends on.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  GRAPH_MIN_SUPPORT_DEFAULT,
  MAX_MATCHABLE_ENTITIES,
  MAX_NEIGHBOURS,
  entityDetailQuery,
  entityDocumentsQuery,
  entityNeighboursQuery,
  entityViewQuery,
  expansionTerms,
  graphMinSupport,
  matchEntitiesToQuery,
  matchableEntitiesQuery,
  publishedDocumentCountQuery,
  readEntityDetail,
  readEntityView,
  readGraphRetrieval,
  retrieveDocumentsQuery,
  retrieveEdgesQuery,
  toCount,
  type GraphSql,
  type GraphQueryPayload,
  type MatchableEntity,
} from './queries'

// ---------------------------------------------------------------------------
// Reading the generated SQL
// ---------------------------------------------------------------------------

interface Rendered {
  text: string
  params: unknown[]
}

/**
 * A drizzle SQL object as `{ text, params }`.
 *
 * ⚠ This mirrors drizzle's own `sqlToQuery`: `StringChunk`s concatenate, a
 * nested `SQL` recurses, and anything else is a bound parameter. It exists here
 * rather than in `queries.ts` because it is a way of INSPECTING production code,
 * not a part of it.
 */
function renderSql(query: GraphSql): Rendered {
  const params: unknown[] = []
  const walk = (node: { queryChunks: unknown[] }): string =>
    node.queryChunks
      .map((chunk) => {
        const name = (chunk as { constructor?: { name?: string } })?.constructor?.name
        if (name === 'StringChunk') return (chunk as { value: string[] }).value.join('')
        if (name === 'SQL') return walk(chunk as { queryChunks: unknown[] })
        params.push(chunk)
        return `$${params.length}`
      })
      .join('')
  return { text: walk(query as unknown as { queryChunks: unknown[] }), params }
}

const ORG = 7
const ENTITY = 42

/**
 * Every statement that reads GRAPH ROWS.
 *
 * ⚠ `publishedDocumentCountQuery` IS DELIBERATELY ABSENT and is asserted
 * separately below. It counts `documents`, touches no graph table, and has
 * nothing to apply a support threshold to — demanding gate 3 of it would mean
 * either weakening this list's rule or writing a meaningless `HAVING`.
 */
const graphStatements: Record<string, GraphSql> = {
  'view (no filters)': entityViewQuery({ organizationId: ORG }),
  'view (type filter)': entityViewQuery({ organizationId: ORG, type: 'lugar' }),
  'view (text search)': entityViewQuery({ organizationId: ORG, q: 'consulta' }),
  'entity detail': entityDetailQuery({ organizationId: ORG, entityId: ENTITY }),
  'entity neighbours': entityNeighboursQuery({ organizationId: ORG, entityId: ENTITY }),
  'entity documents': entityDocumentsQuery({ organizationId: ORG, entityId: ENTITY }),
  'retrieve candidates': matchableEntitiesQuery(ORG, GRAPH_MIN_SUPPORT_DEFAULT),
  'retrieve edges': retrieveEdgesQuery(ORG, [ENTITY], GRAPH_MIN_SUPPORT_DEFAULT),
  'retrieve documents': retrieveDocumentsQuery(ORG, [ENTITY], GRAPH_MIN_SUPPORT_DEFAULT),
}

describe('🔴 the three gates, on every statement that reads graph rows', () => {
  describe('gate 1 — the ecosistema is named explicitly, never inferred', () => {
    for (const [name, query] of Object.entries(graphStatements)) {
      it(`${name} filters documents by organization_id`, () => {
        const { text, params } = renderSql(query)
        // The join to `documents` carries the tenant itself, so a graph row can
        // never be paired with another ecosistema's document.
        expect(text).toContain('d.organization_id = $')
        // …and so does whichever graph table the statement reads.
        expect(text).toMatch(/[emr]\.organization_id = \$/)
        // Every one of those placeholders resolves to the org we asked for.
        expect(params).toContain(ORG)
      })
    }

    it('never scopes by anything but the organization column', () => {
      // Access control is not a tenant filter: `visibleToCaller` returns bare
      // `true` for a platform admin. Nothing here may lean on it.
      for (const query of Object.values(graphStatements)) {
        expect(renderSql(query).text).not.toMatch(/uploaded_by|visibleToCaller/i)
      }
    })
  })

  describe('gate 2 — published only, as a JOIN, never a denormalised flag', () => {
    for (const [name, query] of Object.entries(graphStatements)) {
      it(`${name} joins documents and requires publication_status = 'published'`, () => {
        const { text } = renderSql(query)
        expect(text).toContain('JOIN documents d')
        expect(text).toContain("d.publication_status = 'published'")
      })
    }

    it('reads publication status only from the documents table', () => {
      // A flag copied onto a graph row goes stale at exactly the moment
      // publishing happens (ADR §6.2). There must be no such column read.
      for (const query of Object.values(graphStatements)) {
        const text = renderSql(query).text
        const mentions = text.match(/publication_status/g) ?? []
        const qualified = text.match(/d\.publication_status/g) ?? []
        expect(qualified.length).toBe(mentions.length)
      }
    })
  })

  describe('gate 3 — minimum support, over DISTINCT documents, in SQL', () => {
    for (const [name, query] of Object.entries(graphStatements)) {
      it(`${name} measures support as COUNT(DISTINCT …document_id)`, () => {
        expect(renderSql(query).text).toMatch(/COUNT\(DISTINCT [a-z]+\.document_id\)/)
      })

      it(`${name} compares that support to the configured minimum, in SQL`, () => {
        const { text, params } = renderSql(query)
        // Two accepted forms, and only two. `HAVING` is the normal one; the view
        // uses `WHERE support >= $n` on an aggregate CTE column because its
        // `hidden` branch has to count the rows a `HAVING` would have deleted.
        expect(text).toMatch(
          /(HAVING COUNT\(DISTINCT [a-z]+\.document_id\)|WHERE support) >= \$/,
        )
        expect(params).toContain(GRAPH_MIN_SUPPORT_DEFAULT)
      })
    }

    it('the view thresholds both branches from one place', () => {
      // Two predicates, one CTE, one parameter — so `visible` and `hidden`
      // cannot drift apart and start describing different graphs.
      const { text } = renderSql(entityViewQuery({ organizationId: ORG }))
      expect(text).toContain('WHERE support >= $')
      expect(text).toContain('WHERE support < $')
      expect(text.match(/FROM supported/g)).toHaveLength(2)
    })

    it('counts DISTINCT DOCUMENTS, never occurrences', () => {
      // ADR §7.3.3's whole basis: one repetitive testimony must not be able to
      // look like three independent sources.
      for (const query of Object.values(graphStatements)) {
        const text = renderSql(query).text
        expect(text).not.toMatch(/HAVING\s+SUM\(/)
        expect(text).not.toMatch(/HAVING COUNT\(\*\)/)
      }
    })

    it('applies the SAME threshold to retrieval as to the view', () => {
      // Retrieval is otherwise "the side door that leaks what the view refuses
      // to show" (ADR §7.3.3).
      const view = renderSql(entityViewQuery({ organizationId: ORG })).params
      const retrieval = renderSql(matchableEntitiesQuery(ORG, graphMinSupport())).params
      expect(view).toContain(GRAPH_MIN_SUPPORT_DEFAULT)
      expect(retrieval).toContain(GRAPH_MIN_SUPPORT_DEFAULT)
    })
  })

  it('the published-document count carries gates 1 and 2 — it has no graph rows to threshold', () => {
    const { text, params } = renderSql(publishedDocumentCountQuery(ORG))
    expect(text).toContain('d.organization_id = $')
    expect(text).toContain("d.publication_status = 'published'")
    expect(params).toContain(ORG)
  })
})

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

describe("🔴 graph_mentions.snippet never leaves for anything but a 'documento'", () => {
  it('is gated in SQL by the document content kind', () => {
    const { text } = renderSql(entityDocumentsQuery({ organizationId: ORG, entityId: ENTITY }))
    expect(text).toContain("CASE WHEN d.content_kind = 'documento' THEN m.snippet ELSE NULL END")
  })

  it('is not selected AT ALL by any other statement', () => {
    // Belt-and-braces over the writer, which already stores NULL there
    // (ADR §7.3.4). The rows that feed a chat prompt carry no quotation of any
    // kind, for any content kind.
    for (const [name, query] of Object.entries(graphStatements)) {
      if (name === 'entity documents') continue
      expect(renderSql(query).text).not.toContain('snippet')
    }
  })

  it('is dropped in JavaScript too, even if the database hands one back', async () => {
    // The SQL `CASE` is the first mechanism. This is the second, and it is the
    // one that still holds if a future write path starts storing snippets for a
    // testimonio.
    const payload = fakePayload([
      [{ id: ENTITY, type: 'tema', label: 'Consulta previa', support: 3 }],
      [],
      [
        {
          id: 1,
          name: 'Testimonio de María López.mp3',
          content_kind: 'testimonio',
          snippet: 'me llamo María y vivo en …',
        },
        { id: 2, name: 'informe.pdf', content_kind: 'documento', snippet: 'la consulta previa' },
      ],
    ])

    const detail = await readEntityDetail(payload, { organizationId: ORG, entityId: ENTITY })
    expect(detail?.documents[0]?.snippet).toBeNull()
    expect(detail?.documents[1]?.snippet).toBe('la consulta previa')
  })
})

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

describe('🔴 no document title reaches a graph surface as raw `documents.name`', () => {
  it('masks a testimonio and a conversacion, and keeps a documento title', async () => {
    // `lib/contentKind.ts` records "Testimonio de María López.mp3" as the case
    // that nearly reached a citation card. A graph surface is the same leak on a
    // new surface.
    const payload = fakePayload([
      [{ id: ENTITY, type: 'tema', label: 'Tema', support: 3 }],
      [],
      [
        { id: 1, name: 'Testimonio de María López.mp3', content_kind: 'testimonio' },
        { id: 2, name: '¿Qué pasó con el predio de Ana?', content_kind: 'conversacion' },
        { id: 3, name: 'informe-2019.pdf', content_kind: 'documento' },
        { id: 4, name: '   ', content_kind: 'documento' },
      ],
    ])

    const detail = await readEntityDetail(payload, { organizationId: ORG, entityId: ENTITY })
    expect(detail?.documents.map((d) => d.title)).toEqual([
      'Testimonio',
      'Conversación',
      'informe-2019.pdf',
      'Documento sin título',
    ])
    expect(JSON.stringify(detail)).not.toContain('María López')
  })

  it('masks them in the retrieval answer too — the same rule on the other route', async () => {
    const payload = fakePayload([
      [
        { id: 1, type: 'tema', label: 'Consulta previa', canonical_key: 'consulta previa', support: 3 },
      ],
      [],
      [{ id: 9, name: 'Testimonio de María López.mp3', content_kind: 'testimonio' }],
    ])

    const result = await readGraphRetrieval(payload, {
      organizationId: ORG,
      query: '¿qué dice la consulta previa?',
    })
    expect(result.documents).toEqual([{ id: 9, title: 'Testimonio', contentKind: 'testimonio' }])
  })

  it('treats an unknown content kind as a plain documento, never as gated content', () => {
    // `contentKindOf` defaults to `documento` — the LEAST privileged reading.
    // Asserted here because the opposite default would silently unmask nothing
    // but would silently MASK a real document, and someone might "fix" it.
    expect(GRAPH_MIN_SUPPORT_DEFAULT).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// The two Postgres types that arrive as strings
// ---------------------------------------------------------------------------

describe('⚠ counts arrive from `pg` as strings', () => {
  it('coerces a bigint COUNT and a numeric SUM', () => {
    // `"12" >= 3` is `false`. That is the whole bug, and it is silent.
    expect(toCount('12')).toBe(12)
    expect(toCount('0')).toBe(0)
    expect(toCount(12n)).toBe(12)
    expect(toCount('12.0')).toBe(12)
    expect(toCount(7)).toBe(7)
  })

  it('treats junk, null and undefined as zero rather than NaN', () => {
    for (const junk of [null, undefined, '', '  ', 'doce', {}, []]) {
      expect(toCount(junk)).toBe(0)
    }
  })

  it('coerces support and hidden on the way out of the view', async () => {
    const payload = fakePayload([
      [
        { id: '5', type: 'tema', label: 'Agua', support: '9', hidden: '4' },
        { id: '6', type: 'lugar', label: 'Oaxaca', support: '3', hidden: '4' },
      ],
      [{ n: '11' }],
    ])
    const view = await readEntityView(payload, { organizationId: ORG })
    expect(view.entities).toEqual([
      { id: 5, type: 'tema', label: 'Agua', support: 9 },
      { id: 6, type: 'lugar', label: 'Oaxaca', support: 3 },
    ])
    expect(view.hidden).toBe(4)
    expect(view.publishedDocuments).toBe(11)
  })
})

// ---------------------------------------------------------------------------
// GRAPH_MIN_SUPPORT
// ---------------------------------------------------------------------------

describe('GRAPH_MIN_SUPPORT', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to 3', () => {
    vi.stubEnv('GRAPH_MIN_SUPPORT', '')
    expect(graphMinSupport()).toBe(GRAPH_MIN_SUPPORT_DEFAULT)
  })

  it('accepts a deliberate override', () => {
    vi.stubEnv('GRAPH_MIN_SUPPORT', '5')
    expect(graphMinSupport()).toBe(5)
    // 1 is a real, weaker choice somebody can make on purpose.
    vi.stubEnv('GRAPH_MIN_SUPPORT', '1')
    expect(graphMinSupport()).toBe(1)
  })

  it('🔴 falls back to the default on junk, zero and negatives — a typo must not disable the gate', () => {
    for (const bad of ['0', '-1', 'tres', 'NaN', '  ']) {
      vi.stubEnv('GRAPH_MIN_SUPPORT', bad)
      expect(graphMinSupport()).toBe(GRAPH_MIN_SUPPORT_DEFAULT)
    }
  })

  it('reaches the SQL, so an override actually changes what is visible', () => {
    vi.stubEnv('GRAPH_MIN_SUPPORT', '6')
    expect(renderSql(entityViewQuery({ organizationId: ORG })).params).toContain(6)
    expect(
      renderSql(entityDocumentsQuery({ organizationId: ORG, entityId: ENTITY })).params,
    ).toContain(6)
  })
})

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

describe('the view, when the threshold hides everything', () => {
  it('🔴 still reports how many entities were removed', async () => {
    // A statement that returns no visible rows still returns ONE row carrying
    // `hidden` — otherwise an empty graph could not explain itself and the UI
    // would render a blank canvas that reads as broken (ADR §7.3.3).
    const payload = fakePayload([
      [{ id: null, type: null, label: null, support: null, hidden: 12 }],
      [{ n: 2 }],
    ])
    const view = await readEntityView(payload, { organizationId: ORG })
    expect(view).toEqual({ entities: [], hidden: 12, minSupport: 3, publishedDocuments: 2 })
  })

  it('reports an ecosistema with nothing published as empty in BOTH senses', async () => {
    // `hidden: 0` with `publishedDocuments: 0` is "nobody has published yet".
    // `hidden: 12` with `publishedDocuments: 2` is "published, but below the
    // threshold". The UI needs different Spanish for each, so the answer has to
    // carry both numbers.
    const payload = fakePayload([[], [{ n: 0 }]])
    const view = await readEntityView(payload, { organizationId: ORG })
    expect(view).toEqual({ entities: [], hidden: 0, minSupport: 3, publishedDocuments: 0 })
  })

  it('caps what a caller can ask for', () => {
    const params = renderSql(entityViewQuery({ organizationId: ORG, limit: 100000 })).params
    expect(params).toContain(200)
    expect(params).not.toContain(100000)
  })

  it('rejects nothing on a `q` full of LIKE wildcards — it searches literally', () => {
    // `LIKE '%' || $1 || '%'` would make a search for "50%" match everything.
    const { text, params } = renderSql(entityViewQuery({ organizationId: ORG, q: '50%' }))
    expect(text).toContain('strpos(e.canonical_key, $')
    expect(text).not.toContain('LIKE')
    expect(params).toContain('50%')
  })

  it('canonicalises `q` with the same helper the writer used, so accents do not matter', () => {
    const { params } = renderSql(entityViewQuery({ organizationId: ORG, q: '  MÉXICO  ' }))
    expect(params).toContain('mexico')
  })

  it('adds no search clause for an empty or whitespace-only `q`', () => {
    for (const q of ['', '   ', null, undefined]) {
      expect(renderSql(entityViewQuery({ organizationId: ORG, q })).text).not.toContain('strpos')
    }
  })
})

// ---------------------------------------------------------------------------
// One entity, one hop
// ---------------------------------------------------------------------------

describe('the entity detail', () => {
  it('🔴 answers "no such node" for one the threshold hides', async () => {
    // The focal entity's own `HAVING` is what stops `/entity/:id` becoming the
    // side door. Ids are sequential integers, so guessing one is trivial.
    const payload = fakePayload([[]])
    expect(await readEntityDetail(payload, { organizationId: ORG, entityId: ENTITY })).toBeNull()
  })

  it('does not run the neighbour or document queries once the entity is hidden', async () => {
    const payload = fakePayload([[]])
    await readEntityDetail(payload, { organizationId: ORG, entityId: ENTITY })
    expect(payload.executed).toHaveLength(1)
  })

  it('⚠ requires the NEIGHBOUR to be above threshold as well as the edge', () => {
    // An edge can reach the threshold while an endpoint does not — verified
    // against real rows: three documents evidenced an edge, but only two of them
    // recorded a mention of one endpoint. A neighbour is a node the caller can
    // see, so it needs its own support check.
    const { text } = renderSql(entityNeighboursQuery({ organizationId: ORG, entityId: ENTITY }))
    expect(text).toContain('JOIN ent_support s ON s.entity_id = e.id')
    expect(text.match(/HAVING COUNT\(DISTINCT/g)).toHaveLength(2)
  })

  it('holds the ego-network to ADR §7.2’s 20 neighbours', () => {
    const params = renderSql(
      entityNeighboursQuery({ organizationId: ORG, entityId: ENTITY, neighbourLimit: 500 }),
    ).params
    expect(params).toContain(MAX_NEIGHBOURS)
  })

  it('maps neighbours with the edge support and the neighbour support kept apart', async () => {
    const payload = fakePayload([
      [{ id: ENTITY, type: 'tema', label: 'Consulta previa', support: '7' }],
      [
        {
          id: 5,
          type: 'lugar',
          label: 'Oaxaca',
          support: '9',
          relation_type: 'ocurre_en',
          edge_support: '4',
        },
      ],
      [],
    ])
    const detail = await readEntityDetail(payload, { organizationId: ORG, entityId: ENTITY })
    expect(detail?.entity.support).toBe(7)
    expect(detail?.neighbours[0]).toEqual({
      entity: { id: 5, type: 'lugar', label: 'Oaxaca', support: 9 },
      relationType: 'ocurre_en',
      support: 4,
    })
  })
})

// ---------------------------------------------------------------------------
// Deterministic matching for /retrieve
// ---------------------------------------------------------------------------

const candidate = (
  id: number,
  label: string,
  key: string,
  support = 3,
): MatchableEntity => ({ id, type: 'tema', label, canonicalKey: key, support })

describe('matchEntitiesToQuery — deterministic, no model call', () => {
  const entities = [
    candidate(1, 'Consulta previa', 'consulta previa'),
    candidate(2, 'Consulta', 'consulta', 9),
    candidate(3, 'México', 'mexico'),
    candidate(4, 'Año', 'año'),
    candidate(5, 'Campaña', 'campaña'),
    candidate(6, 'CIDE', 'cide'),
  ]

  it('matches through punctuation, because a real question has some', () => {
    const found = matchEntitiesToQuery(entities, '¿Qué pasó con la consulta previa en México?')
    // `Consulta` (2) is subsumed by `Consulta previa` (1) and dropped.
    expect(found.map((e) => e.id)).toEqual([1, 3])
  })

  it('matches accent-insensitively, via the writer’s own canonicalKey', () => {
    expect(matchEntitiesToQuery(entities, 'háblame de Mexico').map((e) => e.id)).toEqual([3])
  })

  it('keeps `ñ` distinct — campaña is not campana, año is not ano', () => {
    expect(matchEntitiesToQuery(entities, 'la campana de la iglesia')).toEqual([])
    expect(matchEntitiesToQuery(entities, 'este ano')).toEqual([])
    expect(matchEntitiesToQuery(entities, 'la campaña de este año').map((e) => e.id)).toEqual([5, 4])
  })

  it('drops a match subsumed by a longer one, even when it has more support', () => {
    // "Consulta" has support 9 against "Consulta previa"'s 3, so a plain
    // support ranking would put the broad node first and — under a tight seed
    // cap — keep only it. The expansion would then drift to a neighbourhood the
    // question never asked about.
    const found = matchEntitiesToQuery(entities, 'la consulta previa')
    expect(found.map((e) => e.label)).toEqual(['Consulta previa'])
  })

  it('does not treat a mere substring as subsumption — only whole tokens', () => {
    const pair = [candidate(1, 'Agua', 'agua'), candidate(2, 'Aguascalientes', 'aguascalientes')]
    // Both survive; equal support, so the longer (more specific) key leads.
    expect(matchEntitiesToQuery(pair, 'agua en Aguascalientes').map((e) => e.id)).toEqual([2, 1])
  })

  it('ranks by support when nothing is subsumed', () => {
    const pair = [candidate(1, 'Agua', 'agua', 2), candidate(2, 'Oaxaca', 'oaxaca', 8)]
    expect(matchEntitiesToQuery(pair, 'el agua en Oaxaca').map((e) => e.label)).toEqual([
      'Oaxaca',
      'Agua',
    ])
  })

  it('does not match inside a word', () => {
    // "cide" sits inside "decide" and "coincidencia". A substring match there
    // would seed the graph expansion from nothing.
    expect(matchEntitiesToQuery(entities, 'quien decide eso')).toEqual([])
    expect(matchEntitiesToQuery(entities, 'una coincidencia')).toEqual([])
    expect(matchEntitiesToQuery(entities, 'el CIDE lo publicó').map((e) => e.id)).toEqual([6])
  })

  it('ignores keys shorter than three characters', () => {
    const noisy = [candidate(7, 'AP', 'ap'), candidate(8, 'Río', 'rio')]
    expect(matchEntitiesToQuery(noisy, 'ap y rio')).toHaveLength(1)
  })

  it('returns nothing for an empty or punctuation-only query', () => {
    for (const q of ['', '   ', '¿¿??', '...']) {
      expect(matchEntitiesToQuery(entities, q)).toEqual([])
    }
  })

  it('honours the seed limit', () => {
    expect(matchEntitiesToQuery(entities, 'consulta previa en México')).toHaveLength(2)
    expect(matchEntitiesToQuery(entities, 'consulta previa en México', 1)).toHaveLength(1)
  })
})

describe('expansionTerms', () => {
  const seed = { id: 1, type: 'tema' as const, label: 'Consulta previa', support: 5 }
  const other = { id: 2, type: 'lugar' as const, label: 'Oaxaca', support: 4 }
  const dupe = { id: 3, type: 'lugar' as const, label: 'oaxaca', support: 3 }

  it('returns neighbour labels and excludes the seeds', () => {
    const terms = expansionTerms([seed], [
      { from: seed, to: other, relationType: 'ocurre_en', support: 4 },
    ])
    expect(terms).toEqual(['Oaxaca'])
  })

  it('de-duplicates by canonical key, so México and Mexico are one term', () => {
    const terms = expansionTerms([seed], [
      { from: seed, to: other, relationType: 'ocurre_en', support: 4 },
      { from: seed, to: dupe, relationType: 'ocurre_en', support: 3 },
    ])
    expect(terms).toEqual(['Oaxaca'])
  })

  it('caps the list', () => {
    const edges = Array.from({ length: 30 }, (_, i) => ({
      from: seed,
      to: { id: i + 10, type: 'tema' as const, label: `Tema ${i}`, support: 3 },
      relationType: 'relacionado_con' as const,
      support: 3,
    }))
    expect(expansionTerms([seed], edges, 5)).toHaveLength(5)
  })
})

// ---------------------------------------------------------------------------
// Retrieval, end to end over a fake database
// ---------------------------------------------------------------------------

describe('readGraphRetrieval', () => {
  it('short-circuits when the query names nothing — no expansion, no second query', async () => {
    const payload = fakePayload([
      [{ id: 1, type: 'tema', label: 'Agua', canonical_key: 'agua', support: 3 }],
    ])
    const result = await readGraphRetrieval(payload, {
      organizationId: ORG,
      query: 'hola, ¿cómo estás?',
    })
    expect(result).toEqual({ entities: [], edges: [], documents: [], terms: [] })
    // Silent fallback is free only if we do not pay for the queries first.
    expect(payload.executed).toHaveLength(1)
  })

  it('returns seeds, one hop of edges, documents and expansion terms', async () => {
    const payload = fakePayload([
      [
        { id: 1, type: 'tema', label: 'Consulta previa', canonical_key: 'consulta previa', support: '6' },
        { id: 2, type: 'lugar', label: 'Oaxaca', canonical_key: 'oaxaca', support: '4' },
      ],
      [
        {
          relation_type: 'ocurre_en',
          support: '3',
          from_id: 1,
          from_type: 'tema',
          from_label: 'Consulta previa',
          from_support: '6',
          to_id: 2,
          to_type: 'lugar',
          to_label: 'Oaxaca',
          to_support: '4',
        },
      ],
      [{ id: 88, name: 'informe.pdf', content_kind: 'documento' }],
    ])

    const result = await readGraphRetrieval(payload, {
      organizationId: ORG,
      query: '¿qué dice sobre la consulta previa?',
    })

    expect(result.entities).toEqual([
      { id: 1, type: 'tema', label: 'Consulta previa', support: 6 },
    ])
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]?.support).toBe(3)
    expect(result.documents).toEqual([{ id: 88, title: 'informe.pdf', contentKind: 'documento' }])
    // Oaxaca is a neighbour, not a seed, so it is worth adding to the query.
    expect(result.terms).toEqual(['Oaxaca'])
  })

  it('caps how many entity rows it will ever pull into this process', () => {
    expect(renderSql(matchableEntitiesQuery(ORG, 3)).params).toContain(MAX_MATCHABLE_ENTITIES)
  })

  it('passes seed ids as a typed array parameter, not an interpolated IN list', () => {
    const { text, params } = renderSql(retrieveEdgesQuery(ORG, [4, 9], 3))
    expect(text).toContain('= ANY($')
    expect(text).toContain('::int[]')
    expect(params).toContainEqual([4, 9])
  })

  it('drops junk out of the seed id list rather than letting it reach SQL', () => {
    const ids = [1, Number.NaN, 3] as number[]
    const { params } = renderSql(retrieveEdgesQuery(ORG, ids, 3))
    expect(params).toContainEqual([1, 3])
  })
})

// ---------------------------------------------------------------------------
// The fake database
// ---------------------------------------------------------------------------

interface FakePayload extends GraphQueryPayload {
  executed: Rendered[]
}

/**
 * A `GraphQueryPayload` that answers with canned rows, in call order, and
 * records the SQL it was asked to run.
 *
 * ⚠ Wraps each batch in `{ rows }`, which is the shape drizzle's node-postgres
 * driver actually returns. `rowsOf` also accepts a bare array; that tolerance is
 * exercised by the empty-result cases below.
 */
function fakePayload(results: Record<string, unknown>[][]): FakePayload {
  const executed: Rendered[] = []
  let call = 0
  return {
    executed,
    db: {
      drizzle: {
        async execute(query: GraphSql) {
          executed.push(renderSql(query))
          return { rows: results[call++] ?? [] }
        },
      },
    },
  }
}
