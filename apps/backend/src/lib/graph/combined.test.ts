/**
 * The combined graph's statements, read as text: every gate is present, per row.
 * `combined.pg.test.ts` runs them; this file catches a gate deleted from the text.
 */

import { describe, expect, it } from 'vitest'

import {
  combinedEdgeDocumentsQuery,
  combinedEntityDetailQuery,
  combinedEntityDocumentsQuery,
  combinedEntityViewQuery,
  combinedNeighboursQuery,
  combinedViewEdgesQuery,
  normaliseOrgIds,
} from './combined'
import { MENTION_GATE, RELATION_GATE, readSites } from './gateSites.testutil'
import type { GraphSql } from './queries'

function render(query: GraphSql): { text: string; params: unknown[] } {
  const params: unknown[] = []
  const walk = (node: { queryChunks: unknown[] }): string =>
    node.queryChunks
      .map((chunk) => {
        const name = (chunk as { constructor?: { name?: string } })?.constructor?.name
        if (name === 'StringChunk') return (chunk as { value: string[] }).value.join('')
        if (name === 'SQL') return walk(chunk as { queryChunks: unknown[] })
        params.push((chunk as { value?: unknown })?.value ?? chunk)
        return `$${params.length}`
      })
      .join('')
  return { text: walk(query as unknown as { queryChunks: unknown[] }).replace(/\s+/g, ' '), params }
}

const IDS = [3, 1]
const detail = { organizationIds: IDS, entityId: 11 }
const statements: Record<string, GraphSql> = {
  view: combinedEntityViewQuery({ organizationIds: IDS }),
  'view (search)': combinedEntityViewQuery({ organizationIds: IDS, q: 'agua' }),
  edges: combinedViewEdgesQuery(IDS, [11, 12], 1),
  detail: combinedEntityDetailQuery(detail),
  neighbours: combinedNeighboursQuery(detail),
  'edge documents': combinedEdgeDocumentsQuery(detail),
  documents: combinedEntityDocumentsQuery(detail),
}

describe('combined statements carry every gate, per row', () => {
  for (const [name, query] of Object.entries(statements)) {
    it(`${name}: tenant per row, published only, thresholds, noise, persona`, () => {
      const { text } = render(query)
      expect(text).toContain('e.organization_id = ANY(')
      expect(text).toContain('m.organization_id = e.organization_id')
      expect(text).toContain('d.organization_id = m.organization_id')
      expect(text).toContain("d.publication_status = 'published'")
      expect(text).toContain('a.support >= $')
      expect(text).toMatch(/NOT \(e\.canonical_key ~ \$\d+\)/)
      expect(text).toContain("(e.type <> 'persona' OR (d.content_kind = 'documento' AND e.public_figure))")
    })

    it(`🔴 ${name}: gate 5 at every mention and relation read site, not only somewhere`, () => {
      const { text } = render(query)
      const mentions = readSites(text, 'graph_mentions')
      expect(mentions.length).toBeGreaterThan(0)
      for (const site of mentions) expect(site).toMatch(MENTION_GATE)
      for (const site of readSites(text, 'graph_relations')) expect(site).toMatch(RELATION_GATE)
    })
  }

  it('🔴 relation statements join documents to the RELATION row’s own ecosistema', () => {
    for (const name of ['edges', 'neighbours', 'edge documents']) {
      const { text } = render(statements[name]!)
      expect(text).toContain('d.organization_id = r.organization_id')
      expect(text).toContain('r.organization_id = ANY(')
      // Gate 5 on both ends of the relation row.
      expect(text).toMatch(RELATION_GATE)
      if (name === 'edges') {
        // Per-ecosistema pair count by window, and both ends from the relation's ecosistema.
        expect(text).toMatch(/rc\.org_pair_docs >= \$\d+/)
        expect(text).toContain('rel.from_org = rel.org_id AND rel.to_org = rel.org_id')
        expect(text).toMatch(/CASE WHEN co\.weight >= \$\d+/)
      } else {
        // Per-ecosistema pair count by window, before the merge.
        expect(text).toMatch(/roc\.org_pair_docs >= \$\d+/)
        expect(text).toContain('PARTITION BY rel.org_id, rel.neighbour_id ORDER BY rel.document_id')
      }
    }
  })

  /**
   * ⚠ THE PLANNER GUESSES ~1 ROW FOR EVERY AGGREGATED CTE, so a JOIN between
   * two derived sets is a nested loop over both. The node panel's old
   * `merged … IN (SELECT … FROM focal)` re-ran a `member` self-join per node:
   * 4.7 s for one hub on an ecosistema the size of dev org 6 (audit,
   * 2026-10-28). A JOIN may reach a base table or `focal` (one row per
   * ecosistema), nothing else. The real-Postgres proof is
   * `combinedDetail.pg.test.ts`.
   */
  it('node panel statements join only base tables and `focal`, never two derived sets', () => {
    const allowed = new Set(['graph_mentions', 'documents', 'graph_entities', 'focal'])
    for (const name of ['detail', 'neighbours', 'edge documents', 'documents']) {
      const { text } = render(statements[name]!)
      const joined = [...text.matchAll(/\bJOIN\s+(?!LATERAL\b)(\w+)/g)].map((m) => m[1])
      expect(joined.filter((table) => !allowed.has(table!)), name).toEqual([])
      // The node is one scalar lookup, planned once — never a semi-join to a CTE.
      expect(text, name).not.toMatch(/IN \(SELECT \w+\.node_id FROM/)
      expect(text, name).toContain('(SELECT fm.node_id FROM member fm WHERE fm.entity_id = $')
      if (name !== 'detail') expect(text, name).toContain('focal AS MATERIALIZED')
    }
    for (const name of ['neighbours', 'edge documents']) {
      const { text } = render(statements[name]!)
      // The neighbour gate is a fold over relation rows and visible node rows.
      expect(text, name).toMatch(/FROM rel_raw rr UNION ALL SELECT .* FROM node_attr na/)
      expect(text, name).toContain('WHERE rf.is_rel AND rf.neighbour_id IS NOT NULL')
      // Neighbour label and support come from `node_attr`, not a join back to `merged`.
      expect(text, name).not.toMatch(/FROM merged|JOIN merged/)
    }
  })

  it('🔴 the search subquery ties every row to the mention’s own ecosistema', () => {
    const { text } = render(statements['view (search)']!)
    expect(text).toContain('sd.organization_id = sm.organization_id')
    expect(text).toContain('se.organization_id = sm.organization_id')
    expect(text).toContain("(se.type <> 'persona' OR (sd.content_kind = 'documento' AND se.public_figure))")
  })

  it('🔴 only the entity documents statement selects a snippet, behind the documento CASE', () => {
    for (const [name, query] of Object.entries(statements)) {
      const { text } = render(query)
      if (name === 'documents') {
        expect(text).toContain("CASE WHEN d.content_kind = 'documento' THEN m.snippet ELSE NULL END")
      } else {
        expect(text).not.toContain('snippet')
      }
    }
  })

  it('🔴 P-13: both document statements return the title gate’s columns, as queries.ts does', () => {
    const edge = render(statements['edge documents']!).text
    expect(edge).toContain("d.anonymisation_report->>'redactedTitle' AS redacted_title")
    expect(edge).toContain('ranked.anonymise AS anonymise, ranked.redacted_title AS redacted_title FROM ranked')
    const docs = render(statements.documents!).text
    expect(docs).toContain('d.anonymise AS anonymise')
    expect(docs).toContain("d.anonymisation_report->>'redactedTitle' AS redacted_title")
  })

  it('binds the ecosistema ids one parameter each, sorted, never inlined', () => {
    const { text, params } = render(statements.view!)
    expect(text).not.toMatch(/ANY\(ARRAY\[\d/)
    expect(params.slice(0, 2)).toEqual([1, 3])
  })
})

describe('normaliseOrgIds', () => {
  it('keeps positive integers, de-duplicated and ascending', () => {
    expect(normaliseOrgIds([3, '1', 3, '2 ', 0, -4, 'x', 1.5, null])).toEqual([1, 2, 3])
  })
})
