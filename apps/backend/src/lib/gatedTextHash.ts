import { createHash } from 'node:crypto'

/**
 * 🔴 WHAT COUNTS AS "THE SAME WORDS" FOR A GATE HOLD. Owner ruling R78.
 *
 * Unicode NFC, lower case, every whitespace run collapsed to one space, ends
 * trimmed. A transcript edit that only adds a space or changes case is not a
 * new source, so it must not clear a hold — otherwise "edit, re-gate until the
 * model says `ready`" is the same re-roll `/retry` refuses.
 */
export function normaliseGatedText(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** True when two texts differ only by whitespace or case (`normaliseGatedText`). */
export function sameGatedText(a: string, b: string): boolean {
  return normaliseGatedText(a) === normaliseGatedText(b)
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * 🔴 THE FINGERPRINT OF THE TEXT A GATE HOLD IS ABOUT (`documents.heldTextHash`).
 *
 * Audit 2026-10-28 item 2: the detector is a model, so re-running it on the
 * same text can flip a `held` verdict to `ready`. The hold stores this hash;
 * `planIngestRetry` refuses a retry on a held row whose text still matches it.
 * SHA-256 hex of the UTF-8 NORMALISED text (`normaliseGatedText`, R78).
 */
export function gatedTextHash(text: string): string {
  return sha256(normaliseGatedText(text))
}

/**
 * True when `text` is still the text a hold with `heldHash` is about.
 *
 * ⚠ Also matches the pre-R78 hash of the RAW text, so a hold written before
 * normalisation is not reopened by the change of hash. Fails closed: a missing
 * hash is the caller's to refuse.
 */
export function matchesHeldTextHash(heldHash: string, text: string): boolean {
  return heldHash === gatedTextHash(text) || heldHash === sha256(text)
}
