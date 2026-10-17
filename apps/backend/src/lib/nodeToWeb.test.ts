/**
 * 🔴 `nodeToWeb` survives a cancel while the source still holds data.
 *
 * On Node 22 and 24, `Readable.toWeb` throws an uncaught "Controller is already
 * closed" in exactly the first case below, which would crash the backend when
 * an upload to audio-service is aborted mid-body. See the module header.
 */

import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { nodeToWeb } from './nodeToWeb'

const tick = () => new Promise((r) => setTimeout(r, 20))
const uncaught: unknown[] = []
const onUncaught = (err: unknown) => uncaught.push(err)

beforeEach(() => {
  uncaught.length = 0
  process.on('uncaughtException', onUncaught)
})
afterEach(() => {
  process.off('uncaughtException', onUncaught)
})

/** A source with `n` chunks already buffered, as a socket-fed body has. */
function buffered(n: number) {
  const r = new Readable({ read() {} })
  for (let i = 0; i < n; i++) r.push(Buffer.alloc(1 << 16, 0x61))
  return r
}

describe('🔴 nodeToWeb — cancel with buffered data', () => {
  it('cancels without an uncaught enqueue-after-close, and destroys the source', async () => {
    const src = buffered(20)
    const reader = nodeToWeb(src).getReader()
    await reader.read()
    await reader.read()
    await reader.cancel()
    src.destroy()
    await tick()
    expect(uncaught).toEqual([])
    expect(src.destroyed).toBe(true)
  })

  it('reads nothing before the first pull', async () => {
    let produced = 0
    const src = new Readable({
      read() {
        produced++
        this.push(Buffer.alloc(1))
      },
    })
    nodeToWeb(src)
    await tick()
    expect(produced).toBe(0)
    src.destroy()
  })

  it('delivers every byte as plain Uint8Array and then closes', async () => {
    const src = Readable.from([Buffer.from('ab'), Buffer.from('cd')], { objectMode: false })
    const reader = nodeToWeb(src).getReader()
    const parts: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      expect(value.constructor).toBe(Uint8Array)
      parts.push(value)
    }
    expect(Buffer.concat(parts).toString()).toBe('abcd')
  })

  it('errors the web stream when the source errors or is destroyed early', async () => {
    const failing = buffered(0)
    const r1 = nodeToWeb(failing).getReader()
    const p1 = r1.read()
    failing.destroy(new Error('boom'))
    await expect(p1).rejects.toThrow('boom')

    const dropped = buffered(0)
    const r2 = nodeToWeb(dropped).getReader()
    const p2 = r2.read()
    dropped.destroy()
    await expect(p2).rejects.toThrow(/closed before it ended/)
  })
})
