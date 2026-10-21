/**
 * Docker-free checks of the purge's control flow. The real-Postgres behaviour
 * (what is deleted, scoping, idempotence) is in `queries.pg.test.ts`.
 */
import { describe, expect, it } from 'vitest'

import { GRAPH_NOISE_KEY_PATTERN } from './noise'
import { purgeGraphNoise, purgeNoiseDeleteQueries } from './purgeNoise'
import type { GraphQueryPayload, GraphSql } from './queries'

function render(query: GraphSql): { text: string; params: unknown[] } {
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

function fake(entities: number) {
  const seen: string[] = []
  const payload = {
    db: {
      drizzle: {
        async execute(q: GraphSql) {
          const { text } = render(q)
          seen.push(text)
          if (text.includes('AS entities')) return { rows: [{ entities, mentions: 2, relations: 1 }] }
          return { rows: [] }
        },
      },
    },
  } as GraphQueryPayload
  return { payload, seen }
}

describe('purgeGraphNoise', () => {
  it('🔴 dry run by default: counts, issues no DELETE', async () => {
    const { payload, seen } = fake(3)
    const report = await purgeGraphNoise(payload)
    expect(report).toMatchObject({ apply: false, organizationId: null, entities: 3, mentions: 2, relations: 1 })
    expect(seen.some((t) => /DELETE/.test(t))).toBe(false)
  })

  it('apply deletes relations, then mentions, then entities', async () => {
    const { payload, seen } = fake(3)
    await purgeGraphNoise(payload, { apply: true, organizationId: 4 })
    expect(seen.filter((t) => t.startsWith('DELETE')).map((t) => t.split(' ')[2])).toEqual([
      'graph_relations',
      'graph_mentions',
      'graph_entities',
    ])
  })

  it('apply with nothing to delete issues no DELETE (idempotent)', async () => {
    const { payload, seen } = fake(0)
    await purgeGraphNoise(payload, { apply: true })
    expect(seen.some((t) => /DELETE/.test(t))).toBe(false)
  })

  it('scopes every delete by the ecosistema when one is given, and binds the shared pattern', () => {
    for (const q of purgeNoiseDeleteQueries(4)) {
      const { text, params } = render(q)
      expect(text).toContain('e.organization_id = $')
      expect(params).toContain(4)
      expect(params).toContain(GRAPH_NOISE_KEY_PATTERN)
    }
    for (const q of purgeNoiseDeleteQueries(null)) {
      expect(render(q).text).not.toContain('organization_id')
    }
  })
})
