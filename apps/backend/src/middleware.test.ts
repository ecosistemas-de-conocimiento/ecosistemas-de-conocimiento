/**
 * 🔴 `src/middleware.ts`: a declared body over the cap is 413 on any `/api/*`
 * route, and multipart never runs through it (audit 2026-11-10, C-03).
 */

import { NextRequest } from 'next/server'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { describe, expect, it } from 'vitest'

import { API_BODY_MAX_BYTES } from '@/lib/bodyCap'
import { config, middleware } from './middleware'

const at = (headers: Record<string, string>) =>
  new NextRequest('http://backend.test/api/holds/1', { method: 'POST', headers })

describe('middleware', () => {
  it('🔴 refuses a Content-Length over the cap with 413', () => {
    const res = middleware(at({ 'content-type': 'application/json', 'content-length': String(API_BODY_MAX_BYTES + 1) }))
    expect(res.status).toBe(413)
  })

  it('lets a body at the cap through', () => {
    const res = middleware(at({ 'content-type': 'application/json', 'content-length': String(API_BODY_MAX_BYTES) }))
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })

  it('runs for JSON on /api/*', () => {
    const headers = { 'content-type': 'application/json' }
    expect(unstable_doesMiddlewareMatch({ config, url: '/api/documents/1', headers })).toBe(true)
    expect(unstable_doesMiddlewareMatch({ config, url: '/api/ai-service/callback', headers })).toBe(true)
  })

  it('🔴 never runs for multipart: Next would cut the body it copies at 10 MiB', () => {
    const headers = { 'content-type': 'multipart/form-data; boundary=----x' }
    expect(unstable_doesMiddlewareMatch({ config, url: '/api/media', headers })).toBe(false)
  })

  it('🔴 never runs for multipart in any letter case (re-audit N2)', () => {
    for (const type of ['Multipart/Form-Data; boundary=----x', 'MULTIPART/FORM-DATA; boundary=----x']) {
      expect(unstable_doesMiddlewareMatch({ config, url: '/api/media', headers: { 'content-type': type } }), type).toBe(
        false,
      )
    }
  })

  it('still runs for a type that only mentions multipart', () => {
    const headers = { 'content-type': 'text/plain; x=multipart/form-data' }
    expect(unstable_doesMiddlewareMatch({ config, url: '/api/sugerencias', headers })).toBe(true)
  })

  it('stays off the admin panel', () => {
    expect(unstable_doesMiddlewareMatch({ config, url: '/admin' })).toBe(false)
  })
})
