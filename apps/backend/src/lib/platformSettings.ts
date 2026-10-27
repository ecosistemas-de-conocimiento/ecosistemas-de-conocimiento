/**
 * The platform switches (`globals/PlatformSettings.ts`), read at runtime.
 *
 * 🔴 THE ENV IS THE DEFAULT. A stored NULL, an unregistered payload (scripts,
 * unit tests) or a failed read all fall through to the env var, so behaviour is
 * unchanged until an admin saves a value. Cached ≤ 60 s; a save in this process
 * clears it at once.
 */

import type { Payload } from 'payload'

import { fallbackModeFromEnv, type FallbackMode } from './anonymise/fallbackGenerator'

const TTL_MS = 30_000

type SettingsPayload = Pick<Payload, 'findGlobal'>

let registered: SettingsPayload | null = null
let cached: { at: number; detectorFallback: FallbackMode | null } | null = null

/** Called from `onInit`. Without it every read is the env value. */
export function registerPlatformSettings(payload: SettingsPayload | null): void {
  registered = payload
  cached = null
}

export function invalidatePlatformSettings(): void {
  cached = null
}

export const isFallbackMode = (v: unknown): v is FallbackMode => v === 'hosted' || v === 'none'

/** The stored value, or `null` (= use env). */
export async function storedDetectorFallback(now: () => number = Date.now): Promise<FallbackMode | null> {
  if (!registered) return null
  if (cached && now() - cached.at < TTL_MS) return cached.detectorFallback
  try {
    const row = (await registered.findGlobal({ slug: 'platform-settings', depth: 0, overrideAccess: true })) as {
      detectorFallback?: unknown
    }
    const value = isFallbackMode(row?.detectorFallback) ? row.detectorFallback : null
    cached = { at: now(), detectorFallback: value }
    return value
  } catch {
    return null
  }
}

/**
 * What the detector does when the Spark cannot answer. Stored value first, then
 * `ANONYMISE_DETECT_FALLBACK`. ⚠ A bad env value still THROWS (→ HOLD) when
 * nothing is stored, exactly as `fallbackModeFromEnv` did before.
 */
export async function detectorFallbackMode(
  env: Record<string, string | undefined> = process.env,
): Promise<FallbackMode> {
  return (await storedDetectorFallback()) ?? fallbackModeFromEnv(env)
}
