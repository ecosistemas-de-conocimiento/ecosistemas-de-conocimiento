/**
 * `postStreaming` against a real local HTTP server.
 *
 * 🔴 The property that matters is BACKPRESSURE: while the server is not
 * reading, the source must not be read ahead. Node 22's `fetch` failed exactly
 * this — it held a streamed body in memory (see the module header).
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { postStreaming } from './streamingPost'

const CHUNK = 64 * 1024

/** A body of `size` bytes, generated as pulled. `state.pulled` counts bytes handed out. */
function source(size: number) {
  const state = { pulled: 0 }
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (state.pulled >= size) return c.close()
        const n = Math.min(CHUNK, size - state.pulled)
        state.pulled += n
        c.enqueue(new Uint8Array(n).fill(0x61))
      },
    },
    { highWaterMark: 0 },
  )
  return { body, state }
}

let server: http.Server | null = null
async function listen(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler)
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/up`
}
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise((r) => server?.close(r) ?? r(null))
  server = null
})

describe('postStreaming', () => {
  it('delivers the whole body with the declared length, and returns the answer', async () => {
    let seen = { length: '', bytes: 0, auth: '' }
    const url = await listen((req, res) => {
      seen.length = String(req.headers['content-length'])
      seen.auth = String(req.headers.authorization)
      req.on('data', (c: Buffer) => (seen.bytes += c.length))
      req.on('end', () => {
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ transcribeId: 'tr_1' }))
      })
    })
    const { body } = source(3 * 1024 * 1024 + 5)
    const res = await postStreaming(url, {
      headers: { 'Content-Length': String(3 * 1024 * 1024 + 5), Authorization: 'Bearer k' },
      body,
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ transcribeId: 'tr_1' })
    expect(seen).toEqual({ length: String(3 * 1024 * 1024 + 5), bytes: 3 * 1024 * 1024 + 5, auth: 'Bearer k' })
  })

  it('🔴 does not read ahead of a server that is not reading', async () => {
    const SIZE = 256 * 1024 * 1024
    let request: http.IncomingMessage | null = null
    const url = await listen((req, res) => {
      request = req
      req.pause()
      req.on('end', () => res.end('{}'))
    })
    const { body, state } = source(SIZE)
    const done = postStreaming(url, { headers: { 'Content-Length': String(SIZE) }, body })
    await new Promise((r) => setTimeout(r, 300))
    // Socket buffers on both ends hold a few MB at most; never the body.
    expect(state.pulled).toBeLessThan(32 * 1024 * 1024)
    request!.resume()
    const res = await done
    expect(res.status).toBe(200)
    expect(state.pulled).toBe(SIZE)
  })

  it('rejects when nothing is listening — the caller turns that into a value', async () => {
    const url = await listen(() => {})
    const dead = url
    server!.close()
    await new Promise((r) => setTimeout(r, 10))
    const { body } = source(10)
    await expect(postStreaming(dead, { headers: {}, body })).rejects.toThrow()
  })

  it('an early answer (413 before the body is read) still comes back as a status', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ error: 'payload_too_large' }))
    })
    const { body } = source(64 * 1024 * 1024)
    const res = await postStreaming(url, { headers: { 'Content-Length': String(64 * 1024 * 1024) }, body })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload_too_large' })
  })
})
