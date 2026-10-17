/**
 * What actually reaches audio-service, and what comes back.
 *
 * Two properties carry most of the weight here:
 *
 *   1. **A rejection is classified, not just logged.** `permanent` decides
 *      whether the user is told to change their file or to try again. Getting it
 *      backwards is expensive in both directions: telling someone to re-upload a
 *      perfectly good recording costs them CPU-hours, and telling them to retry
 *      an unsupported format costs them the same wait, five times, to reach the
 *      same answer.
 *   2. **Nothing throws.** This runs inside a `setImmediate` in a Payload
 *      afterChange hook, where an unhandled rejection is a log line nobody reads
 *      and a row left mid-flight. Every failure has to come back as a value.
 *
 * No network: `fetch` is stubbed wholesale.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AUDIO_SERVICE_API_KEY_VAR,
  AUDIO_SERVICE_URL_VAR,
  audioServiceBaseUrl,
  audioServiceConfigured,
  checkAudioServiceConfig,
  fetchTranscriptText,
  missingAudioServiceConfig,
  submitTranscription,
} from './audioClient'

const fetchMock = vi.fn()
// The upload goes through `postStreaming` (node:http), the transcript read
// through `fetch`; both land in the same mock, with fetch's (url, init) shape.
vi.mock('./streamingPost', () => ({
  postStreaming: (...args: unknown[]) => fetchMock(...args),
}))

const submit = (over: Partial<Parameters<typeof submitTranscription>[0]> = {}) =>
  submitTranscription({
    body: new Blob(['fake audio bytes']),
    filename: 'junta.m4a',
    contentType: 'audio/x-m4a',
    externalId: '42',
    title: 'Junta de agosto',
    idempotencyKey: 'doc-42-a0',
    callbackUrl: 'https://backend.test/api/ai-service/callback',
    metadata: { docId: '42', organizationId: '10', uploadedById: '3', kind: 'audio' },
    ...over,
  })

/**
 * The multipart body of the one call that was made, as a plain map.
 *
 * Parsed back by undici's own multipart parser, so a malformed hand-built body
 * fails here rather than at audio-service.
 */
const sentForm = async (): Promise<Record<string, string>> => {
  const init = fetchMock.mock.calls[0]![1] as RequestInit
  const headers = init.headers as Record<string, string>
  const form = await new Response(init.body as ReadableStream, {
    headers: { 'content-type': headers['Content-Type']! },
  }).formData()
  const out: Record<string, string> = {}
  for (const [k, v] of form.entries()) {
    out[k] = typeof v === 'string' ? v : `<file:${(v as File).name}>`
  }
  return out
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv(AUDIO_SERVICE_URL_VAR, 'http://audio-service:8080')
  vi.stubEnv(AUDIO_SERVICE_API_KEY_VAR, 'audio-key')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── Configuration ──────────────────────────────────────────────────────────

describe('configuration', () => {
  it('strips trailing slashes, like aiClient does', () => {
    vi.stubEnv(AUDIO_SERVICE_URL_VAR, 'http://audio-service:8080///')
    expect(audioServiceBaseUrl()).toBe('http://audio-service:8080')
  })

  it.each([
    ['unset', ''],
    ['a bare host', 'audio-service:8080'],
    ['a relative path', '/v1'],
    ['a placeholder', 'unset'],
  ])('treats a URL that is %s as not configured', (_label, value) => {
    vi.stubEnv(AUDIO_SERVICE_URL_VAR, value)
    expect(audioServiceConfigured()).toBe(false)
  })

  it('names a URL that is SET BUT UNUSABLE distinctly from one that is unset', () => {
    // An operator hunting for an unset variable that is in fact set to garbage
    // will not find it. Say which of the two it is.
    vi.stubEnv(AUDIO_SERVICE_URL_VAR, 'audio-service:8080')
    expect(missingAudioServiceConfig().join(' ')).toMatch(/set, but not an absolute/i)
  })

  it('reports a missing API key', () => {
    vi.stubEnv(AUDIO_SERVICE_API_KEY_VAR, '')
    expect(missingAudioServiceConfig()).toContain(AUDIO_SERVICE_API_KEY_VAR)
  })
})

describe('boot check', () => {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }

  beforeEach(() => {
    logger.error.mockReset()
    logger.warn.mockReset()
    logger.info.mockReset()
  })

  it('never throws — a missing audio key must not crash-loop the admin panel', () => {
    vi.stubEnv(AUDIO_SERVICE_URL_VAR, '')
    vi.stubEnv(AUDIO_SERVICE_API_KEY_VAR, '')
    expect(() => checkAudioServiceConfig(logger)).not.toThrow()
  })

  it('logs at ERROR in production and names what is missing', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv(AUDIO_SERVICE_API_KEY_VAR, '')
    checkAudioServiceConfig(logger)
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error.mock.calls[0]![0]).toContain(AUDIO_SERVICE_API_KEY_VAR)
  })

  it('says the callback secret is NOT a separate variable', () => {
    // The single most likely misconfiguration: an operator inventing an
    // AUDIO_CALLBACK_SECRET because the service is different. One verifier,
    // one secret — the boot log has to say so where they will read it.
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv(AUDIO_SERVICE_API_KEY_VAR, '')
    checkAudioServiceConfig(logger)
    expect(logger.error.mock.calls[0]![0]).toContain('CALLBACK_SECRET')
  })

  it('is only a warning below production', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv(AUDIO_SERVICE_API_KEY_VAR, '')
    checkAudioServiceConfig(logger)
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(logger.error).not.toHaveBeenCalled()
  })
})

// ── Submitting ─────────────────────────────────────────────────────────────

describe('submitTranscription — the wire', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transcribeId: 'tr_1', durationSeconds: 1834.2 }), {
        status: 202,
      }),
    )
  })

  it('POSTs multipart to /v1/transcribe with the bearer key', async () => {
    await submit()
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('http://audio-service:8080/v1/transcribe')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer audio-key')
  })

  it('sends the document id as externalId — the only join back to the row', async () => {
    await submit()
    expect((await sentForm()).externalId).toBe('42')
  })

  it('asks for Spanish rather than relying on the service default', async () => {
    await submit()
    expect((await sentForm()).language).toBe('es')
  })

  it('keeps the filename, which is audio-service’s cheap pre-filter before ffprobe', async () => {
    await submit()
    expect((await sentForm()).file).toBe('<file:junta.m4a>')
  })

  it('carries the callbackUrl — without it the transcript has no way home', async () => {
    await submit()
    expect((await sentForm()).callbackUrl).toBe(
      'https://backend.test/api/ai-service/callback',
    )
  })

  it('sends metadata as JSON, and it is decorative only', async () => {
    // ⚠ audio-service echoes this back. Nothing on the return leg may use it to
    // decide anything: the row is the source of truth for who owns the document.
    await submit()
    expect(JSON.parse((await sentForm()).metadata!)).toMatchObject({
      docId: '42',
      organizationId: '10',
    })
  })

  it('NEVER names a corpus — that is derived in lib/corpus.ts and nowhere else', async () => {
    await submit()
    expect(JSON.stringify(await sentForm())).not.toMatch(/corpus|eco-/i)
  })

  it('returns the transcribeId and the duration known at 202', async () => {
    const result = await submit()
    expect(result).toMatchObject({ ok: true, transcribeId: 'tr_1', durationSeconds: 1834.2 })
  })
})

/** An audio body of `size` bytes, produced on demand. Counts what was pulled. */
function lazyAudio(size: number, chunk = 1 << 20) {
  const state = { pulled: 0 }
  const body = {
    size,
    stream: () =>
      new ReadableStream<Uint8Array>({
        pull(c) {
          const n = Math.min(chunk, size - state.pulled)
          if (n <= 0) return c.close()
          state.pulled += n
          c.enqueue(new Uint8Array(n).fill(0x61))
        },
      }),
  }
  return { body, state }
}

describe('🔴 submitTranscription — the audio is streamed, never buffered', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transcribeId: 'tr_1' }), { status: 202 }),
    )
  })

  it('sends a ReadableStream (not a FormData) with an exact Content-Length', async () => {
    await submit()
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.body).toBeInstanceOf(ReadableStream)
    const declared = Number((init.headers as Record<string, string>)['Content-Length'])
    const bytes = new Uint8Array(await new Response(init.body as ReadableStream).arrayBuffer())
    expect(declared).toBe(bytes.byteLength)
  })

  it('round-trips the file bytes and every field through a real multipart parser', async () => {
    await submit({ filename: 'Junta de la señora.m4a' })
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    const form = await new Response(init.body as ReadableStream, {
      headers: { 'content-type': (init.headers as Record<string, string>)['Content-Type']! },
    }).formData()
    const file = form.get('file') as File
    expect(file.name).toBe('Junta de la señora.m4a')
    expect(file.type).toBe('audio/x-m4a')
    expect(await file.text()).toBe('fake audio bytes')
    expect(form.get('idempotencyKey')).toBe('doc-42-a0')
    expect(form.get('title')).toBe('Junta de agosto')
  })

  it('🔴 reads none of a 300 MB recording until fetch pulls it', async () => {
    const { body, state } = lazyAudio(300 * 1024 * 1024)
    await submit({ body })
    // The mocked fetch never reads the body: nothing may have been read for it.
    expect(state.pulled).toBe(0)
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    const declared = Number((init.headers as Record<string, string>)['Content-Length'])
    expect(declared).toBeGreaterThan(300 * 1024 * 1024)
    expect(declared).toBeLessThan(300 * 1024 * 1024 + 4096)
  })

  it('🔴 hands chunks through one at a time — the body is never concatenated', async () => {
    const { body, state } = lazyAudio(32 * 1024 * 1024)
    const concat = vi.spyOn(Buffer, 'concat')
    const sizes: number[] = []
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        sizes.push(value.byteLength)
      }
      return new Response(JSON.stringify({ transcribeId: 'tr_1' }), { status: 202 })
    })
    await submit({ body })
    expect(state.pulled).toBe(32 * 1024 * 1024)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1 << 20)
    // Nothing anywhere joined audio chunks into a bigger buffer.
    const joined = concat.mock.calls.map(([list]) => list.reduce((n, b) => n + b.length, 0))
    expect(joined.filter((n) => n > 1 << 20)).toEqual([])
  })

  it('a quote or a newline in the filename cannot break the part header', async () => {
    await submit({ filename: 'a"b\r\nX-Evil: 1.m4a' })
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    const raw = await new Response(init.body as ReadableStream).text()
    expect(raw).toContain('filename="a%22b%0D%0AX-Evil: 1.m4a"\r\n')
    expect(raw).not.toMatch(/^X-Evil/m)
  })
})

describe('submitTranscription — idempotency', () => {
  it('accepts a 200 dedupe hit as success and flags it', async () => {
    // audio-service answers 200 (not 202) with the ORIGINAL id when the key was
    // already claimed. Treating that as a failure would fail a row whose
    // transcription is running perfectly well.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transcribeId: 'tr_first', deduplicated: true }), {
        status: 200,
      }),
    )
    const result = await submit()
    expect(result).toMatchObject({ ok: true, transcribeId: 'tr_first', deduplicated: true })
  })
})

describe('submitTranscription — rejections', () => {
  it.each([
    [415, 'unsupported_media_type'],
    [413, 'payload_too_large'],
    [400, 'bad_request'],
  ])('classifies %i as PERMANENT — the user must change the file', async (status, code) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: code, message: 'nope' }), { status }),
    )
    const result = await submit()
    expect(result).toMatchObject({ ok: false, permanent: true, code })
  })

  it('classifies a 5xx as NOT permanent', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 503 }))
    const result = await submit()
    expect(result).toMatchObject({ ok: false, permanent: false })
  })

  it('turns a network throw into a value, never an exception', async () => {
    // This runs inside a setImmediate in an afterChange hook. A throw here is an
    // unhandled rejection and a row stranded mid-flight.
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await submit()
    expect(result).toMatchObject({
      ok: false,
      permanent: false,
      code: 'audio_service_unreachable',
    })
    expect((result as { message: string }).message).toContain('ECONNREFUSED')
  })

  it('refuses a 2xx that carries no transcribeId rather than promising a job', async () => {
    // Nothing was scheduled. Reporting success would leave the row waiting for a
    // callback that no job exists to send.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 202 }))
    const result = await submit()
    expect(result).toMatchObject({ ok: false, code: 'audio_service_bad_response' })
  })

  it('fails without calling out when audio-service is not configured', async () => {
    vi.stubEnv(AUDIO_SERVICE_URL_VAR, '')
    const result = await submit()
    expect(result).toMatchObject({
      ok: false,
      permanent: true,
      code: 'audio_service_not_configured',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never leaks the API key into a failure message', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 401 }))
    const result = await submit()
    expect(JSON.stringify(result)).not.toContain('audio-key')
  })
})

// ── Fetching a truncated transcript ────────────────────────────────────────

describe('fetchTranscriptText', () => {
  it('asks without segments — thousands of timestamps nothing downstream reads', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transcript: { text: 'hola mundo' } }), { status: 200 }),
    )
    const text = await fetchTranscriptText('tr_1')
    expect(text).toBe('hola mundo')
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://audio-service:8080/v1/transcribe/tr_1?includeSegments=false',
    )
  })

  it('returns null when the transcript has expired out of audio-service', async () => {
    // Redis-only with a TTL. Past it the transcript is simply gone, and the
    // caller has to fail the document rather than embed nothing.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
    expect(await fetchTranscriptText('tr_1')).toBeNull()
  })

  it('returns null rather than throwing on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    expect(await fetchTranscriptText('tr_1')).toBeNull()
  })

  it('treats a blank transcript as absent', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ transcript: { text: '   ' } }), { status: 200 }),
    )
    expect(await fetchTranscriptText('tr_1')).toBeNull()
  })

  it('url-encodes the id', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await fetchTranscriptText('a/b')
    expect(fetchMock.mock.calls[0]![0]).toContain('/v1/transcribe/a%2Fb')
  })
})
