/**
 * PER-ECOSISTEMA FEATURES (owner ruling 2026-10-27): each ecosistema switches
 * its own features on or off. Stored as `organizations.features` (jsonb).
 *
 * 🔴 DEFAULTS ARE TODAY'S BEHAVIOUR. A NULL column, a missing key or a value
 * that is not a boolean reads as the default, so an ecosistema nobody has
 * touched behaves exactly as before this file existed. `studentView` is the one
 * default that is `false`: the student view is not built yet, and only
 * "Semiosis práctica" will get it.
 *
 * Each flag is enforced where the work happens, not only hidden in the UI:
 *   audioUpload        Documents `refuseDisabledFeatures` (kind=audio create → 403)
 *   liveMic            `app/api/live/[sid]/route.ts` (403)
 *   interviewerMode    web `api/generate` (heuristic skipped → always answer)
 *   graph              `endpoints/graph.ts` (view/entity 404, retrieve empty)
 *   graph3d            web only: a rendering mode, no server data behind it
 *   combinedGraph      `endpoints/graph.ts` (`organization=all` leaves it out)
 *   chatOrientation    web `api/generate` (orientation leg off)
 *   testimonioTitles   `lib/testimonioTitle.ts` (no title run)
 *   autoPublishMembers `lib/autoPublish.ts` (participant drafts stay drafts)
 *   studentView        nothing yet; read by the future student view
 */

import type { Payload } from 'payload'

export const FEATURE_DEFAULTS = {
  audioUpload: true,
  liveMic: true,
  interviewerMode: true,
  graph: true,
  graph3d: true,
  combinedGraph: true,
  chatOrientation: true,
  testimonioTitles: true,
  autoPublishMembers: true,
  studentView: false,
} as const satisfies Record<string, boolean>

export type FeatureKey = keyof typeof FEATURE_DEFAULTS
export type Features = Record<FeatureKey, boolean>

export const FEATURE_KEYS = Object.keys(FEATURE_DEFAULTS) as FeatureKey[]

export function isFeatureKey(key: string): key is FeatureKey {
  return Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, key)
}

/** The stored value, made whole: every key, defaults where unset or malformed. */
export function resolveFeatures(raw: unknown): Features {
  const out: Features = { ...FEATURE_DEFAULTS }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isFeatureKey(k) && typeof v === 'boolean') out[k] = v
  }
  return out
}

/**
 * A client's patch → the known boolean keys, or a Spanish error.
 * ⚠ Unknown keys and non-booleans are REFUSED, not dropped: a typo that
 * silently did nothing would read as "saved".
 */
export function parseFeaturesPatch(raw: unknown): Partial<Features> | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Faltan las funciones.'
  const out: Partial<Features> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isFeatureKey(k)) return `Función desconocida: ${k.slice(0, 40)}`
    if (typeof v !== 'boolean') return `Valor no válido para ${k}.`
    out[k] = v
  }
  return out
}

/** ≤ 60 s per the ruling; a save in this process clears it at once. */
const TTL_MS = 30_000
const cache = new Map<string, { at: number; features: Features }>()

export function invalidateFeatures(organizationId?: number | string): void {
  if (organizationId === undefined) cache.clear()
  else cache.delete(String(organizationId))
}

type FeaturesPayload = Pick<Payload, 'findByID'>

/**
 * One ecosistema's features. A failed read returns the DEFAULTS (today's
 * behaviour), never "all off": a database blip must not switch features off
 * across an ecosistema. ⚠ `studentView` therefore fails to `false`.
 */
export async function featuresFor(
  payload: FeaturesPayload,
  organizationId: number | string,
  now: () => number = Date.now,
): Promise<Features> {
  const key = String(organizationId)
  const hit = cache.get(key)
  if (hit && now() - hit.at < TTL_MS) return hit.features
  try {
    const row = (await payload.findByID({
      collection: 'organizations',
      id: organizationId as never,
      depth: 0,
      overrideAccess: true,
      select: { features: true } as never,
    })) as { features?: unknown } | null
    const features = resolveFeatures(row?.features)
    cache.set(key, { at: now(), features })
    return features
  } catch {
    return { ...FEATURE_DEFAULTS }
  }
}

export async function featureEnabled(
  payload: FeaturesPayload,
  organizationId: number | string | null | undefined,
  key: FeatureKey,
): Promise<boolean> {
  if (organizationId === null || organizationId === undefined || organizationId === '') {
    return FEATURE_DEFAULTS[key]
  }
  return (await featuresFor(payload, organizationId))[key]
}
