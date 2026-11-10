/**
 * GET  /api/holds/:id   — everything a reviewer needs to judge one hold.
 * POST /api/holds/:id   — the decision. `{ decision, text?, note? }`.
 *
 * 🔴 READ `lib/holdReview.ts` BEFORE TOUCHING EITHER. The access check, the
 * audit write and the ordering between them all live there, and the reasoning
 * for each is written down next to the code that depends on it.
 *
 * ── WHAT GET RETURNS ─────────────────────────────────────────────────────────
 *
 * `heldText` — the gate's own REFUSED output — plus `survivors` (offsets, not
 * strings, into that text) and the gate `report` (per-stage counts and rule
 * names). ⚠ NOT `extractedText`: the job is to judge the redaction, and the
 * redaction is judged against the redacted text. Nothing in the response
 * identifies the speaker, because nothing in this system knows who they are.
 *
 * ── WHAT POST DOES ───────────────────────────────────────────────────────────
 *
 * `{ "decision": "approve" }`                    release the gate's own output
 * `{ "decision": "approve", "text": "…" }`       release a CORRECTED redaction
 * `{ "decision": "reject", "note": "…" }`        terminal; never ingested
 *
 * An approval is a human overriding a fail-closed safety gate, so it writes an
 * audit row FIRST — who, when, and a copy of the gate report they were looking
 * at — and only then releases the text. It is the ONLY way out of a hold: an
 * ordinary save does not re-gate a held row, retry refuses a reviewed one, and
 * the gate's columns cannot be written through the API at all.
 *
 * ⚠ REFUSALS ARE 404, NOT 403. Unknown document, not your ecosistema, no
 * `holds:review`, and "that document is not held" are one indistinguishable
 * answer, so this cannot be used to probe ids.
 *
 *   GET  200 HeldDetail
 *   POST 200 { id, decision, reviewId, anonymisationStatus }
 *        400 malformed body — `decision`, or an empty/oversized `text`
 *        401 not signed in   413 body over 8 MiB
 *        404 no such held document, or not yours to review
 *        500 the read or the write itself failed
 */

import configPromise from '@payload-config'
import { NextResponse } from 'next/server'
import { getPayload } from 'payload'

import { API_BODY_MAX_BYTES, BodyTimeoutError, bodyTimedOut, readCapped, tooLarge } from '@/lib/bodyCap'
import { safeErrMessage } from '@/lib/errorSummary'
import {
  HoldNotVisibleError,
  HoldReviewInputError,
  HoldSettingsChangedError,
  decideOnHold,
  heldDocument,
} from '@/lib/holdReview'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE = { 'cache-control': 'no-store' } as const

const fail = (status: number, message: string): Response =>
  NextResponse.json({ errors: [{ message }] }, { status, headers: NO_STORE })

/** Next hands route params as a promise in this version. */
type Ctx = { params: Promise<{ id: string }> }

/**
 * ⚠ ONE ERROR MAPPING FOR BOTH VERBS, so a GET and a POST cannot come to
 * disagree about which refusals are visible. `HoldReviewInputError` is safe to
 * distinguish — it describes the REQUEST, never whether a row exists.
 */
function toResponse(err: unknown, what: string): Response {
  if (err instanceof HoldNotVisibleError) return fail(404, err.message)
  if (err instanceof HoldSettingsChangedError) return fail(409, err.message)
  if (err instanceof HoldReviewInputError) return fail(400, err.message)
  console.error(`[holds] ${what} failed`, safeErrMessage(err))
  return fail(500, `Could not ${what}.`)
}

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const payload = await getPayload({ config: configPromise })

  const { user } = await payload.auth({ headers: request.headers })
  if (!user) return fail(401, 'Authentication required.')

  const { id } = await ctx.params
  try {
    return NextResponse.json(await heldDocument({ payload, documentId: id, user }), {
      headers: NO_STORE,
    })
  } catch (err) {
    return toResponse(err, 'read the held document')
  }
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const payload = await getPayload({ config: configPromise })

  const { user } = await payload.auth({ headers: request.headers })
  if (!user) return fail(401, 'Authentication required.')

  const { id } = await ctx.params

  // 🔴 Counted: a multipart label skips the middleware, and `json()` has no cap.
  let bytes: Uint8Array | null
  try {
    bytes = await readCapped(request, API_BODY_MAX_BYTES)
  } catch (err) {
    if (err instanceof BodyTimeoutError) return bodyTimedOut()
    throw err
  }
  if (!bytes) return tooLarge(API_BODY_MAX_BYTES)

  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    body = parsed as Record<string, unknown>
  } catch {
    return fail(400, 'Send a JSON object with a `decision` of "approve" or "reject".')
  }

  const decision = body.decision
  if (decision !== 'approve' && decision !== 'reject') {
    return fail(400, '`decision` must be "approve" or "reject".')
  }

  try {
    const outcome = await decideOnHold({
      payload,
      documentId: id,
      user,
      decision,
      // ⚠ Passed through as-is. `decideOnHold` decides what an absent `text`
      // means (approve the gate's own output) — the route must not substitute
      // anything, because the one thing it could reach for is the raw original.
      ...(typeof body.text === 'string' ? { text: body.text } : {}),
      ...(typeof body.note === 'string' ? { note: body.note } : {}),
    })
    return NextResponse.json(outcome, { headers: NO_STORE })
  } catch (err) {
    return toResponse(err, 'record the decision')
  }
}
