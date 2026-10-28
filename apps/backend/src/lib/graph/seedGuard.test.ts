import { describe, expect, it } from 'vitest'

import { renderSql } from '../../eval/db'
import { liveEdge, liveMention } from './seedGuard'

const text = (q: unknown) => renderSql(q).text.replace(/\s+/g, ' ')

describe('seedGuard SQL shape', () => {
  it('🔴 liveEdge probes an uncorrelated dead-seed set once per end (no correlated EXISTS, no IN (from, to))', () => {
    const sql = text(liveEdge('r'))
    expect(sql).not.toMatch(/entity_id IN \(/)
    expect(sql).toContain('(r.document_id, r.from_entity_id) NOT IN (')
    expect(sql).toContain('(r.document_id, r.to_entity_id) NOT IN (')
    expect(sql).not.toMatch(/dm\.document_id = r\./)
  })
  it('liveMention excludes the dead-seed pairs', () => {
    expect(text(liveMention('m'))).toContain('(m.document_id, m.entity_id) NOT IN (')
  })
  it('refuses an alias that is not a short literal', () => {
    expect(() => liveEdge('r; DROP TABLE x')).toThrow(/bad alias/)
  })
})
