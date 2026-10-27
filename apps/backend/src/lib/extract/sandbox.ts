/**
 * 🔴 EVERY EXTRACTOR RUNS IN A WORKER THREAD THAT IS ALLOWED TO DIE.
 *
 * Extraction used to run in the server's own thread (`Documents.ts`'s
 * `void runExtractAndIngest(row)`). The audit of 2026-10-26 found a 1.5 KB XLSX
 * that ran Node out of heap and ABORTED THE PROCESS, and an HTML page that held
 * the event loop for 40 s. Parsers of hostile formats will keep having bugs
 * like that; this module makes each one cost one failed document, not the
 * server.
 *
 *   · one Worker per file, its old generation capped at `maxHeapMb`, its young
 *     generation and stack capped too;
 *   · 🔴 AT MOST `EXTRACT_MAX_CONCURRENCY` (default 2) WORKERS AT ONCE, process
 *     wide. Re-audit 2026-10-26: every upload spawned its own ~600 MB worker,
 *     and four parallel 1.4 KB XLSX killed a 2 GB process. Others wait in a
 *     queue of `EXTRACT_MAX_QUEUE` (default 32); past it a job fails at once
 *     with `extract_busy: …` — a failed extraction, retryable like any other;
 *   · 🔴 A MEMORY WATCHDOG: the heap cap does not see Buffers (inflated zip
 *     entries live outside the V8 heap — the 1.5 MB DOCX holding 1.5 GB of XML).
 *     Every `WATCH_MS` the worker's heap + external memory is read; past
 *     `maxWorkerMb` (`EXTRACT_MAX_WORKER_MB`, default 640) it is terminated;
 *   · a wall clock: past `timeoutMs` the worker is terminated;
 *   · out of heap or memory → `extract_too_large: …`
 *     past timeout → `extract_timeout: …`
 *     any other death → `extract_failed: …`
 *     an extractor's own error keeps its message (`text_too_long: …`).
 *
 * ⚠ The watchdog samples, so a worker can overshoot `maxWorkerMb` by what it
 * allocates in one `WATCH_MS` — and one native call (a single `inflateSync`)
 * is not interrupted at all. That is why `./zipGuard.ts` refuses bombs from
 * the zip directory before any unzipper runs.
 *
 * ⚠ The worker entry is `worker.mjs`, found ON DISK from the working directory
 * (`apps/backend`, as in the runtime image and in tests). It is not bundled:
 * `new URL(…, import.meta.url)` would make webpack copy it away from the
 * TypeScript it loads through tsx.
 */

import path from 'node:path'
import { Worker } from 'node:worker_threads'

import { ExtractTooLargeError } from './text'

export type ExtractKind = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'html' | 'markdown'

export const EXTRACT_TIMEOUT_MS = 60_000
export const EXTRACT_MAX_HEAP_MB = 512
export const EXTRACT_MAX_CONCURRENCY_VAR = 'EXTRACT_MAX_CONCURRENCY'
export const EXTRACT_MAX_QUEUE_VAR = 'EXTRACT_MAX_QUEUE'
export const EXTRACT_MAX_WORKER_MB_VAR = 'EXTRACT_MAX_WORKER_MB'
const DEFAULT_CONCURRENCY = 2
const DEFAULT_QUEUE = 32
const DEFAULT_WORKER_MB = 640
const WATCH_MS = 25

const positiveIntFromEnv = (name: string, fallback: number): number => {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}

// ── The process-wide slot pool. ──────────────────────────────────────────────
let running = 0
const waiting: Array<() => void> = []

/** Workers running and jobs waiting, for tests and logs. */
export function extractLoad(): { running: number; queued: number } {
  return { running, queued: waiting.length }
}

/** A slot, or `extract_busy` at once when the queue is full. Release exactly once. */
function acquireSlot(): Promise<() => void> {
  let released = false
  const release = () => {
    if (released) return
    released = true
    const next = waiting.shift()
    if (next) next()
    else running--
  }
  // Read per call, so a deploy (or a test) can change them without a restart of this module.
  if (running < positiveIntFromEnv(EXTRACT_MAX_CONCURRENCY_VAR, DEFAULT_CONCURRENCY)) {
    running++
    return Promise.resolve(release)
  }
  const maxQueue = positiveIntFromEnv(EXTRACT_MAX_QUEUE_VAR, DEFAULT_QUEUE)
  if (waiting.length >= maxQueue) {
    return Promise.reject(
      new Error(`extract_busy: ${running} extractions running and ${waiting.length} waiting; retry later`),
    )
  }
  // A woken waiter inherits the releaser's slot: `running` is unchanged.
  return new Promise((resolve) => waiting.push(() => resolve(release)))
}

const workerPath = () => path.join(process.cwd(), 'src/lib/extract/worker.mjs')

type Reply = { ok: true; text: string } | { ok: false; message: string }

/**
 * `bytes` may be a loader: it then runs only once a slot is free, so a queued
 * job holds no file in this process's memory while it waits.
 */
export async function extractInWorker(
  kind: ExtractKind,
  bytes: Uint8Array | (() => Promise<Uint8Array>),
  opts: { maxChars: number; timeoutMs?: number; maxHeapMb?: number; maxWorkerMb?: number },
): Promise<string> {
  const release = await acquireSlot()
  try {
    return await runWorker(kind, typeof bytes === 'function' ? await bytes() : bytes, opts)
  } finally {
    release()
  }
}

function runWorker(
  kind: ExtractKind,
  bytes: Uint8Array,
  opts: { maxChars: number; timeoutMs?: number; maxHeapMb?: number; maxWorkerMb?: number },
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? EXTRACT_TIMEOUT_MS
  const maxWorkerMb = opts.maxWorkerMb ?? positiveIntFromEnv(EXTRACT_MAX_WORKER_MB_VAR, DEFAULT_WORKER_MB)
  // A private copy, transferred: the caller's Buffer may be a slice of a pool.
  const copy = new Uint8Array(bytes)
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(watch)
      fn()
      void worker.terminate()
    }
    const worker = new Worker(workerPath(), {
      workerData: { kind, bytes: copy, maxChars: opts.maxChars },
      transferList: [copy.buffer],
      resourceLimits: {
        maxOldGenerationSizeMb: opts.maxHeapMb ?? EXTRACT_MAX_HEAP_MB,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    })
    const timer = setTimeout(
      () => settle(() => reject(new Error(`extract_timeout: no text after ${timeoutMs} ms`))),
      timeoutMs,
    )
    // `getHeapStatistics` is answered between the worker's JS steps, even while
    // it is busy; `external_memory` counts its Buffers.
    let sampling = false
    const watch = setInterval(() => {
      if (sampling || settled) return
      sampling = true
      worker
        .getHeapStatistics()
        .then((h) => {
          const mb = (h.used_heap_size + ((h as { external_memory?: number }).external_memory ?? 0)) / 1e6
          if (mb > maxWorkerMb) {
            settle(() =>
              reject(new ExtractTooLargeError(`the extractor used ${Math.round(mb)} MB (cap ${maxWorkerMb} MB)`)),
            )
          }
        })
        .catch(() => {
          /* the worker already exited; `exit` settles */
        })
        .finally(() => {
          sampling = false
        })
    }, WATCH_MS)
    worker.once('message', (reply: Reply) =>
      settle(() => (reply.ok ? resolve(reply.text) : reject(new Error(reply.message)))),
    )
    worker.once('error', (err: Error & { code?: string }) =>
      settle(() =>
        reject(
          err.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? new ExtractTooLargeError('the extractor ran out of memory')
            : new Error(`extract_failed: ${err.message}`),
        ),
      ),
    )
    worker.once('exit', (code) =>
      settle(() => reject(new Error(`extract_failed: the extractor exited with code ${code}`))),
    )
  })
}
