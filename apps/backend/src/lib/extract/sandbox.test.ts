/**
 * 🔴 EVERY EXTRACTOR RUNS IN A WORKER THAT MAY DIE; THE SERVER MAY NOT.
 *
 * Regression for the audit of 2026-10-26: a 1.5 KB XLSX ran the backend out of
 * heap and aborted the process, and a deeply nested HTML page held the main
 * thread for 40 s. These tests pass only if the work happens off the main
 * thread and a dead or stuck worker comes back as a short, stable reason.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractInWorker } from './sandbox'

const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name))
const enc = (s: string) => Buffer.from(s, 'utf8')

/** Runs `job` while a 10 ms timer ticks; returns the longest gap between ticks. */
async function longestStall<T>(job: () => Promise<T>): Promise<{ result: PromiseSettledResult<T>; stallMs: number }> {
  let last = performance.now()
  let stallMs = 0
  const timer = setInterval(() => {
    const now = performance.now()
    stallMs = Math.max(stallMs, now - last)
    last = now
  }, 10)
  const [result] = await Promise.allSettled([job()])
  clearInterval(timer)
  return { result, stallMs: Math.max(stallMs, performance.now() - last) }
}

describe('extractInWorker', () => {
  it('returns the text of an ordinary file', async () => {
    await expect(extractInWorker('csv', enc('a,b\n1,2\n'), { maxChars: 100 })).resolves.toBe('a | b\n1 | 2')
  })

  it('extracts a markdown note in the worker too', async () => {
    await expect(
      extractInWorker('markdown', enc('---\ntags: [a]\n---\nVer [[Freire|Paulo]].\n'), { maxChars: 100 }),
    ).resolves.toBe('Ver Paulo.')
  })

  it('passes an extractor error through with its message', async () => {
    await expect(
      extractInWorker('csv', enc('a,b\n'.repeat(100)), { maxChars: 50 }),
    ).rejects.toThrow(/^text_too_long/)
  })

  it('refuses the far-cell XLSX as extract_too_large', async () => {
    await expect(extractInWorker('xlsx', fixture('celda-lejana.xlsx'), { maxChars: 2_000_000 })).rejects.toThrow(
      /^extract_too_large/,
    )
  })

  it('keeps the main thread responsive while a worker parses deep HTML', async () => {
    const depth = 200_000
    const html = enc('<div>'.repeat(depth) + 'hondo' + '</div>'.repeat(depth))
    const { result, stallMs } = await longestStall(() => extractInWorker('html', html, { maxChars: 2_000_000 }))
    expect(result).toEqual({ status: 'fulfilled', value: 'hondo' })
    expect(stallMs).toBeLessThan(250)
  })

  it('kills a worker past the wall clock: extract_timeout', async () => {
    await expect(
      extractInWorker('csv', enc('a,b\n'), { maxChars: 100, timeoutMs: 1 }),
    ).rejects.toThrow(/^extract_timeout/)
  })

  it('a worker that runs out of heap is extract_too_large, and this process lives on', async () => {
    // 4 MB of one CSV field: the decoded string, the field and the line are
    // each a copy, far past an 8 MB old generation.
    const big = Buffer.alloc(4_000_000, 0x61)
    await expect(
      extractInWorker('csv', big, { maxChars: 100_000_000, maxHeapMb: 8 }),
    ).rejects.toThrow(/^extract_too_large/)
  }, 15_000)
})
