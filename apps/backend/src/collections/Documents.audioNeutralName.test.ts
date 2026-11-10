/**
 * 🔴 NO NAME LEAVES FOR audio-service (audit 2026-11-10, C-11). It keeps the
 * title and filename (24 h, quoted from its `config.py`) and echoes both in
 * every callback, and an upload's name is often the speaker's. Only the
 * extension goes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CALLBACK_BASE_URL_VAR, CALLBACK_SECRET_VAR } from '@/lib/callbackConfig'
import { neutralAudioFilename, startTranscription } from './Documents'

vi.mock('@/lib/aiClient', () => ({ getAppAIClient: () => ({ ingest: { enqueue: vi.fn() } }) }))

const submitTranscription = vi.fn(async (_req: Record<string, unknown>) => ({
  ok: true as const,
  transcribeId: 'tr_1',
  deduplicated: false,
  durationSeconds: 1,
}))
vi.mock('@/lib/audioClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audioClient')>('@/lib/audioClient')
  return {
    ...actual,
    submitTranscription: (...args: unknown[]) =>
      (submitTranscription as unknown as (...a: unknown[]) => unknown)(...args),
  }
})

const NAME = 'Testimonio de María López, Juchitán'

beforeEach(() => {
  submitTranscription.mockClear()
  vi.stubEnv(CALLBACK_SECRET_VAR, 'c'.repeat(64))
  vi.stubEnv(CALLBACK_BASE_URL_VAR, 'https://backend.test')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('startTranscription sends audio-service no name', () => {
  it('a null title and `audio.<ext>` as the filename', async () => {
    await startTranscription({
      payload: { update: async () => ({}), findByID: async () => ({}) } as never,
      docId: 42,
      fresh: { name: NAME, kind: 'audio', mediaFile: 7, organization: 10, uploadedBy: 3 },
      openMedia: (async () => ({
        body: new Blob(['audio']),
        filename: `${NAME}.M4A`,
        contentType: 'audio/x-m4a',
        close: () => {},
      })) as never,
    })
    const sent = submitTranscription.mock.calls[0]![0]
    expect(sent.title).toBeNull()
    expect(sent.filename).toBe('audio.m4a')
    expect(JSON.stringify(sent)).not.toMatch(/María|López|Juchitán|Testimonio/)
  })
})

describe('neutralAudioFilename', () => {
  it.each([
    ['voz.webm', 'audio.webm'],
    ['a.b.OGG', 'audio.ogg'],
    ['sin extension', 'audio'],
    ['', 'audio'],
    [null, 'audio'],
    ['x.not-an-ext', 'audio'],
    // A dot inside the name is not an extension (audit 2026-11-10).
    ['Testimonio de M.Lopez', 'audio'],
    ['Entrevista J.Perez', 'audio'],
  ])('%s → %s', (input, out) => {
    expect(neutralAudioFilename(input)).toBe(out)
  })

  it.each([
    ['Testimonio de M.Lopez', 'audio/mpeg', 'audio.mp3'],
    ['voz', 'audio/webm;codecs=opus', 'audio.webm'],
    ['grabacion.M4A', 'audio/mpeg', 'audio.m4a'],
    ['Testimonio de M.Lopez', 'application/octet-stream', 'audio'],
    ['clip.Lopez', 'video/quicktime', 'audio.mov'],
  ])('%s (%s) → %s', (input, mime, out) => {
    expect(neutralAudioFilename(input, mime)).toBe(out)
  })
})
