import { describe, expect, it } from 'vitest'

import { MAX_MEDIA_UPLOAD_BYTES, rejectOversizedUpload } from './Media'

/**
 * The browser and the BFF both check an upload's size, and neither is a
 * security boundary: `POST /api/media` is a plain authenticated REST endpoint
 * that a session cookie can reach directly. This hook is the gate that binds.
 */

const MB = 1024 * 1024
const run = (size: unknown) =>
  (rejectOversizedUpload as (a: unknown) => unknown)({
    data: { alt: 'x' },
    req: { file: size === undefined ? undefined : { size } },
  })

describe('rejectOversizedUpload', () => {
  it('accepts a file at the cap', () => {
    expect(() => run(MAX_MEDIA_UPLOAD_BYTES)).not.toThrow()
  })

  it('🔴 rejects one byte over — the whole point of the gate', () => {
    expect(() => run(MAX_MEDIA_UPLOAD_BYTES + 1)).toThrow()
  })

  it('the message names both numbers, so the limit is actionable', () => {
    try {
      run(512 * MB)
      throw new Error('should have thrown')
    } catch (err) {
      const msg = JSON.stringify((err as { data?: unknown }).data ?? String(err))
      expect(msg).toContain('512')
      expect(msg).toContain('200')
    }
  })

  it('⚠ the cap is the AUDIO limit, not the document one', () => {
    // Applying the 20 MB document limit here would refuse every real recording.
    // A 100 MB audio upload is ordinary and must pass.
    expect(MAX_MEDIA_UPLOAD_BYTES).toBe(200 * MB)
    expect(() => run(100 * MB)).not.toThrow()
  })

  it('lets a metadata-only write through — there is no file to measure', () => {
    expect(() => run(undefined)).not.toThrow()
  })

  it('ignores a non-numeric size rather than blocking the upload', () => {
    // A parser that reports something odd must not become an outage. The
    // absurd-size case is what this hook exists for, and that reports a number.
    expect(() => run('big')).not.toThrow()
    expect(() => run(Number.NaN)).not.toThrow()
  })
})
