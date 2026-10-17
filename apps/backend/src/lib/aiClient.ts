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
 * ONE ai-service ORG PER ECOSISTEMA.
 *
 * ai-service reads `{org, project}` from its `API_KEYS` map, keyed by the
 * bearer token. Our keys carry `delegateOrgPrefix: "edc-"`, so a request that
 * sends `X-AI-Org: eco-<organizationId>` acts as org `edc-eco-<organizationId>`:
 * that ecosistema's own budget, usage rows and corpora. Pass the organization
 * id to `getAppAIClient(id)` / `getAdminAIClient(id)` and you get a client that
 * always sends it; one client is cached per org.
 *
 *   · Called with NO argument you get the BASE client: no header, the key's
 *     own org. Only for calls with no ecosistema in hand (boot capability
 *     check, platform-wide admin scripts).
 *   · Passing `null` THROWS. A row whose organization failed to load must not
 *     quietly land in the shared org.
 *   · 🔴 An ai-service older than org delegation IGNORES the header and puts
 *     every ecosistema back in one org. `capabilityCheck.ts` requires
 *     `orgDelegation` at boot for exactly that reason.
 *   · Corpus names still carry the organization (`lib/corpus.ts`). They stay
 *     the line between a person's drafts and the shared corpus inside one org.
 *
 * ⚠ `threadCorpus` IS NOT RE-EXPORTED FROM HERE ANY MORE. It used to be, which
 * made this module look like the corpus authority while the actual rule — "the
 * session must be proven to belong to the caller first" — lived nowhere.
 * Import corpus names from `lib/corpus.ts`, which owns both halves.
 */

import { AIClient } from '@edc/ai-client'

/** Every org suffix must match this — ai-service and ai-client both check it. */
const ORG_SUFFIX = /^[a-z0-9-]{1,48}$/

const BASE = '' // cache key of the client that sends no X-AI-Org
const appClients = new Map<string, AIClient>()
const adminClients = new Map<string, AIClient>()

function baseUrl(): string {
  const url = process.env.AI_SERVICE_URL
  if (!url) {
    throw new Error('AI_SERVICE_URL is not set.')
  }
  return url.replace(/\/+$/, '')
}

/**
 * The `X-AI-Org` suffix for an ecosistema: `eco-<organizationId>`. With the
 * key's `delegateOrgPrefix: "edc-"` the effective org is `edc-eco-<id>` —
 * pass THAT full string to `budget.get()`.
 */
export function aiOrgSuffix(organizationId: number | string): string {
  const suffix = `eco-${String(organizationId)}`
  if (String(organizationId) === '' || !ORG_SUFFIX.test(suffix)) {
    throw new Error(
      `[aiClient] organization id ${JSON.stringify(organizationId)} cannot be an ai-service org ` +
        '(lowercase letters, digits and "-" only).',
    )
  }
  return suffix
}

type OrgArg = number | string | undefined

function cacheKey(organizationId: OrgArg): string {
  if (organizationId === undefined) return BASE
  if (organizationId === null) {
    throw new Error(
      '[aiClient] organization is null. Pass an id, or call with no argument for the base client.',
    )
  }
  return aiOrgSuffix(organizationId)
}

function clientFor(
  cache: Map<string, AIClient>,
  organizationId: OrgArg,
  keyVar: 'AI_SERVICE_API_KEY' | 'AI_SERVICE_ADMIN_API_KEY',
  missing: string,
): AIClient {
  const key = cacheKey(organizationId)
  const hit = cache.get(key)
  if (hit) return hit
  const apiKey = process.env[keyVar]
  if (!apiKey) throw new Error(missing)
  const client = new AIClient({
    baseUrl: baseUrl(),
    apiKey,
    ...(key === BASE ? {} : { org: key }),
  })
  cache.set(key, client)
  return client
}

/** The app-role client for one ecosistema; no argument = the base client. */
export function getAppAIClient(organizationId?: number | string): AIClient {
  return clientFor(appClients, organizationId, 'AI_SERVICE_API_KEY', 'AI_SERVICE_API_KEY is not set.')
}

/** The admin-role client for one ecosistema; no argument = the base client. */
export function getAdminAIClient(organizationId?: number | string): AIClient {
  return clientFor(
    adminClients,
    organizationId,
    'AI_SERVICE_ADMIN_API_KEY',
    'AI_SERVICE_ADMIN_API_KEY is not set. Required for corpus delete.',
  )
}

/** Test-only: drop every cached client so an env change takes effect. */
export function _resetAIClientsForTests(): void {
  appClients.clear()
  adminClients.clear()
}
