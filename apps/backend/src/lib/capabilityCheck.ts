/**
 * Boot-time ai-service capability check.
 *
 * This backend and ai-service are version-coupled, and every environment runs
 * its OWN ai-service. Deploying them in the wrong order used to be caught only
 * by a human remembering a runbook — which failed silently, because the symptom
 * is uploads that never leave `embedding` rather than an error anyone sees.
 * This asks the question once, at boot, and refuses to come up when the answer
 * is positively wrong.
 *
 * ⚠ KEPT DELIBERATELY. It is named "capability negotiation", but what it
 * actually protects is this product's single most silent failure: the
 * ingest callback. Removing it would remove the only thing that notices.
 *
 * The negotiation itself lives in `@edc/ai-client`. Since 0.32.0 the client
 * throws on every outcome but `ok`; the warn/strict split and the "unreachable
 * never blocks" rule below are EDC's own, because AI is optional here.
 */

import { CapabilityNegotiationError, ORG_DELEGATION_CAPABILITY } from '@edc/ai-client'

import { getAppAIClient } from './aiClient'

/**
 * What this backend cannot run without — deliberately SHORT. Over-declaring
 * would block boots for capabilities the product survives without, and a check
 * that blocks for nothing is a check people switch off.
 *
 * Two real couplings: org delegation, always, and the ingest callback when
 * there is a public URL to be called back on — see below.
 */
export function requiredAICapabilities(): string[] {
  // 🔴 Every ecosistema is its own ai-service org via `X-AI-Org` (see
  // `aiClient.ts`). An ai-service without the feature IGNORES the header and
  // books every ecosistema's budget, usage and corpora under one org — no
  // error, just tenants mixed together. Required unconditionally.
  const required: string[] = [ORG_DELEGATION_CAPABILITY]
  // Documents are marked `embedding` and left there: the ai-service callback is
  // what flips them to `ready`/`failed`, and NOTHING POLLS. So against a service
  // that ignores `callbackUrl`, nothing errors and every uploaded document hangs
  // in `embedding` forever. That is the precise silent failure this check
  // exists to catch. Only required when we actually advertise a callback URL —
  // with no public origin there is no callback to miss.
  if (process.env.PUBLIC_BACKEND_URL) required.push('ingestChunkCallback')
  return required
}

export type CapabilityMode = 'strict' | 'warn'

/**
 * `strict` throws at boot on a missing capability; `warn` logs and continues.
 * `AI_CAPABILITY_MODE` wins when it is `strict` or `warn`; otherwise strict on
 * NODE_ENV=production and warn everywhere else.
 */
export function capabilityModeFromEnv(
  env: Record<string, string | undefined> = process.env,
): CapabilityMode {
  const explicit = env['AI_CAPABILITY_MODE']?.trim().toLowerCase()
  if (explicit === 'strict' || explicit === 'warn') return explicit
  return (env['NODE_ENV'] ?? '').trim().toLowerCase() === 'production' ? 'strict' : 'warn'
}

// `onInit` re-runs on every `next dev` hot-reload; one check per process.
let alreadyChecked = false

type CapabilityLogger = { warn: (message: string) => void; info?: (message: string) => void }

/**
 * Run the check. Call from `onInit`.
 *
 *   - ai-service not configured → skipped. AI is optional: a deployment
 *     without ai-service must keep starting and working (login, the admin
 *     panel and markdown documents do not need it).
 *   - reachable, missing → THROWS in `strict` (production), warns in `warn`.
 *   - unreachable → warns and continues, always. A restarting ai-service is not
 *     evidence a capability is gone; bricking a deploy over it would be worse
 *     than the mistake being caught.
 */
export async function checkAIServiceCapabilities(logger: CapabilityLogger): Promise<void> {
  if (alreadyChecked) return
  alreadyChecked = true

  const required = requiredAICapabilities()

  if (!process.env.AI_SERVICE_URL || !process.env.AI_SERVICE_API_KEY) {
    logger.info?.(
      '[capability-check] ai-service not configured — skipping (AI is optional).',
    )
    return
  }

  try {
    await getAppAIClient().capabilities.negotiate({
      consumer: 'edc-backend',
      require: required,
      // The pre-0.32 window (3 attempts, 400 ms doubling): a short boot delay
      // when ai-service is down, since unreachable never blocks here anyway.
      attempts: 3,
      retryDelayMs: 400,
      logger,
    })
  } catch (err) {
    if (!(err instanceof CapabilityNegotiationError)) throw err
    if (err.status === 'unreachable') {
      logger.warn(`${err.message} Starting anyway — a restarting ai-service is not a missing capability.`)
      return
    }
    if (capabilityModeFromEnv() === 'warn') {
      logger.warn(`${err.message} Starting anyway (AI_CAPABILITY_MODE=warn).`)
      return
    }
    throw err
  }
}

/** Test-only: let the check run again in the same process. */
export function _resetCapabilityCheckForTests(): void {
  alreadyChecked = false
}
