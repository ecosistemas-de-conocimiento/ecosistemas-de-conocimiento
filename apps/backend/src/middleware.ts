/**
 * 🔴 A DECLARED BODY OVER THE CAP IS REFUSED BEFORE ANY ROUTE READS IT (audit
 * 2026-11-10, C-03). Covers every `/api/*` route, Payload's and our own; the
 * cap and why it is that size are in `lib/bodyCap.ts`.
 *
 * ⚠ Multipart never reaches this. Next copies the body of every request a
 * middleware runs for and TRUNCATES that copy at 10 MiB (Next 15.4,
 * `server/body-streams.js`), which would cut every media upload short. The
 * routes count it instead (`lib/bodyCap.ts`), and on an upload route busboy's
 * `upload.limits` bound it.
 *
 * 🔴 The header test is a regex Next anchors and builds with no flags
 * (`new RegExp('^' + value + '$')`, `matchHas` in Next 15.4), so it is
 * case-sensitive and spelled out letter by letter here. With plain
 * `multipart/.*` a `Multipart/form-data` upload ran through, and that copy
 * would cut it.
 *
 * ⚠ A chunked body has no `Content-Length` and passes here. Every route that
 * reads a body counts it (`lib/bodyCap.ts`).
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
      missing: [{ type: 'header', key: 'content-type', value: '[Mm][Uu][Ll][Tt][Ii][Pp][Aa][Rr][Tt]/.*' }],
    },
  ],
}
