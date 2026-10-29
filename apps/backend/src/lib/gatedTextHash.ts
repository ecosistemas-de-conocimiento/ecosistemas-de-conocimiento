import { createHash } from 'node:crypto'

/**
 * 🔴 THE FINGERPRINT OF THE TEXT A GATE HOLD IS ABOUT (`documents.heldTextHash`).
 *
 * Audit 2026-10-28 item 2: the detector is a model, so re-running it on the
 * same text can flip a `held` verdict to `ready`. The hold stores this hash;
 * `planIngestRetry` refuses a retry on a held row whose text still matches it.
 * SHA-256 hex of the UTF-8 text, nothing else mixed in.
 */
export function gatedTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
