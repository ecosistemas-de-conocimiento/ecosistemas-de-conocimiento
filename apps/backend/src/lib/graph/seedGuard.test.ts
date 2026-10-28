import { sql } from '@payloadcms/db-postgres'
import { describe, expect, it } from 'vitest'

import { renderSql } from '../../eval/db'
import { liveEdge, liveMention } from './seedGuard'

const text = (q: unknown) => renderSql(q).text.replace(/\s+/g, ' ')

describe('seedGuard SQL shape', () => {
  it('🔴 liveEdge probes an uncorrelated dead-seed set once per end (no correlated EXISTS, no IN (from, to))', () => {
    const sql = text(liveEdge('r', 8))
    expect(sql).not.toMatch(/entity_id IN \(/)
    expect(sql).toContain('(r.document_id, r.from_entity_id) NOT IN (')
    expect(sql).toContain('(r.document_id, r.to_entity_id) NOT IN (')
    expect(sql).not.toMatch(/dm\.document_id = r\./)
  })
  it('liveMention excludes the dead-seed pairs', () => {
    expect(text(liveMention('m', 8))).toContain('(m.document_id, m.entity_id) NOT IN (')
  })
  it('🔴 the dead-seed set is scoped to the queried ecosistema(s)', () => {
    expect(text(liveMention('m', 8))).toMatch(/dm\.organization_id = \$\d+ AND dm\.seeded = true/)
    expect(text(liveEdge('r', { anyOf: sql`ARRAY[1, 8]::int[]` }))).toContain('dm.organization_id = ANY(')
    expect(() => liveMention('m', 1.5)).toThrow(/bad organization id/)
  })
  it('refuses an alias that is not a short literal', () => {
    expect(() => liveEdge('r; DROP TABLE x', 8)).toThrow(/bad alias/)
  })
})
