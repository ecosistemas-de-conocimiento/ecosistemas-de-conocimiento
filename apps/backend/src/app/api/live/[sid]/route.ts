/**
 * POST   /api/live/:sid?offset=N   raw audio slice -> { committed, tentative, seconds, received }
 * DELETE /api/live/:sid            drop the session
 *
 * Live partial text while someone records. A thin pass-through to audio-service
 * `/v1/live` (read `services/audio-service/app/live.py`). The real document is
 * the whole recording, uploaded on stop through the normal path.
 *
 * 🔴 THE PARTIAL TEXT IS RAW, PRE-GATE TESTIMONY. It goes back to the caller in
 * this response and nowhere else: no Payload write, no log line with the body,
 * no cache (`no-store`).
 *
 * 🔴 THE SESSION ID IS BOUND TO THE CALLER. audio-service keys sessions by its
 * one API key, so every EDC user looks the same to it. Prefixing the caller's
 * own user id means nobody can read or append to another person's session by
 * guessing its id.
 */

import configPromise from '@payload-config'
import { NextResponse } from 'next/server'
import { getPayload } from 'payload'

import { audioServiceApiKey, audioServiceBaseUrl } from '@/lib/audioClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE = { 'cache-control': 'no-store' } as const
const SID = /^[A-Za-z0-9_-]{8,64}$/
/** Matches audio-service's per-slice cap. */
const MAX_SLICE_BYTES = 4 * 1024 * 1024

const fail = (status: number, error: string): Response =>
  NextResponse.json({ error }, { status, headers: NO_STORE })

type Ctx = { params: Promise<{ sid: string }> }

async function prepare(
  request: Request,
  ctx: Ctx,
): Promise<{ url: string; key: string } | Response> {
  const payload = await getPayload({ config: configPromise })
  const { user } = await payload.auth({ headers: request.headers })
  if (!user) return fail(401, 'unauthorized')
  const { sid } = await ctx.params
  if (!SID.test(sid)) return fail(400, 'bad_session_id')
  const base = audioServiceBaseUrl()
  const key = audioServiceApiKey()
  if (!base || !key) return fail(503, 'live_unavailable')
  return { url: `${base}/v1/live/${encodeURIComponent(`${user.id}.${sid}`)}`, key }
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const target = await prepare(request, ctx)
  if (target instanceof Response) return target
  const offset = Number.parseInt(new URL(request.url).searchParams.get('offset') ?? '0', 10)
  if (!Number.isFinite(offset) || offset < 0) return fail(400, 'bad_offset')
  const body = await request.arrayBuffer()
  if (body.byteLength > MAX_SLICE_BYTES) return fail(413, 'live_slice_too_large')

  let upstream: Response
  try {
    upstream = await fetch(`${target.url}/chunk?offset=${offset}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.key}`,
        'Content-Type': 'application/octet-stream',
      },
      body,
      signal: AbortSignal.timeout(70_000),
    })
  } catch {
    return fail(502, 'live_unreachable')
  }
  // audio-service's body is already the shape the client reads, success or error.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', ...NO_STORE },
  })
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  const target = await prepare(request, ctx)
  if (target instanceof Response) return target
  try {
    await fetch(target.url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${target.key}` },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    // The session expires on its own (audio-service IDLE_TTL_S).
  }
  return new Response(null, { status: 204, headers: NO_STORE })
}
