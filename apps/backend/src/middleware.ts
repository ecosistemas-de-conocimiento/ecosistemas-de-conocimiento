/**
 * 🔴 A DECLARED BODY OVER THE CAP IS REFUSED BEFORE ANY ROUTE READS IT (audit
 * 2026-11-10, C-03). Covers every `/api/*` route, Payload's and our own; the
 * cap and why it is that size are in `lib/bodyCap.ts`.
 *
 * ⚠ Multipart never reaches this. Next copies the body of every request a
 * middleware runs for and TRUNCATES that copy at 10 MiB (Next 15.4,
 * `server/body-streams.js`), which would cut every media upload short. busboy's
 * `upload.limits` bounds multipart instead.
 *
 * ⚠ A chunked body has no `Content-Length` and passes here. Payload's REST
 * routes and the callback receiver count what they read; any other route gets
 * at most the 10 MiB copy above.
 */

import { NextResponse, type NextRequest } from 'next/server'

import { API_BODY_MAX_BYTES, declaresOver, tooLarge } from '@/lib/bodyCap'

export function middleware(request: NextRequest): Response {
  return declaresOver(request, API_BODY_MAX_BYTES) ? tooLarge(API_BODY_MAX_BYTES) : NextResponse.next()
}

export const config = {
  matcher: [
    {
      source: '/api/:path*',
      missing: [{ type: 'header', key: 'content-type', value: 'multipart/.*' }],
    },
  ],
}
