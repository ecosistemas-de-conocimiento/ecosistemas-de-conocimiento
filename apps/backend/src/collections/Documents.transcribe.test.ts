/**
 * Handing an audio document to audio-service, and what a retry costs.
 *
 * 🔴 The single most important property in this file is the one that is NOT
 * here: `startTranscription` must never call `enqueueIngestForDoc`. There is no
 * text yet, and enqueuing an empty document would have ai-service embed nothing,
 * flip the row to `ready`, and leave search permanently unable to find the
 * recording — a silent failure with a green badge on it. The test named
 * "never enqueues an ingest" is that guard.
 *
 * Second: **a failure has to be visible.** Every rejection path below asserts a
 * `failed` status AND a reason on the row. A row that stops at `transcribing`
 * with no error is indistinguishable from one still working, because a real
 * transcription legitimately takes as long as the recording does.
 *
 * `@/lib/aiClient` is mocked so an accidental ingest would be caught rather than
 * attempted; `@/lib/audioClient` is mocked at the submit boundary. `lib/corpus`
 * is NOT mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CALLBACK_BASE_URL_VAR, CALLBACK_SECRET_VAR } from '@/lib/callbackConfig'
import { planIngestRetry, startTranscription } from './Documents'

const SECRET = 'c'.repeat(64)

const ingestEnqueue = vi.fn(async () => ({ ingestId: 'ing_should_not_happen' }))
vi.mock('@/lib/aiClient', () => ({
  getAppAIClient: () => ({ ingest: { enqueue: ingestEnqueue } }),
}))

const submitTranscription = vi.fn(async (_req: Record<string, unknown>) => ({
  ok: true as const,
  transcribeId: 'tr_1',
  deduplicated: false,
  durationSeconds: 1834.2,
}))
vi.mock('@/lib/audioClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audioClient')>('@/lib/audioClient')
  return {
    ...actual,
    submitTranscription: (...args: unknown[]) =>
      (submitTranscription as unknown as (...a: unknown[]) => unknown)(...args),
  }
})

const updates: Array<Record<string, unknown>> = []
const fakePayload = {
  update: async (args: Record<string, unknown>) => {
    updates.push(args)
    return {}
  },
  findByID: async () => ({ filename: 'junta.m4a', mimeType: 'audio/x-m4a' }),
}

const openMedia = vi.fn(async () => ({
  body: new Blob(['audio']),
  filename: 'junta.m4a',
  contentType: 'audio/x-m4a',
}))

const run = (fresh: Record<string, unknown> = {}) =>
  startTranscription({
    payload: fakePayload as unknown as Parameters<typeof startTranscription>[0]['payload'],
    docId: 42,
    fresh: {
      name: 'Junta de agosto',
      kind: 'audio',
      mediaFile: 7,
      organization: 10,
      uploadedBy: 3,
      ...fresh,
    },
    openMedia: openMedia as unknown as Parameters<typeof startTranscription>[0]['openMedia'],
  })

/** Everything written to the row, flattened. */
const written = (): Record<string, unknown> =>
  Object.assign({}, ...updates.map((u) => u.data as Record<string, unknown>))

const submitArgs = (): Record<string, unknown> => submitTranscription.mock.calls[0]![0]

beforeEach(() => {
  updates.length = 0
  ingestEnqueue.mockClear()
  submitTranscription.mockClear()
  openMedia.mockClear()
  vi.stubEnv(CALLBACK_SECRET_VAR, SECRET)
  vi.stubEnv(CALLBACK_BASE_URL_VAR, 'https://backend.test')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// ── The happy path ─────────────────────────────────────────────────────────

describe('startTranscription', () => {
  it('marks the row `transcribing` BEFORE the network call', async () => {
    // Order matters: audio-service can take seconds to answer and the job then
    // runs for an hour. A row that only turns `transcribing` after the response
    // shows the user nothing at all during the part they are watching.
    await run()
    expect(updates[0]).toMatchObject({ data: { ingestStatus: 'transcribing' } })
  })

  it('records the transcribeId and the duration known at 202', async () => {
    await run()
    const data = written()
    expect(data.transcribeId).toBe('tr_1')
    // ⚠ The duration is what lets the UI quote an honest wait WHILE the job
    // runs. Losing it downgrades the UI to an indeterminate spinner on a job
    // that can last an hour.
    expect(data.audioMeta).toMatchObject({ durationSeconds: 1834.2 })
  })

  it('sends the document id as the join key and the callback URL verbatim', async () => {
    await run()
    expect(submitArgs()).toMatchObject({
      externalId: '42',
      callbackUrl: 'https://backend.test/api/ai-service/callback',
      language: 'es',
    })
  })

  it('puts the attempt number in the idempotency key', async () => {
    // ⚠ Without it, a retry re-uses the key, audio-service hands back the
    // ORIGINAL failed job, and the retry silently does nothing at all.
    await run({ transcribeAttempt: 0 })
    expect(submitArgs().idempotencyKey).toBe('doc-42-a0')

    updates.length = 0
    submitTranscription.mockClear()
    await run({ transcribeAttempt: 3 })
    expect(submitArgs().idempotencyKey).toBe('doc-42-a3')
  })

  it('🔴 NEVER enqueues an ingest — there is no text yet', async () => {
    await run()
    expect(ingestEnqueue).not.toHaveBeenCalled()
    expect(JSON.stringify(updates)).not.toContain('ingestId')
    expect(JSON.stringify(updates)).not.toContain('embedding')
  })

  it('🔴 never names a corpus', async () => {
    // The corpus is resolved once, in `enqueueIngestForDoc`, from the row. A
    // second place that builds one is a second place to get tenancy wrong.
    await run()
    expect(JSON.stringify(submitArgs())).not.toMatch(/corpus|eco-/i)
  })

  it('sends the tenant ids only as decorative metadata', async () => {
    await run()
    expect(submitArgs().metadata).toMatchObject({
      docId: '42',
      organizationId: '10',
      uploadedById: '3',
    })
  })
})

// ── Idempotency ────────────────────────────────────────────────────────────

describe('re-entrancy', () => {
  it('does nothing when a job is already running for this row', async () => {
    // The afterChange hook re-fires on every save, including the saves this
    // function makes. One job per document per attempt, or every re-save costs
    // another full transcription.
    await run({ transcribeId: 'tr_already' })
    expect(submitTranscription).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })
})

// ── Failure is visible ─────────────────────────────────────────────────────

describe('failures are visible and carry a reason', () => {
  it('fails the row when callbacks are not configured, instead of hanging', async () => {
    // 🔴 Audio diverges from the PDF path here ON PURPOSE. A PDF with no
    // callback still gets its text and its chunks; only the status flip is lost.
    // For audio the callback IS the delivery mechanism, so without it the row
    // would sit in `transcribing` forever with nothing able to move it.
    vi.stubEnv(CALLBACK_BASE_URL_VAR, '')
    await run()
    expect(submitTranscription).not.toHaveBeenCalled()
    expect(written()).toMatchObject({ ingestStatus: 'failed' })
    expect(String(written().ingestError)).toContain('callbacks_not_configured')
  })

  it('fails the row when the media file cannot be read', async () => {
    openMedia.mockRejectedValueOnce(new Error('ENOENT'))
    await run()
    expect(written()).toMatchObject({ ingestStatus: 'failed' })
    expect(String(written().ingestError)).toContain('media_unreadable')
  })

  it('fails the row when the document has no audio file at all', async () => {
    await run({ mediaFile: null })
    expect(written()).toMatchObject({ ingestStatus: 'failed' })
    expect(String(written().ingestError)).toContain('no_media')
  })

  it('records audio-service’s own code so the UI can translate it', async () => {
    submitTranscription.mockResolvedValueOnce({
      ok: false,
      permanent: true,
      code: 'unsupported_media_type',
      message: 'The file contains no audio stream',
    } as never)
    await run()
    expect(written()).toMatchObject({ ingestStatus: 'failed' })
    // The leading code is the stable part the frontend switches on; the English
    // message rides along as a detail line, never as the primary explanation.
    expect(String(written().ingestError)).toMatch(/^unsupported_media_type: /)
  })

  it('fails rather than retrying on an infrastructure error', async () => {
    // audio-service owns retries. A retry from this side would double-transcribe
    // and pay the CPU-hours twice for one recording.
    submitTranscription.mockResolvedValueOnce({
      ok: false,
      permanent: false,
      code: 'audio_service_unreachable',
      message: 'ECONNREFUSED',
    } as never)
    await run()
    expect(submitTranscription).toHaveBeenCalledOnce()
    expect(written()).toMatchObject({ ingestStatus: 'failed' })
  })

  it('truncates a long reason so one error cannot bloat the row', async () => {
    submitTranscription.mockResolvedValueOnce({
      ok: false,
      permanent: true,
      code: 'bad_request',
      message: 'x'.repeat(5000),
    } as never)
    await run()
    expect(String(written().ingestError).length).toBeLessThanOrEqual(500)
  })
})

// ── Retry ──────────────────────────────────────────────────────────────────

describe('planIngestRetry — 🔴 what a retry actually costs', () => {
  it('re-enqueues the INGEST ONLY when the text already exists', async () => {
    // ⚠ The expensive mistake this prevents. If the transcript succeeded and
    // only the ai-service ingest failed, clearing `extractedText` would throw
    // away a finished transcription and re-run the recording through Whisper —
    // CPU-hours to redo work that worked.
    const plan = planIngestRetry({
      kind: 'audio',
      ingestStatus: 'failed',
      extractedText: 'la junta empezó a las diez',
      transcribeAttempt: 0,
    })
    expect(plan).toMatchObject({ ingestStatus: 'pending', ingestError: null, ingestId: null })
    expect(plan).not.toHaveProperty('transcribeId')
    // ⚠ A retry is also the ONLY way out of an anonymisation hold, so it clears
    // the gate's verdict — `runExtractAndIngest` refuses to re-gate a `held` row
    // on any other save, which is what stops a rename from being a free retry.
    expect(plan).toMatchObject({ anonymisationStatus: 'n/a', anonymisationError: null })
  })

  it('starts over, with a NEW idempotency key, when there is no text', () => {
    const plan = planIngestRetry({
      kind: 'audio',
      ingestStatus: 'failed',
      extractedText: '',
      transcribeAttempt: 2,
    })
    expect(plan).toMatchObject({
      ingestStatus: 'pending',
      transcribeId: null,
      // ⚠ Bumped. An unchanged attempt number means an unchanged idempotency
      // key, which means audio-service hands back the failed job and the user's
      // retry does nothing.
      transcribeAttempt: 3,
    })
  })

  it('treats whitespace-only text as no text', () => {
    const plan = planIngestRetry({ kind: 'audio', ingestStatus: 'failed', extractedText: '   ' })
    expect(plan).toHaveProperty('transcribeId', null)
  })

  it.each(['pending', 'transcribing', 'transcribed', 'embedding', 'ready'])(
    'refuses to retry a document in `%s`',
    (status) => {
      // Re-running a job that is still going would double-transcribe and leave
      // two callbacks racing for one row.
      expect(planIngestRetry({ kind: 'audio', ingestStatus: status })).toBeNull()
    },
  )

  it('refuses a markdown note, which never had a pipeline', () => {
    expect(planIngestRetry({ kind: 'markdown', ingestStatus: 'failed' })).toBeNull()
  })

  it('works for pdf and docx too — the retry path is not audio-specific', () => {
    expect(planIngestRetry({ kind: 'pdf', ingestStatus: 'failed' })).not.toBeNull()
    expect(planIngestRetry({ kind: 'docx', ingestStatus: 'failed' })).not.toBeNull()
  })
})
