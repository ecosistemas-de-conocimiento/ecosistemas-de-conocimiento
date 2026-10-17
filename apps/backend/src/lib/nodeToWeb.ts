/**
 * Wrap a Node `Readable` as a web `ReadableStream`, safe to cancel.
 *
 * 🔴 WHY NOT `Readable.toWeb`: on Node 22 and 24 (the runtime image is 22,
 * `apps/backend/Dockerfile`) its adapter can call `controller.enqueue` AFTER
 * the web stream was cancelled. That throws "Invalid state: Controller is
 * already closed" from a stream event — an uncaught exception, which takes the
 * process down. Measured 2026-10-17 on the dev box with Node 22.23.2 and
 * 24.19.0: a Readable holding buffered data, read twice through `toWeb`, then
 * cancelled, throws every time; Node 26.10.0 does not. The trigger in
 * production: audio-service rejects an upload mid-body, the upload pipeline
 * cancels the multipart stream, and the cancel reaches the S3 body.
 *
 * The AWS SDK's `transformToWebStream()` is `Readable.toWeb` underneath, so it
 * has the same flaw.
 *
 * Same shape as Node's adapter — flowing mode, paused whenever the web queue is
 * full — plus one guard: once the web side is closed, cancelled or errored,
 * nothing more is enqueued.
 */

import type { Readable } from 'node:stream'

export function nodeToWeb(readable: Readable): ReadableStream<Uint8Array> {
  let settled = false
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        // Paused BEFORE the 'data' listener, so attaching it starts no flow:
        // nothing is read until the first pull.
        readable.pause()
        readable.on('data', (chunk: Buffer) => {
          if (settled) return
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
          if ((controller.desiredSize ?? 0) <= 0) readable.pause()
        })
        readable.once('end', () => {
          if (settled) return
          settled = true
          controller.close()
        })
        readable.once('error', (err) => {
          if (settled) return
          settled = true
          controller.error(err)
        })
        readable.once('close', () => {
          // Destroyed by someone else before it ended.
          if (settled) return
          settled = true
          controller.error(new Error('source stream closed before it ended'))
        })
      },
      pull() {
        readable.resume()
      },
      cancel() {
        settled = true
        readable.destroy()
      },
    },
    // 0: no pull until a reader asks, so wrapping the source reads nothing.
    { highWaterMark: 0 },
  )
}
