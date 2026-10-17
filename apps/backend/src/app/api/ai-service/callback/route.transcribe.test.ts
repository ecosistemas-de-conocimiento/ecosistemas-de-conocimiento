/**
 * The transcription half of the receiver — the leg that turns a recording into
 * a searchable, citable document.
 *
 * Three properties are load-bearing:
 *
 *   1. **ONE verifier.** audio-service signs with `X-AIService-*` and the
 *      identical HMAC scheme on purpose, so these events go through the existing
 *      verification code untouched. The first describe block proves that — if it
 *      ever fails, someone added a second verifier and the two will drift.
 *   2. **The callback only persists.** `transcribe.completed` writes the text
 *      and `transcribed`, and stops. `lib/ingestRecovery.ts` runs the gate and
 *      `enqueueIngestForDoc`; its tests assert the PRIVATE draft corpus name.
 *   3. **A stale job cannot clobber a live one.** A retry mints a new
 *      transcribeId while the old job may still be alive; both callbacks carry
 *      the same externalId. The `transcribeId` guard is the whole defence.
 *
 * ⚠ The 900s skew window is exercised too. The contract document says 300s and
 * is wrong about our services — see `lib/hmac.ts`. A "fix" back to 300 would
 * silently reject the tail of every retry schedule, so it gets a test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { signCallback } from '@/lib/hmac'

const SECRET = 'e'.repeat(64)

const created: Array<Record<string, unknown>> = []
const updated: Array<Record<string, unknown>> = []

let findByIDImpl: (args: Record<string, unknown>) => Promise<unknown>

const fakePayload = {
  create: async (args: Record<string, unknown>) => {
    created.push(args)
    return {}
  },
  findByID: (args: Record<string, unknown>) => findByIDImpl(args),
  update: async (args: Record<string, unknown>) => {
    updated.push(args)
    return {}
  },
}

vi.mock('payload', () => ({ getPayload: async () => fakePayload }))
vi.mock('@payload-config', () => ({ default: {} }))

const ingestEnqueue = vi.fn(async (_req: { corpus: string }) => ({
  ingestId: 'ing_from_transcript',
}))
vi.mock('@/lib/aiClient', () => ({
  getAppAIClient: () => ({ ingest: { enqueue: ingestEnqueue } }),
}))

const fetchTranscriptText = vi.fn(async () => 'texto completo desde el GET')
vi.mock('@/lib/audioClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audioClient')>('@/lib/audioClient')
  return {
    ...actual,
    fetchTranscriptText: (...args: unknown[]) =>
      (fetchTranscriptText as unknown as (...a: unknown[]) => unknown)(...args),
  }
})

/** A document row mid-transcription: a job is running and no text exists yet. */
const transcribingRow = (over: Record<string, unknown> = {}) => ({
  id: 42,
  kind: 'audio',
  // ⚠ The FILE format above; what the material IS, here. Required on the fixture
  // because the gate reads the raw value and fails closed — see
  // `mustPassAnonymisationGate` in `lib/anonymiseDocument.ts`.
  contentKind: 'documento',
  name: 'Junta de agosto',
  organization: 10,
  uploadedBy: 3,
  publicationStatus: 'draft',
  transcribeId: 'tr_1',
  extractedText: null,
  ingestId: null,
  ...over,
})

const completed = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: 'transcribe.completed',
    emittedAt: new Date().toISOString(),
    transcribeId: 'tr_1',
    org: 'demo',
    project: 'demo',
    externalId: '42',
    title: 'Junta de agosto',
    audio: { filename: 'junta.m4a', bytes: 8123904, durationSeconds: 1834.2, chunks: 4 },
    transcript: {
      language: 'es',
      languageProbability: 0.9912,
      segmentCount: 312,
      durationSeconds: 1834.2,
      characters: 26,
      truncated: false,
      text: 'La junta empezó a las diez',
    },
    model: { name: 'large-v3-turbo', device: 'cpu' },
    durationMs: 1_700_000,
    metadata: { docId: '42', organizationId: '10' },
    ...over,
  })

const headersFor = (body: string, opts: { secret?: string; skewSeconds?: number } = {}) => {
  const timestamp = Math.floor(Date.now() / 1000) + (opts.skewSeconds ?? 0)
  return {
    'content-type': 'application/json',
    'x-aiservice-timestamp': String(timestamp),
    'x-aiservice-signature': signCallback({
      timestamp,
      body,
      secret: opts.secret ?? SECRET,
    }),
    // Purely additive — audio-service sends it so a receiver CAN branch on the
    // emitter. We deliberately do not, and this test proves it is not needed.
    'x-callback-source': 'audio-service',
  }
}

const post = async (body: string, headers: Record<string, string>) => {
  const { POST } = await import('./route')
  return POST(
    new Request('http://backend.test/api/ai-service/callback', {
      method: 'POST',
      body,
      headers,
    }),
  )
}

/** Everything written to the documents row, flattened. */
const written = (): Record<string, unknown> =>
  Object.assign({}, ...updated.map((u) => u.data as Record<string, unknown>))

beforeEach(() => {
  created.length = 0
  updated.length = 0
  ingestEnqueue.mockClear()
  fetchTranscriptText.mockClear()
  findByIDImpl = async () => transcribingRow()
  vi.stubEnv('CALLBACK_SECRET', SECRET)
  vi.stubEnv('PUBLIC_BACKEND_URL', 'https://backend.test')
  vi.stubEnv('AI_SERVICE_URL', 'http://ai-service:3001')
  vi.stubEnv('AI_SERVICE_API_KEY', 'app-key')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// ── One verifier, one secret ───────────────────────────────────────────────

describe('signature verification is the SAME code, unchanged', () => {
  it('accepts an audio-service callback signed with the ai-service scheme', async () => {
    const body = completed()
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(200)
  })

  it('401s a wrong signature', async () => {
    const body = completed()
    const res = await post(body, headersFor(body, { secret: 'f'.repeat(64) }))
    expect(res.status).toBe(401)
    expect(updated).toHaveLength(0)
  })

  it('accepts a timestamp 10 minutes old — the window is 900s, NOT 300s', async () => {
    // 🔴 The retry schedule outlives a 300s window. With 300s, a callback that
    // failed once because this backend was mid-deploy could never succeed, and
    // the document would stay `transcribing` forever behind a 401 that reads
    // like an attack. Do not "fix" this back. See lib/hmac.ts.
    const body = completed()
    const res = await post(body, headersFor(body, { skewSeconds: -600 }))
    expect(res.status).toBe(200)
  })

  it('still rejects a timestamp beyond the 900s window', async () => {
    const body = completed()
    const res = await post(body, headersFor(body, { skewSeconds: -1000 }))
    expect(res.status).toBe(401)
  })
})

// ── Dedupe keys ────────────────────────────────────────────────────────────

describe('dedupe keys', () => {
  it('keys a terminal event on (transcribeId, externalId)', async () => {
    const body = completed()
    await post(body, headersFor(body))
    expect(created[0]).toMatchObject({
      data: { correlationKey: 'tr_1', eventKey: '42', event: 'transcribe.completed' },
    })
  })

  it('🔴 keys progress on a CONSTANT, never on an empty eventKey', async () => {
    // An empty eventKey collides with the terminal event's key when externalId
    // is absent, and the first progress callback would then dedupe the
    // COMPLETION away — losing the transcript entirely. Deduping several
    // progress events is harmless; deduping the completion is data loss.
    const body = JSON.stringify({
      event: 'transcribe.progress',
      transcribeId: 'tr_1',
      chunksDone: 2,
      chunksTotal: 8,
    })
    await post(body, headersFor(body))
    expect(created[0]).toMatchObject({ data: { correlationKey: 'tr_1', eventKey: 'progress' } })
  })

  it('treats progress as a no-op on the row', async () => {
    const body = JSON.stringify({
      event: 'transcribe.progress',
      transcribeId: 'tr_1',
      externalId: '42',
      chunksDone: 2,
      chunksTotal: 8,
    })
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(200)
    expect(updated).toHaveLength(0)
  })
})

// ── 🔴 The join back into the existing pipeline ────────────────────────────

describe('transcribe.completed — the join into the EXISTING ingest path', () => {
  it('persists the transcript as `extractedText`, not a new field', async () => {
    // Reusing `extractedText` is what makes publish/unpublish work on a
    // transcript for free — `lib/publishDocument.ts` re-embeds that field. A
    // separate `transcript` column is what forks the pipeline.
    const body = completed()
    await post(body, headersFor(body))
    expect(written().extractedText).toBe('La junta empezó a las diez')
  })

  it('records the recording metadata, including the ASR confidence', async () => {
    const body = completed()
    await post(body, headersFor(body))
    expect(written().audioMeta).toMatchObject({
      durationSeconds: 1834.2,
      language: 'es',
      languageProbability: 0.9912,
      segmentCount: 312,
      model: 'large-v3-turbo',
      chunks: 4,
    })
  })

  it('🔴 stops at `transcribed`: the gate and the enqueue are left to the recovery sweep', async () => {
    // audio-service gives up on a callback after 20 s, and the gate is two model
    // calls. `lib/ingestRecovery.ts` drives the row from here; its tests cover
    // the corpus name and the tenant-from-the-row rule that used to live here.
    const body = completed()
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(200)
    const statuses = updated
      .map((u) => (u.data as Record<string, unknown>).ingestStatus)
      .filter(Boolean)
    expect(statuses).toEqual(['transcribed'])
    expect(ingestEnqueue).not.toHaveBeenCalled()
    expect(written().ingestId).toBeUndefined()
  })

  it('answers 500 when the transcript cannot be written, so audio-service retries', async () => {
    fakePayload.update = async () => {
      throw new Error('db down')
    }
    try {
      const body = completed()
      const res = await post(body, headersFor(body))
      expect(res.status).toBe(500)
    } finally {
      fakePayload.update = async (args: Record<string, unknown>) => {
        updated.push(args)
        return {}
      }
    }
  })
})

// ── Truncated transcripts ──────────────────────────────────────────────────

describe('transcribe.completed — a transcript too big for the webhook', () => {
  it('fetches the full text when the callback omitted it', async () => {
    // Above CALLBACK_MAX_TRANSCRIPT_CHARS audio-service sets `truncated` and
    // sends `text: null` rather than POSTing megabytes through a proxy that may
    // cap the body. Embedding the null would produce a `ready` document that
    // matches nothing.
    const body = completed({
      transcript: { truncated: true, text: null, language: 'es', segmentCount: 9000 },
    })
    await post(body, headersFor(body))
    expect(fetchTranscriptText).toHaveBeenCalledWith('tr_1')
    expect(written().extractedText).toBe('texto completo desde el GET')
  })

  it('fails the row visibly when the full text can no longer be fetched', async () => {
    // audio-service is Redis-only with a TTL. Past it the transcript is gone and
    // the audio must be re-uploaded — which the user can only do if they are
    // told.
    fetchTranscriptText.mockResolvedValueOnce(null as never)
    const body = completed({ transcript: { truncated: true, text: null } })
    await post(body, headersFor(body))
    expect(written()).toMatchObject({ ingestStatus: 'failed' })
    expect(ingestEnqueue).not.toHaveBeenCalled()
  })

  it('fails a recording with no speech in it rather than embedding nothing', async () => {
    fetchTranscriptText.mockResolvedValueOnce(null as never)
    const body = completed({ transcript: { text: '   ', truncated: false } })
    await post(body, headersFor(body))
    expect(written()).toMatchObject({ ingestStatus: 'failed' })
    expect(String(written().ingestError)).toContain('empty_transcript')
    // Still records what we learned about the audio — useful in a bug report.
    expect(written().audioMeta).toBeTruthy()
  })
})

// ── 🔴 Stale and duplicate callbacks ───────────────────────────────────────

describe('a superseded job cannot clobber a live one', () => {
  it('ignores a completed event whose transcribeId is not the one the row awaits', async () => {
    // A retry mints a new job while the old one may still be alive; both
    // callbacks name the same document. Without this guard a late event from an
    // abandoned attempt overwrites a good transcript minutes after the fact.
    findByIDImpl = async () => transcribingRow({ transcribeId: 'tr_2' })
    const body = completed({ transcribeId: 'tr_1' })
    await post(body, headersFor(body))
    expect(updated).toHaveLength(0)
    expect(ingestEnqueue).not.toHaveBeenCalled()
  })

  it('ignores a failed event from a superseded job', async () => {
    findByIDImpl = async () => transcribingRow({ transcribeId: 'tr_2' })
    const body = JSON.stringify({
      event: 'transcribe.failed',
      transcribeId: 'tr_1',
      externalId: '42',
      error: { code: 'abandoned', message: 'no worker touched it' },
    })
    await post(body, headersFor(body))
    expect(updated).toHaveLength(0)
  })

  it('ignores a row that never started a job', async () => {
    findByIDImpl = async () => transcribingRow({ transcribeId: null })
    const body = completed()
    await post(body, headersFor(body))
    expect(updated).toHaveLength(0)
  })

  it('ignores a repeat once the transcript is persisted and the row left `transcribing`', async () => {
    findByIDImpl = async () =>
      transcribingRow({ extractedText: 'ya estaba', ingestStatus: 'transcribed' })
    const body = completed()
    await post(body, headersFor(body))
    expect(updated).toHaveLength(0)
  })

  it('ignores a repeat of a completion already applied', async () => {
    // ⚠ The composite UNIQUE index on `aiServiceCallbacks` does not exist yet
    // (no migration baseline), so the dedupe insert upstream is inert. Without
    // this guard a redelivery enqueues a SECOND ingest for the same document.
    findByIDImpl = async () =>
      transcribingRow({ extractedText: 'ya estaba', ingestId: 'ing_old' })
    const body = completed()
    await post(body, headersFor(body))
    expect(updated).toHaveLength(0)
    expect(ingestEnqueue).not.toHaveBeenCalled()
  })
})

// ── transcribe.failed ──────────────────────────────────────────────────────

describe('transcribe.failed', () => {
  it('records the code and the message, and does NOT revert to pending', async () => {
    // A silent revert to `pending` reads as "still queued" and the user waits
    // forever for a job nobody is running. `failed` + a reason is the truth, and
    // it is what the retry button keys off.
    const body = JSON.stringify({
      event: 'transcribe.failed',
      transcribeId: 'tr_1',
      externalId: '42',
      error: { code: 'no_audio_stream', message: 'The file contains no audio stream' },
      attempts: 1,
    })
    await post(body, headersFor(body))
    expect(written()).toMatchObject({ ingestStatus: 'failed' })
    expect(String(written().ingestError)).toMatch(/^no_audio_stream: /)
    expect(JSON.stringify(updated)).not.toContain('pending')
  })

  it('handles a killed worker — the reconciler’s `abandoned`', async () => {
    // arq cancels a timed-out task with CancelledError, which no `except
    // Exception` catches, and a SIGKILL has no handler at all. audio-service's
    // reconciler is what turns that into a real terminal event; this is the
    // receiving end of it, and without it the row sits in `transcribing`.
    const body = JSON.stringify({
      event: 'transcribe.failed',
      transcribeId: 'tr_1',
      externalId: '42',
      error: { code: 'abandoned', message: 'no worker touched it for 600s' },
    })
    await post(body, headersFor(body))
    expect(String(written().ingestError)).toContain('abandoned')
  })

  it('survives an envelope with no error object at all', async () => {
    const body = JSON.stringify({
      event: 'transcribe.failed',
      transcribeId: 'tr_1',
      externalId: '42',
    })
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(200)
    expect(written()).toMatchObject({ ingestStatus: 'failed' })
  })

  it('ignores an event with no externalId rather than guessing a row', async () => {
    const body = JSON.stringify({ event: 'transcribe.failed', transcribeId: 'tr_1' })
    const res = await post(body, headersFor(body))
    expect(res.status).toBe(200)
    expect(updated).toHaveLength(0)
  })
})
