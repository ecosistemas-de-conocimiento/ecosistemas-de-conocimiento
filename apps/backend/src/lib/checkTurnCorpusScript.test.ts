/**
 * 🔴 `scripts/check-turn-corpus.ts`, RUN FOR REAL, with its I/O faked.
 *
 * Booting Payload ran the admin seed, the demo-seed gate, the bucket check and
 * every janitor inside a "read-only" check (edc-1 runbook §4m). So the test
 * imports the script itself and fails if `getPayload` is ever called or the
 * Payload config is ever loaded. It also pins the exit codes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  getPayload: vi.fn(),
  configLoaded: vi.fn(),
  urls: [] as string[],
  turnRows: [] as unknown[],
  existing: [] as Array<{ id: number }>,
  messageCount: 1,
  deleteDocument: vi.fn(async (_corpus: string, _externalId: string) => {}),
}))

vi.mock('payload', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPayload: h.getPayload,
}))
vi.mock('@payload-config', () => {
  h.configLoaded()
  return { default: {} }
})

/** The text of a drizzle `sql` object, enough to tell the queries apart. */
function textOf(query: unknown): string {
  const out: string[] = []
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node == null) return
    if (typeof node === 'string') return void out.push(node)
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1))
    if (typeof node === 'object') {
      const o = node as { value?: unknown; queryChunks?: unknown }
      walk(o.value, depth + 1)
      walk(o.queryChunks, depth + 1)
    }
  }
  walk(query, 0)
  return out.join(' ')
}

vi.mock('@payloadcms/db-postgres/drizzle/node-postgres', () => ({
  drizzle: (url: string) => {
    h.urls.push(url)
    return {
      $client: { end: async () => {} },
      execute: async (query: unknown) => {
        const text = textOf(query)
        if (text.includes("LIKE 'msg-%'")) return { rows: h.turnRows }
        if (text.includes('IS DISTINCT FROM')) return { rows: [] }
        if (text.includes('count(*)')) return { rows: [{ n: h.messageCount }] }
        if (text.includes('FROM messages WHERE id IN')) return { rows: h.existing }
        throw new Error(`unexpected query: ${text}`)
      },
    }
  },
}))
vi.mock('./aiClient', () => ({
  getAdminAIClient: () => ({ admin: { deleteDocument: h.deleteDocument } }),
}))

const turn = (externalId: string) => ({
  corpus: 'eco-1',
  org: 'edc-eco-1',
  externalId,
  docLive: false,
  chunks: 1,
  liveChunks: 0,
})

async function runScript(): Promise<number | undefined> {
  let code: number | undefined
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c
  }) as never)
  vi.resetModules()
  await import('../../scripts/check-turn-corpus')
  return code
}

describe('🔴 scripts/check-turn-corpus.ts', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('AI_DATABASE_URL', 'postgres://edc:ai-pw@db:5432/edc_ai')
    vi.stubEnv('DATABASE_URI', 'postgres://edc:be-pw@db:5432/edc_backend')
    vi.stubEnv('TURN_CHECK_APPLY', '')
    vi.stubEnv('TURN_CHECK_MAX_ERASE', '')
    vi.stubEnv('TURN_CHECK_FORCE', '')
    h.urls.length = 0
    h.turnRows = [turn('msg-1'), turn('msg-2')]
    h.existing = [{ id: 1 }]
    h.messageCount = 1
    h.getPayload.mockClear()
    h.configLoaded.mockClear()
    h.deleteDocument.mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('never boots Payload, and opens BOTH databases read-only', async () => {
    const code = await runScript()

    expect(code).toBe(0)
    expect(h.getPayload).not.toHaveBeenCalled()
    expect(h.configLoaded).not.toHaveBeenCalled()
    expect(h.urls).toHaveLength(2)
    for (const url of h.urls) {
      expect(new URL(url).searchParams.get('options')).toContain('default_transaction_read_only=on')
    }
    expect(h.deleteDocument).not.toHaveBeenCalled()
  })

  it('APPLY erases through the ai-service client only, and exits 0', async () => {
    vi.stubEnv('TURN_CHECK_APPLY', '1')

    expect(await runScript()).toBe(0)
    expect(h.deleteDocument.mock.calls).toEqual([['eco-1', 'msg-2']])
    expect(h.getPayload).not.toHaveBeenCalled()
  })

  it('🔴 APPLY exits 1 when an erase fails', async () => {
    vi.stubEnv('TURN_CHECK_APPLY', '1')
    h.deleteDocument.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 503 }))

    expect(await runScript()).toBe(1)
  })

  it('🔴 APPLY against an empty backend is refused and exits 1', async () => {
    vi.stubEnv('TURN_CHECK_APPLY', '1')
    h.messageCount = 0
    h.existing = []

    expect(await runScript()).toBe(1)
    expect(h.deleteDocument).not.toHaveBeenCalled()
  })

  it('a failure prints neither password', async () => {
    vi.stubEnv('DATABASE_URI', 'postgres://edc:be-pw@[bad')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await runScript()).toBe(1)
    const printed = errors.mock.calls.flat().join(' ')
    expect(printed).not.toContain('be-pw')
    expect(printed).not.toContain('ai-pw')
  })
})
