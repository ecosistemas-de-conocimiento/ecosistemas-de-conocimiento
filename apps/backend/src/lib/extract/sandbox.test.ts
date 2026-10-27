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

import { afterEach, describe, expect, it, vi } from 'vitest'

import { extractInWorker, extractLoad } from './sandbox'
import { testXlsx, testZip } from './testZip'

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

  it('🔴 a worker whose heap + external memory passes maxWorkerMb is killed: extract_too_large', async () => {
    const depth = 200_000
    const html = enc('<div>'.repeat(depth) + 'hondo' + '</div>'.repeat(depth))
    await expect(
      extractInWorker('html', html, { maxChars: 2_000_000, maxWorkerMb: 1 }),
    ).rejects.toThrow(/^extract_too_large: .*MB/)
  }, 15_000)

  it('🔴 a DOCX whose document.xml declares 1.5 GB is refused before mammoth unzips it', async () => {
    const bomb = testZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document/>', declaredSize: 1_500_000_000 },
    ])
    await expect(extractInWorker('docx', bomb, { maxChars: 2_000_000 })).rejects.toThrow(/^extract_too_large/)
  })

  it('🔴 an XLSX with a benign sheet and a huge junk entry is refused', async () => {
    const bomb = testXlsx([{ path: 'worksheets/s0.xml', ref: 'A1' }], [
      { name: 'xl/junk.xml', data: ' '.repeat(60_000_000) },
    ])
    await expect(extractInWorker('xlsx', bomb, { maxChars: 2_000_000 })).rejects.toThrow(/^extract_too_large/)
  }, 15_000)
})

describe('🔴 extractInWorker concurrency (re-audit 2026-10-26: 4 parallel uploads killed a 2 GB process)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('runs at most EXTRACT_MAX_CONCURRENCY workers; the rest wait their turn', async () => {
    vi.stubEnv('EXTRACT_MAX_CONCURRENCY', '1')
    vi.stubEnv('EXTRACT_MAX_QUEUE', '5')
    const jobs = [1, 2, 3].map((n) => extractInWorker('csv', enc(`a,${n}\n`), { maxChars: 100 }))
    expect(extractLoad()).toEqual({ running: 1, queued: 2 })
    await expect(Promise.all(jobs)).resolves.toEqual(['a | 1', 'a | 2', 'a | 3'])
    expect(extractLoad()).toEqual({ running: 0, queued: 0 })
  })

  it('past EXTRACT_MAX_QUEUE a job fails fast with extract_busy, and the others still finish', async () => {
    vi.stubEnv('EXTRACT_MAX_CONCURRENCY', '1')
    vi.stubEnv('EXTRACT_MAX_QUEUE', '1')
    const ok1 = extractInWorker('csv', enc('a\n'), { maxChars: 100 })
    const ok2 = extractInWorker('csv', enc('b\n'), { maxChars: 100 })
    await expect(extractInWorker('csv', enc('c\n'), { maxChars: 100 })).rejects.toThrow(/^extract_busy/)
    await expect(Promise.all([ok1, ok2])).resolves.toEqual(['a', 'b'])
  })

  it('🔴 a loader runs only once a slot is free: a queued job holds no bytes', async () => {
    vi.stubEnv('EXTRACT_MAX_CONCURRENCY', '1')
    const loads: string[] = []
    const loader = (s: string) => async () => (loads.push(s), enc(`${s}\n`))
    const first = extractInWorker('csv', loader('a'), { maxChars: 100 })
    const second = extractInWorker('csv', loader('b'), { maxChars: 100 })
    await new Promise((r) => setTimeout(r, 0))
    expect(loads).toEqual(['a'])
    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b'])
    expect(loads).toEqual(['a', 'b'])
  })

  it('a failing loader frees its slot', async () => {
    vi.stubEnv('EXTRACT_MAX_CONCURRENCY', '1')
    await expect(
      extractInWorker('csv', async () => Promise.reject(new Error('storage_unreachable: x')), { maxChars: 100 }),
    ).rejects.toThrow(/^storage_unreachable/)
    await expect(extractInWorker('csv', enc('a\n'), { maxChars: 100 })).resolves.toBe('a')
  })

  it('a failing job frees its slot', async () => {
    vi.stubEnv('EXTRACT_MAX_CONCURRENCY', '1')
    await expect(extractInWorker('csv', enc('a,b\n'.repeat(100)), { maxChars: 5 })).rejects.toThrow(/^text_too_long/)
    await expect(extractInWorker('csv', enc('a\n'), { maxChars: 100 })).resolves.toBe('a')
  })
})
