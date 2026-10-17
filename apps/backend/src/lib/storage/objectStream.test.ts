/**
 * 🔴 `openObjectStream` hands back the object as a stream, never as bytes.
 *
 * Audit I-10: the transcription path used to read a whole recording (up to the
 * 200 MB upload cap) into a Buffer, copy it into a Uint8Array, and copy it again
 * into a Blob. These pin that the S3 read stays a stream: the SDK's buffering
 * helper is never called, and nothing is read until the consumer pulls.
 */

import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SIZE = 300 * 1024 * 1024
const CHUNK = 1 << 20
const state = { produced: 0, destroyed: false }
const transformToByteArray = vi.fn(async () => {
  throw new Error('buffered the whole object')
})
let response: Record<string, unknown> = {}

function lazyBody() {
  const readable = Readable.from(
    (function* () {
      while (state.produced < SIZE) {
        state.produced += CHUNK
        yield Buffer.alloc(CHUNK, 0x61)
      }
    })(),
    { objectMode: false },
  )
  readable.on('close', () => (state.destroyed = true))
  return Object.assign(readable, {
    transformToByteArray,
    transformToWebStream: () => Readable.toWeb(readable) as ReadableStream<Uint8Array>,
  })
}

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    async send() {
      return response
    }
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}))

import { openObjectStream } from './client'

beforeEach(() => {
  state.produced = 0
  state.destroyed = false
  transformToByteArray.mockClear()
  response = { Body: lazyBody(), ContentLength: SIZE, ContentType: 'audio/x-m4a' }
  vi.stubEnv('S3_ENDPOINT', 'http://rustfs.test:9000')
  vi.stubEnv('S3_ACCESS_KEY_ID', 'k')
  vi.stubEnv('S3_SECRET_ACCESS_KEY', 's')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('🔴 openObjectStream — a 300 MB object is not read into memory', () => {
  it('returns a lazy web stream and the declared size, and buffers nothing', async () => {
    const obj = await openObjectStream('eco_1/u_2/voz.m4a')
    expect(obj.size).toBe(SIZE)
    expect(obj.contentType).toBe('audio/x-m4a')
    expect(obj.stream()).toBeInstanceOf(ReadableStream)
    expect(transformToByteArray).not.toHaveBeenCalled()
    // Readable.from may pre-read one chunk; never the object.
    expect(state.produced).toBeLessThanOrEqual(2 * CHUNK)
    obj.close()
  })

  it('reads chunk by chunk as the consumer pulls', async () => {
    const obj = await openObjectStream('k')
    const reader = obj.stream().getReader()
    await reader.read()
    await reader.read()
    expect(state.produced).toBeLessThan(8 * CHUNK)
    await reader.cancel()
    obj.close()
  })

  it('close() releases the connection even if the stream was never read', async () => {
    const obj = await openObjectStream('k')
    obj.close()
    await new Promise((r) => setImmediate(r))
    expect(state.destroyed).toBe(true)
  })

  it('refuses an object with no body or no length rather than guessing', async () => {
    response = { ContentLength: SIZE }
    await expect(openObjectStream('k')).rejects.toThrow(/no body/)
    response = { Body: lazyBody() }
    await expect(openObjectStream('k')).rejects.toThrow(/no length/)
  })
})
