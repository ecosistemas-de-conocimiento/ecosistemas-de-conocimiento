/**
 * The Playwright journey's upload fixtures, read out of the manifest
 * `scripts/corpus-fixtures.sh` writes next to them.
 *
 * 🔴 NOTHING IN `e2e/` MAY HARDCODE A FIXTURE FILENAME OR A MARKER WORD. The
 * fixtures come from `../corpus-generativo`, a separate repo that gets
 * regenerated; a regeneration changes which document sorts first. A literal
 * filename in the spec then fails for a reason that has nothing to do with the
 * app. Ask this module instead.
 *
 * The fixtures are NOT committed — they are built, so that re-running the
 * script after a corpus update is the whole upgrade path.
 *
 * Kept deliberately parallel to `apps/backend/e2e/support/fixtures.ts`. The two
 * suites read the SAME generated manifest shape out of their own directory.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fixturesDir } from './env';

export interface FixtureEntry {
  /** Filename inside `e2e/fixtures`. */
  file: string;
  /** The corpus file it was built from. */
  source: string;
  /** What the file chooser must report. Must stay inside `MEDIA_MIME_TYPES`. */
  mimeType: string;
  /**
   * A word that can only have come from inside this document — the subject's
   * name, unique across the corpus's 250 documents. Used to ask a question the
   * answer can only be grounded in.
   *
   * ⚠ NOT assertable for audio: see `markerIsAssertable`.
   */
  marker: string;
  ecosistema: string;
  formato: string;
  words: number;
  durationSeconds?: number;
  /**
   * `false` on the audio fixture — the marker there is a transcriber's guess at
   * a spoken proper noun, which no ASR model spells reliably.
   */
  markerIsAssertable?: boolean;
}

export interface FixtureManifest {
  /** Short SHA of the corpus checkout these were built from. */
  corpusCommit: string;
  pdf: FixtureEntry;
  docx: FixtureEntry;
  audio: FixtureEntry;
}

let cached: FixtureManifest | null = null;

/** Load the manifest, naming the command that fixes a missing one. */
export function fixtures(): FixtureManifest {
  if (cached) return cached;
  const manifestPath = join(fixturesDir, 'fixtures.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      'No e2e fixtures. They are built from the corpus, not committed.\n' +
        '  ./scripts/corpus-fixtures.sh\n' +
        `Looked for: ${manifestPath}`,
    );
  }
  cached = JSON.parse(readFileSync(manifestPath, 'utf8')) as FixtureManifest;
  return cached;
}

/** The bytes of one fixture, ready for `setFiles`. */
export function fixtureBytes(entry: FixtureEntry): Buffer {
  const file = join(fixturesDir, entry.file);
  if (!existsSync(file)) {
    throw new Error(
      `fixtures.json names ${entry.file}, which is not on disk. ` +
        'Re-run ./scripts/corpus-fixtures.sh',
    );
  }
  return readFileSync(file);
}
