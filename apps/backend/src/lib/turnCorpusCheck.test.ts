/**
 * THE TURN-CORPUS CONSISTENCY CHECK, against fakes. The SQL itself runs
 * against a real Postgres in `turnCorpusCheck.pg.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  checkTurnCorpus,
  classifyTurnRows,
  describeError,
  readOnlyUrl,
  organizationOfTurnCorpus,
  turnCheckEnv,
  turnCheckExitCode,
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
    countMessages: async () => 1,
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

  it('🔴 allTurns (TURN_CHECK_ALL_TURNS=1): erases every turn, live message or not (ruling 2026-10-21)', async () => {
    const t = deps()

    const report = await checkTurnCorpus({ ...t.d, apply: true, allTurns: true })

    expect(t.erase.mock.calls.map((c) => c.join(' ')).sort()).toEqual([
      'eco-1 msg-1',
      'eco-1 msg-2',
      'eco-1 msg-3',
    ])
    expect(report).toMatchObject({ erased: 3, skipped: 1, orphanLive: 1, orphanStored: 2 })
    expect(t.lines.some((l) => l.startsWith('turn ') && l.includes('msg-1'))).toBe(true)
  })

  it('allTurns is still read-only without apply, and still capped', async () => {
    const t = deps()
    expect(await checkTurnCorpus({ ...t.d, apply: false, allTurns: true })).toMatchObject({ erased: 0 })
    expect(t.erase).not.toHaveBeenCalled()

    const capped = await checkTurnCorpus({ ...t.d, apply: true, allTurns: true, maxErase: 2 })
    expect(capped.refused).toMatch(/3 turns to erase, above the cap of 2/)
    expect(t.erase).not.toHaveBeenCalled()
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

describe('readOnlyUrl', () => {
  it('adds the read-only option', () => {
    const url = new URL(readOnlyUrl('postgres://u:p@h:5432/edc_ai'))
    expect(url.searchParams.get('options')).toBe('-c default_transaction_read_only=on')
  })

  it('MERGES an existing options param instead of overwriting it', () => {
    const url = new URL(readOnlyUrl('postgres://u:p@h:5432/edc_ai?options=-c%20search_path%3Dai&sslmode=require'))
    expect(url.searchParams.get('options')).toBe('-c search_path=ai -c default_transaction_read_only=on')
    expect(url.searchParams.get('sslmode')).toBe('require')
  })

  it('🔴 a malformed URL throws an error that does not carry the URL', () => {
    const secretUrl = 'postgres://edc:s3cr3t-pw@[bad'
    let caught: unknown
    try {
      readOnlyUrl(secretUrl)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught as object))).not.toContain('s3cr3t-pw')
  })
})

describe('describeError', () => {
  it('🔴 never prints a password: Node’s invalid-URL error carries `input`', () => {
    const secretUrl = 'postgres://edc:s3cr3t-pw@[bad/edc_ai'
    let nodeErr: unknown
    try {
      new URL(secretUrl)
    } catch (err) {
      nodeErr = err
    }
    // The leak, as Node ships it.
    expect((nodeErr as { input?: string }).input).toContain('s3cr3t-pw')

    const line = describeError(nodeErr, [secretUrl])
    expect(line).not.toContain('s3cr3t-pw')
    expect(line).toContain('TypeError')
    expect(line).toContain('ERR_INVALID_URL')
  })

  it('redacts a URL echoed in a message, known or not', () => {
    const known = 'postgres://edc:pw-one@db:5432/edc_ai'
    const err = Object.assign(new Error(`connect failed for ${known} and postgresql://x:pw-two@other/db`), {
      code: 'ECONNREFUSED',
    })
    const line = describeError(err, [known])
    expect(line).not.toContain('pw-one')
    expect(line).not.toContain('pw-two')
    expect(line).toContain('Error ECONNREFUSED')
  })

  it('handles a non-Error', () => {
    expect(describeError('boom postgres://a:pw@h/d', [])).not.toContain('pw@')
  })
})

describe('turnCheckEnv — the script reads both databases itself, read-only', () => {
  const env = {
    AI_DATABASE_URL: 'postgres://edc:ai-pw@db:5432/edc_ai',
    DATABASE_URI: 'postgres://edc:be-pw@db:5432/edc_backend',
  }
  const readOnly = (url: string) => new URL(url).searchParams.get('options')

  it('🔴 opens BOTH connections read-only, the backend one too', () => {
    const cfg = turnCheckEnv(env)
    expect(readOnly(cfg.aiUrl)).toBe('-c default_transaction_read_only=on')
    expect(readOnly(cfg.backendUrl)).toBe('-c default_transaction_read_only=on')
    expect(new URL(cfg.backendUrl).pathname).toBe('/edc_backend')
    expect(cfg.apply).toBe(false)
  })

  it('all turns only on TURN_CHECK_ALL_TURNS=1', () => {
    expect(turnCheckEnv(env).allTurns).toBe(false)
    expect(turnCheckEnv({ ...env, TURN_CHECK_ALL_TURNS: '1' }).allTurns).toBe(true)
    expect(turnCheckEnv({ ...env, TURN_CHECK_ALL_TURNS: 'true' }).allTurns).toBe(false)
  })

  it('applies only on TURN_CHECK_APPLY=1', () => {
    expect(turnCheckEnv({ ...env, TURN_CHECK_APPLY: '1' }).apply).toBe(true)
    expect(turnCheckEnv({ ...env, TURN_CHECK_APPLY: 'true' }).apply).toBe(false)
  })

  it('names a missing variable, never a value', () => {
    expect(() => turnCheckEnv({ DATABASE_URI: env.DATABASE_URI })).toThrow(/AI_DATABASE_URL/)
    expect(() => turnCheckEnv({ AI_DATABASE_URL: env.AI_DATABASE_URL })).toThrow(/DATABASE_URI/)
  })

  it('🔴 a malformed backend URL fails without carrying it', () => {
    let caught: unknown
    try {
      turnCheckEnv({ ...env, DATABASE_URI: 'postgres://edc:s3cr3t-pw@[bad' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught as object))).not.toContain('s3cr3t-pw')
  })
})

describe('🔴 the APPLY guards — a wrong DATABASE_URI makes every turn look orphaned', () => {
  const orphans = (n: number) => async () =>
    Array.from({ length: n }, (_, i) => row({ externalId: `msg-${i + 100}` }))

  it('refuses APPLY when the erasable orphans exceed the cap, and erases nothing', async () => {
    const t = deps() // msg-2 and msg-3 erasable

    const report = await checkTurnCorpus({ ...t.d, apply: true, maxErase: 1 })

    expect(t.erase).not.toHaveBeenCalled()
    expect(report.refused).toMatch(/TURN_CHECK_MAX_ERASE/)
    expect(turnCheckExitCode(report)).toBe(1)
  })

  it('the default cap is 50: 50 orphans go, 51 are refused', async () => {
    const fifty = deps({ readTurnRows: orphans(50) })
    expect(await checkTurnCorpus({ ...fifty.d, apply: true })).toMatchObject({ erased: 50, refused: null })

    const fiftyOne = deps({ readTurnRows: orphans(51) })
    const report = await checkTurnCorpus({ ...fiftyOne.d, apply: true })
    expect(fiftyOne.erase).not.toHaveBeenCalled()
    expect(report.refused).toMatch(/51/)
  })

  it('an explicit cap raises the limit', async () => {
    const t = deps({ readTurnRows: orphans(51) })
    expect(await checkTurnCorpus({ ...t.d, apply: true, maxErase: 100 })).toMatchObject({ erased: 51 })
  })

  it('🔴 refuses APPLY when the backend has 0 messages but ai-service holds turns', async () => {
    const t = deps({ countMessages: async () => 0 })

    const report = await checkTurnCorpus({ ...t.d, apply: true })

    expect(t.erase).not.toHaveBeenCalled()
    expect(report.refused).toMatch(/0 messages/)
    expect(report.refused).toMatch(/TURN_CHECK_FORCE/)
  })

  it('force lets the empty-backend case through, still under the cap', async () => {
    const t = deps({ countMessages: async () => 0 })
    expect(await checkTurnCorpus({ ...t.d, apply: true, force: true })).toMatchObject({ erased: 2, refused: null })

    const big = deps({ countMessages: async () => 0, readTurnRows: orphans(51) })
    expect((await checkTurnCorpus({ ...big.d, apply: true, force: true })).refused).toMatch(/TURN_CHECK_MAX_ERASE/)
  })

  it('read-only never refuses, but says what APPLY would refuse', async () => {
    const t = deps({ countMessages: async () => 0 })

    const report = await checkTurnCorpus({ ...t.d, apply: false })

    expect(report.refused).toBeNull()
    expect(t.lines.some((l) => l.startsWith('warning') && l.includes('0 messages'))).toBe(true)
  })

  it('🔴 APPLY exits non-zero when any erase failed', async () => {
    const t = deps()
    t.erase.mockImplementationOnce(async () => {
      throw new Error('503')
    })
    const report = await checkTurnCorpus({ ...t.d, apply: true })
    expect(turnCheckExitCode(report)).toBe(1)
    expect(turnCheckExitCode(await checkTurnCorpus({ ...deps().d, apply: true }))).toBe(0)
  })
})

describe('turnCheckEnv — the guard settings', () => {
  const env = { AI_DATABASE_URL: 'postgres://a@h/x', DATABASE_URI: 'postgres://b@h/y' }

  it('defaults the cap to 50 and force to off', () => {
    expect(turnCheckEnv(env)).toMatchObject({ maxErase: 50, force: false })
  })

  it('reads an explicit cap and TURN_CHECK_FORCE=1', () => {
    expect(turnCheckEnv({ ...env, TURN_CHECK_MAX_ERASE: '500', TURN_CHECK_FORCE: '1' })).toMatchObject({
      maxErase: 500,
      force: true,
    })
    expect(turnCheckEnv({ ...env, TURN_CHECK_MAX_ERASE: '0' }).maxErase).toBe(0)
  })

  it('refuses a junk cap rather than guessing one', () => {
    expect(() => turnCheckEnv({ ...env, TURN_CHECK_MAX_ERASE: 'lots' })).toThrow(/TURN_CHECK_MAX_ERASE/)
    expect(() => turnCheckEnv({ ...env, TURN_CHECK_MAX_ERASE: '-1' })).toThrow(/TURN_CHECK_MAX_ERASE/)
  })
})

describe('describeError — keeps the Postgres cause', () => {
  it('prints the cause code and a redacted cause message, never the URL', () => {
    const url = 'postgres://edc:pw-cause@db:5432/edc_ai'
    const cause = Object.assign(new Error(`password authentication failed (${url})`), { code: '28P01' })
    const err = new Error('Failed query: SELECT 1', { cause })

    const line = describeError(err, [url])

    expect(line).toContain('28P01')
    expect(line).toContain('password authentication failed')
    expect(line).not.toContain('pw-cause')
  })
})
