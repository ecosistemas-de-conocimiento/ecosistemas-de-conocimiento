/**
 * Server-only ai-service client factory.
 *
 * Two clients are constructed lazily:
 *
 *   - The "app" client (`getAppAIClient`) uses `AI_SERVICE_API_KEY`. Used by
 *     the Documents ingest hook and by the boot capability check.
 *   - The "admin" client (`getAdminAIClient`) uses `AI_SERVICE_ADMIN_API_KEY`.
 *     Required for `admin.deleteCorpus` — the app-role bearer would 403.
 *
 * Both use the same `AI_SERVICE_URL`. Construction THROWS when a key is not
 * set; callers should catch and log rather than crash the request. Losing a
 * corpus delete is recoverable (the janitor sweeps); failing the user-visible
 * flow is not.
 *
 * ⚠ THE API KEY CARRIES THE TENANT, AND IT IS FIXED AT BOOT.
 *
 * ai-service reads `{org, project}` from its own `API_KEYS` environment map,
 * keyed by the bearer token — never from the request. So every organization in
 * this product arrives at ai-service under ONE key and looks like ONE org to
 * it. Two consequences, both real:
 *
 *   · ai-service CANNOT enforce per-organization isolation for us. The only
 *     thing separating tenants there is the corpus name, and choosing that name
 *     safely is THIS backend's job — see `lib/corpus.ts`.
 *   · ⚠ Budget is keyed on `org` alone, so all tenants share one spend cap and
 *     one of them can exhaust it for everyone. Accepted for now; it is the
 *     reason to watch `logAIBudgetFailure` output rather than assume a budget
 *     error names the tenant that caused it.
 *
 * ⚠ `threadCorpus` IS NOT RE-EXPORTED FROM HERE ANY MORE. It used to be, which
 * made this module look like the corpus authority while the actual rule — "the
 * session must be proven to belong to the caller first" — lived nowhere.
 * Import corpus names from `lib/corpus.ts`, which owns both halves.
 */

import { AIClient } from '@edc/ai-client'

let appClient: AIClient | null = null
let adminClient: AIClient | null = null

function baseUrl(): string {
  const url = process.env.AI_SERVICE_URL
  if (!url) {
    throw new Error('AI_SERVICE_URL is not set.')
  }
  return url.replace(/\/+$/, '')
}

export function getAppAIClient(): AIClient {
  if (appClient) return appClient
  const apiKey = process.env.AI_SERVICE_API_KEY
  if (!apiKey) {
    throw new Error('AI_SERVICE_API_KEY is not set.')
  }
  appClient = new AIClient({ baseUrl: baseUrl(), apiKey })
  return appClient
}

export function getAdminAIClient(): AIClient {
  if (adminClient) return adminClient
  const apiKey = process.env.AI_SERVICE_ADMIN_API_KEY
  if (!apiKey) {
    throw new Error(
      'AI_SERVICE_ADMIN_API_KEY is not set. Required for corpus delete.',
    )
  }
  adminClient = new AIClient({ baseUrl: baseUrl(), apiKey })
  return adminClient
}
