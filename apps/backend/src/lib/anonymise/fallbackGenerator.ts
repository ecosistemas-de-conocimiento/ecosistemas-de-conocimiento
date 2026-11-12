/**
 * SELF-HOSTED FIRST, HOSTED WHEN THE SELF-HOSTED BOX IS DOWN.
 *
 * 🔴 OWNER DECISION, 2026-10-21 (reverses the earlier fail-closed
 * rule): while the corpus holds no real testimony, a dead DGX Spark must not
 * stall the gate. A call the Spark cannot answer goes to ai-service → OpenRouter,
 * the path every document took before `ANONYMISE_DETECT_URL` existed. That path
 * sends the raw text to a hosted model; ai-service asks OpenRouter for zero
 * data retention on every call (owner decision, 2026-11-09). Set
 * `ANONYMISE_DETECT_FALLBACK=none` to fail closed instead.
 *
 * ── WHAT FALLS BACK, AND WHAT DOES NOT ─────────────────────────────────────
 *
 *   falls back   network fault (fetch failed, ECONNREFUSED, DNS), our own
 *                timeout, any HTTP 5xx, HTTP 429
 *   throws       every other HTTP status (400/401/403/404…) — a config bug,
 *                logged at ERROR so it surfaces; a reply we could not use
 *   never here   a missing URL/model: `openaiCompatFromEnv` throws before this
 *
 * ── THE CIRCUIT BREAKER ────────────────────────────────────────────────────
 *
 * After a fallback-triggering failure, every call goes straight to the hosted
 * path for `ANONYMISE_DETECT_FALLBACK_COOLDOWN_S` seconds (default 60), then the
 * next call probes the Spark again. Without it a dead Spark costs a full
 * per-call timeout (90 s default) on EVERY chunk. The state is one timestamp per
 * process, shared by every detector, because `anonymiseDocument.ts` builds a
 * new detector per document. ⚠ Calls already in flight when the breaker opens
 * still wait out their own Spark attempt.
 *
 * ── HOW THIS STACKS WITH `aiRetry.ts` ──────────────────────────────────────
 *
 * This wrapper sits INSIDE the detector's `withRateLimitRetry`, so one retry
 * attempt = at most one Spark try plus at most one hosted try. The Spark is
 * never retried on its own: its first fallback-class failure goes straight to
 * the hosted call, and opens the breaker, so later attempts skip it. A chunk
 * therefore makes 1 Spark try + up to `attempts` (default 4) hosted tries — not
 * 4 × 4. Worst case in time: the cooldown runs out between two attempts and
 * the Spark times out again, so one attempt can cost the Spark timeout PLUS the
 * hosted timeout (2 × 90 s by default).
 */

import type { SyncGenerator } from './detector'

export const ANONYMISE_DETECT_FALLBACK_VAR = 'ANONYMISE_DETECT_FALLBACK'
export const ANONYMISE_DETECT_FALLBACK_COOLDOWN_S_VAR = 'ANONYMISE_DETECT_FALLBACK_COOLDOWN_S'
export const DEFAULT_FALLBACK_COOLDOWN_S = 60

export type FallbackMode = 'hosted' | 'none'

/** `hosted` when unset or blank. Any other value is a config error and throws → HOLD. */
export function fallbackModeFromEnv(env: Record<string, string | undefined> = process.env): FallbackMode {
  const v = (env[ANONYMISE_DETECT_FALLBACK_VAR] ?? '').trim().toLowerCase()
  if (v === '' || v === 'hosted') return 'hosted'
  if (v === 'none') return 'none'
  throw new Error(`${ANONYMISE_DETECT_FALLBACK_VAR} must be "hosted" or "none"`)
}

export function cooldownMsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const text = (env[ANONYMISE_DETECT_FALLBACK_COOLDOWN_S_VAR] ?? '').trim()
  const n = Number(text)
  return (text !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_FALLBACK_COOLDOWN_S) * 1000
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
])

/** Why the Spark counts as unavailable, or `null` when the error must surface. Never the message text. */
export function fallbackReason(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const e = err as { status?: unknown; name?: unknown; reason?: unknown; code?: unknown; cause?: unknown; message?: unknown }
  if (typeof e.status === 'number') {
    return e.status === 429 || e.status >= 500 ? `http-${e.status}` : null
  }
  if (e.name === 'RequestAbortedError' && e.reason === 'timeout') return 'timeout'
  const code = e.code ?? (e.cause as { code?: unknown } | null | undefined)?.code
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return `network-${code}`
  if (err instanceof TypeError && e.message === 'fetch failed') return 'network'
  return null
}

/** Process-wide: the Spark is skipped until this time (ms epoch). */
let sparkSkippedUntil = 0
let lastReason = ''

export function _resetFallbackBreakerForTests(): void {
  sparkSkippedUntil = 0
  lastReason = ''
}

export interface FallbackOptions {
  cooldownMs: number
  now?: () => number
  warn?: (line: string) => void
  error?: (line: string) => void
}

/**
 * `primary` (the Spark) with `hosted` (ai-service, resolved lazily) behind it.
 * The SAME request goes to both: the detector already builds it in
 * ai-service's shape, and `openaiCompatGenerator` reads the same fields.
 */
export function withHostedFallback(
  primary: SyncGenerator,
  hosted: () => Promise<SyncGenerator>,
  opts: FallbackOptions,
): SyncGenerator {
  const now = opts.now ?? Date.now
  const warn = opts.warn ?? ((l: string) => console.warn(l))
  const error = opts.error ?? ((l: string) => console.error(l))

  const goHosted: SyncGenerator['generate']['sync'] = async (req, callOpts) => {
    const gen = await hosted()
    return gen.generate.sync(req, callOpts)
  }

  return {
    generate: {
      async sync(req, callOpts) {
        if (now() < sparkSkippedUntil) {
          warn(`[anonymise-detect] WARN falling back to ai-service (hosted): self-hosted in cooldown after ${lastReason}`)
          return goHosted(req, callOpts)
        }
        try {
          return await primary.generate.sync(req, callOpts)
        } catch (err) {
          const reason = fallbackReason(err)
          if (reason === null) {
            const status = (err as { status?: unknown } | null)?.status
            if (typeof status === 'number') {
              error(`[anonymise-detect] ERROR self-hosted detector answered HTTP ${status} — check ANONYMISE_DETECT_* config; NOT falling back`)
            }
            throw err
          }
          sparkSkippedUntil = now() + opts.cooldownMs
          lastReason = reason
          warn(`[anonymise-detect] WARN falling back to ai-service (hosted): self-hosted unavailable (${reason}); skipping it for ${Math.round(opts.cooldownMs / 1000)} s`)
          return goHosted(req, callOpts)
        }
      },
    },
  }
}
