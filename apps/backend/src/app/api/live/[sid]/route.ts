/**
 * POST   /api/live/:sid?organization=<id>[&conversation=<id>]&offset=N
 *                                                    raw audio slice -> { committed, tentative, seconds, received }
 * DELETE /api/live/:sid                              drop the session (never gated)
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

import { isActiveUser, isPlatformAdminUser } from '@/access'
import { audioServiceApiKey, audioServiceBaseUrl } from '@/lib/audioClient'
import { readCapped } from '@/lib/bodyCap'
import { featureEnabled } from '@/lib/features'
import { organizationIdsForUser, relationId } from '@/lib/permissions'

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
  gate: boolean,
): Promise<{ url: string; key: string } | Response> {
  const payload = await getPayload({ config: configPromise })
  const { user } = await payload.auth({ headers: request.headers })
  // 🔴 `isActive` is the revoke switch and Payload's auth ignores it: a
  // deactivated account's token stays valid until it expires (code audit
  // 2026-10-28, item 4).
  if (!user || !isActiveUser(user)) return fail(401, 'unauthorized')
  const { sid } = await ctx.params
  if (!SID.test(sid)) return fail(400, 'bad_session_id')
  // 🔴 `liveMic` (`lib/features.ts`), per ecosistema. The ecosistema is named
  // by the caller and checked against their memberships, so naming one with
  // the switch on that is not theirs gets the same 403.
  // Stopping (DELETE) is never gated.
  //
  // 🔴 WITH A CONVERSATION, ITS ECOSISTEMA DECIDES (re-audit 2026-10-26). The
  // recording uploads into that conversation, so the switch that counts is its
  // ecosistema's — not the one selected in the cookie, which can differ. The
  // conversation is read AS THE CALLER, so one they cannot read is a 403.
  // Without one (no conversation yet), the named ecosistema is where the
  // upload will open it.
  if (gate) {
    const query = new URL(request.url).searchParams
    let organization = query.get('organization') ?? ''
    const conversation = query.get('conversation')
    if (conversation !== null && conversation !== '') {
      if (!/^\d{1,12}$/.test(conversation)) return fail(400, 'bad_conversation')
      try {
        const row = (await payload.findByID({
          collection: 'sessions',
          id: conversation,
          depth: 0,
          overrideAccess: false,
          user,
        })) as { organization?: unknown } | null
        const id = relationId(row?.organization)
        if (id === null) return fail(403, 'live_disabled')
        organization = String(id)
      } catch {
        return fail(403, 'live_disabled')
      }
    }
    if (!/^\d{1,12}$/.test(organization)) return fail(400, 'bad_organization')
    if (!isPlatformAdminUser(user)) {
      const mine = await organizationIdsForUser(payload, user.id)
      if (!mine.some((id) => String(id) === organization)) return fail(403, 'live_disabled')
    }
    if (!(await featureEnabled(payload, organization, 'liveMic'))) return fail(403, 'live_disabled')
  }
  const base = audioServiceBaseUrl()
  const key = audioServiceApiKey()
  if (!base || !key) return fail(503, 'live_unavailable')
  return { url: `${base}/v1/live/${encodeURIComponent(`${user.id}.${sid}`)}`, key }
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const target = await prepare(request, ctx, true)
  if (target instanceof Response) return target
  const offset = Number.parseInt(new URL(request.url).searchParams.get('offset') ?? '0', 10)
  if (!Number.isFinite(offset) || offset < 0) return fail(400, 'bad_offset')
  const body = await readCapped(request, MAX_SLICE_BYTES)
  if (!body) return fail(413, 'live_slice_too_large')

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
  const target = await prepare(request, ctx, false)
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
