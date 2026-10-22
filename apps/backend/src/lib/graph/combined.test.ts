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
      expect(text).toContain("(e.type <> 'persona' OR d.content_kind = 'documento')")
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
      expect(text).toContain("WHERE d.content_kind = 'documento' OR NOT EXISTS (SELECT 1 FROM graph_entities pe WHERE pe.id IN (r.from_entity_id, r.to_entity_id) AND pe.type = 'persona')")
      if (name === 'edges') {
        // Per-ecosistema pair count by window, and both ends from the relation's ecosistema.
        expect(text).toMatch(/rc\.org_pair_docs >= \$\d+/)
        expect(text).toContain('rel.from_org = rel.org_id AND rel.to_org = rel.org_id')
        expect(text).toMatch(/CASE WHEN co\.weight >= \$\d+/)
      } else {
        expect(text).toMatch(/HAVING COUNT\(DISTINCT rel\.document_id\) >= \$\d+/)
      }
    }
  })

  it('🔴 the search subquery ties every row to the mention’s own ecosistema', () => {
    const { text } = render(statements['view (search)']!)
    expect(text).toContain('sd.organization_id = sm.organization_id')
    expect(text).toContain('se.organization_id = sm.organization_id')
    expect(text).toContain("(se.type <> 'persona' OR sd.content_kind = 'documento')")
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
