/**
 * P-07 (re-audit 2026-11-10): a route's 500 logs the error's class and
 * SQLSTATE, never the failed query's params. `console.error('…', err)` let
 * `util.format` print a `DrizzleQueryError`'s message, which holds them.
 *
 * C-03 (same re-audit): the routes that read their own body answer 408 to one
 * that stalls.
 */
import { createRequire } from 'node:module'
import { format } from 'node:util'

import { DrizzleQueryError } from '@payloadcms/db-postgres/drizzle'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const { fails } = vi.hoisted(() => ({ fails: vi.fn() }))

vi.mock('@payload-config', () => ({ default: {} }))
vi.mock('payload', () => ({ getPayload: async () => ({ auth: async () => ({ user: { id: 1 } }) }) }))
vi.mock('@/lib/holdReview', async (orig) => ({ ...(await orig<object>()), listHeldDocuments: fails }))
vi.mock('@/lib/rejectPublished', async (orig) => ({ ...(await orig<object>()), listPublishedTestimonios: fails }))
vi.mock('@/lib/chatUsage', () => ({ chatUsage: fails }))
vi.mock('@/lib/ecosystemMetrics', async (orig) => ({ ...(await orig<object>()), ecosystemMetrics: fails }))

const SECRET = 'Me llamo Lucía Hernández y vivo con mi hermano Tomás Ruiz'

const requireFromPg = createRequire(
  createRequire(createRequire(import.meta.url).resolve('@payloadcms/db-postgres')).resolve('pg'),
)

function dbError(): Error {
  const { DatabaseError } = requireFromPg('pg-protocol') as {
    DatabaseError: new (message: string, length: number, name: string) => Error & Record<string, unknown>
  }
  const cause = new DatabaseError(`value too long, near "${SECRET}"`, 0, 'error')
  cause.code = '57P01'
  return new DrizzleQueryError('select * from "documents" where "extracted_text" = $1', [SECRET], cause)
}

afterEach(() => vi.restoreAllMocks())

type Route = { GET: (r: Request) => Promise<Response> }

const routes: [string, () => Promise<Route>, string][] = [
  ['holds', () => import('./holds/route'), '/api/holds?organization=1'],
  ['published', () => import('./published/route'), '/api/published?organization=1'],
  ['metrics/usage', () => import('./metrics/usage/route'), '/api/metrics/usage?organization=1'],
  ['metrics/ecosystem', () => import('./metrics/ecosystem/route'), '/api/metrics/ecosystem?organization=1'],
]

const loaded = new Map<string, Route>()

describe('route 500s', () => {
  // The real route modules import half the app: a one-time cost, not a test's.
  beforeAll(async () => {
    for (const [name, load] of routes) loaded.set(name, await load())
  })

  it.each(routes)('🔴 %s: the log line names the error, not the row', async (name, _load, path) => {
    fails.mockRejectedValue(dbError())
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void lines.push(format(...args)))
    const { GET } = loaded.get(name)!
    const res = await GET(new Request(`http://localhost${path}`))
    expect(res.status).toBe(500)
    const all = lines.join('\n')
    expect(all).toContain('DrizzleQueryError(57P01)')
    expect(all).not.toContain('Lucía')
    expect(all).not.toContain('Failed query')
  })
})

describe('a stalled body (C-03)', () => {
  const stalled = () => {
    let sent = false
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent) return new Promise<void>(() => {})
        sent = true
        c.enqueue(new TextEncoder().encode('{"decision":'))
      },
    })
  }
  const ctx = { params: Promise.resolve({ id: '1' }) }

  it.each([
    ['holds/[id]', () => import('./holds/[id]/route')],
    ['published/[id]', () => import('./published/[id]/route')],
  ] as const)('🔴 %s: 408', async (_name, load) => {
    vi.stubEnv('API_BODY_IDLE_TIMEOUT_MS', '50')
    try {
      const { POST } = await load()
      const res = await POST(
        new Request('http://localhost/api/x/1', {
          method: 'POST',
          body: stalled(),
          headers: { 'content-type': 'application/json' },
          duplex: 'half',
        } as RequestInit),
        ctx,
      )
      expect(res.status).toBe(408)
    } finally {
      vi.unstubAllEnvs()
    }
  }, 30_000)
})
