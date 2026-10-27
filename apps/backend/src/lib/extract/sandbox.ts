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
 *   · one Worker per file, its old generation capped at `maxHeapMb`;
 *   · a wall clock: past `timeoutMs` the worker is terminated;
 *   · out of heap  → `extract_too_large: …`
 *     past timeout → `extract_timeout: …`
 *     any other death → `extract_failed: …`
 *     an extractor's own error keeps its message (`text_too_long: …`).
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

const workerPath = () => path.join(process.cwd(), 'src/lib/extract/worker.mjs')

type Reply = { ok: true; text: string } | { ok: false; message: string }

export function extractInWorker(
  kind: ExtractKind,
  bytes: Uint8Array,
  opts: { maxChars: number; timeoutMs?: number; maxHeapMb?: number },
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? EXTRACT_TIMEOUT_MS
  // A private copy, transferred: the caller's Buffer may be a slice of a pool.
  const copy = new Uint8Array(bytes)
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
      void worker.terminate()
    }
    const worker = new Worker(workerPath(), {
      workerData: { kind, bytes: copy, maxChars: opts.maxChars },
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: opts.maxHeapMb ?? EXTRACT_MAX_HEAP_MB },
    })
    const timer = setTimeout(
      () => settle(() => reject(new Error(`extract_timeout: no text after ${timeoutMs} ms`))),
      timeoutMs,
    )
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
