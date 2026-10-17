/**
 * POST a streamed body over `node:http(s)`, and answer with a web `Response`.
 *
 * 🔴 WHY NOT `fetch`: on Node 22 (the runtime image, `apps/backend/Dockerfile`)
 * `fetch` with a `ReadableStream` body held about as much memory as the body
 * itself. Measured 2026-10-17 on the dev box, Node 22.23.2, POSTing a generated
 * 200 MB stream to a local server that discards it: peak RSS 209 MB with
 * `fetch`, 97 MB with `http.request` + `pipeline`. Node 26 did not show it
 * (110 MB). `pipeline` waits for the socket to drain before it pulls the next
 * chunk, so at most a few chunks are in memory at once.
 *
 * Only the method, headers and a stream body are supported — what an upload
 * needs, nothing more. Redirects are not followed.
 */

import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface StreamingPostInit {
  method?: string
  headers: Record<string, string>
  body: ReadableStream<Uint8Array>
}

/** Statuses a `Response` may not carry a body for. */
const NULL_BODY = new Set([101, 204, 205, 304])

export function postStreaming(url: string, init: StreamingPostInit): Promise<Response> {
  const target = new URL(url)
  const transport = target.protocol === 'https:' ? https : http
  return new Promise<Response>((resolve, reject) => {
    const req = transport.request(
      target,
      { method: init.method ?? 'POST', headers: init.headers },
      (res) => {
        try {
          const headers = new Headers()
          for (const [name, value] of Object.entries(res.headers)) {
            if (value != null) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
          }
          const status = res.statusCode ?? 502
          const body = NULL_BODY.has(status)
            ? null
            : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>)
          if (!body) res.resume()
          resolve(new Response(body, { status, headers }))
        } catch (err) {
          res.resume()
          reject(err)
        }
      },
    )
    req.on('error', reject)
    // ⚠ A server may answer (a 413, say) and close before the body is sent;
    // the pipeline then fails with EPIPE after the promise has already
    // resolved, and the rejection is a no-op. Either way the source stream is
    // destroyed, which releases whatever it reads from.
    pipeline(Readable.fromWeb(init.body as Parameters<typeof Readable.fromWeb>[0]), req).catch(
      reject,
    )
  })
}
