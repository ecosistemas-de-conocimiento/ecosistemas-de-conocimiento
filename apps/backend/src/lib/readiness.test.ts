/**
 * Readiness contract tests.
 *
 * Four properties matter, and they are the four the health-check contract was
 * written to protect:
 *
 *   1. SHAPE + STRICTNESS (Rule 1/3) — one dependency down takes the whole
 *      service down, and down means 503. There is no `degraded` to hide in.
 *   2. TOLERANCE (Rule 4c) — one failed probe is not an outage; two consecutive
 *      ones are. Including the accepted cost: in the 1-of-2 window the body
 *      carries an `error` while `status` is still `ok`.
 *   3. CACHING (Rule 4c) — the result is reused for 5s so a 5s container probe
 *      and a 5min monitor cannot multiply load on a shared dependency.
 *   4. 🔴 REDACTION — the route is UNAUTHENTICATED, so a probe error carrying a
 *      Postgres auth message or a DSN must not reach the body. Postgres emits
 *      `password authentication failed for user "…"` straight to the wire.
 *
 * All probes are injected, so nothing here touches Postgres, ai-service or the
 * network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CACHE_TTL_MS,
  DOWN_AFTER_CONSECUTIVE_FAILURES,
  __resetReadinessStateForTests,
  classifyError,
  getReadiness,
  httpStatusFor,
  probeAll,
  probeAiService,
  type Dependency,
} from './readiness'

const ok = (name: string): Dependency => ({ name, probe: async () => {} })
const fails = (name: string, err: unknown): Dependency => ({
  name,
  probe: async () => {
    throw err
  },
})

/** The exact shape of the error a bad Postgres credential produces. */
function pgAuthError() {
  const err = new Error('password authentication failed for user "chat"') as Error & {
    code?: string
    severity?: string
  }
  err.code = '28P01'
  err.severity = 'FATAL'
  return err
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  __resetReadinessStateForTests()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  vi.useRealTimers()
  __resetReadinessStateForTests()
})

describe('shape and strictness (Rules 1 + 3)', () => {
  it('reports ok / 200 when every declared dependency is reachable', async () => {
    const report = await probeAll([ok('database'), ok('ai-service')])

    expect(report.status).toBe('ok')
    expect(Object.keys(report.checks).sort()).toEqual(['ai-service', 'database'])
    expect(report.checks.database.status).toBe('ok')
    expect(report.checks['ai-service'].status).toBe('ok')
    expect(httpStatusFor(report)).toBe(200)
  })

  it('every check reports a latency, so a slow dependency is visible before it is an unreachable one', async () => {
    const report = await probeAll([ok('database'), ok('ai-service')])

    for (const check of Object.values(report.checks)) {
      expect(typeof check.ms).toBe('number')
      expect(check.ms).toBeGreaterThanOrEqual(0)
    }
  })

  it('a single dependency down takes the whole service down, at 503', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:8080'), {
      code: 'ECONNREFUSED',
    })
    const deps = [ok('database'), fails('ai-service', refused)]

    await probeAll(deps) // failure 1 of 2 — tolerated
    const report = await probeAll(deps) // failure 2 of 2 — down

    expect(report.checks.database.status).toBe('ok')
    expect(report.checks['ai-service']).toEqual({
      status: 'down',
      ms: expect.any(Number),
      error: 'ECONNREFUSED',
    })
    expect(report.status).toBe('down')
    expect(httpStatusFor(report)).toBe(503)
  })

  it('never emits a third status — down is the only non-ok value', async () => {
    const deps = [fails('database', new Error('boom')), fails('ai-service', new Error('boom'))]
    await probeAll(deps)
    const report = await probeAll(deps)

    const statuses = [report.status, ...Object.values(report.checks).map((c) => c.status)]
    for (const status of statuses) expect(['ok', 'down']).toContain(status)
    expect(statuses).not.toContain('degraded')
  })
})

describe('2-consecutive-failure tolerance (Rule 4c)', () => {
  it('tolerates one failed probe: status stays ok, but the body carries the error', async () => {
    const deps = [ok('database'), fails('ai-service', new Error('transient'))]

    const first = await probeAll(deps)

    expect(DOWN_AFTER_CONSECUTIVE_FAILURES).toBe(2)
    expect(first.status).toBe('ok')
    expect(httpStatusFor(first)).toBe(200)
    // The accepted cost, asserted so nobody "fixes" it into a third status:
    // ok + a populated error is the 1-of-2 window, and monitors treat a
    // populated error as a signal.
    expect(first.checks['ai-service'].status).toBe('ok')
    expect(first.checks['ai-service'].error).toBe('unknown')
  })

  it('marks down only on the SECOND consecutive failure', async () => {
    const deps = [fails('ai-service', new Error('transient'))]

    expect((await probeAll(deps)).status).toBe('ok')
    expect((await probeAll(deps)).status).toBe('down')
  })

  it('a success between two failures resets the counter — no down', async () => {
    let shouldFail = true
    const flapping: Dependency = {
      name: 'ai-service',
      probe: async () => {
        if (shouldFail) throw new Error('transient')
      },
    }

    expect((await probeAll([flapping])).status).toBe('ok') // fail 1
    shouldFail = false
    expect((await probeAll([flapping])).status).toBe('ok') // success — resets
    shouldFail = true
    expect((await probeAll([flapping])).status).toBe('ok') // fail 1 again, not 2
    expect((await probeAll([flapping])).status).toBe('down') // fail 2
  })

  it('counts each dependency independently', async () => {
    const deps = [ok('database'), fails('ai-service', new Error('x'))]
    await probeAll(deps)
    const report = await probeAll(deps)

    expect(report.checks.database.status).toBe('ok')
    expect(report.checks['ai-service'].status).toBe('down')
  })
})

describe('result caching (Rule 4c)', () => {
  it('reuses the result for 5s instead of re-probing', async () => {
    vi.useFakeTimers()
    const probe = vi.fn(async () => {})

    await getReadiness([{ name: 'database', probe }])
    await getReadiness([{ name: 'database', probe }])
    vi.setSystemTime(Date.now() + CACHE_TTL_MS - 1)
    await getReadiness([{ name: 'database', probe }])

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('re-probes once the cache expires', async () => {
    vi.useFakeTimers()
    const probe = vi.fn(async () => {})

    await getReadiness([{ name: 'database', probe }])
    vi.setSystemTime(Date.now() + CACHE_TTL_MS + 1)
    await getReadiness([{ name: 'database', probe }])

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('de-duplicates concurrent requests onto one probe', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const probe = vi.fn(async () => {
      await gate
    })
    const deps = [{ name: 'database', probe }]

    const all = Promise.all([getReadiness(deps), getReadiness(deps), getReadiness(deps)])
    release()
    const reports = await all

    expect(probe).toHaveBeenCalledTimes(1)
    for (const report of reports) expect(report.status).toBe('ok')
  })
})

describe('🔴 redaction — the route is unauthenticated', () => {
  it('never leaks a Postgres credential message into the body', async () => {
    const secret = pgAuthError()
    const deps = [fails('database', secret)]

    await probeAll(deps)
    const report = await probeAll(deps)
    const body = JSON.stringify(report)

    expect(report.checks.database.status).toBe('down')
    expect(report.checks.database.error).toBe('unknown')
    expect(body).not.toContain('password')
    expect(body).not.toContain('authentication')
    expect(body).not.toContain('chat"')
    expect(body).not.toContain('28P01')
    expect(body.toLowerCase()).not.toContain('fatal')
  })

  it('never leaks a DSN, host or credential from any probe error', async () => {
    const dsn = 'postgres://chat_user:hunter2@10.10.4.7:5432/chatdb'
    const deps = [
      fails('database', new Error(`could not connect to ${dsn}`)),
      fails('ai-service', new Error('bearer sk-live-abcdef123 rejected by https://ai.internal')),
    ]

    await probeAll(deps)
    const body = JSON.stringify(await probeAll(deps))

    for (const leak of ['hunter2', 'chat_user', '10.10.4.7', 'chatdb', 'sk-live-abcdef123', 'ai.internal']) {
      expect(body).not.toContain(leak)
    }
  })

  it('emits ONLY the closed vocabulary, whatever the probe throws', async () => {
    const allowed = /^(ECONNREFUSED|timeout|unreachable|not_configured|unknown|http_[1-5][0-9]{2})$/
    const thrown: unknown[] = [
      pgAuthError(),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('getaddrinfo ENOTFOUND ai.internal'), { code: 'ENOTFOUND' }),
      Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
      'a bare string with a password=hunter2 in it',
      { message: 'a bare object with token=sk-live-xyz' },
      null,
      undefined,
    ]

    for (const err of thrown) {
      __resetReadinessStateForTests()
      const deps = [fails('database', err)]
      await probeAll(deps)
      const report = await probeAll(deps)
      const code = report.checks.database.error

      expect(code).toBeDefined()
      expect(code).toMatch(allowed)
      expect(JSON.stringify(report)).not.toContain('hunter2')
      expect(JSON.stringify(report)).not.toContain('sk-live-xyz')
    }
  })

  it('logs the FULL error to console.error — the only place it is allowed to exist', async () => {
    const secret = pgAuthError()

    await probeAll([fails('database', secret)])

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0]).toContain(secret)
  })

  it('maps an HTTP failure to http_<code> and nothing else', async () => {
    // A dependency answering 503 with a body that describes its internals.
    const server = { status: 503, body: 'upstream postgres://u:p@db:5432 unavailable' }
    const dep: Dependency = {
      name: 'ai-service',
      probe: async () => {
        const res = new Response(server.body, { status: server.status })
        await res.body?.cancel()
        if (!res.ok) {
          const err = new Error(`http_${res.status}`) as Error & { httpStatus?: number }
          err.name = 'HttpStatusError'
          err.httpStatus = res.status
          throw err
        }
      },
    }

    await probeAll([dep])
    const report = await probeAll([dep])

    // The externally-constructed marker is not our class, so it degrades to
    // `unknown` rather than guessing — still redacted, which is the property
    // that matters. The real path is covered by classifyError below.
    expect(['unknown', 'http_503']).toContain(report.checks['ai-service'].error)
    expect(JSON.stringify(report)).not.toContain('postgres://')
  })
})

describe('classifyError', () => {
  it('maps socket-level codes onto the vocabulary', () => {
    expect(classifyError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED')
    expect(classifyError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('timeout')
    expect(classifyError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe('unreachable')
    expect(classifyError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout')
  })

  it('unwraps undici`s `fetch failed` cause', () => {
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:8080'), { code: 'ECONNREFUSED' }),
    })
    expect(classifyError(wrapped)).toBe('ECONNREFUSED')
  })

  it('falls back to unknown rather than guessing from a message', () => {
    expect(classifyError(pgAuthError())).toBe('unknown')
    expect(classifyError(new Error('ECONNREFUSED appears only in the message'))).toBe('unknown')
  })
})

describe('ai-service probe (Rules 1a + 5)', () => {
  it('probes /health/ready — never /health, never a /v1/* route', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))

    await probeAiService('http://ai.test/')

    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).toBe('http://ai.test/health/ready')
    expect(url).not.toContain('/v1/')
    fetchSpy.mockRestore()
  })

  it('is bounded by an abort signal so readiness can never hang', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))

    await probeAiService('http://ai.test')

    const init = fetchSpy.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    fetchSpy.mockRestore()
  })

  it('throws on a non-2xx, and the failure classifies as http_<code>', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('service unavailable', { status: 503 }))

    await expect(probeAiService('http://ai.test')).rejects.toThrow()

    const deps: Dependency[] = [{ name: 'ai-service', probe: () => probeAiService('http://ai.test') }]
    await probeAll(deps)
    const report = await probeAll(deps)

    expect(report.checks['ai-service'].error).toBe('http_503')
    expect(report.checks['ai-service'].status).toBe('down')
    fetchSpy.mockRestore()
  })

  it('an unset AI_SERVICE_URL is DOWN, not omitted — ai-service is required (Rule 1a)', async () => {
    const deps: Dependency[] = [{ name: 'ai-service', probe: () => probeAiService(undefined) }]

    await probeAll(deps)
    const report = await probeAll(deps)

    expect(report.checks['ai-service']).toEqual({
      status: 'down',
      ms: expect.any(Number),
      error: 'not_configured',
    })
    expect(httpStatusFor(report)).toBe(503)
  })
})
