/**
 * 🔴 AT MOST N UPLOADS AT ONCE PER ACCOUNT (re-audit 2026-11-10, C-03).
 *
 * busboy holds an upload in memory while Payload decides on it, about twice
 * the 200 MiB media cap at worst (`payload.config.ts`, `upload.limits`). One
 * account opening twenty uploads at once could hold gigabytes. So the REST
 * wrapper (`app/(payload)/api/[...slug]/route.ts`) takes a slot per upload
 * request before Payload reads it, and gives it back when the handler is done,
 * however it ends.
 *
 * ⚠ In-process: each backend process counts its own. One process today
 * (`infra/docker-compose.yml`, no replicas), so that is the whole count.
 */

/**
 * 2. The app uploads one file per request and one request at a time
 * (`apps/web/src/lib/server/uploadDocument.ts`); 2 leaves room for a retry
 * that overlaps a slow first try (inferred, not measured on real traffic).
 * `UPLOAD_MAX_CONCURRENT_PER_USER` overrides it.
 */
export const DEFAULT_UPLOADS_PER_USER = 2

/**
 * 5 s. Long enough that a client honouring it is not retrying in a loop, short
 * enough that a refused upload waits less than the one ahead of it takes
 * (inferred: a 200 MiB upload over a 100 Mbit/s link is about 17 s).
 */
export const UPLOAD_RETRY_AFTER_SECONDS = 5

/** The env value as a whole number ≥ 1, else the default. */
export function uploadsPerUser(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.UPLOAD_MAX_CONCURRENT_PER_USER)
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_UPLOADS_PER_USER
}

const inFlight = new Map<string, number>()

/**
 * A release function, or null when `userId` already holds `max` slots. The
 * release frees the slot once, however many times it is called.
 */
export function takeUploadSlot(userId: string, max: number): (() => void) | null {
  const held = inFlight.get(userId) ?? 0
  if (held >= max) return null
  inFlight.set(userId, held + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const now = (inFlight.get(userId) ?? 1) - 1
    if (now > 0) inFlight.set(userId, now)
    else inFlight.delete(userId)
  }
}

/** Slots `userId` holds now. For tests. */
export const uploadSlotsHeld = (userId: string): number => inFlight.get(userId) ?? 0

export const tooManyUploads = (): Response =>
  Response.json(
    { errors: [{ message: 'Too many uploads at once. Wait for one to finish.' }] },
    {
      status: 429,
      headers: { 'cache-control': 'no-store', 'retry-after': String(UPLOAD_RETRY_AFTER_SECONDS) },
    },
  )
