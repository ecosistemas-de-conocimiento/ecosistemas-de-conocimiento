/**
 * 🔴 The recording reaches audio-service as a stream, from either store.
 *
 * Audit I-10: `openMediaBlob` read the whole object into a Buffer, then a
 * Uint8Array, then a Blob — three copies of a recording of up to 200 MB in the
 * backend's heap. `openMediaStream` replaces it: object storage hands back the
 * S3 response stream, local disk a file-backed `fs.openAsBlob`. Neither path
 * may go through the whole-object readers (`getObjectBytes`, `readFile`).
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({
  on: false,
  getObjectBytes: vi.fn(async () => {
    throw new Error('buffered the whole object')
  }),
  openObjectStream: vi.fn(),
  close: vi.fn(),
}))
vi.mock('@/lib/storage/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage/client')>()),
  isStorageConfigured: () => storage.on,
  getObjectBytes: storage.getObjectBytes,
  openObjectStream: storage.openObjectStream,
}))

const fsSpies = vi.hoisted(() => ({
  readFile: vi.fn(),
  openAsBlob: vi.fn(),
  realOpenAsBlob: null as null | ((...a: unknown[]) => unknown),
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, default: { ...actual, readFile: fsSpies.readFile }, readFile: fsSpies.readFile }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  fsSpies.realOpenAsBlob = actual.openAsBlob as never
  return {
    ...actual,
    default: { ...actual, openAsBlob: fsSpies.openAsBlob },
    openAsBlob: fsSpies.openAsBlob,
  }
})

import { openMediaStream } from './Documents'

const SIZE = 300 * 1024 * 1024
const payload = {
  findByID: async () => ({ filename: 'voz.m4a', mimeType: 'audio/x-m4a', prefix: 'eco_1/u_2' }),
} as unknown as Parameters<typeof openMediaStream>[0]

let dir: string
beforeEach(() => {
  storage.on = false
  storage.getObjectBytes.mockClear()
  storage.close.mockClear()
  storage.openObjectStream.mockReset()
  fsSpies.readFile.mockReset()
  fsSpies.openAsBlob.mockReset()
  fsSpies.openAsBlob.mockImplementation((...a: unknown[]) => fsSpies.realOpenAsBlob!(...a))
  dir = mkdtempSync(join(tmpdir(), 'edc-media-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('🔴 openMediaStream — object storage', () => {
  it('streams the S3 object under its prefixed key, and never buffers it', async () => {
    storage.on = true
    const stream = new ReadableStream<Uint8Array>({ pull: () => {} })
    storage.openObjectStream.mockResolvedValue({
      size: SIZE,
      contentType: 'audio/x-m4a',
      stream: () => stream,
      close: storage.close,
    })
    const media = await openMediaStream(payload, 7)
    expect(storage.openObjectStream).toHaveBeenCalledWith('eco_1/u_2/voz.m4a')
    expect(storage.getObjectBytes).not.toHaveBeenCalled()
    expect(media.body.size).toBe(SIZE)
    expect(media.body).not.toBeInstanceOf(Blob)
    expect(media.body.stream()).toBe(stream)
    expect(media.filename).toBe('voz.m4a')
    media.close()
    expect(storage.close).toHaveBeenCalled()
  })

  it('a missing object fails with a message safe to store on the row', async () => {
    storage.on = true
    storage.openObjectStream.mockRejectedValue(new Error('NoSuchKey: eco_1/u_2/voz.m4a'))
    await expect(openMediaStream(payload, 7)).rejects.toThrow(/media 7/)
    await expect(openMediaStream(payload, 7)).rejects.not.toThrow(/voz\.m4a/)
  })
})

describe('🔴 openMediaStream — local disk', () => {
  it('opens a FILE-BACKED blob, never readFile', async () => {
    mkdirSync(join(dir, 'media'))
    writeFileSync(join(dir, 'media', 'voz.m4a'), 'audio bytes')
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    const media = await openMediaStream(payload, 7)
    expect(fsSpies.openAsBlob).toHaveBeenCalledWith(join(dir, 'media', 'voz.m4a'), {
      type: 'audio/x-m4a',
    })
    expect(fsSpies.readFile).not.toHaveBeenCalled()
    expect(media.body.size).toBe('audio bytes'.length)
    expect(await new Response(media.body.stream()).text()).toBe('audio bytes')
    media.close()
  })

  it('a missing file fails at open, before the row is marked `transcribing`', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    await expect(openMediaStream(payload, 7)).rejects.toThrow(/could not read the stored file for media 7/)
  })
})
