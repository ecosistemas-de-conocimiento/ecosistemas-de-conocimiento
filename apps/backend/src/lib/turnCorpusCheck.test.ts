/**
 * THE TURN-CORPUS CONSISTENCY CHECK, against fakes. The SQL itself runs
 * against a real Postgres in `turnCorpusCheck.pg.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  checkTurnCorpus,
  classifyTurnRows,
  organizationOfTurnCorpus,
  type AiTurnRow,
  type TurnCheckDeps,
} from './turnCorpusCheck'

const row = (over: Partial<AiTurnRow>): AiTurnRow => ({
  corpus: 'eco-1',
  org: 'edc-eco-1',
  externalId: 'msg-1',
  docLive: false,
  chunks: 1,
  liveChunks: 0,
  ...over,
})

describe('classifyTurnRows', () => {
  it('a turn whose message exists is fine, live or not', () => {
    const rows = [row({ externalId: 'msg-1', docLive: true, liveChunks: 1 }), row({ externalId: 'msg-2' })]
    expect(classifyTurnRows(rows, new Set(['1', '2']))).toEqual([])
  })

  it('🔴 message gone and the doc OR any chunk live → orphan-live', () => {
    const rows = [
      row({ externalId: 'msg-2', docLive: false, liveChunks: 1 }), // the dev `msg-2` case
      row({ externalId: 'msg-11', docLive: true, liveChunks: 1 }),
    ]
    expect(classifyTurnRows(rows, new Set()).map((p) => [p.kind, p.externalId])).toEqual([
      ['orphan-live', 'msg-2'],
      ['orphan-live', 'msg-11'],
    ])
  })

  it('message gone, everything retired → orphan-stored (hidden, but the text is still kept)', () => {
    expect(classifyTurnRows([row({ externalId: 'msg-3' })], new Set())).toEqual([
      { kind: 'orphan-stored', corpus: 'eco-1', org: 'edc-eco-1', externalId: 'msg-3', messageId: '3' },
    ])
  })

  it('ignores an id that is not msg-<number>', () => {
    expect(classifyTurnRows([row({ externalId: 'msg-x' })], new Set())).toEqual([])
  })
})

describe('organizationOfTurnCorpus', () => {
  it('reads the ecosistema id from the shared corpus name only', () => {
    expect(organizationOfTurnCorpus('eco-12')).toBe('12')
    expect(organizationOfTurnCorpus('eco-12-draft-3')).toBeNull()
    expect(organizationOfTurnCorpus('other')).toBeNull()
  })
})

function deps(over: Partial<TurnCheckDeps> = {}) {
  const lines: string[] = []
  const erase = vi.fn(async (_corpus: string, _externalId: string) => {})
  const d: TurnCheckDeps = {
    readTurnRows: async () => [
      row({ externalId: 'msg-1', docLive: true, liveChunks: 1 }),
      row({ externalId: 'msg-2', liveChunks: 1 }),
      row({ externalId: 'msg-3' }),
      row({ corpus: 'eco-1-draft-4', externalId: 'msg-4' }),
    ],
    readValidityMismatches: async () => [
      { corpus: 'eco-1', org: 'edc-eco-1', externalId: '57', chunks: 2 },
    ],
    existingMessageIds: async (ids) => new Set(ids.filter((id) => id === '1')),
    erase,
    log: (line) => lines.push(line),
    ...over,
  }
  return { d, erase, lines }
}

describe('checkTurnCorpus', () => {
  it('🔴 is READ-ONLY by default: reports, erases nothing', async () => {
    const t = deps()

    const report = await checkTurnCorpus({ ...t.d, apply: false })

    expect(t.erase).not.toHaveBeenCalled()
    expect(report).toMatchObject({
      apply: false,
      turnDocs: 4,
      orphanLive: 1,
      orphanStored: 2,
      validityMismatches: 1,
      erased: 0,
    })
    expect(t.lines.some((l) => l.includes('validity-mismatch') && l.includes('57'))).toBe(true)
  })

  it('with apply, erases each orphan from its shared corpus, and skips an unexpected corpus', async () => {
    const t = deps()

    const report = await checkTurnCorpus({ ...t.d, apply: true })

    expect(t.erase.mock.calls).toEqual([
      ['eco-1', 'msg-2'],
      ['eco-1', 'msg-3'],
    ])
    expect(report).toMatchObject({ erased: 2, eraseFailed: 0, skipped: 1 })
  })

  it('a failed erase is counted and logged; the rest still runs', async () => {
    const t = deps()
    t.erase.mockImplementationOnce(async () => {
      throw new Error('503')
    })

    const report = await checkTurnCorpus({ ...t.d, apply: true })

    expect(report).toMatchObject({ erased: 1, eraseFailed: 1 })
    expect(t.lines.some((l) => l.includes('erase failed') && l.includes('msg-2'))).toBe(true)
  })

  it('never erases a validity mismatch: it only reports it', async () => {
    const t = deps({ readTurnRows: async () => [] })

    const report = await checkTurnCorpus({ ...t.d, apply: true })

    expect(t.erase).not.toHaveBeenCalled()
    expect(report.validityMismatches).toBe(1)
  })
})
