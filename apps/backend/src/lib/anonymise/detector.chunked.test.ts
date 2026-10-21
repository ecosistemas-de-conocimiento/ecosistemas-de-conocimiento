/**
 * The REAL detector, chunked, through the REAL gate. The only fake is `fetch`
 * under a real `AIClient`: no network, no spend.
 *
 * The fake model answers like a well-behaved detector: it returns every planted
 * name that occurs in the slice of text it was sent, and nothing else.
 */

import { AIClient } from '@edc/ai-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { chunkText } from './chunk'
import { aiServiceDetector, type SyncGenerator } from './detector'
import { runAnonymisationGate } from './gate'

const NAMES = ['Eustolia Barragán', 'Teodulfo', 'Nicasia Olvera']

const filler = (n: number) => Array.from({ length: n }, (_, i) => `palabra${i}`).join(' ')

interface Call {
  userPrompt: string
  signal: boolean
}

type Answer = (prompt: string, n: number) => Response | Promise<Response>

function syncOk(text: string): Response {
  return new Response(
    JSON.stringify({ text, modelUsed: 'fake', provider: 'fake', costUsd: 0, traceId: 't' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

/** Returns every name in `NAMES` present in the prompt. */
const honest: Answer = (prompt) =>
  syncOk(
    JSON.stringify({
      hallazgos: NAMES.filter((n) => prompt.includes(n)).map((n) => ({ texto: n, tipo: 'persona' })),
    }),
  )

function fakeClient(answer: Answer = honest) {
  const calls: Call[] = []
  let inFlight = 0
  let maxInFlight = 0
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { unit: { input: { userPrompt: string } } }
    calls.push({ userPrompt: body.unit.input.userPrompt, signal: Boolean(init.signal) })
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      await new Promise((r) => setTimeout(r, 1))
      // Honour the abort signal the way the platform fetch does.
      const aborted = new Promise<never>((_, reject) => {
        const sig = init.signal
        if (!sig) return
        if (sig.aborted) reject(sig.reason)
        sig.addEventListener('abort', () => reject(sig.reason), { once: true })
      })
      return await Promise.race([answer(body.unit.input.userPrompt, calls.length), aborted])
    } finally {
      inFlight -= 1
    }
  }) as unknown as typeof fetch
  const client = new AIClient({ baseUrl: 'http://ai.test', apiKey: 'k', fetch: fetchImpl })
  // Same cast as production (`getAppAIClient(...) as unknown as SyncGenerator`).
  return { client: client as unknown as SyncGenerator, calls, maxInFlight: () => maxInFlight }
}

/** Paragraphs of 100 words; a name sits at the very end of one chunk and the start of the next. */
function longTestimony(): string {
  return [
    `${filler(100)}`,
    `${filler(140)} Me acompañó Teodulfo`,
    `Teodulfo dijo que ${filler(100)}`,
    `${filler(90)} con Eustolia Barragán.`,
    `Eustolia Barragán y Nicasia Olvera ${filler(150)}`,
    `${filler(200)} Teodulfo.`,
  ].join('\n\n')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('aiServiceDetector — chunked', () => {
  it('sends one call per chunk, each carrying only its chunk', async () => {
    const text = longTestimony()
    const { client, calls } = fakeClient()
    const detector = aiServiceDetector({ client, chunkWords: 250 })
    await detector.detect({ text, contentKind: 'testimonio' })

    const chunks = chunkText(text, 250)
    expect(chunks.length).toBeGreaterThan(2)
    expect(calls).toHaveLength(chunks.length)
    for (const c of chunks) {
      expect(calls.some((call) => call.userPrompt.endsWith(c.text))).toBe(true)
    }
  })

  it('🔴 through the gate: every occurrence of a name repeated across chunks is gone, ready', async () => {
    const text = longTestimony()
    const { client } = fakeClient()
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text },
      { detector: aiServiceDetector({ client, chunkWords: 250 }) },
    )
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    for (const n of NAMES) expect(result.redactedText).not.toContain(n)
    // One person, one pseudonym, however many chunks named them.
    const teo = result.redactedText.match(/\[Persona [A-Z]+\]/g) ?? []
    expect(new Set(teo).size).toBe(3)
  })

  it('🔴 verify survivors carry offsets into the FULL redacted text, near chunk boundaries', async () => {
    const text = longTestimony()
    // Stage 3 is a lazy model that never finds Teodulfo; stage 4 does. With
    // concurrency 1 the first `stage3Calls` calls are stage 3.
    const stage3Calls = chunkText(text, 250).length
    const { client } = fakeClient((prompt, n) => {
      const found = NAMES.filter((name) => prompt.includes(name)).filter(
        (name) => n > stage3Calls || name !== 'Teodulfo',
      )
      return syncOk(JSON.stringify({ hallazgos: found.map((n) => ({ texto: n, tipo: 'persona' })) }))
    })
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text },
      { detector: aiServiceDetector({ client, chunkWords: 250, concurrency: 1 }) },
    )
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('verify')
    const red = result.redactedText ?? ''
    const spans = result.survivors ?? []
    expect(spans).toHaveLength(3)
    for (const s of spans) expect(red.slice(s.start, s.end)).toBe('Teodulfo')
    // The occurrences sit on both sides of a chunk boundary of the redacted text.
    const bounds = chunkText(red, 250).map((c) => c.end)
    const chunkOf = (at: number) => bounds.findIndex((b) => at < b)
    expect(new Set(spans.map((s) => chunkOf(s.start))).size).toBeGreaterThan(1)
  })

  it('🔴 fails closed: one bad chunk among many holds the document', async () => {
    const text = longTestimony()
    const { client } = fakeClient((prompt, n) =>
      n === 2 ? syncOk('{"hallazgos":[{"texto":"Teo') : honest(prompt, n),
    )
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text },
      { detector: aiServiceDetector({ client, chunkWords: 250, concurrency: 1 }) },
    )
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.stage).toBe('content')
    expect(result.reason).toMatch(/respuesta-no-json|json-invalido/)
  })

  it('🔴 fails closed on a 400 from one chunk, and stops launching the rest', async () => {
    const text = longTestimony()
    const { client, calls } = fakeClient((prompt, n) =>
      n === 1
        ? new Response(JSON.stringify({ error: 'boom' }), { status: 400 })
        : honest(prompt, n),
    )
    await expect(
      aiServiceDetector({ client, chunkWords: 100, concurrency: 1 }).detect({
        text,
        contentKind: 'testimonio',
      }),
    ).rejects.toMatchObject({ failureClass: 'transporte', infrastructure: true })
    expect(calls).toHaveLength(1)
  })

  it('runs at most `concurrency` chunks at once', async () => {
    const text = longTestimony()
    const { client, calls, maxInFlight } = fakeClient()
    await aiServiceDetector({ client, chunkWords: 60, concurrency: 3 }).detect({
      text,
      contentKind: 'testimonio',
    })
    expect(calls.length).toBeGreaterThan(6)
    expect(maxInFlight()).toBe(3)
  })

  it('retries a chunk that ai-service rate-limited (429), then succeeds', async () => {
    const text = longTestimony()
    const sleeps: number[] = []
    const { client, calls } = fakeClient((prompt, n) =>
      n === 1
        ? new Response(JSON.stringify({ error: 'RateLimitExceeded', retryAfterMs: 1 }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          })
        : honest(prompt, n),
    )
    const found = await aiServiceDetector({
      client,
      chunkWords: 250,
      concurrency: 1,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    }).detect({ text, contentKind: 'testimonio' })
    expect(sleeps).toHaveLength(1)
    expect(calls).toHaveLength(chunkText(text, 250).length + 1)
    expect(found.map((f) => f.text).sort()).toEqual([...NAMES].sort())
  })

  it('🔴 sets an explicit per-call timeout, and a timed-out chunk is a hold', async () => {
    vi.stubEnv('ANONYMISE_DETECT_TIMEOUT_MS', '20')
    // A model that never answers: only the abort signal ends the request.
    const { client, calls } = fakeClient(
      () => new Promise<Response>(() => {}),
    )
    const t0 = Date.now()
    const sleeps: number[] = []
    const result = await runAnonymisationGate(
      { contentKind: 'testimonio', text: 'Me acompañó Teodulfo a la clínica.' },
      {
        detector: aiServiceDetector({
          client,
          sleep: async (ms) => {
            sleeps.push(ms)
          },
        }),
      },
    )
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(calls[0]?.signal).toBe(true)
    // Our own timeout is transient: 1 + 3 retries, then the hold.
    expect(calls).toHaveLength(4)
    expect(sleeps).toHaveLength(3)
    expect(result.status).toBe('hold')
    if (result.status !== 'hold') return
    expect(result.reason).toContain('tiempo-agotado')
  })

  describe('🔴 transient failures: retried, and still fail-closed', () => {
    const TEXT = 'Me acompañó Teodulfo a la clínica.'
    const status = (code: number, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify({ error: 'x', message: 'x' }), {
        status: code,
        headers: { 'Content-Type': 'application/json', ...headers },
      })

    async function gate(answer: Answer) {
      const sleeps: number[] = []
      const { client, calls } = fakeClient(answer)
      const result = await runAnonymisationGate(
        { contentKind: 'testimonio', text: TEXT },
        {
          detector: aiServiceDetector({
            client,
            sleep: async (ms) => {
              sleeps.push(ms)
            },
          }),
        },
      )
      return { result, calls, sleeps }
    }

    it('a 503 is retried, then the gate is ready', async () => {
      const { result, calls, sleeps } = await gate((p, n) => (n === 1 ? status(503) : honest(p, n)))
      expect(result.status).toBe('ready')
      expect(sleeps).toHaveLength(1)
      // stage 3: 503 + retry; stage 4: one call
      expect(calls).toHaveLength(3)
    })

    it('a network error is retried, then the gate is ready', async () => {
      const { result, sleeps } = await gate((p, n) => {
        if (n === 1) {
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
          })
        }
        return honest(p, n)
      })
      expect(result.status).toBe('ready')
      expect(sleeps).toHaveLength(1)
    })

    it('a 429 on every attempt ends in a HOLD after 1 + 3 retries', async () => {
      const { result, calls } = await gate(() =>
        new Response(JSON.stringify({ error: 'RateLimitExceeded', retryAfterMs: 1 }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      expect(result.status).toBe('hold')
      if (result.status !== 'hold') return
      expect(result.stage).toBe('content')
      expect(calls).toHaveLength(4)
      // 🔴 Not a finding: the model never answered, so the hold is retryable.
      expect(result.retryable).toBe(true)
    })

    it('🔴 `retry` raises the per-chunk budget (the seed passes its patient one)', async () => {
      const sleeps: number[] = []
      const { client, calls } = fakeClient(() =>
        new Response(JSON.stringify({ error: 'RateLimitExceeded', retryAfterMs: 60_000 }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      const result = await runAnonymisationGate(
        { contentKind: 'testimonio', text: TEXT },
        {
          detector: aiServiceDetector({
            client,
            retry: {
              attempts: 20,
              budgetMs: 15 * 60_000,
              random: () => 0,
              sleep: async (ms) => {
                sleeps.push(ms)
              },
            },
          }),
        },
      )
      // Default budget: 2 full-window waits overrun 120 s. Seed budget: 14 fit.
      expect(calls.length).toBeGreaterThan(4)
      expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(15 * 60_000)
      expect(result.status === 'hold' && result.retryable).toBe(true)
    })

    it.each([500, 502, 504])('a %i is retried, then the gate is ready', async (code) => {
      const { result, sleeps } = await gate((p, n) => (n === 1 ? status(code) : honest(p, n)))
      expect(result.status).toBe('ready')
      expect(sleeps).toHaveLength(1)
    })

    it('🔴 a 402 budget refusal holds at once, and the hold is retryable', async () => {
      const { result, calls } = await gate(() => status(402))
      expect(calls).toHaveLength(1)
      expect(result.status === 'hold' && result.retryable).toBe(true)
    })

    it('🔴 unparseable model output is NOT retryable: an ordinary hold', async () => {
      const { result } = await gate(() => syncOk('no es json'))
      expect(result.status).toBe('hold')
      expect(result.status === 'hold' && result.retryable).toBeUndefined()
    })

    it('the verify stage retries too', async () => {
      const { result, calls } = await gate((p, n) => (n === 2 ? status(503) : honest(p, n)))
      expect(result.status).toBe('ready')
      expect(calls).toHaveLength(3)
    })

    it.each([400, 401, 422])('a %i is not retried and holds', async (code) => {
      const { result, calls, sleeps } = await gate(() => status(code))
      expect(result.status).toBe('hold')
      expect(calls).toHaveLength(1)
      expect(sleeps).toHaveLength(0)
    })
  })

  it('🔴 ANONYMISE_DETECT_MIN_GAP_MS spaces every call start, across concurrent chunks', async () => {
    vi.stubEnv('ANONYMISE_DETECT_MIN_GAP_MS', '2700')
    const text = longTestimony()
    const sleeps: number[] = []
    const { client, calls } = fakeClient()
    await aiServiceDetector({
      client,
      chunkWords: 60,
      concurrency: 3,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    }).detect({ text, contentKind: 'testimonio' })
    // The sleep is injected and returns at once, so each start reserves the
    // next 2.7 s slot: waits grow by ~2.7 s per call.
    expect(sleeps.length).toBeGreaterThanOrEqual(calls.length - 1)
    const sorted = [...sleeps].sort((a, b) => a - b)
    expect(sorted[sorted.length - 1]!).toBeGreaterThan(2_700 * (calls.length - 2))
    vi.unstubAllEnvs()
  })

  it('reads chunk size and concurrency from the environment', async () => {
    vi.stubEnv('ANONYMISE_CHUNK_WORDS', '60')
    vi.stubEnv('ANONYMISE_DETECT_CONCURRENCY', '1')
    const text = longTestimony()
    const { client, calls, maxInFlight } = fakeClient()
    await aiServiceDetector({ client }).detect({ text, contentKind: 'testimonio' })
    expect(calls).toHaveLength(chunkText(text, 60).length)
    expect(maxInFlight()).toBe(1)
  })
})
