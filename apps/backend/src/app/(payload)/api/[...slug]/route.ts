import {
  REST_OPTIONS,
  REST_GET,
  REST_POST,
  REST_PUT,
  REST_PATCH,
  REST_DELETE,
} from '@payloadcms/next/routes'
import configPromise from '@payload-config'

export const OPTIONS = REST_OPTIONS(configPromise)
export const GET = REST_GET(configPromise)
export const POST = REST_POST(configPromise)
export const PUT = REST_PUT(configPromise)
export const PATCH = REST_PATCH(configPromise)
export const DELETE = REST_DELETE(configPromise)
