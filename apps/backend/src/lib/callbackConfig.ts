/**
 * Configuration seam for the ai-service ingest-callback round-trip.
 *
 * There is NO `AI_SERVICE_CALLBACK_ENABLED` master switch, and there deliberately
 * will not be one: callbacks are ALWAYS ON wherever they are configured. The
 * only question this module answers is whether the two things a callback needs
 * are actually present.
 *
 *   CALLBACK_SECRET          <64 hex>  shared HMAC secret — the RECEIVER side
 *                                      (`/api/ai-service/callback`) verifies
 *                                      every inbound POST against it.
 *   PUBLIC_BACKEND_URL       origin    public origin of THIS backend — the
 *                                      EMIT side hands it to ai-service as
 *                                      `callbackUrl`. It must be reachable
 *                                      FROM ai-service, which is not the same
 *                                      thing as reachable from your browser.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The two vars are read from two different places (the Documents enqueue hook
 * and the callback receiver) and a HALF-configured environment fails silently
 * in the worst possible way:
 *
 *   - base URL set, secret missing/wrong → ai-service calls back, every POST
 *     401s, and the row NEVER leaves `embedding`.
 *   - secret set, base URL missing       → no `callbackUrl` is ever sent, so
 *     nothing calls back, and the row NEVER leaves `embedding`.
 *
 * Nothing polls `ingest.status`, so `embedding` is a terminal state in practice.
 * One seam, read by both the enqueue path and the boot check, so the boot check
 * cannot drift from what the enqueue path actually does.
 *
 * ⚠ Be precise about the damage. A stuck row is NOT hidden from retrieval:
 * retrieval asks ai-service by CORPUS NAME and never filters on `ingestStatus`,
 * so if ai-service embedded the chunks they are still findable. The real harm
 * is that the status is permanently WRONG — and, worse, an ingest that
 * genuinely FAILED looks exactly like one that succeeded, because
 * `ingest.failed` travels over the same callback that is not working.
 */

/** Path the receiver route is mounted at (`src/app/api/ai-service/callback/route.ts`). */
export const CALLBACK_PATH = '/api/ai-service/callback'

/** Env var names, so log lines and tests never hand-type a string that can drift. */
export const CALLBACK_SECRET_VAR = 'CALLBACK_SECRET'
export const CALLBACK_BASE_URL_VAR = 'PUBLIC_BACKEND_URL'

/**
 * ai-service validates `callbackUrl` with `z.string().url()`. A bare host, a
 * relative path, or a stray `"unset"` placeholder is therefore a 400 on the
 * INGEST call itself — which takes ingestion down entirely, not just the
 * callback. Anything that fails this check degrades to "no callback" instead.
 */
const ABSOLUTE_HTTP_URL = /^https?:\/\/.+/i

/** The shared HMAC secret, or null. Never log the VALUE of this. */
export function callbackSecret(): string | null {
  const raw = process.env[CALLBACK_SECRET_VAR]
  return raw && raw.trim() ? raw.trim() : null
}

/** The configured public origin with trailing slashes stripped, or null. */
export function callbackBaseUrl(): string | null {
  const raw = process.env[CALLBACK_BASE_URL_VAR] ?? ''
  const trimmed = raw.trim().replace(/\/+$/, '')
  return trimmed || null
}

/** Is the configured base URL a shape ai-service will accept? */
export function callbackBaseUrlIsValid(): boolean {
  const base = callbackBaseUrl()
  return base !== null && ABSOLUTE_HTTP_URL.test(base)
}

/**
 * The absolute URL to hand ai-service as `callbackUrl`, or null when callbacks
 * cannot work in this environment.
 *
 * Returns null unless BOTH the secret and a well-formed base URL are present. A
 * partial configuration is treated as OFF rather than half-on: advertising a
 * callback URL we cannot verify signatures for is strictly worse than sending
 * no callback at all — ai-service would burn its whole retry schedule on 401s
 * while the row sits in `embedding` either way.
 */
export function ingestCallbackUrl(): string | null {
  if (!callbackSecret()) return null
  if (!callbackBaseUrlIsValid()) return null
  return `${callbackBaseUrl()}${CALLBACK_PATH}`
}

/** Which required pieces are missing or unusable. Empty ⇒ fully configured. */
export function missingCallbackConfig(): string[] {
  const missing: string[] = []
  if (!callbackSecret()) missing.push(CALLBACK_SECRET_VAR)
  if (!callbackBaseUrl()) {
    missing.push(CALLBACK_BASE_URL_VAR)
  } else if (!callbackBaseUrlIsValid()) {
    // Present but unusable — name it distinctly so an operator doesn't go
    // looking for an unset variable that is in fact set to garbage.
    missing.push(`${CALLBACK_BASE_URL_VAR} (set, but not an absolute http(s):// URL)`)
  }
  return missing
}

export function callbacksFullyConfigured(): boolean {
  return missingCallbackConfig().length === 0
}

/**
 * Structurally compatible with Payload's pino logger (its `LogFn` has a
 * `(msg: string, ...args: any[])` overload) and trivially fakeable in tests.
 * Single-string messages only — deliberately, so nothing here can ever be
 * handed an object that might carry the secret.
 */
export type BootLogger = {
  error: (msg: string) => void
  warn: (msg: string) => void
  info: (msg: string) => void
}

/**
 * Boot-time check — call from `onInit`.
 *
 * ⚠ NEVER THROWS, never `process.exit`s. Gating boot on this would crash-loop
 * every replica over a config problem that leaves the rest of the product
 * perfectly usable — login, chat and markdown documents all work without
 * callbacks. The posture for this class of misconfiguration is "log at ERROR,
 * let boot continue".
 *
 * "Deployed" is `NODE_ENV === 'production'`, matching `capabilityModeFromEnv`
 * in `@edc/ai-client`. Below production this is info/warn only: a local
 * `next dev` with no public origin is a normal, expected state.
 *
 * The secret's VALUE is never logged — only whether it is present.
 */
export function checkCallbackConfig(logger: BootLogger): void {
  const missing = missingCallbackConfig()

  if (missing.length === 0) {
    logger.info(
      `[callback-config] ai-service ingest callbacks configured → ${ingestCallbackUrl()}`,
    )
    return
  }

  const consequence =
    'every uploaded PDF/DOCX document will hang in ingestStatus="embedding" forever ' +
    '(nothing flips it, nothing polls ingest.status, no janitor fails it out), and ' +
    'ingest FAILURES become undetectable — ingest.failed travels over this same callback, ' +
    'so a document ai-service could not embed is indistinguishable from one it did'

  if (process.env.NODE_ENV === 'production') {
    logger.error(
      `[callback-config] MISCONFIGURED — missing: ${missing.join(', ')}. ` +
        `ai-service ingest callbacks are DISABLED in this deployed environment, so ${consequence}. ` +
        `Set both ${CALLBACK_SECRET_VAR} (64-hex, must equal this API key's callbackSecret on ai-service) ` +
        `and ${CALLBACK_BASE_URL_VAR} (absolute https:// origin of THIS backend, reachable from ai-service). ` +
        `Boot continues — the product works without callbacks; document ingest does not.`,
    )
    return
  }

  logger.warn(
    `[callback-config] ai-service ingest callbacks are off — missing: ${missing.join(', ')}. ` +
      `Expected below production; uploaded PDF/DOCX docs will stay in ingestStatus="embedding".`,
  )
}
