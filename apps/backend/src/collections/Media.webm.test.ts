/**
 * Live-mic recordings are WebM/Opus, which file-type sniffs as `video/webm`.
 * Payload rejected every one on dev (2026-10-24, 400 on Stop) because that type
 * was not allowed. Media now allows it, and `audioOnlyWebm` refuses any WebM
 * that really carries video.
 */

import { describe, expect, it } from 'vitest'

import { MEDIA_MIME_TYPES, audioOnlyWebm } from './Media'

const EBML = [0x1a, 0x45, 0xdf, 0xa3, 0, 0]
const codec = (id: string) => [0x86, 0x80 | id.length, ...Buffer.from(id)]

const run = (file: unknown, data: Record<string, unknown> = { alt: 'x' }) =>
  (audioOnlyWebm as (a: unknown) => Promise<unknown>)({ data, req: { file } })

describe('Media accepts the recorder WebM', () => {
  it('allows video/webm, the type file-type sniffs for it', () => {
    expect(MEDIA_MIME_TYPES).toContain('video/webm')
  })
})

describe('audioOnlyWebm', () => {
  it('passes an audio-only WebM and stores it as audio/webm', async () => {
    const data = { mimeType: 'video/webm' }
    const out = (await run({ data: Buffer.from([...EBML, ...codec('A_OPUS')]) }, data)) as {
      mimeType: string
    }
    expect(out.mimeType).toBe('audio/webm')
  })

  it('🔴 refuses a WebM with a video track', async () => {
    const file = { data: Buffer.from([...EBML, ...codec('A_OPUS'), ...codec('V_VP8')]) }
    await expect(run(file, { mimeType: 'video/webm' })).rejects.toThrow()
  })

  it('refuses a WebM with no audio track', async () => {
    await expect(run({ data: Buffer.from(EBML) }, { mimeType: 'video/webm' })).rejects.toThrow()
  })

  it('leaves non-Matroska uploads and metadata-only updates alone', async () => {
    const pdf = { data: Buffer.from('%PDF-1.7') }
    expect(await run(pdf, { mimeType: 'application/pdf' })).toEqual({ mimeType: 'application/pdf' })
    expect(await run(undefined)).toEqual({ alt: 'x' })
  })
})
