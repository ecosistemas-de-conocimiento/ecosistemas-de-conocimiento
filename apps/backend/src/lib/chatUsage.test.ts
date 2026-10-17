import { describe, expect, it } from 'vitest'

import {
  chatUsage,
  parseMessageRow,
  summarizeUsage,
  utcDay,
  USAGE_PAGE_SIZE,
  type UsageMessageRow,
} from './chatUsage'
import { EcosystemNotVisibleError } from './ecosystemMetrics'

/**
 * Three promises, all load-bearing:
 *
 *   1. THE NUMBERS ARE THE ECOSISTEMA'S TOTAL, not the caller's own chats. The
 *      reads are elevated for exactly that reason.
 *   2. ONLY ADMINS OF THAT ECOSISTEMA (or platform admins) MAY ASK. Cost and
 *      activity are administration, not something every member needs.
 *   3. NOTHING SAID IN A CONVERSATION COMES BACK. The fake below hands the code
 *      full message rows — content, provenance, a title — exactly as a widened
 *      `select` would, and the response is checked for every one of them.
 */

// ---------------------------------------------------------------------------
// A fake Payload
// ---------------------------------------------------------------------------

type Call = { collection: string; where: unknown; overrideAccess: unknown; select?: unknown; page?: unknown }

const SECRET_CONTENT = 'El presupuesto participativo es de 1,250,000 pesos.'
const SECRET_PROVENANCE = 'Acta de la sesión del cabildo'
const SECRET_TITLE = '¿Cuánto cobra la regidora?'
const SECRET_TRACE = '66e8dd07-0008-461a-aebd-1f8214a55eaf'

interface World {
  organizations: Record<string, { id: number; name: string; slug: string }>
  /** user id → [orgId, role] memberships. */
  memberships: Record<string, Array<[number, string]>>
  sessions?: number
  /** Raw message rows the elevated read returns, CONTENT INCLUDED. */
  messages?: Array<Record<string, unknown>>
}

const makePayload = (world: World) => {
  const counted: Call[] = []
  const found: Call[] = []

  const payload = {
    count: async ({ collection, where, overrideAccess }: Call) => {
      counted.push({ collection, where, overrideAccess })
      return { totalDocs: collection === 'sessions' ? (world.sessions ?? 0) : 0 }
    },
    find: async (args: Call & { limit?: number }) => {
      const { collection, where } = args
      found.push(args)

      if (collection === 'organizations') {
        const clauses = (where as { and?: Array<Record<string, never>> })?.and ?? []
        const idClause = clauses.find((c) => 'id' in c) as
          | { id?: { equals?: unknown; in?: unknown[] } }
          | undefined
        if (idClause?.id?.equals !== undefined) {
          const org = world.organizations[String(idClause.id.equals)]
          return { docs: org ? [{ ...org, isActive: true }] : [], hasNextPage: false }
        }
        const ids = (idClause?.id?.in ?? []).map(String)
        return {
          docs: ids
            .map((id) => world.organizations[id])
            .filter(Boolean)
            .map((org) => ({ ...org, isActive: true })),
          hasNextPage: false,
        }
      }

      if (collection === 'memberships') {
        const clauses = (where as { and?: Array<Record<string, never>> })?.and ?? []
        const userClause = clauses.find((c) => 'user' in c) as { user?: { equals?: unknown } } | undefined
        const rows = world.memberships[String(userClause?.user?.equals)] ?? []
        return {
          docs: rows.map(([organization, role], i) => ({
            id: i + 1,
            user: userClause?.user?.equals,
            organization,
            role,
            isActive: true,
          })),
          hasNextPage: false,
        }
      }

      if (collection === 'messages') {
        const all = world.messages ?? []
        const page = Number(args.page ?? 1)
        const limit = Number(args.limit ?? USAGE_PAGE_SIZE)
        const docs = all.slice((page - 1) * limit, page * limit)
        return { docs, hasNextPage: page * limit < all.length }
      }

      return { docs: [], hasNextPage: false }
    },
  }

  return { payload: payload as never, counted, found }
}

const ACME = { id: 7, name: 'Acme', slug: 'acme' }
const OTRO = { id: 9, name: 'Otro', slug: 'otro' }

/** A raw `messages` row exactly as Payload would hand it back, unredacted. */
const rawMessage = (over: Record<string, unknown> = {}) => ({
  id: 61,
  session: { id: 57, title: SECRET_TITLE, user: 3, organization: 7 },
  role: 'assistant',
  content: SECRET_CONTENT,
  provenance: { chunks: [{ text: SECRET_PROVENANCE }] },
  createdAt: '2026-08-27T21:55:55.137Z',
  generationMeta: {
    costUsd: 0.00035317,
    traceId: SECRET_TRACE,
    provider: 'openrouter',
    modelUsed: 'deepseek/deepseek-chat-v3.1',
  },
  ...over,
})

const world = (over: Partial<World> = {}): World => ({
  organizations: { '7': ACME, '9': OTRO },
  memberships: {
    '100': [[7, 'member']],
    '101': [[7, 'investigador']],
    '102': [[7, 'admin']],
    '103': [[7, 'owner']],
    '104': [[9, 'admin']],
  },
  sessions: 3,
  messages: [
    rawMessage({ role: 'user', generationMeta: null, createdAt: '2026-08-27T21:55:00.000Z' }),
    rawMessage(),
  ],
  ...over,
})

const platformAdmin = { id: 1, isPlatformAdmin: true, isActive: true }
const member = { id: 100, isActive: true }
const investigador = { id: 101, isActive: true }
const orgAdmin = { id: 102, isActive: true }
const owner = { id: 103, isActive: true }
const otherOrgAdmin = { id: 104, isActive: true }

const run = (w: World, user: unknown, organizationId: number | string = 7) => {
  const { payload, counted, found } = makePayload(w)
  return { counted, found, result: chatUsage({ payload, organizationId, user }) }
}

// ---------------------------------------------------------------------------
// Who may ask
// ---------------------------------------------------------------------------

describe('who may ask for an ecosistema’s chat usage', () => {
  it('a platform admin may, without being a member', async () => {
    await expect(run(world({ memberships: {} }), platformAdmin).result).resolves.toMatchObject({
      ecosystem: { id: '7', name: 'Acme' },
    })
  })

  it('an admin of that ecosistema may', async () => {
    await expect(run(world(), orgAdmin).result).resolves.toBeTruthy()
  })

  it('an owner of that ecosistema may — owner outranks admin', async () => {
    await expect(run(world(), owner).result).resolves.toBeTruthy()
  })

  it('🔴 a plain member of that ecosistema may NOT', async () => {
    await expect(run(world(), member).result).rejects.toBeInstanceOf(EcosystemNotVisibleError)
  })

  it('🔴 an investigador of that ecosistema may NOT', async () => {
    await expect(run(world(), investigador).result).rejects.toBeInstanceOf(EcosystemNotVisibleError)
  })

  it('🔴 an admin of ANOTHER ecosistema may NOT', async () => {
    await expect(run(world(), otherOrgAdmin).result).rejects.toBeInstanceOf(EcosystemNotVisibleError)
  })

  it('🔴 a deactivated platform admin may NOT', async () => {
    await expect(
      run(world(), { ...platformAdmin, isActive: false }).result,
    ).rejects.toBeInstanceOf(EcosystemNotVisibleError)
  })

  it('nobody signed in, an unknown or a malformed ecosistema are refused', async () => {
    await expect(run(world(), null).result).rejects.toBeInstanceOf(EcosystemNotVisibleError)
    await expect(run(world(), platformAdmin, 404).result).rejects.toBeInstanceOf(EcosystemNotVisibleError)
  })

  it('🔴 refusals are indistinguishable, and nothing is read before the gate passes', async () => {
    const refusals = [
      run(world(), member),
      run(world(), otherOrgAdmin),
      run(world(), orgAdmin, 404),
    ]
    const messages = await Promise.all(
      refusals.map(({ result }) => result.then(() => 'resolved', (e: Error) => e.message)),
    )
    expect(new Set(messages).size).toBe(1)
    for (const { counted, found } of refusals) {
      expect(counted).toEqual([])
      expect(found.filter((c) => c.collection === 'messages' || c.collection === 'sessions')).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

/** Every `path → string` leaf in a JSON value. */
const stringLeaves = (value: unknown, path = ''): Array<[string, string]> => {
  if (typeof value === 'string') return [[path, value]]
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, `${path}[${i}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, path ? `${path}.${k}` : k))
  }
  return []
}

describe('🔴 no conversation text ever reaches the response', () => {
  it('contains no free-text field — only the echo, model/provider names, days and timestamps', async () => {
    const body = JSON.parse(JSON.stringify(await run(world(), orgAdmin).result))
    const ALLOWED = [
      /^ecosystem\.(id|name|slug)$/,
      /^usage\.(models|providers)\[\d+\]\.name$/,
      /^usage\.daily\[\d+\]\.day$/,
      /^usage\.(firstAt|lastAt)$/,
    ]
    const leaves = stringLeaves(body)
    expect(leaves.length).toBeGreaterThan(0)
    for (const [path] of leaves) {
      expect(ALLOWED.some((re) => re.test(path)), `unexpected text at ${path}`).toBe(true)
    }
  })

  it('🔴 drops content, provenance, title and trace id even when the read returns them', async () => {
    const serialized = JSON.stringify(await run(world(), platformAdmin).result)
    for (const secret of [SECRET_CONTENT, SECRET_PROVENANCE, SECRET_TITLE, SECRET_TRACE]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('🔴 never asks the database for content, provenance or a title', async () => {
    const { found, result } = run(world(), orgAdmin)
    await result
    const reads = found.filter((c) => c.collection === 'messages')
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) {
      expect(read.select).toEqual({ session: true, role: true, generationMeta: true, createdAt: true })
    }
    expect(found.some((c) => c.collection === 'sessions')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

describe('the reads', () => {
  it('🔴 are elevated — the caller’s own rules are what under-count', async () => {
    const { found, counted, result } = run(world(), orgAdmin)
    await result
    const usageReads = [
      ...counted,
      ...found.filter((c) => c.collection === 'messages'),
    ]
    expect(usageReads.length).toBeGreaterThan(0)
    for (const read of usageReads) expect(read.overrideAccess).toBe(true)
  })

  it('🔴 are scoped to the one ecosistema asked for, messages through their session', async () => {
    const { found, counted, result } = run(world(), orgAdmin)
    await result
    expect(counted).toEqual([
      { collection: 'sessions', where: { organization: { equals: 7 } }, overrideAccess: true },
    ])
    for (const read of found.filter((c) => c.collection === 'messages')) {
      expect(read.where).toEqual({ 'session.organization': { equals: 7 } })
    }
  })

  it('reads every page, so the totals are totals and not a prefix', async () => {
    const many = Array.from({ length: USAGE_PAGE_SIZE + 3 }, (_, i) =>
      rawMessage({ id: i, session: (i % 5) + 1 }),
    )
    const { found, result } = run(world({ messages: many, sessions: 5 }), orgAdmin)
    const usage = await result
    expect(found.filter((c) => c.collection === 'messages').length).toBe(2)
    expect(usage.usage.messages).toBe(USAGE_PAGE_SIZE + 3)
    expect(usage.usage.conversations).toBe(5)
  })

  it('counts the ecosistema’s conversations, including ones with no turns', async () => {
    const usage = await run(world(), orgAdmin).result
    expect(usage.usage.conversations).toBe(3)
    expect(usage.usage.conversationsWithMessages).toBe(1)
    expect(usage.usage.messages).toBe(2)
    expect(usage.usage.costUsd).toBeCloseTo(0.00035317)
  })
})

// ---------------------------------------------------------------------------
// The parse boundary
// ---------------------------------------------------------------------------

describe('parseMessageRow', () => {
  it('🔴 keeps no field that content could land in', () => {
    const row = parseMessageRow(rawMessage())!
    expect(Object.keys(row).sort()).toEqual(['costUsd', 'createdAt', 'model', 'provider', 'role', 'sessionId'])
    const serialized = JSON.stringify(row)
    for (const secret of [SECRET_CONTENT, SECRET_PROVENANCE, SECRET_TITLE, SECRET_TRACE]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('keeps the telemetry, and reads a populated session as its id', () => {
    expect(parseMessageRow(rawMessage())).toMatchObject({
      sessionId: '57',
      role: 'assistant',
      costUsd: 0.00035317,
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat-v3.1',
    })
  })

  it('C-6: adds the query-expansion call\'s cost to the answer\'s', () => {
    const row = parseMessageRow({
      session: 5,
      role: 'assistant',
      generationMeta: { costUsd: 0.003, expansionCostUsd: 0.0002 },
    })!
    expect(row.costUsd).toBeCloseTo(0.0032, 10)
  })

  it('C-6: an expansion cost alone does not price an answer that has no cost', () => {
    const row = parseMessageRow({ session: 5, role: 'assistant', generationMeta: { expansionCostUsd: 0.0002 } })!
    expect(row.costUsd).toBeNull()
  })

  it('tolerates a turn with no telemetry at all — user turns have none', () => {
    expect(parseMessageRow({ session: 5, role: 'user', createdAt: 'x' })).toMatchObject({
      costUsd: null,
      provider: null,
      model: null,
    })
  })

  it('rejects a negative or non-numeric cost rather than summing garbage', () => {
    expect(parseMessageRow({ session: 5, generationMeta: { costUsd: -3 } })!.costUsd).toBeNull()
    expect(parseMessageRow({ session: 5, generationMeta: { costUsd: '0.01' } })!.costUsd).toBeNull()
  })

  it('drops a turn with no session — it cannot be attributed to an ecosistema', () => {
    expect(parseMessageRow({ role: 'user', content: 'hola' })).toBeNull()
    expect(parseMessageRow(null)).toBeNull()
  })

  it('falls back to "user" for an unknown role rather than dropping the turn', () => {
    expect(parseMessageRow({ session: 5, role: 'tool' })!.role).toBe('user')
  })
})

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

describe('summarizeUsage', () => {
  const msg = (over: Partial<UsageMessageRow>): UsageMessageRow => ({
    sessionId: '1',
    role: 'user',
    createdAt: '2026-08-01T10:00:00.000Z',
    costUsd: null,
    provider: null,
    model: null,
    ...over,
  })

  const priced = (over: Partial<UsageMessageRow>): UsageMessageRow =>
    msg({ role: 'assistant', costUsd: 0.001, provider: 'openrouter', model: 'a/b', ...over })

  it('counts nothing as nothing, without dividing by zero', () => {
    const s = summarizeUsage(0, [])
    expect(s.conversations).toBe(0)
    expect(s.turnsPerConversation).toBeNull()
    expect(s.costPerTurn).toBeNull()
    expect(s.spans.averageSeconds).toBeNull()
    expect(s.costIsComplete).toBe(true)
  })

  it('counts a conversation with no turns as a conversation', () => {
    const s = summarizeUsage(1, [])
    expect(s.conversations).toBe(1)
    expect(s.conversationsWithMessages).toBe(0)
  })

  it('splits user turns from answers, and averages turns per conversation', () => {
    const s = summarizeUsage(2, [
      msg({ sessionId: '1' }),
      priced({ sessionId: '1', createdAt: '2026-08-01T10:00:20.000Z' }),
      msg({ sessionId: '2' }),
    ])
    expect(s.userTurns).toBe(2)
    expect(s.assistantTurns).toBe(1)
    expect(s.turnsPerConversation).toBe(1.5)
  })

  it('sums cost, and reports it as a FLOOR when an answer had no telemetry', () => {
    const s = summarizeUsage(1, [priced({}), msg({ role: 'assistant' })])
    expect(s.costUsd).toBeCloseTo(0.001)
    expect(s.pricedTurns).toBe(1)
    expect(s.unpricedTurns).toBe(1)
    expect(s.costIsComplete).toBe(false)
  })

  it('does not count a user turn as a missing cost — user turns are free', () => {
    const s = summarizeUsage(1, [msg({}), priced({})])
    expect(s.unpricedTurns).toBe(0)
    expect(s.costIsComplete).toBe(true)
    expect(s.costPerTurn).toBeCloseTo(0.001)
  })

  it('measures a span from the first turn to the last, per conversation', () => {
    const s = summarizeUsage(1, [
      msg({ sessionId: '1', createdAt: '2026-08-01T10:00:00.000Z' }),
      priced({ sessionId: '1', createdAt: '2026-08-01T10:02:00.000Z' }),
    ])
    expect(s.spans).toEqual({ measured: 1, totalSeconds: 120, averageSeconds: 120, longestSeconds: 120 })
  })

  it('⚠ excludes one-turn conversations from the span average', () => {
    const s = summarizeUsage(2, [
      msg({ sessionId: '1', createdAt: '2026-08-01T10:00:00.000Z' }),
      priced({ sessionId: '1', createdAt: '2026-08-01T10:01:00.000Z' }),
      msg({ sessionId: '2', createdAt: '2026-08-01T10:00:00.000Z' }),
    ])
    expect(s.spans.measured).toBe(1)
    expect(s.spans.averageSeconds).toBe(60)
  })

  it('breaks traffic down by model and provider, busiest first', () => {
    const s = summarizeUsage(1, [
      priced({ model: 'x/slow', costUsd: 0.01 }),
      priced({ model: 'x/fast' }),
      priced({ model: 'x/fast' }),
    ])
    expect(s.models.map((m) => m.name)).toEqual(['x/fast', 'x/slow'])
    expect(s.models[0]).toMatchObject({ turns: 2, share: 67 })
    expect(s.models[1]!.costUsd).toBeCloseTo(0.01)
    expect(s.providers).toEqual([{ name: 'openrouter', turns: 3, costUsd: 0.012, share: 100 }])
  })

  it('files each conversation on the day of its EARLIEST turn, not every day', () => {
    const s = summarizeUsage(1, [
      msg({ sessionId: '1', createdAt: '2026-08-01T23:00:00.000Z' }),
      priced({ sessionId: '1', createdAt: '2026-08-02T01:00:00.000Z' }),
    ])
    expect(s.daily.map((d) => [d.day, d.conversations, d.messages])).toEqual([
      ['2026-08-01', 1, 1],
      ['2026-08-02', 0, 1],
    ])
  })

  it('reports the first and last turn it saw, in order', () => {
    const s = summarizeUsage(1, [
      priced({ createdAt: '2026-08-05T10:00:00.000Z' }),
      msg({ createdAt: '2026-08-01T10:00:00.000Z' }),
    ])
    expect(s.firstAt).toBe('2026-08-01T10:00:00.000Z')
    expect(s.lastAt).toBe('2026-08-05T10:00:00.000Z')
  })

  it('survives an unparseable timestamp without losing the turn', () => {
    const s = summarizeUsage(1, [msg({ createdAt: 'nunca' })])
    expect(s.messages).toBe(1)
    expect(s.daily).toEqual([])
    expect(s.firstAt).toBeNull()
  })

  it('never reports fewer conversations than it has groups of messages for', () => {
    expect(summarizeUsage(0, [msg({ sessionId: '9' })]).conversations).toBe(1)
  })
})

describe('utcDay', () => {
  it('reduces a timestamp to its UTC day, or null', () => {
    expect(utcDay('2026-08-27T21:55:55.137Z')).toBe('2026-08-27')
    expect(utcDay('nunca')).toBeNull()
    expect(utcDay(null)).toBeNull()
  })
})
