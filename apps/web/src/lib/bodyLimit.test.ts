import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_AUDIO_UPLOAD_BYTES } from './config';

/**
 * 🔴 adapter-node refuses any request body over `BODY_SIZE_LIMIT` (default
 * 512K) with a 413, BEFORE the upload route runs. Every recording past ~2 min
 * failed on dev that way (2026-10-24: a 5.3 MB WAV got 413). The image must set
 * a limit at least as large as the audio upload cap, plus multipart overhead.
 */

const UNITS: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

function parseLimit(raw: string): number {
  const m = /^(\d+)([KMG]?)$/i.exec(raw.trim());
  if (!m) throw new Error(`unparseable BODY_SIZE_LIMIT: ${raw}`);
  return Number(m[1]) * UNITS[m[2]!.toUpperCase()]!;
}

describe('web image body limit', () => {
  const dockerfile = readFileSync(resolve(import.meta.dirname, '../../Dockerfile'), 'utf8');
  const runStage = dockerfile.slice(dockerfile.lastIndexOf('FROM '));

  it('sets BODY_SIZE_LIMIT in the run stage, above the audio upload cap', () => {
    const m = /^ENV BODY_SIZE_LIMIT=(\S+)/m.exec(runStage);
    expect(m, 'ENV BODY_SIZE_LIMIT missing from the run stage').not.toBeNull();
    expect(parseLimit(m![1]!)).toBeGreaterThan(MAX_AUDIO_UPLOAD_BYTES);
  });
});
