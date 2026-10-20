/**
 * THE TURN-CORPUS CONSISTENCY CHECK, against fakes. The SQL itself runs
 * against a real Postgres in `turnCorpusCheck.pg.test.ts`.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import {
  checkTurnCorpus,
  classifyTurnRows,
  describeError,
  readOnlyUrl,
  organizationOfTurnCorpus,
  turnCheckEnv,
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

describe('🔴 scripts/check-turn-corpus.ts does not boot Payload', () => {
  // Booting Payload ran the admin seed, the demo-seed gate, the bucket check and
  // every janitor inside a "read-only" check (edc-1 runbook §4m).
  const source = readFileSync(new URL('../../scripts/check-turn-corpus.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('never calls getPayload or loads the Payload config', () => {
    expect(code).not.toMatch(/getPayload|@payload-config|from 'payload'/)
  })

  it('reads its connections from turnCheckEnv', () => {
    expect(code).toMatch(/turnCheckEnv\(process\.env\)/)
  })
})
