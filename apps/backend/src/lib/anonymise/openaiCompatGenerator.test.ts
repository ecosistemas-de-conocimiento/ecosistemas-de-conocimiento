/**
 * The self-hosted detector backend. The only fake is `fetch`: no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { isRateLimited, isTransient } from '@/lib/aiRetry'

import { aiServiceDetector, DetectorFailure, DETECT_SYSTEM_PROMPT } from './detector'
import {
  DETECT_MAX_TOKENS,
  DETECT_TEMPERATURE,
  openaiCompatFromEnv,
  openaiCompatGenerator,
} from './openaiCompatGenerator'

const REQ = {
  unit: {
    unitKey: 'k',
    unitType: 'anonymise-detect',
    input: { userPrompt: 'Es el testimonio. Me acompañó Teodulfo.' },
    systemPrompt: 'SYS',
    specOverride: { promptTemplate: '{{{userPrompt}}}' },
  },
  effortLevel: 'quick',
}

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      model: 'qwen3-30b',
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 120, completion_tokens: 15 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

const quiet = () => {}

describe('openaiCompatGenerator', () => {
  it('maps the request to one non-streaming chat completion and returns the content', async () => {
    const fetchImpl = vi.fn(async () => completion('{"hallazgos":[]}'))
    const lines: string[] = []
    const gen = openaiCompatGenerator({
      baseUrl: 'http://spark.test/',
      apiKey: 'secret-key',
      model: 'qwen3-30b',
      fetch: fetchImpl as unknown as typeof fetch,
      log: (l) => lines.push(l),
    })

    const out = await gen.generate.sync(REQ, { timeoutMs: 5_000 })

    expect(out).toEqual({ text: '{"hallazgos":[]}', modelUsed: 'qwen3-30b' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://spark.test/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'qwen3-30b',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'Es el testimonio. Me acompañó Teodulfo.' },
      ],
      max_tokens: DETECT_MAX_TOKENS,
      temperature: DETECT_TEMPERATURE,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/in=120 out=15/)
    // The log line never carries the text or the key.
    expect(lines[0]).not.toMatch(/Teodulfo|secret-key/)
  })

  it('a 5xx throws with `status` and is transient', async () => {
    const gen = openaiCompatGenerator({
      baseUrl: 'http://spark.test',
      model: 'm',
      fetch: (async () => new Response('Teodulfo', { status: 503 })) as unknown as typeof fetch,
      log: quiet,
    })
    const err = await gen.generate.sync(REQ).catch((e: unknown) => e)
    expect((err as { status: number }).status).toBe(503)
    expect(String((err as Error).message)).not.toContain('Teodulfo')
    expect(isTransient(err)).toBe(true)
  })

  it('a 429 is rate-limited and carries Retry-After', async () => {
    const gen = openaiCompatGenerator({
      baseUrl: 'http://spark.test',
      model: 'm',
      fetch: (async () =>
        new Response('', { status: 429, headers: { 'Retry-After': '7' } })) as unknown as typeof fetch,
      log: quiet,
    })
    const err = await gen.generate.sync(REQ).catch((e: unknown) => e)
    expect(isRateLimited(err)).toBe(true)
    expect((err as { retryAfterMs: number }).retryAfterMs).toBe(7_000)
  })

  it('a 401 is permanent', async () => {
    const gen = openaiCompatGenerator({
      baseUrl: 'http://spark.test',
      model: 'm',
      fetch: (async () => new Response('', { status: 401 })) as unknown as typeof fetch,
      log: quiet,
    })
    const err = await gen.generate.sync(REQ).catch((e: unknown) => e)
    expect((err as { status: number }).status).toBe(401)
    expect(isTransient(err)).toBe(false)
    expect(isRateLimited(err)).toBe(false)
  })

  it('our own deadline is a RequestAbortedError with reason timeout, and transient', async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })) as unknown as typeof fetch
    const gen = openaiCompatGenerator({ baseUrl: 'http://spark.test', model: 'm', fetch: hang, log: quiet })
    const err = await gen.generate.sync(REQ, { timeoutMs: 10 }).catch((e: unknown) => e)
    expect((err as Error).name).toBe('RequestAbortedError')
    expect((err as { reason: string }).reason).toBe('timeout')
    expect(isTransient(err)).toBe(true)
  })

  it('a network fault passes through and is transient', async () => {
    const gen = openaiCompatGenerator({
      baseUrl: 'http://spark.test',
      model: 'm',
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
      log: quiet,
    })
    const err = await gen.generate.sync(REQ).catch((e: unknown) => e)
    expect(isTransient(err)).toBe(true)
  })
})

describe('openaiCompatFromEnv', () => {
  it('is null when ANONYMISE_DETECT_URL is unset or blank', () => {
    expect(openaiCompatFromEnv({})).toBeNull()
    expect(openaiCompatFromEnv({ ANONYMISE_DETECT_URL: '  ' })).toBeNull()
  })

  it('throws when the URL is set without a model (fail closed, no fallback)', () => {
    expect(() => openaiCompatFromEnv({ ANONYMISE_DETECT_URL: 'http://spark.test' })).toThrow(
      /ANONYMISE_DETECT_MODEL/,
    )
  })

  it('builds a generator and reports host and model, never the key', () => {
    const r = openaiCompatFromEnv({
      ANONYMISE_DETECT_URL: 'https://spark.test:8443',
      ANONYMISE_DETECT_MODEL: 'qwen3-30b',
      ANONYMISE_DETECT_API_KEY: 'secret-key',
    })
    expect(r?.host).toBe('spark.test:8443')
    expect(r?.model).toBe('qwen3-30b')
    expect(JSON.stringify({ host: r?.host, model: r?.model })).not.toContain('secret-key')
  })
})

describe('aiServiceDetector — backend selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('with ANONYMISE_DETECT_URL set, calls the self-hosted endpoint and never ai-service', async () => {
    vi.stubEnv('ANONYMISE_DETECT_URL', 'http://spark.test')
    vi.stubEnv('ANONYMISE_DETECT_MODEL', 'qwen3-30b')
    vi.stubEnv('ANONYMISE_DETECT_API_KEY', 'k')
    vi.stubEnv('ANONYMISE_DETECT_MIN_GAP_MS', '0')
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return completion(JSON.stringify({ hallazgos: [{ texto: 'Teodulfo', tipo: 'persona' }] }))
      }),
    )

    const detector = aiServiceDetector()
    expect(detector.name).toBe('openai-compat:qwen3-30b')
    const found = await detector.detect({ text: 'Me acompañó Teodulfo.', contentKind: 'testimonio' })

    expect(found).toEqual([{ text: 'Teodulfo', type: 'persona' }])
    expect(urls).toEqual(['http://spark.test/v1/chat/completions'])
  })

  it('sends the detector system prompt as the system message', async () => {
    vi.stubEnv('ANONYMISE_DETECT_URL', 'http://spark.test')
    vi.stubEnv('ANONYMISE_DETECT_MODEL', 'm')
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const bodies: { messages: { role: string; content: string }[] }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return completion('{"hallazgos":[]}')
      }),
    )
    await aiServiceDetector().detect({ text: 'Hola.', contentKind: 'conversacion' })
    expect(bodies[0]?.messages[0]).toEqual({ role: 'system', content: DETECT_SYSTEM_PROMPT })
  })

  it('an unreachable self-hosted box fails closed: DetectorFailure, no fallback call', async () => {
    vi.stubEnv('ANONYMISE_DETECT_URL', 'http://spark.test')
    vi.stubEnv('ANONYMISE_DETECT_MODEL', 'm')
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetchMock)

    const detector = aiServiceDetector({ retry: { attempts: 2, sleep: async () => {} } })
    const err = await detector
      .detect({ text: 'Me acompañó Teodulfo.', contentKind: 'testimonio' })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DetectorFailure)
    for (const [url] of fetchMock.mock.calls as unknown as [string][]) {
      expect(url).toBe('http://spark.test/v1/chat/completions')
    }
  })

  it('without ANONYMISE_DETECT_URL, keeps the ai-service name', () => {
    vi.stubEnv('ANONYMISE_DETECT_URL', '')
    expect(aiServiceDetector().name).toBe('ai-service:anonymise-detect')
  })
})
