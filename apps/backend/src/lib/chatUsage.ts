/**
 * ONE ECOSISTEMA'S CHAT USAGE — conversations, turns, cost, timings, models.
 * NEVER WHAT WAS SAID.
 *
 * ── 🔴 WHY THIS RUNS IN THE BACKEND ──────────────────────────────────────────
 *
 * Same reason as `ecosystemMetrics.ts` (read its header first): `Sessions.read`
 * is own-only and `Messages.read` is own-via-session, so the web BFF reading
 * these lists as an admin gets the ADMIN'S OWN conversations back, not the
 * ecosistema's. The owner wants the ecosistema's total usage and cost, so the
 * read happens here, elevated, and only an aggregate leaves.
 *
 * ── 🔴 THIS FILE DOES AN ELEVATED `find` OF MESSAGES. THE RULES THAT MAKE THAT SAFE ──
 *
 * `ecosystemMetrics` gets away with `count` only. Cost, models and timings need
 * per-turn telemetry, so this file reads message ROWS with `overrideAccess`.
 * Three independent doors keep the text out:
 *
 *   1. `MESSAGE_SELECT` names `session`, `role`, `generationMeta`, `createdAt`.
 *      `content` and `provenance` (retrieved chunks — document text, drafts
 *      included) are never asked for, and `depth: 0` keeps the session's
 *      `title` from being populated.
 *   2. `parseMessageRow` builds a `UsageMessageRow`, which has NO FIELD content
 *      could land in. Even a future widened `select` cannot leak through it.
 *   3. What leaves is `ChatUsage`: numbers, plus model/provider names, UTC days
 *      and the first/last timestamps. No row, no id list, no trace id.
 *
 * ⚠ NEVER widen `ChatUsage` with a row, a sample, a session id, a trace id or a
 * "most recent conversation". If something needs rows, it needs its own
 * endpoint with its own access rules.
 *
 * ── 🔴 COST, NOT TOKENS ──────────────────────────────────────────────────────
 *
 * `generationMeta` carries `{ costUsd, traceId, provider, modelUsed }` — no
 * tokens. Tokens live in ai-service's `usage_logs`. Since each ecosistema is
 * its own ai-service org (`edc-eco-<id>`, see `aiClient.ts`), new rows there
 * ARE split per ecosistema — but ai-service has no endpoint that returns
 * tokens: `GET /v1/budget/:org` answers dollars only (limit, remaining,
 * spent). Rows written before the move stay under the old shared org. Cost
 * IS attributed per message here, so cost is what is reported until
 * ai-service exposes a per-org token read.
 *
 * ── WHO MAY ASK ──────────────────────────────────────────────────────────────
 *
 * Platform admins, and admins/owners OF THAT ECOSISTEMA. Unlike the tile
 * counts, spend and activity patterns are administration, not something every
 * member needs. Refusals are the same indistinguishable 404 as
 * `ecosystemMetrics` — see `resolveVisibleEcosystem`.
 */

import type { Payload, Where } from 'payload'

import { ecosystemEcho, resolveVisibleEcosystem, type EcosystemMetrics } from './ecosystemMetrics'
import { relationId } from './permissions'

type Id = number | string

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

/** A model or a provider, and how much traffic went through it. */
export interface UsageBreakdownRow {
  name: string
  turns: number
  costUsd: number
  /** Share of the generated turns, whole percent. Null when there were none. */
  share: number | null
}

/** One day of activity. `day` is `YYYY-MM-DD`, UTC. */
export interface UsageDayRow {
  day: string
  /** Conversations whose FIRST turn fell on this day. */
  conversations: number
  messages: number
  costUsd: number
}

/**
 * ⚠ WALL CLOCK BETWEEN THE FIRST AND LAST TURN — NOT TIME SPENT. One-turn
 * conversations are excluded from `measured`: they have nothing to measure.
 */
export interface UsageSpans {
  measured: number
  totalSeconds: number
  averageSeconds: number | null
  longestSeconds: number | null
}

export interface UsageSummary {
  /** Every conversation filed under the ecosistema, with or without turns. */
  conversations: number
  conversationsWithMessages: number
  messages: number
  userTurns: number
  assistantTurns: number
  /** Over conversations that have any turns. One decimal. */
  turnsPerConversation: number | null
  /** 🔴 A FLOOR, NOT A TOTAL, whenever `unpricedTurns > 0`. */
  costUsd: number
  pricedTurns: number
  /** Assistant turns with no cost telemetry. The hole in the total. */
  unpricedTurns: number
  costIsComplete: boolean
  costPerTurn: number | null
  spans: UsageSpans
  models: UsageBreakdownRow[]
  providers: UsageBreakdownRow[]
  /** Oldest first. Days with no activity are omitted. */
  daily: UsageDayRow[]
  firstAt: string | null
  lastAt: string | null
}

export interface ChatUsage {
  ecosystem: EcosystemMetrics['ecosystem']
  usage: UsageSummary
}

// ---------------------------------------------------------------------------
// The parse boundary
// ---------------------------------------------------------------------------

/**
 * 🔴 One turn, as metadata. There is no field for `content`, `provenance`, a
 * session title or a trace id — so none of them can survive past
 * `parseMessageRow`, whatever the read returned.
 */
export interface UsageMessageRow {
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  createdAt: string | null
  /** Null on user turns AND on answers whose telemetry never arrived. */
  costUsd: number | null
  provider: string | null
  model: string | null
}

/** The only message fields the elevated read asks for. See the file header. */
export const MESSAGE_SELECT = {
  session: true,
  role: true,
  generationMeta: true,
  createdAt: true,
} as const

/**
 * Rows per page of the elevated read. The read walks EVERY page — these are
 * totals, and an aggregate over a prefix is a wrong number, not a smaller one.
 */
export const USAGE_PAGE_SIZE = 500

const name = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/**
 * A raw `messages` row → `UsageMessageRow`. Rows with no session are dropped:
 * a turn that cannot be attributed to a conversation cannot be attributed to
 * an ecosistema either.
 */
export function parseMessageRow(raw: unknown): UsageMessageRow | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const session = relationId(row.session)
  if (session === null || session === '') return null
  const role =
    row.role === 'user' || row.role === 'assistant' || row.role === 'system' ? row.role : 'user'
  const meta =
    row.generationMeta && typeof row.generationMeta === 'object'
      ? (row.generationMeta as Record<string, unknown>)
      : null
  const cost = meta?.costUsd
  return {
    sessionId: String(session),
    role,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
    costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    provider: name(meta?.provider),
    model: name(meta?.modelUsed),
  }
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

/** `2026-08-27T21:55:55.137Z` → `2026-08-27`. Null when unparseable. */
export function utcDay(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
}

const share = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 100) : null

function breakdownRows(
  bucket: Map<string, { turns: number; costUsd: number }>,
  generatedTurns: number,
): UsageBreakdownRow[] {
  return [...bucket.entries()]
    .map(([key, v]) => ({ name: key, turns: v.turns, costUsd: v.costUsd, share: share(v.turns, generatedTurns) }))
    .sort((a, b) => b.turns - a.turns || a.name.localeCompare(b.name, 'es'))
}

/**
 * The chat, as administration: is anybody using it, what does it cost, on
 * which model, and are these one-shot questions or real back-and-forth.
 *
 * `sessionCount` is the ecosistema's conversation count, so conversations with
 * no turns still count — otherwise "conversaciones" would quietly mean
 * "conversaciones con mensajes", and the two differ exactly when something
 * has gone wrong.
 */
export function summarizeUsage(
  sessionCount: number,
  messages: readonly UsageMessageRow[],
): UsageSummary {
  const spanBySession = new Map<string, { first: number; last: number; count: number }>()
  const byModel = new Map<string, { turns: number; costUsd: number }>()
  const byProvider = new Map<string, { turns: number; costUsd: number }>()
  const byDay = new Map<string, UsageDayRow>()
  /** session id → the earliest day it was seen on. */
  const firstDayOf = new Map<string, string>()

  let userTurns = 0
  let assistantTurns = 0
  let costUsd = 0
  let pricedTurns = 0
  let unpricedTurns = 0
  let generatedTurns = 0
  let firstAt: string | null = null
  let lastAt: string | null = null

  const bump = (bucket: Map<string, { turns: number; costUsd: number }>, key: string, cost: number) => {
    const row = bucket.get(key) ?? { turns: 0, costUsd: 0 }
    row.turns += 1
    row.costUsd += cost
    bucket.set(key, row)
  }

  for (const m of messages) {
    if (m.role === 'user') userTurns += 1
    else if (m.role === 'assistant') assistantTurns += 1

    if (m.costUsd != null) {
      costUsd += m.costUsd
      pricedTurns += 1
    } else if (m.role === 'assistant') {
      // A user turn without a cost is normal; an answer without one is a hole.
      unpricedTurns += 1
    }

    if (m.model || m.provider) generatedTurns += 1
    if (m.model) bump(byModel, m.model, m.costUsd ?? 0)
    if (m.provider) bump(byProvider, m.provider, m.costUsd ?? 0)

    const at = m.createdAt
    const t = at ? Date.parse(at) : Number.NaN
    const span = spanBySession.get(m.sessionId) ?? { first: Number.NaN, last: Number.NaN, count: 0 }
    span.count += 1
    spanBySession.set(m.sessionId, span)
    if (Number.isNaN(t) || !at) continue

    span.first = Number.isNaN(span.first) ? t : Math.min(span.first, t)
    span.last = Number.isNaN(span.last) ? t : Math.max(span.last, t)
    if (!firstAt || at < firstAt) firstAt = at
    if (!lastAt || at > lastAt) lastAt = at

    const day = utcDay(at)
    if (day) {
      const row = byDay.get(day) ?? { day, conversations: 0, messages: 0, costUsd: 0 }
      row.messages += 1
      row.costUsd += m.costUsd ?? 0
      byDay.set(day, row)
      // ⚠ A conversation belongs to the day of its EARLIEST turn — otherwise one
      // long thread reads as a week of new conversations.
      const known = firstDayOf.get(m.sessionId)
      if (!known || day < known) firstDayOf.set(m.sessionId, day)
    }
  }

  for (const day of firstDayOf.values()) {
    const row = byDay.get(day)
    if (row) row.conversations += 1
  }

  let measured = 0
  let totalSeconds = 0
  let longestSeconds: number | null = null
  for (const span of spanBySession.values()) {
    if (span.count < 2 || Number.isNaN(span.first) || Number.isNaN(span.last)) continue
    const secs = Math.max(0, Math.round((span.last - span.first) / 1000))
    measured += 1
    totalSeconds += secs
    if (longestSeconds == null || secs > longestSeconds) longestSeconds = secs
  }

  const conversationsWithMessages = spanBySession.size

  return {
    // ⚠ `max`: a session created between the count and the read must not make
    // the page report fewer conversations than it has turns for.
    conversations: Math.max(sessionCount, conversationsWithMessages),
    conversationsWithMessages,
    messages: messages.length,
    userTurns,
    assistantTurns,
    turnsPerConversation: conversationsWithMessages
      ? Math.round((messages.length / conversationsWithMessages) * 10) / 10
      : null,
    costUsd,
    pricedTurns,
    unpricedTurns,
    costIsComplete: unpricedTurns === 0,
    costPerTurn: pricedTurns ? costUsd / pricedTurns : null,
    spans: {
      measured,
      totalSeconds,
      averageSeconds: measured ? Math.round(totalSeconds / measured) : null,
      longestSeconds,
    },
    models: breakdownRows(byModel, generatedTurns),
    providers: breakdownRows(byProvider, generatedTurns),
    daily: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    firstAt,
    lastAt,
  }
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * 🔴 THE ELEVATION SITE. Runs only after `resolveVisibleEcosystem` has passed
 * the caller at `admin` or above (or as a platform admin).
 */
async function readMessages(payload: Payload, organizationId: Id): Promise<UsageMessageRow[]> {
  // ⚠ Messages carry no `organization`; the filter walks the session, the same
  // path `ecosystemMetrics` counts through.
  const where: Where = { 'session.organization': { equals: organizationId } }
  const rows: UsageMessageRow[] = []
  for (let page = 1; ; page += 1) {
    const result = await payload.find({
      collection: 'messages',
      where,
      select: MESSAGE_SELECT,
      depth: 0,
      limit: USAGE_PAGE_SIZE,
      page,
      sort: 'createdAt',
      overrideAccess: true,
    })
    for (const raw of result.docs) {
      const row = parseMessageRow(raw)
      if (row) rows.push(row)
    }
    if (!result.hasNextPage) return rows
  }
}

/**
 * Chat usage for ONE ecosistema, for ONE caller who administers it.
 * Throws `EcosystemNotVisibleError` for every refusal.
 */
export async function chatUsage(args: {
  payload: Payload
  /** As sent by the caller. Never trusted. */
  organizationId: Id
  user: unknown
}): Promise<ChatUsage> {
  const { payload } = args
  const organization = await resolveVisibleEcosystem({ ...args, minRole: 'admin' })

  const [sessions, messages] = await Promise.all([
    payload
      .count({
        collection: 'sessions',
        where: { organization: { equals: organization.id } },
        overrideAccess: true,
      })
      .then((r) => r.totalDocs),
    readMessages(payload, organization.id),
  ])

  return { ecosystem: ecosystemEcho(organization), usage: summarizeUsage(sessions, messages) }
}
