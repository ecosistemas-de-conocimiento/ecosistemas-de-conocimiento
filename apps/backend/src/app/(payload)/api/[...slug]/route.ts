import {
  REST_OPTIONS,
  REST_GET,
  REST_POST,
  REST_PUT,
  REST_PATCH,
  REST_DELETE,
} from '@payloadcms/next/routes'
import configPromise from '@payload-config'

import { API_BODY_MAX_BYTES, tooLarge, withCappedBody } from '@/lib/bodyCap'

type Handler = ReturnType<typeof REST_POST>

/**
 * 🔴 Payload reads a JSON body whole, before access runs. This counts it first
 * (`lib/bodyCap.ts`), so a chunked body with no `Content-Length` stops too.
 */
const capped =
  (handler: Handler): Handler =>
  async (request, args) => {
    const bounded = await withCappedBody(request, API_BODY_MAX_BYTES)
    return bounded ? handler(bounded, args) : tooLarge(API_BODY_MAX_BYTES)
  }

export const OPTIONS = REST_OPTIONS(configPromise)
export const GET = REST_GET(configPromise)
export const POST = capped(REST_POST(configPromise))
export const PUT = capped(REST_PUT(configPromise))
export const PATCH = capped(REST_PATCH(configPromise))
export const DELETE = capped(REST_DELETE(configPromise))
