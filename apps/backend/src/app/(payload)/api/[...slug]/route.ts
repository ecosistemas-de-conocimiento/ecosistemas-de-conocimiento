import {
  REST_OPTIONS,
  REST_GET,
  REST_POST,
  REST_PUT,
  REST_PATCH,
  REST_DELETE,
} from '@payloadcms/next/routes'
import configPromise from '@payload-config'
import { getPayload } from 'payload'

import { isActiveUser } from '@/access'
import { API_BODY_MAX_BYTES, isMultipart, isUploadRoute, tooLarge, withCappedBody } from '@/lib/bodyCap'

type Handler = ReturnType<typeof REST_POST>

/**
 * 🔴 Payload reads a JSON body whole, before access runs. This counts it first
 * (`lib/bodyCap.ts`), so a chunked body with no `Content-Length` stops too.
 *
 * 🔴 An upload is the one body left uncounted, and busboy still reads up to
 * `upload.limits` of it before Payload's access runs. Every upload route needs
 * an active account (`Media.access`), so nobody else gets that far.
 */
const capped =
  (handler: Handler): Handler =>
  async (request, args) => {
    if (isMultipart(request.headers.get('content-type')) && isUploadRoute(request)) {
      const payload = await getPayload({ config: configPromise })
      const { user } = await payload.auth({ headers: request.headers })
      if (!isActiveUser(user)) {
        return Response.json(
          { errors: [{ message: 'Authentication required.' }] },
          { status: 401, headers: { 'cache-control': 'no-store' } },
        )
      }
      return handler(request, args)
    }
    const bounded = await withCappedBody(request, API_BODY_MAX_BYTES)
    return bounded ? handler(bounded, args) : tooLarge(API_BODY_MAX_BYTES)
  }

export const OPTIONS = REST_OPTIONS(configPromise)
export const GET = REST_GET(configPromise)
export const POST = capped(REST_POST(configPromise))
export const PUT = capped(REST_PUT(configPromise))
export const PATCH = capped(REST_PATCH(configPromise))
export const DELETE = capped(REST_DELETE(configPromise))
