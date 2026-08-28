/**
 * The e2e upload fixtures, read out of the manifest `scripts/corpus-fixtures.sh`
 * writes next to them.
 *
 * 🔴 NOTHING IN `e2e/` MAY HARDCODE A FIXTURE FILENAME OR A MARKER WORD. The
 * fixtures come from `../corpus-generativo`, which is a separate repo and gets
 * regenerated. A regeneration changes which document sorts first, so a literal
 * filename in a spec fails for a reason that has nothing to do with this code.
 * Ask this module instead.
 *
 * The fixtures are NOT committed — they are built. That is deliberate: a
 * vendored copy of a corpus that still moves is a copy that quietly tests
 * yesterday's corpus.
 */

import fs from 'node:fs'
import path from 'node:path'

import { FIXTURES_DIR } from './env'

export interface FixtureEntry {
  /** Filename inside `e2e/fixtures`. */
  file: string
  /** The corpus file it was built from. */
  source: string
  /** What to upload it as. Must stay inside `MEDIA_MIME_TYPES`. */
  mimeType: string
  /**
   * A word that can only have come from inside this document — the subject's
   * name, which is unique across the corpus's 250 documents.
   *
   * ⚠ NOT assertable for audio: see `markerIsAssertable`.
   */
  marker: string
  ecosistema: string
  formato: string
  words: number
  durationSeconds?: number
  /**
   * `false` on the audio fixture. The marker there is a transcriber's guess at
   * a spoken proper noun, and no ASR model spells `Valdés Colín` reliably. It
   * is there so a human reading a failure knows whose testimony it is.
   */
  markerIsAssertable?: boolean
}

export interface FixtureManifest {
  /** Short SHA of the corpus checkout these were built from. */
  corpusCommit: string
  pdf: FixtureEntry
  docx: FixtureEntry
  audio: FixtureEntry
}

let cached: FixtureManifest | null = null

/**
 * Load the manifest. Throws with the command that fixes it, because the failure
 * mode this guards against is a stack trace saying only `ENOENT fixtures.json`.
 */
export function fixtures(): FixtureManifest {
  if (cached) return cached
  const manifestPath = path.join(FIXTURES_DIR, 'fixtures.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `No e2e fixtures. They are built from the corpus, not committed.\n` +
        `  ./scripts/corpus-fixtures.sh\n` +
        `Looked for: ${manifestPath}`,
    )
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as FixtureManifest
  for (const key of ['pdf', 'docx', 'audio'] as const) {
    const entry = manifest[key]
    if (!entry || !fs.existsSync(path.join(FIXTURES_DIR, entry.file))) {
      throw new Error(
        `fixtures.json names a ${key} fixture (${entry?.file}) that is not on disk. ` +
          `Re-run ./scripts/corpus-fixtures.sh`,
      )
    }
  }
  cached = manifest
  return cached
}
