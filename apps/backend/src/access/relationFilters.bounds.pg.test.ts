/**
 * 🔴 A FILTER THROUGH A RELATION HAS A BOUNDED COST — OVER REST, AGAINST A
 * REAL POSTGRES, WITH THE CALLER OWNING 20 000 CONVERSATIONS.
 *
 * Audit 2026-11-10 (D1): `resolveRelationCrossings` turned every crossing
 * term into the full list of ids the caller may read in the target, all terms
 * at once, with no bound. A member who opened 20 000 conversations sent
 * `where[or][i][session.title][like]=b` ten times: 5.3 s, the event loop
 * blocked up to 2.5 s, another person's `/api/users/me` delayed 4.8 s, and a
 * 500 at the end; forty terms took 25 s (quoted from the audit). The first
 * three tests below failed on a3c9df9f; the three marked D2 or on the log
 * (concurrency and rate per person, the log level) failed on dc1a4188; the
 * slot held through the main query (D2 leftover) failed on 77f335fc, and the
 * slot coming back after a failure there failed without `afterError`. The
 * web's filters and the platform admin are controls.
 *
 * The bounds (`relationFilterLimits` in `relationFilters.ts`): at most
 * `QUERY_RELATION_MAX_TERMS` crossings per request, at most
 * `QUERY_RELATION_MAX_IDS` ids read in all; past either, 400.
 *
 * `EDC_MEASURE_RELATION_BOUNDS=1` also runs the timing probes at the end,
 * which print each request's time (one at a time, twenty at once from one
 * member, and one member resending every 429), a concurrent `/api/users/me`
 * and the event loop's longest stall.
 * They assert nothing.
 *
 * Harness: `lib/testing/realPostgres`; driven through `handleEndpoints`, real JWT.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks'

import { sql } from '@payloadcms/db-postgres'
import type { Payload, SanitizedConfig } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true, ingestId: 'fake-ingest' }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { relationSlotsHeld } from '@/access/relationFilters'
import { resetRateLimits } from '@/lib/rateLimit'
import { bootPayload, dockerOk, shutdown, startRealPostgres, type RealPostgres } from '@/lib/testing/realPostgres'

const PASSWORD = 'relation-bounds-pw'
let pg: RealPostgres
let payload: Payload
let config: SanitizedConfig
const tokens: Record<string, string> = {}

const BEN = 2 // member: owns every conversation below
const ANA = 3 // member, same ecosistema: the bystander
const PLATFORM = 9
/**
 * BEN's conversations, as in the audit. Titles `b00001` … `b20000`: no space,
 * since `like` matches each space-separated word on its own.
 */
const SESSIONS = 20_000
/** BEN's first conversations carry a rated message each. */
const RATED = 3

/**
 * A request that answers 400 must do so without reading the lists: well under
 * the 5.3 s measured before. 1.5 s leaves room for a loaded host; on torre at
 * load ~17-21 on 16 cores they answered in under 15 ms (2026-11-10).
 */
const QUICK_MS = 1_500

async function rest(method: string, path: string, token?: string): Promise<Response> {
  const { handleEndpoints } = await import('payload')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `JWT ${token}`
  return handleEndpoints({ config, request: new Request(`http://localhost${path}`, { method, headers }) })
}

async function login(email: string): Promise<string> {
  const { handleEndpoints } = await import('payload')
  const res = await handleEndpoints({
    config,
    request: new Request('http://localhost/api/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  })
  const token = ((await res.json()) as { token?: string }).token
  if (!token) throw new Error('login failed')
  return token
}

/** `where[or][i][session.title][like]=b`, `terms` times. */
const orTerms = (terms: number, value = 'b') =>
  Array.from({ length: terms }, (_, i) => `where[or][${i}][session.title][like]=${encodeURIComponent(value)}`).join('&')

async function timed(path: string, who: string): Promise<{ status: number; ms: number; body: unknown }> {
  const started = performance.now()
  const res = await rest('GET', path, tokens[who])
  const body = await res.json().catch(() => null)
  return { status: res.status, ms: performance.now() - started, body }
}

const message = (body: unknown) => JSON.stringify(body)

describe.skipIf(!dockerOk)('a filter through a relation has a bounded cost (real Postgres, 20 000 rows)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-relation-bounds-${process.pid}`, 'relation_bounds')
    payload = await bootPayload(pg.url, 'relation-bounds-secret')
    config = await (await import('@payload-config')).default
    await pg.db.execute(sql.raw(`
      INSERT INTO users (id, email, is_platform_admin) VALUES
        (${BEN}, 'ben@example.invalid', false), (${ANA}, 'ana@example.invalid', false),
        (${PLATFORM}, 'platform@example.invalid', true);
      INSERT INTO organizations (id, name, slug) VALUES (1, 'Uno', 'uno');
      INSERT INTO memberships (user_id, organization_id, role) VALUES (${BEN}, 1, 'member'), (${ANA}, 1, 'member');
      INSERT INTO sessions (id, user_id, organization_id, title)
        SELECT g, ${BEN}, 1, 'b' || lpad(g::text, 5, '0') FROM generate_series(1, ${SESSIONS}) g;
      INSERT INTO messages (id, session_id, role, content)
        SELECT g, g, 'assistant', 'respuesta ' || g FROM generate_series(1, ${RATED}) g;
      INSERT INTO ratings (id, message_id, session_id, organization_id, user_id, stars)
        SELECT g, g, g, 1, ${BEN}, 4 FROM generate_series(1, ${RATED}) g;
    `))
    for (const t of ['users', 'organizations', 'memberships', 'sessions', 'messages', 'ratings']) {
      await pg.db.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), ${SESSIONS + 1000})`))
    }
    for (const id of [BEN, ANA, PLATFORM]) {
      await payload.update({ collection: 'users', id, overrideAccess: true, data: { password: PASSWORD } as never })
    }
    tokens.ben = await login('ben@example.invalid')
    tokens.ana = await login('ana@example.invalid')
    tokens.platform = await login('platform@example.invalid')
  }, 180_000)

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  afterEach(() => {
    delete process.env.QUERY_RELATION_MAX_TERMS
    delete process.env.QUERY_RELATION_MAX_IDS
    delete process.env.QUERY_RELATION_MAX_CONCURRENT_PER_USER
    delete process.env.QUERY_RELATION_RATELIMIT_USER_MAX
    vi.restoreAllMocks()
    resetRateLimits()
  })

  it('🔴 10 and 40 crossing terms answer 400 at once, naming the limit', async () => {
    for (const terms of [10, 40]) {
      const res = await timed(`/api/ratings?depth=0&${orTerms(terms)}`, 'ben')
      expect(res.status, `${terms} terms`).toBe(400)
      expect(message(res.body), `${terms} terms`).toMatch(/too many filters through a relationship/i)
      expect(res.ms, `${terms} terms`).toBeLessThan(QUICK_MS)
    }
    // `/count` and the nested spelling take the same path.
    const nested = Array.from({ length: 10 }, (_, i) => `where[or][${i}][session][title][like]=b`).join('&')
    expect((await rest('GET', `/api/ratings/count?${nested}`, tokens.ben)).status).toBe(400)
  }, 60_000)

  it('🔴 one term whose readable rows pass the id cap answers 400, not a 500', async () => {
    const res = await timed(`/api/ratings?depth=0&${orTerms(1)}`, 'ben')
    expect(res.status).toBe(400)
    expect(message(res.body)).toMatch(/matches too many rows/i)
    expect(res.ms).toBeLessThan(QUICK_MS)
  }, 60_000)

  it('the caps are env-tunable, and the boundary itself passes', async () => {
    process.env.QUERY_RELATION_MAX_IDS = '11'
    // `b000`: b00001 … b00099, 99 rows.
    expect((await rest('GET', '/api/ratings?depth=0&where[session.title][like]=b000', tokens.ben)).status).toBe(400)
    // `b00001`, and `b0001`: b00010 … b00019. 11 rows in all, exactly the cap.
    const exact = 'where[or][0][session.title][equals]=b00001&where[or][1][session.title][like]=b0001'
    const ok = await rest('GET', `/api/ratings?depth=0&${exact}`, tokens.ben)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { totalDocs: number }).totalDocs).toBe(1)
    process.env.QUERY_RELATION_MAX_TERMS = '1'
    expect((await rest('GET', `/api/ratings?depth=0&${exact}`, tokens.ben)).status).toBe(400)
  }, 60_000)

  it("the web's filters and a few crossing terms still answer", async () => {
    // The web sends no crossing term (grep of `apps/web/src`, 2026-11-10): ids only.
    const own = await rest('GET', `/api/ratings?depth=0&where[and][0][session][equals]=1&where[and][1][user][equals]=${BEN}`, tokens.ben)
    expect(((await own.json()) as { totalDocs: number }).totalDocs).toBe(1)
    // Up to the term cap, each under the id cap, still filters.
    const five = Array.from({ length: 5 }, (_, i) => `where[or][${i}][session.title][equals]=b0000${i + 1}`).join('&')
    const res = await rest('GET', `/api/ratings?depth=0&${five}`, tokens.ben)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { totalDocs: number }).totalDocs).toBe(RATED)
    // A deeper hop counts each lookup: `message.session.title` is two.
    const deep = await rest('GET', `/api/ratings?depth=0&where[message.session.title][equals]=b00002`, tokens.ben)
    expect(((await deep.json()) as { totalDocs: number }).totalDocs).toBe(1)
  }, 60_000)

  it('🔴 one member\'s requests at once past the cap: 429 with Retry-After, never a 500 (D2)', async () => {
    process.env.QUERY_RELATION_MAX_CONCURRENT_PER_USER = '1'
    const edge = Array.from({ length: 5 }, (_, i) => `where[or][${i}][session.title][like]=b0${i + 1}`).join('&')
    const res = await Promise.all(Array.from({ length: 6 }, () => rest('GET', `/api/ratings?depth=0&${edge}`, tokens.ben)))
    const statuses = res.map((r) => r.status)
    expect(statuses.every((s) => s === 200 || s === 429), String(statuses)).toBe(true)
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1)
    const refused = res.find((r) => r.status === 429)
    expect(refused, String(statuses)).toBeDefined()
    expect(refused!.headers.get('retry-after')).toBe('1')
    // Another member is not held by them, and the slot came back.
    expect((await rest('GET', `/api/ratings?depth=0&${orTerms(1, 'b00001')}`, tokens.ana)).status).toBe(200)
    expect((await rest('GET', `/api/ratings?depth=0&${orTerms(1, 'b00001')}`, tokens.ben)).status).toBe(200)
    // A deeper hop runs its own lookup under the request's one slot.
    const deep = await rest('GET', '/api/ratings?depth=0&where[message.session.title][equals]=b00002', tokens.ben)
    expect(((await deep.json()) as { totalDocs: number }).totalDocs).toBe(1)
  }, 60_000)

  it('🔴 the slot is held through the main query, not only the lookups (D2 leftover)', async () => {
    // Hold the `ratings` query itself (the one with the resolved `in` lists); the lookups on `sessions` run.
    const db = payload.db as unknown as { find: (args: { collection: string }) => Promise<unknown> }
    const original = db.find.bind(db)
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    let waiting = 0
    vi.spyOn(db, 'find').mockImplementation(async (args) => {
      if (args.collection === 'ratings') {
        waiting++
        await gate
      }
      return original(args)
    })
    const path = `/api/ratings?depth=0&${orTerms(1, 'b00001')}`
    const held = [rest('GET', path, tokens.ben), rest('GET', path, tokens.ben)]
    while (waiting < 2) await new Promise((r) => setTimeout(r, 10))
    expect(relationSlotsHeld(BEN)).toBe(2)
    const third = await rest('GET', path, tokens.ben)
    expect(third.status).toBe(429)
    open()
    expect((await Promise.all(held)).map((r) => r.status)).toEqual([200, 200])
    expect(relationSlotsHeld(BEN)).toBe(0)
  }, 60_000)

  it('🔴 the slot comes back when the operation fails after its lookups: a 400, a throw (D2 leftover)', async () => {
    // A path Payload refuses after the hook ran: 400 from its own validation.
    const bad = await rest('GET', `/api/ratings?depth=0&${orTerms(1, 'b00001')}&where[nope][equals]=1`, tokens.ben)
    expect(bad.status).toBe(400)
    expect(relationSlotsHeld(BEN)).toBe(0)
    // The main query throws (a timeout, the database going away).
    const db = payload.db as unknown as { find: (args: { collection: string }) => Promise<unknown> }
    const original = db.find.bind(db)
    vi.spyOn(db, 'find').mockImplementation(async (args) => {
      if (args.collection === 'ratings') throw new Error('canceling statement due to statement timeout')
      return original(args)
    })
    const res = await Promise.all([0, 1, 2].map(() => rest('GET', `/api/ratings?depth=0&${orTerms(1, 'b00001')}`, tokens.ben)))
    expect(res.map((r) => r.status)).toContain(500)
    expect(relationSlotsHeld(BEN)).toBe(0)
    vi.restoreAllMocks()
    // And the person is not locked out.
    expect((await rest('GET', `/api/ratings?depth=0&${orTerms(1, 'b00001')}`, tokens.ben)).status).toBe(200)
  }, 60_000)

  it('🔴 past the per-minute budget: 429 with Retry-After (D2)', async () => {
    process.env.QUERY_RELATION_RATELIMIT_USER_MAX = '2'
    const path = `/api/ratings?depth=0&${orTerms(1, 'b00001')}`
    expect((await rest('GET', path, tokens.ben)).status).toBe(200)
    expect((await rest('GET', path, tokens.ben)).status).toBe(200)
    const third = await rest('GET', path, tokens.ben)
    expect(third.status).toBe(429)
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('a 400 past a cap is logged at warn, without a stack; other errors keep their level', async () => {
    const warn = vi.spyOn(payload.logger, 'warn')
    const error = vi.spyOn(payload.logger, 'error')
    expect((await rest('GET', `/api/ratings?depth=0&${orTerms(1)}`, tokens.ben)).status).toBe(400)
    expect((await rest('GET', `/api/ratings?depth=0&${orTerms(10)}`, tokens.ben)).status).toBe(400)
    expect(error).not.toHaveBeenCalled()
    const logged = warn.mock.calls.map((c) => (c[0] as { err?: Error }).err).filter((e) => e?.name === 'RelationFilterTooBroad')
    expect(logged).toHaveLength(2)
    for (const err of logged) expect(err!.stack).not.toMatch(/\n\s+at /)
    expect(config.loggingLevels).toMatchObject({ Forbidden: 'info', NotFound: 'info', ValidationError: 'info' })
    expect(config.loggingLevels.QueryError).toBeUndefined()
  }, 60_000)

  it('a platform admin is not bounded: the hook does not run for them', async () => {
    const res = await rest('GET', `/api/ratings?depth=0&${orTerms(10)}`, tokens.platform)
    expect(res.status).toBe(200)
  }, 60_000)

  it.runIf(process.env.EDC_MEASURE_RELATION_BOUNDS === '1')('measure: request time, a concurrent /me, the event loop', async () => {
    const lines: string[] = []
    const probe = async (label: string, path: string, who: string) => {
      const h = monitorEventLoopDelay({ resolution: 10 })
      h.enable()
      const big = timed(path, who)
      await new Promise((r) => setTimeout(r, 100))
      const me = timed('/api/users/me', 'ana')
      const [b, m] = await Promise.all([big, me])
      h.disable()
      lines.push(`${label}: HTTP${b.status} ${b.ms.toFixed(0)} ms; /me ${m.ms.toFixed(0)} ms; loop max ${(h.max / 1e6).toFixed(0)} ms, p99 ${(h.percentile(99) / 1e6).toFixed(0)} ms`)
    }
    for (const terms of [10, 40]) await probe(`${terms} terms, member`, `/api/ratings?depth=0&${orTerms(terms)}`, 'ben')
    await probe('1 term over the id cap, member', `/api/ratings?depth=0&${orTerms(1)}`, 'ben')
    await probe('10 terms, platform admin', `/api/ratings?depth=0&${orTerms(10)}`, 'platform')
    // The most a member can still ask under the default caps: 5 terms of 1000
    // rows each (`b01` … `b05`: b01000 … b05999), 5000 ids in all.
    const edge = Array.from({ length: 5 }, (_, i) => `where[or][${i}][session.title][like]=b0${i + 1}`).join('&')
    await probe('5 terms, 5000 ids in all, member', `/api/ratings?depth=0&${edge}`, 'ben')
    // One term of 9999 ids (`b0`), the cap raised to let it through.
    process.env.QUERY_RELATION_MAX_IDS = '10000'
    await probe('1 term, 9999 ids, cap raised, member', '/api/ratings?depth=0&where[session.title][like]=b0', 'ben')
    process.stdout.write(`\n[relation bounds] ${lines.join('\n[relation bounds] ')}\n`)
  }, 300_000)

  it.runIf(process.env.EDC_MEASURE_RELATION_BOUNDS === '1')('measure: 20 requests at once from one member (D2)', async () => {
    const lines: string[] = []
    const edge = Array.from({ length: 5 }, (_, i) => `where[or][${i}][session.title][like]=b0${i + 1}`).join('&')
    const burst = async (label: string, path: string) => {
      resetRateLimits()
      const h = monitorEventLoopDelay({ resolution: 10 })
      h.enable()
      const all = Promise.all(Array.from({ length: 20 }, () => timed(path, 'ben')))
      await new Promise((r) => setTimeout(r, 100))
      const me = timed('/api/users/me', 'ana')
      const [rs, m] = await Promise.all([all, me])
      h.disable()
      const statuses: Record<number, number> = {}
      for (const r of rs) statuses[r.status] = (statuses[r.status] ?? 0) + 1
      const slowest = Math.max(...rs.map((r) => r.ms))
      lines.push(`${label}: ${JSON.stringify(statuses)}, slowest ${slowest.toFixed(0)} ms; /me ${m.ms.toFixed(0)} ms; loop max ${(h.max / 1e6).toFixed(0)} ms`)
    }
    await burst('20 at the caps (5 terms x 1000 ids)', `/api/ratings?depth=0&${edge}`)
    await burst('20 over the id cap (1 term, 20000 ids)', `/api/ratings?depth=0&${orTerms(1)}`)
    await burst('20 /count at the caps', `/api/ratings/count?${edge}`)
    for (let i = 0; i < 3; i++) {
      resetRateLimits()
      const one = await timed(`/api/ratings?depth=0&${orTerms(1)}`, 'ben')
      lines.push(`1 over the id cap, alone: HTTP${one.status} ${one.ms.toFixed(0)} ms`)
    }
    process.stdout.write(`\n[relation burst] ${lines.join('\n[relation burst] ')}\n`)
  }, 300_000)

  it.runIf(process.env.EDC_MEASURE_RELATION_BOUNDS === '1')('measure: one member retrying every 429 at once (D2 leftover)', async () => {
    // Twenty loops that resend on a 429 with no pause: whatever the slot does not
    // cover runs alongside the next request's lookups. 30 requests in all (the
    // per-minute budget); `/me` from another member is sent every 50 ms.
    const lines: string[] = []
    const edge = Array.from({ length: 5 }, (_, i) => `where[or][${i}][session.title][like]=b0${i + 1}`).join('&')
    for (const [label, path] of [
      ['at the caps (5 terms x 1000 ids)', `/api/ratings?depth=0&${edge}`],
      ['/count at the caps', `/api/ratings/count?${edge}`],
    ] as const) {
      resetRateLimits()
      let left = 30
      let refused = 0
      const h = monitorEventLoopDelay({ resolution: 10 })
      h.enable()
      const started = performance.now()
      const loop = async () => {
        while (left > 0) {
          const r = await timed(path, 'ben')
          if (r.status === 429) refused++
          else left--
        }
      }
      const loops = Promise.all(Array.from({ length: 20 }, loop))
      const me: number[] = []
      let done = false
      void loops.then(() => (done = true))
      while (!done) {
        me.push((await timed('/api/users/me', 'ana')).ms)
        await new Promise((r) => setTimeout(r, 50))
      }
      await loops
      h.disable()
      me.sort((a, b) => a - b)
      lines.push(`${label}: 30 answered in ${(performance.now() - started).toFixed(0)} ms, ${refused} refused on the way; /me n=${me.length} median ${me[Math.floor(me.length / 2)]!.toFixed(0)} ms, max ${me[me.length - 1]!.toFixed(0)} ms; loop max ${(h.max / 1e6).toFixed(0)} ms`)
    }
    process.stdout.write(`\n[relation retry] ${lines.join('\n[relation retry] ')}\n`)
  }, 300_000)
})
