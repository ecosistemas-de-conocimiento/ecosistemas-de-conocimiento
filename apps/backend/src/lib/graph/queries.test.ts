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

import type { GraphEntityType } from './types'
import { contentKindOf } from '../contentKind'
import { GRAPH_NOISE_KEY_PATTERN } from './noise'
import { MENTION_GATE, RELATION_GATE, readSites } from './gateSites.testutil'

import {
  GRAPH_COMENTION_TOP_K_DEFAULT,
  GRAPH_MIN_COMENTION_DOCS_DEFAULT,
  GRAPH_MIN_EDGE_DOCS_DEFAULT,
  GRAPH_MIN_ENTITY_DOCS_DEFAULT,
  MAX_COMENTION_TOP_K,
  MAX_EDGE_DOCUMENTS,
  MAX_SEARCH_CHARS,
  MAX_VIEW_ENTITIES,
  MAX_MATCHABLE_ENTITIES,
  MAX_NEIGHBOURS,
  entityDetailQuery,
  entityDocumentsQuery,
  entityEdgeDocumentsQuery,
  entityNeighboursQuery,
  entityViewQuery,
  expansionTerms,
  graphCoMentionTopK,
  graphMinCoMentionDocs,
  graphMinEdgeDocs,
  graphMinEntityDocs,
  graphMinSupport,
  categoryMatchEntities,
  matchEntitiesToQuery,
  queryEntityTypes,
  seedEntitiesForQuery,
  matchableEntitiesQuery,
  publishedDocumentCountQuery,
  readEntityDetail,
  readEntityView,
  readGraphRetrieval,
  retrieveDocumentsQuery,
  retrieveEdgesQuery,
  viewEdgesQuery,
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
/** The entity threshold the statement table below is built with. */
const MIN = GRAPH_MIN_ENTITY_DOCS_DEFAULT
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
  'entity edge documents': entityEdgeDocumentsQuery({ organizationId: ORG, entityId: ENTITY }),
  'retrieve candidates': matchableEntitiesQuery(ORG, MIN),
  'retrieve edges': retrieveEdgesQuery(ORG, [ENTITY], MIN),
  'retrieve documents': retrieveDocumentsQuery(ORG, [ENTITY], MIN),
  'view edges': viewEdgesQuery(ORG, [ENTITY, 43], MIN),
}

describe('🔴 gate 4 — no language and no redaction placeholder, on every statement', () => {
  for (const [name, query] of Object.entries(graphStatements)) {
    it(`${name} excludes noise keys in SQL, with the shared pattern bound`, () => {
      const { text, params } = renderSql(query)
      expect(text).toMatch(/AND NOT \((e|ne)\.canonical_key ~ \$\d+\)/)
      expect(params).toContain(GRAPH_NOISE_KEY_PATTERN)
    })
  }
})

describe('🔴 gate 5 — no private persona, at every read site', () => {
  // Per site, not per statement: `entitySupportCte` carries the filter into
  // every statement, so a whole-statement match passed while a statement's own
  // mention read had none (see `gateSites.testutil.ts`).
  for (const [name, query] of Object.entries(graphStatements)) {
    it(`${name} drops every persona mention at each mention read`, () => {
      const sites = readSites(renderSql(query).text, 'graph_mentions')
      expect(sites.length).toBeGreaterThan(0)
      for (const site of sites) expect(site).toMatch(MENTION_GATE)
    })
    it(`${name} drops a relation row with a persona end`, () => {
      for (const site of readSites(renderSql(query).text, 'graph_relations')) {
        expect(site).toMatch(RELATION_GATE)
      }
    })
  }

  it('the four relation statements do read relations', () => {
    for (const name of ['entity neighbours', 'entity edge documents', 'retrieve edges', 'view edges']) {
      expect(readSites(renderSql(graphStatements[name]!).text, 'graph_relations').length).toBeGreaterThan(0)
    }
  })

  it('🔴 the site check refuses the old documento-only rule, which let private personas through', () => {
    expect(" AND (ce.type <> 'persona' OR d.content_kind = 'documento')").not.toMatch(MENTION_GATE)
    // The public mark must sit on the SAME entity alias whose type is checked.
    expect(" AND (ce.type <> 'persona' OR (d.content_kind = 'documento' AND ne.public_figure))").not.toMatch(MENTION_GATE)
    expect(" AND (ce.type <> 'persona' OR (d.content_kind = 'documento' AND ce.public_figure))").toMatch(MENTION_GATE)
  })

  it('the site check fails a read whose shared CTE has the filter but its own read does not', () => {
    const text = `
      WITH ent_support AS (SELECT m.entity_id FROM graph_mentions m JOIN documents d ON d.id = m.document_id
        JOIN graph_entities ne ON ne.id = m.entity_id AND (ne.type <> 'persona' OR (d.content_kind = 'documento' AND ne.public_figure)))
      SELECT d.id FROM graph_mentions m JOIN documents d ON d.id = m.document_id
      JOIN ent_support s ON s.entity_id = m.entity_id WHERE m.entity_id = 1`
    const sites = readSites(text, 'graph_mentions')
    expect(sites).toHaveLength(2)
    expect(sites[0]).toMatch(MENTION_GATE)
    expect(sites[1]).not.toMatch(MENTION_GATE)
  })
})

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
        expect(params).toContain(MIN)
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
      expect(view).toContain(MIN)
      expect(retrieval).toContain(MIN)
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
    expect(contentKindOf({ contentKind: 'desconocido' })).toBe('documento')
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
// GRAPH_MIN_ENTITY_DOCS, GRAPH_MIN_EDGE_DOCS, co-mention settings
// ---------------------------------------------------------------------------

describe('graph thresholds from the environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const readers = [
    ['GRAPH_MIN_ENTITY_DOCS', graphMinEntityDocs, GRAPH_MIN_ENTITY_DOCS_DEFAULT],
    ['GRAPH_MIN_EDGE_DOCS', graphMinEdgeDocs, GRAPH_MIN_EDGE_DOCS_DEFAULT],
    ['GRAPH_MIN_COMENTION_DOCS', graphMinCoMentionDocs, GRAPH_MIN_COMENTION_DOCS_DEFAULT],
    ['GRAPH_COMENTION_TOP_K', graphCoMentionTopK, GRAPH_COMENTION_TOP_K_DEFAULT],
  ] as const

  it('defaults: 1 document for entities, edges and co-mentions; 8 co-mentions per node', () => {
    expect(GRAPH_MIN_ENTITY_DOCS_DEFAULT).toBe(1)
    expect(GRAPH_MIN_EDGE_DOCS_DEFAULT).toBe(1)
    expect(GRAPH_MIN_COMENTION_DOCS_DEFAULT).toBe(1)
    expect(GRAPH_COMENTION_TOP_K_DEFAULT).toBe(8)
  })

  for (const [name, read, fallback] of readers) {
    it(`${name}: unset reads the default`, () => {
      vi.stubEnv(name, '')
      expect(read()).toBe(fallback)
    })

    it(`${name}: a deliberate override is taken`, () => {
      vi.stubEnv(name, '5')
      expect(read()).toBe(5)
    })

    it(`${name}: junk, zero and negatives fall back to the default`, () => {
      for (const bad of ['0', '-1', 'tres', 'NaN', '  ']) {
        vi.stubEnv(name, bad)
        expect(read()).toBe(fallback)
      }
    })
  }

  it('caps GRAPH_COMENTION_TOP_K so a typo cannot ship a hairball', () => {
    vi.stubEnv('GRAPH_COMENTION_TOP_K', '100000')
    expect(graphCoMentionTopK()).toBe(MAX_COMENTION_TOP_K)
  })

  it('graphMinSupport is the entity threshold', () => {
    vi.stubEnv('GRAPH_MIN_ENTITY_DOCS', '4')
    expect(graphMinSupport()).toBe(4)
  })

  it('the old GRAPH_MIN_SUPPORT is no longer read', () => {
    vi.stubEnv('GRAPH_MIN_SUPPORT', '3')
    expect(graphMinEntityDocs()).toBe(GRAPH_MIN_ENTITY_DOCS_DEFAULT)
    expect(graphMinEdgeDocs()).toBe(GRAPH_MIN_EDGE_DOCS_DEFAULT)
  })

  it('reaches the SQL: the entity threshold and the edge threshold separately', () => {
    vi.stubEnv('GRAPH_MIN_ENTITY_DOCS', '6')
    vi.stubEnv('GRAPH_MIN_EDGE_DOCS', '9')
    expect(renderSql(entityViewQuery({ organizationId: ORG })).params).toContain(6)
    expect(
      renderSql(entityDocumentsQuery({ organizationId: ORG, entityId: ENTITY })).params,
    ).toContain(6)
    const neighbours = renderSql(entityNeighboursQuery({ organizationId: ORG, entityId: ENTITY }))
    expect(neighbours.params).toEqual(expect.arrayContaining([6, 9]))
    const edgeDocs = renderSql(entityEdgeDocumentsQuery({ organizationId: ORG, entityId: ENTITY }))
    expect(edgeDocs.params).toEqual(expect.arrayContaining([6, 9]))
  })

  it('reaches the view edges: co-mention minimum and top K from the environment', () => {
    vi.stubEnv('GRAPH_MIN_COMENTION_DOCS', '7')
    vi.stubEnv('GRAPH_COMENTION_TOP_K', '11')
    const { text, params } = renderSql(viewEdgesQuery(ORG, [1, 2], { entity: 2, edge: 3 }))
    expect(text).toMatch(/c\.weight >= \$(\d+)/)
    const at = (re: RegExp) => params[Number(text.match(re)![1]) - 1]
    expect(at(/c\.weight >= \$(\d+)/)).toBe(7)
    expect(at(/co_ranked\.rn <= \$(\d+)/)).toBe(11)
    expect(at(/HAVING COUNT\(DISTINCT rel\.document_id\) >= \$(\d+)/)).toBe(3)
    expect(at(/HAVING COUNT\(DISTINCT m\.document_id\) >= \$(\d+)/)).toBe(2)
  })

  it('readEntityView reports both thresholds it applied', async () => {
    vi.stubEnv('GRAPH_MIN_ENTITY_DOCS', '2')
    vi.stubEnv('GRAPH_MIN_EDGE_DOCS', '3')
    const view = await readEntityView(fakePayload([[], [{ n: 0 }]]), { organizationId: ORG })
    expect(view.minSupport).toBe(2)
    expect(view.minEdgeSupport).toBe(3)
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
    expect(view).toEqual({ entities: [], hidden: 12, minSupport: 1, minEdgeSupport: 1, publishedDocuments: 2, edges: [] })
  })

  it('reports an ecosistema with nothing published as empty in BOTH senses', async () => {
    // `hidden: 0` with `publishedDocuments: 0` is "nobody has published yet".
    // `hidden: 12` with `publishedDocuments: 2` is "published, but below the
    // threshold". The UI needs different Spanish for each, so the answer has to
    // carry both numbers.
    const payload = fakePayload([[], [{ n: 0 }]])
    const view = await readEntityView(payload, { organizationId: ORG })
    expect(view).toEqual({ entities: [], hidden: 0, minSupport: 1, minEdgeSupport: 1, publishedDocuments: 0, edges: [] })
  })

  it('caps what a caller can ask for', () => {
    const params = renderSql(entityViewQuery({ organizationId: ORG, limit: 100000 })).params
    expect(params).toContain(MAX_VIEW_ENTITIES)
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

  describe('full-text over published document text (#31)', () => {
    const { text, params } = renderSql(entityViewQuery({ organizationId: ORG, q: 'migración' }))

    it('uses Postgres `spanish` full-text search, websearch syntax, accent-folded too', () => {
      expect(text.match(/to_tsvector\('spanish', /g)).toHaveLength(2)
      expect(text.match(/websearch_to_tsquery\('spanish', /g)).toHaveLength(2)
      expect(text).toContain('translate(')
      expect(params).toContain('migración')
    })

    it('🔴 searches only this ecosistema’s PUBLISHED documents', () => {
      expect(text).toMatch(/sd\.organization_id = \$\d+/)
      expect(text).toMatch(/sm\.organization_id = \$\d+/)
      expect(text).toContain("sd.publication_status = 'published'")
    })

    it('🔴 reads the corpus text: extracted for a documento, redacted only once cleared', () => {
      expect(text).toContain("WHEN sd.content_kind = 'documento' AND sd.anonymise = false THEN sd.extracted_text")
      expect(text).toContain(
        "WHEN sd.anonymisation_status IN ('ready', 'approved') THEN sd.redacted_text",
      )
      // No other path to the raw text of gated content.
      expect(text.match(/sd\.extracted_text/g)?.length).toBe(
        text.match(/WHEN sd\.content_kind = 'documento' AND sd\.anonymise = false THEN sd\.extracted_text/g)?.length,
      )
    })

    it('🔴 repeats gate 5 inside the subquery: only a public persona, only via a documento', () => {
      expect(text).toContain("(se.type <> 'persona' OR (sd.content_kind = 'documento' AND se.public_figure))")
      expect(text).toMatch(/se\.organization_id = \$\d+/)
    })

    it('matches nothing (not everything) when `q` has no searchable characters', () => {
      expect(renderSql(entityViewQuery({ organizationId: ORG, q: '"' })).text).toContain('AND FALSE')
    })

    it('strips NUL bytes from `q`', () => {
      const bound = renderSql(entityViewQuery({ organizationId: ORG, q: 'agua\u0000' })).params
      expect(bound).toContain('agua')
      expect(bound.some((p) => typeof p === 'string' && p.includes('\u0000'))).toBe(false)
    })

    it('caps the query text', () => {
      const long = 'a'.repeat(MAX_SEARCH_CHARS + 50)
      const bound = renderSql(entityViewQuery({ organizationId: ORG, q: long })).params
      expect(bound).toContain('a'.repeat(MAX_SEARCH_CHARS))
      expect(bound).not.toContain(long)
    })
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
    // One for the neighbour (ent_support), one for the PAIR (pairs).
    expect(text.match(/HAVING COUNT\(DISTINCT/g)).toHaveLength(2)
    expect(text).toContain('JOIN pairs ON pairs.neighbour_id = edges.neighbour_id')
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
      [],
    ])
    const detail = await readEntityDetail(payload, { organizationId: ORG, entityId: ENTITY })
    expect(detail?.entity.support).toBe(7)
    expect(detail?.neighbours[0]).toEqual({
      entity: { id: 5, type: 'lugar', label: 'Oaxaca', support: 9 },
      relationType: 'ocurre_en',
      support: 4,
      // No `pair_support` came back, so the pair weighs what its one type does.
      pairSupport: 4,
      // No `direction` column came back, so the edge reads as undirected.
      direction: 'both',
      // No evidence row came back for this edge, so the list is empty rather
      // than absent — see the note on the empty-list case below.
      documents: [],
    })
  })
})

// ---------------------------------------------------------------------------
// Per-edge supporting documents
// ---------------------------------------------------------------------------

/**
 * These were the missing half of ADR §7.2. The surface used to APPROXIMATE an
 * edge's evidence by intersecting the two entities' document lists — a superset,
 * which the UI had to admit to in Spanish. `graph_relations` holds one row per
 * `(document, from, to, type)`, so the real answer is a direct query.
 *
 * ⚠ The SQL below was run against a real Postgres (the scratch database
 * `edc_lane1`) on a fixture built to exercise each branch: an edge with three
 * published documents, the same PAIR under a second predicate, an edge with only
 * two, an edge whose NEIGHBOUR is below the mention threshold, a draft, and
 * another ecosistema's document. Every assertion here mirrors a row that query
 * did or did not return.
 */
describe("🔴 an edge's supporting documents are the ones that EVIDENCE it", () => {
  it('reads them out of graph_relations, not out of a mention intersection', () => {
    const { text } = renderSql(entityEdgeDocumentsQuery({ organizationId: ORG, entityId: ENTITY }))
    // The evidence comes from the relation rows themselves…
    expect(text).toContain('FROM graph_relations r')
    // …and every document it names is joined off THAT row's `document_id`.
    expect(text).toContain('ON d.id = r.document_id')
    // Never from `graph_mentions`, which is what an intersection would use: the
    // only mention table in the statement is the `ent_support` threshold CTE.
    expect(text.match(/FROM graph_mentions m/g)).toHaveLength(1)
  })

  it('⚠ requires BOTH thresholds — the edge and the neighbour', () => {
    // Same pair of checks as `entityNeighboursQuery`, so the two statements
    // cannot come to disagree about which edges exist. Verified against real
    // rows: an edge with three published documents was still withheld because
    // its far endpoint was mentioned by only one.
    const { text } = renderSql(entityEdgeDocumentsQuery({ organizationId: ORG, entityId: ENTITY }))
    expect(text).toContain('HAVING COUNT(DISTINCT r.document_id) >= $')
    expect(text).toContain('JOIN ent_support s ON s.entity_id = ev.neighbour_id')
  })

  it('🔴 caps per EDGE, not per response — a window function, not a LIMIT', () => {
    // A plain `LIMIT` spends the whole budget on the first edge and returns
    // nothing for the rest. Verified with the cap set to 2: every partition
    // returned two rows, not the first partition two and the others none.
    const { text, params } = renderSql(
      entityEdgeDocumentsQuery({ organizationId: ORG, entityId: ENTITY }),
    )
    expect(text).toContain('ROW_NUMBER() OVER (')
    expect(text).toContain('PARTITION BY ev.neighbour_id, ev.relation_type')
    expect(text).toContain('WHERE ranked.rn <= $')
    expect(params).toContain(MAX_EDGE_DOCUMENTS)
    // …and an overall ceiling derived from the two caps, not guessed.
    expect(params).toContain(MAX_NEIGHBOURS * MAX_EDGE_DOCUMENTS)
  })

  it('clamps a caller asking for more evidence than the cap allows', () => {
    const { params } = renderSql(
      entityEdgeDocumentsQuery({ organizationId: ORG, entityId: ENTITY, edgeDocumentLimit: 9999 }),
    )
    expect(params).toContain(MAX_EDGE_DOCUMENTS)
    expect(params).not.toContain(9999)
  })

  it('⚠ carries NO snippet — a quotation belongs to an entity, not to an edge', () => {
    // `graph_mentions.snippet` is per `(document, entity)`, so an edge has two
    // candidates and neither is evidence OF THE EDGE. `entityDocumentsQuery`
    // stays the only statement in the file that selects the column, which the
    // gate suite above asserts of every other one by name.
    expect(
      renderSql(entityEdgeDocumentsQuery({ organizationId: ORG, entityId: ENTITY })).text,
    ).not.toContain('snippet')
  })

  it('excludes the focal entity, so a self-loop cannot become its own neighbour', () => {
    expect(
      renderSql(entityEdgeDocumentsQuery({ organizationId: ORG, entityId: ENTITY })).text,
    ).toContain('WHERE ev.neighbour_id <> $')
  })

  it('attaches evidence to the right edge, keyed on the PREDICATE as well', async () => {
    // Two entities can be joined by more than one predicate, and those are two
    // rows in `neighbours` with their own support each. Keying the attachment on
    // the neighbour alone would give both edges the union of their evidence.
    const payload = fakePayload([
      [{ id: ENTITY, type: 'evento', label: 'Sequía de 2023', support: '4' }],
      [
        { id: 5, type: 'lugar', label: 'Juxtlahuaca', support: '4', relation_type: 'ocurre_en', edge_support: '3' },
        { id: 5, type: 'lugar', label: 'Juxtlahuaca', support: '4', relation_type: 'afecta_a', edge_support: '4' },
      ],
      [],
      [
        { neighbour_id: 5, relation_type: 'ocurre_en', id: 1, name: 'acta.pdf', content_kind: 'documento' },
        { neighbour_id: 5, relation_type: 'afecta_a', id: 2, name: 'boletin.pdf', content_kind: 'documento' },
        { neighbour_id: 5, relation_type: 'afecta_a', id: 3, name: 'informe.pdf', content_kind: 'documento' },
      ],
    ])

    const detail = await readEntityDetail(payload, { organizationId: ORG, entityId: ENTITY })
    expect(detail?.neighbours[0]?.documents.map((d) => d.id)).toEqual([1])
    expect(detail?.neighbours[1]?.documents.map((d) => d.id)).toEqual([2, 3])
  })

  it('🔴 masks a testimonio title on the edge list too — the same rule, a new surface', async () => {
    const payload = fakePayload([
      [{ id: ENTITY, type: 'tema', label: 'Desplazamiento', support: '3' }],
      [{ id: 5, type: 'lugar', label: 'Oaxaca', support: '3', relation_type: 'ocurre_en', edge_support: '3' }],
      [],
      [
        {
          neighbour_id: 5,
          relation_type: 'ocurre_en',
          id: 90,
          name: 'Testimonio de María López.mp3',
          content_kind: 'testimonio',
          // Even if a row somehow carried one, `mapDocumentRow(row, false)`
          // never reads the column for this list.
          snippet: 'me llamo María y vivo en …',
        },
      ],
    ])

    const detail = await readEntityDetail(payload, { organizationId: ORG, entityId: ENTITY })
    expect(detail?.neighbours[0]?.documents).toEqual([
      { id: 90, title: 'Testimonio', contentKind: 'testimonio' },
    ])
    expect(JSON.stringify(detail)).not.toContain('María')
  })

  it('gives an edge with no evidence row an EMPTY list, never `undefined`', async () => {
    // The two statements run concurrently over the same rows, so a neighbour
    // without evidence should be impossible. "Should be impossible" is not a
    // shape guarantee, and a consumer iterating `documents` must not have to
    // guard for the field's absence.
    const payload = fakePayload([
      [{ id: ENTITY, type: 'tema', label: 'Consulta previa', support: '3' }],
      [{ id: 5, type: 'lugar', label: 'Oaxaca', support: '3', relation_type: 'ocurre_en', edge_support: '3' }],
      [],
      [],
    ])
    const detail = await readEntityDetail(payload, { organizationId: ORG, entityId: ENTITY })
    expect(detail?.neighbours[0]?.documents).toEqual([])
  })

  it('costs exactly one extra statement, run alongside the other two', async () => {
    const payload = fakePayload([
      [{ id: ENTITY, type: 'tema', label: 'X', support: '3' }],
      [],
      [],
      [],
    ])
    await readEntityDetail(payload, { organizationId: ORG, entityId: ENTITY })
    // 1 detail + 3 concurrent. Not one round-trip per edge, which is what a
    // dedicated `/edge` route would have cost this panel.
    expect(payload.executed).toHaveLength(4)
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

// ---------------------------------------------------------------------------
// Seeding a CATEGORY question — ADR §19
// ---------------------------------------------------------------------------

/**
 * The measured defect these tests pin.
 *
 * The 2026-09-05 evaluation found that 0 of 55 expected global facts were ever
 * reached as a seed, because `matchEntitiesToQuery` requires the asker to name
 * the answer. `seedEntitiesForQuery` adds two tiers on top of it, and the cases
 * below are the ones taken from that run's own questions — not invented shapes.
 *
 * ⚠ Every assertion here is on a PURE function. If one of these ever needs a
 * mock payload or a fetch stub, ADR §8.1's "no I/O, no model call" has been
 * broken and that is the thing to look at first.
 */
describe('seedEntitiesForQuery — a question that names a category, not an entity', () => {
  const typed = (
    id: number,
    label: string,
    key: string,
    type: GraphEntityType,
    support: number,
  ): MatchableEntity => ({ id, type, label, canonicalKey: key, support })

  // A miniature of organization 1's graph: the shapes that actually appeared.
  const corpus: MatchableEntity[] = [
    typed(1, 'Centro de Salud de Tlayacapan', 'centro de salud de tlayacapan', 'organizacion', 24),
    typed(2, 'Centro de Salud de Villa de Ayala', 'centro de salud de villa de ayala', 'organizacion', 11),
    typed(3, 'Hospital General de Cuernavaca José G. Parres', 'hospital general de cuernavaca jose g. parres', 'organizacion', 8),
    typed(4, 'Escuela Primaria Miguel Hidalgo', 'escuela primaria miguel hidalgo', 'organizacion', 25),
    typed(5, 'doña Eulalia', 'doña eulalia', 'persona', 10),
    typed(6, 'Reynaldo Ocampo', 'reynaldo ocampo', 'persona', 10),
    typed(7, 'Chabela', 'chabela', 'persona', 8),
    typed(8, 'personas sordas', 'personas sordas', 'tema', 15),
    typed(9, 'feria escolar de prevención del dengue', 'feria escolar de prevencion del dengue', 'evento', 20),
    typed(10, 'jornada de descacharrización', 'jornada de descacharrizacion', 'evento', 7),
    typed(11, 'Morelos', 'morelos', 'lugar', 81),
    typed(12, 'Cuernavaca', 'cuernavaca', 'lugar', 56),
    typed(13, 'náhuatl', 'nahuatl', 'tema', 18),
    typed(14, 'español', 'español', 'tema', 38),
  ]

  it('🔴 seeds the hospitals from "centros de salud", which the literal matcher cannot', () => {
    // The exact G01 wording. `Centro de Salud de Tlayacapan` is nowhere inside
    // it, so the shipped matcher returned nothing and the graph leg produced no
    // block at all.
    const question =
      '¿Qué centros de salud y hospitales aparecen mencionados en varios documentos distintos? Enuméralos.'
    expect(matchEntitiesToQuery(corpus, question)).toEqual([])

    const seeds = seedEntitiesForQuery(corpus, question).map((e) => e.id)
    expect(seeds).toContain(1)
    expect(seeds).toContain(2)
    expect(seeds).toContain(3)
  })

  it('singularises both sides, so "centros" reaches "Centro de Salud"', () => {
    // The whole tier turns on this. Without it the plural in the question and
    // the singular in the label never meet.
    expect(categoryMatchEntities(corpus, 'los centros de salud').map((e) => e.id)).toEqual([1, 2])
  })

  it('keeps the literal tier first, and it alone when the question names its subject', () => {
    // A local question — the shape that already worked. It must not change.
    const seeds = seedEntitiesForQuery(corpus, '¿qué dice el documento sobre Chabela?')
    expect(seeds[0].id).toBe(7)
  })

  it('fills the remaining budget by type when a PLURAL noun heads the question', () => {
    // G04. No person is named, so tiers 1 and 2 have nothing; the type anchor
    // is the only thing that can reach `doña Eulalia`.
    const seeds = seedEntitiesForQuery(
      corpus,
      '¿Qué personas concretas se mencionan por su nombre en varios documentos distintos?',
    ).map((e) => e.id)
    expect(seeds).toEqual(expect.arrayContaining([5, 6, 7]))
    // …and ranked by support, because an entity the corpus leans on is the
    // better seed.
    expect(seeds.indexOf(5)).toBeLessThan(seeds.indexOf(7))
  })

  it('🔴 does not fire the type anchor on a noun that is merely the sentence subject', () => {
    // G05: "¿Qué **lenguas** indígenas hablan las **personas**…". `personas` is
    // the subject, not the thing asked for. Filling eight slots with people
    // here is the exact "fires more often but retrieves noise" failure, and it
    // is why the type noun must HEAD the interrogative phrase.
    expect(
      queryEntityTypes('¿Qué lenguas indígenas hablan las personas que aparecen?', true),
    ).toEqual([])
  })

  it('🔴 does not fire the type anchor on a SINGULAR noun — a local question asks for one thing', () => {
    // The ten local questions all read "¿qué lengua habla X, de qué comunidad
    // viene y en qué lugar colabora?". Three type nouns, all singular. If the
    // plural rule were dropped, every local turn would be seeded with the
    // corpus's biggest places and the local arm would regress.
    const local =
      '¿qué lengua habla Efrén Peralta Guzmán, de qué comunidad viene y en qué lugar colabora?'
    expect(queryEntityTypes(local, true)).toEqual([])
    expect(seedEntitiesForQuery(corpus, local).map((e) => e.id)).not.toContain(11)
  })

  it('🔴 never anchors on `tema` or `lugar` — their top of the distribution is hubs, not answers', () => {
    // Measured: allowing these two bought one extra fact across ten global
    // questions and spent twenty-two seed slots on `Morelos`, `Cuernavaca` and
    // `español`. See the block comment on TYPE_ANCHORABLE.
    expect(queryEntityTypes('¿De qué comunidades o pueblos vienen?', true)).toEqual([])
    expect(queryEntityTypes('¿Qué temas o asuntos se repiten?', true)).toEqual([])
    // The same nouns still narrow tier 2's pool, which is the non-strict form.
    expect(queryEntityTypes('¿De qué comunidades o pueblos vienen?', false)).toContain('lugar')
  })

  it('narrows tier 2 by the type the question names, so "personas" does not seed a tema', () => {
    // `personas sordas` is a `tema`. Without the narrowing it outranks every
    // real person, because it has more support than any of them.
    expect(categoryMatchEntities(corpus, 'las personas', ['persona'])).toEqual([])
    expect(categoryMatchEntities(corpus, 'las personas').map((e) => e.id)).toEqual([8])
  })

  it('prefers the entity that absorbed more of the question', () => {
    // A three-token hit is a far better seed than a one-token one: `feria
    // escolar de prevención del dengue` over anything that merely says `feria`.
    const seeds = categoryMatchEntities(corpus, 'la feria escolar de prevención del dengue')
    expect(seeds[0].id).toBe(9)
  })

  it('honours the seed budget and never returns a duplicate', () => {
    const seeds = seedEntitiesForQuery(
      corpus,
      '¿Qué personas y qué centros de salud aparecen en los documentos?',
      4,
    )
    expect(seeds).toHaveLength(4)
    expect(new Set(seeds.map((e) => e.id)).size).toBe(4)
  })

  it('returns nothing for an empty or punctuation-only query', () => {
    for (const q of ['', '   ', '¿¿??', '...']) expect(seedEntitiesForQuery(corpus, q)).toEqual([])
  })

  it('⚠ still cannot reach a category with no lexical bridge — stated, not hidden', () => {
    // G05. The eleven languages are `tema` nodes whose labels contain no word
    // the question uses, no relation types them as languages, and their support
    // sits mid-distribution. This is answered by the `lengua` column (ADR
    // §18.5). The test exists so nobody reads the tiers above as a fix for it.
    const seeds = seedEntitiesForQuery(
      corpus,
      '¿Qué lenguas indígenas hablan las personas que aparecen en los documentos?',
    )
    expect(seeds.map((e) => e.id)).not.toContain(13)
  })

  it('stays pure and synchronous — ADR §8.1', () => {
    // Not a ceremony: the tiers were chosen over an embedding lookup and over
    // seeding from retrieved chunks precisely because both would have made this
    // return a promise and put a round trip on every turn.
    const result = seedEntitiesForQuery(corpus, '¿Qué centros de salud hay?')
    expect(Array.isArray(result)).toBe(true)
    expect(result).not.toBeInstanceOf(Promise)
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

  // 🔴 Never a raw JS array inside the `sql` tag: drizzle expands it into
  // `($6, $7)` and Postgres rejects the cast. This renderer would bind it as one
  // value and hide that, so it asserts the SHAPE here; `queries.pg.test.ts`
  // proves the statements run through the real driver.
  it('passes seed ids as an ARRAY[] of scalar parameters, not an interpolated IN list', () => {
    const { text, params } = renderSql(retrieveDocumentsQuery(ORG, [4, 9], 3))
    expect(text).toMatch(/= ANY\(ARRAY\[\$\d+, \$\d+\]::int\[\]\)/)
    expect(params.some(Array.isArray)).toBe(false)
    expect(params).toEqual(expect.arrayContaining([4, 9]))
  })

  it('renders an empty seed list as an empty typed array', () => {
    expect(renderSql(retrieveEdgesQuery(ORG, [], 3)).text).toContain('ANY(ARRAY[]::int[])')
  })

  it('drops junk out of the seed id list rather than letting it reach SQL', () => {
    const ids = [1, Number.NaN, 3] as number[]
    const { text, params } = renderSql(retrieveDocumentsQuery(ORG, ids, 3))
    expect(text).toMatch(/= ANY\(ARRAY\[\$\d+, \$\d+\]::int\[\]\)/)
    expect(params.some((p) => typeof p === 'number' && Number.isNaN(p))).toBe(false)
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

// ---------------------------------------------------------------------------
// The whole-graph view's edges (backlog #3) and edge direction (backlog #16)
// ---------------------------------------------------------------------------

describe('the whole-graph view edges', () => {
  it('reads the edges among the listed entities, after the view and the count', async () => {
    const payload = fakePayload([
      [
        { id: 5, type: 'tema', label: 'Agua', support: 9, hidden: 0 },
        { id: 6, type: 'lugar', label: 'Oaxaca', support: 3, hidden: 0 },
        { id: 7, type: 'tema', label: 'Salud', support: 3, hidden: 0 },
      ],
      [{ n: 11 }],
      [
        {
          from_id: '5', to_id: '6', kind: 'relation', support: '4', co_mentions: '6',
          relation_type: 'afecta_a', direction: 'out',
        },
        { from_id: '5', to_id: '7', kind: 'co-mention', support: '2', co_mentions: '2' },
        // A self-loop is not an edge anyone can draw.
        { from_id: '6', to_id: '6', kind: 'co-mention', support: '3', co_mentions: '3' },
      ],
    ])
    const view = await readEntityView(payload, { organizationId: ORG })
    expect(view.edges).toEqual([
      {
        from: 5, to: 6, kind: 'relation', support: 4, coMentions: 6,
        relationType: 'afecta_a', direction: 'out',
      },
      { from: 5, to: 7, kind: 'co-mention', support: 2, coMentions: 2 },
    ])
    // The id list is bound as parameters, never interpolated as text.
    const edgeSql = payload.executed[2]
    expect(edgeSql?.params).toEqual(expect.arrayContaining([5, 6, 7]))
    expect(edgeSql?.text).not.toMatch(/ANY\(ARRAY\[5/)
  })

  it('keeps one edge per pair and orients it from the lower id', async () => {
    const payload = fakePayload([
      [
        { id: 5, type: 'tema', label: 'Agua', support: 9, hidden: 0 },
        { id: 6, type: 'lugar', label: 'Oaxaca', support: 3, hidden: 0 },
      ],
      [{ n: 2 }],
      [
        { from_id: 6, to_id: 5, kind: 'relation', support: 2, co_mentions: 2, relation_type: 'ubicado_en', direction: 'out' },
        { from_id: 5, to_id: 6, kind: 'co-mention', support: 2, co_mentions: 2 },
      ],
    ])
    const view = await readEntityView(payload, { organizationId: ORG })
    expect(view.edges).toEqual([
      { from: 5, to: 6, kind: 'relation', support: 2, coMentions: 2, relationType: 'ubicado_en', direction: 'in' },
    ])
  })

  it('makes no third round trip when nothing is visible', async () => {
    const payload = fakePayload([[{ id: null, hidden: 2 }], [{ n: 1 }]])
    await readEntityView(payload, { organizationId: ORG })
    expect(payload.executed).toHaveLength(2)
  })

  it('folds every type and both directions onto the pair BEFORE the edge threshold', () => {
    const { text } = renderSql(viewEdgesQuery(ORG, [1, 2], MIN))
    const fold = text.indexOf('LEAST(r.from_entity_id, r.to_entity_id)')
    const having = text.indexOf('HAVING COUNT(DISTINCT rel.document_id)')
    expect(fold).toBeGreaterThan(-1)
    expect(having).toBeGreaterThan(fold)
    expect(text).toContain('GROUP BY rel.a, rel.b\n')
  })

  it('labels the pair with its most common type, ties in a stable order', () => {
    const { text } = renderSql(viewEdgesQuery(ORG, [1, 2], MIN))
    expect(text).toContain(
      'ORDER BY COUNT(DISTINCT rel.document_id) DESC, rel.relation_type ASC',
    )
    expect(text).toContain('rt.rn = 1')
  })

  it('computes co-mentions from mentions in SQL, gated like everything else', () => {
    const { text } = renderSql(viewEdgesQuery(ORG, [1, 2], MIN))
    expect(text).toContain('FROM graph_mentions m')
    expect(text).toContain('JOIN ment y ON y.document_id = x.document_id AND y.entity_id > x.entity_id')
    // Both ends must be listed AND above the entity threshold (ent_support).
    expect(text).toContain('JOIN listed l ON l.entity_id = m.entity_id')
    // No persona listed at all (owner, 2026-10-24: no private individuals).
    expect(text).toMatch(MENTION_GATE)
  })

  it('caps co-mentions at the top K per node and never spends a slot on a relation pair', () => {
    const { text, params } = renderSql(
      viewEdgesQuery(ORG, [1, 2], { entity: 1, edge: 1, coMention: 1, topK: 3 }),
    )
    expect(text).toContain('PARTITION BY co_ends.node')
    expect(text).toContain('WHERE rp.a IS NULL')
    expect(params).toContain(3)
    // A huge K is clamped.
    const big = renderSql(viewEdgesQuery(ORG, [1, 2], { entity: 1, edge: 1, topK: 10_000 }))
    expect(big.params).toContain(MAX_COMENTION_TOP_K)
    expect(big.params).not.toContain(10_000)
  })
})

describe('edge direction, seen from the focal entity', () => {
  it('carries the direction the database reports, and treats anything else as undirected', async () => {
    const payload = fakePayload([
      [{ id: ENTITY, type: 'lugar', label: 'Morelos', support: '9' }],
      [
        { id: 5, type: 'lugar', label: 'Xoxocotla', support: '4', relation_type: 'ubicado_en', edge_support: '3', direction: 'in' },
        { id: 6, type: 'tema', label: 'Agua', support: '4', relation_type: 'afecta_a', edge_support: '3', direction: 'out' },
        { id: 7, type: 'tema', label: 'Salud', support: '4', relation_type: 'relacionado_con', edge_support: '3', direction: 'junk' },
      ],
      [],
      [],
    ])
    const detail = await readEntityDetail(payload, { organizationId: ORG, entityId: ENTITY })
    expect(detail?.neighbours.map((n) => n.direction)).toEqual(['in', 'out', 'both'])
  })

  it('computes it in the neighbour statement', () => {
    const { text } = renderSql(entityNeighboursQuery({ organizationId: ORG, entityId: ENTITY }))
    expect(text).toContain('AS direction')
    expect(text).toContain('BOOL_AND(r.from_entity_id = $')
  })
})
