/**
 * 🔴 Owner ruling 2026-10-21 (#4, choice A, "store, never cite in chat"):
 * every chat turn goes into the corpus, ASYNC, after the message is saved, and
 * never feeds the graph. This pins the wiring; `conversationIngest.test.ts`
 * pins what one run does.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CollectionConfig } from 'payload'

const ingestConversationTurns = vi.fn(async (_args: Record<string, unknown>) => ({ ingested: 1, waitingOn: [], heldByGate: 0 }))

vi.mock('payload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('payload')>()),
  getPayload: async () => ({ fake: true }),
}))
vi.mock('@payload-config', () => ({ default: {} }))
vi.mock('@/lib/aiClient', () => ({ getAppAIClient: () => ({ ingest: { enqueue: vi.fn() } }) }))
vi.mock('@/lib/callbackConfig', () => ({ ingestCallbackUrl: () => 'http://cb', missingCallbackConfig: () => [] }))
vi.mock('@/lib/conversationIngest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./conversationIngest')>()),
  ingestConversationTurns,
}))

afterEach(() => ingestConversationTurns.mockClear())

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('🔴 every chat turn is ingested, after the save, without blocking the reply', () => {
  // The collection's module graph takes seconds to transform on a busy run:
  // load it in a hook (30 s budget), not inside a 5 s test.
  let Messages: CollectionConfig
  beforeAll(async () => {
    ;({ Messages } = await import('../collections/Messages'))
  })

  it('the messages collection registers the ingest hook', async () => {
    expect(Messages.hooks?.afterChange ?? []).toHaveLength(1)
  })

  it('the hook returns the saved doc at once; the ingest runs on a later tick', async () => {
    const hook = Messages.hooks!.afterChange![0]!
    const doc = { id: 41, session: 500, role: 'user', content: 'hola' }

    const returned = hook({ doc, req: { context: {} }, operation: 'create' } as never)

    expect(returned).toBe(doc)
    // Not called synchronously: the chat reply never waits on the gate.
    expect(ingestConversationTurns).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(ingestConversationTurns).toHaveBeenCalledTimes(1))
    expect(ingestConversationTurns.mock.calls[0]![0]).toMatchObject({ sessionId: 500, callbackUrl: 'http://cb' })
  })

  it('updates and the run’s own status writes never start a run', async () => {
    const hook = Messages.hooks!.afterChange![0]!
    const doc = { id: 41, session: 500 }
    hook({ doc, req: { context: {} }, operation: 'update' } as never)
    hook({ doc, req: { context: { __skipConversationIngest: true } }, operation: 'create' } as never)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 10))
    expect(ingestConversationTurns).not.toHaveBeenCalled()
  })

  it('a publish confirm releases conversations held on that draft', () => {
    expect(read('../app/api/ai-service/callback/route.ts')).toMatch(/releaseConversationsWaitingOn\(/)
  })
})

describe('🔴 turns feed no graph extraction (ruling 2026-10-21, for now)', () => {
  it('conversation ingest imports nothing from the graph', () => {
    expect(read('./conversationIngest.ts')).not.toMatch(/['"]\.\/graph|lib\/graph|scheduleGraph/)
  })

  it('the turn branch of the ingest callback never schedules a graph run', () => {
    const route = read('../app/api/ai-service/callback/route.ts')
    const start = route.indexOf('async function dispatchConversationTurn(')
    expect(start).toBeGreaterThan(0)
    const body = route.slice(start, route.indexOf('\n}\n', start))
    expect(body).not.toMatch(/graph/i)
    // …and the callback returns into that branch before any document handling.
    const branch = route.slice(route.indexOf('const messageId = messageIdFromExternalId(docIdRaw)'))
    expect(branch.slice(0, 200)).toMatch(/dispatchConversationTurn\(payload, messageId, envelope\)\s*\n\s*return/)
  })
})
