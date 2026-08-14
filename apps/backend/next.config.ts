import { withPayload } from '@payloadcms/next/withPayload'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /**
   * ⚠ LOAD-BEARING — the JWK Set must answer at the TRUE ROOT path
   * `/.well-known/jwks.json`. That is the URL a JWT verifier fetches, and
   * `@edc/identity-client` defaults to exactly it. A 404 here breaks token
   * verification everywhere, and it breaks it in the most confusing way
   * possible: signing keeps working, so tokens are issued fine and rejected on
   * arrival.
   *
   * Payload mounts custom endpoints under `routes.api`, so the endpoint
   * registered in `payload.config.ts` as `/.well-known/jwks.json` actually
   * serves at `/api/.well-known/jwks.json`. This rewrite is the only thing
   * putting it back at the root.
   *
   * It runs in `beforeFiles` — before static-file and filesystem-route
   * resolution — and it is a REWRITE, not a redirect, so the response passes
   * through byte for byte, including the one-hour `Cache-Control` the endpoint
   * sets. A redirect would work in a browser and quietly halve the cache
   * behaviour of every verifier.
   *
   * The `/v1/identity/*` endpoints are deliberately NOT rewritten. Callers use
   * their real `/api/v1/identity/{token,me,resolve}` paths, so there is one
   * form to document and one form to debug. JWKS is the single exception,
   * because a spec pins its URL.
   */
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/.well-known/jwks.json', destination: '/api/.well-known/jwks.json' },
      ],
      afterFiles: [],
      fallback: [],
    }
  },
}

export default withPayload(nextConfig)
