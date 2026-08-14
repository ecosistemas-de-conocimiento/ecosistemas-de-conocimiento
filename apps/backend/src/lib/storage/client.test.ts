/**
 * STORAGE MODE SELECTION — the local-disk fallback and its one dangerous edge.
 *
 * What matters here:
 *   1. NO `S3_*` set ⇒ local disk, cleanly. A bare `pnpm dev` must keep working
 *      after this change; that is the whole reason the plugin list is dynamic.
 *   2. 🔴 SOME `S3_*` set ⇒ still local disk, but flagged as a MISCONFIGURATION.
 *      This is the failure that actually bites: somebody sets `S3_ENDPOINT` on a
 *      deployed environment, forgets the secret, and every upload silently lands
 *      on a container filesystem the next redeploy throws away. It must be loud.
 *   3. The client config carries the four settings that are not optional against
 *      an S3-compatible store: path-style addressing and the two checksum
 *      opt-outs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_BUCKET,
  DEFAULT_REGION,
  describeStorageMode,
  isStorageConfigured,
  resolveStorageMode,
  s3ClientConfig,
} from './client'

const FULL = {
  S3_ENDPOINT: 'http://rustfs:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'edc',
  S3_ACCESS_KEY_ID: 'app-key',
  S3_SECRET_ACCESS_KEY: 'app-secret',
}

const S3_KEYS = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const key of S3_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of S3_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('local-disk fallback', () => {
  it('falls back to local disk when NO S3 variable is set, and reports nothing missing', () => {
    const mode = resolveStorageMode({})

    expect(mode.kind).toBe('local')
    // `missing: []` is what distinguishes a deliberate local run from a broken
    // deployment. Both are `local`; only one is a problem.
    expect(mode.missing).toEqual([])
    expect(isStorageConfigured({})).toBe(false)
  })

  it('logs the local-disk fallback at INFO, naming the directory', () => {
    const log = describeStorageMode(resolveStorageMode({}))

    expect(log.level).toBe('info')
    expect(log.message).toContain('LOCAL DISK')
    expect(log.message).toContain('./media')
  })

  it('still falls back to local disk when only some S3 variables are set', () => {
    const mode = resolveStorageMode({ S3_ENDPOINT: 'http://rustfs:9000' })

    expect(mode.kind).toBe('local')
    expect(isStorageConfigured({ S3_ENDPOINT: 'http://rustfs:9000' })).toBe(false)
  })

  it('🔴 flags a PARTIAL configuration at ERROR and names every missing variable', () => {
    const mode = resolveStorageMode({
      S3_ENDPOINT: 'http://rustfs:9000',
      S3_ACCESS_KEY_ID: 'app-key',
    })

    expect(mode.missing).toEqual(['S3_SECRET_ACCESS_KEY'])

    const log = describeStorageMode(mode)
    expect(log.level).toBe('error')
    expect(log.message).toContain('S3_SECRET_ACCESS_KEY')
    // The consequence, not just the symptom — this is what makes the log
    // actionable at 2am.
    expect(log.message).toContain('LOCAL DISK')
  })

  it('treats an EMPTY STRING exactly like an absent variable', () => {
    // ⚠ Contract with the compose file. Docker compose cannot express "absent":
    // `${S3_ENDPOINT:-}` sets an empty string. If empty meant "configured", a
    // stack that merely forgot its env_file would try to reach an endpoint of
    // `''` instead of falling back to disk.
    const mode = resolveStorageMode({
      S3_ENDPOINT: '',
      S3_ACCESS_KEY_ID: '',
      S3_SECRET_ACCESS_KEY: '',
    })

    expect(mode.kind).toBe('local')
    expect(mode.missing).toEqual([])
  })

  it('flags a mix of empty and real values as PARTIAL, not as configured', () => {
    const mode = resolveStorageMode({
      S3_ENDPOINT: 'http://rustfs:9000',
      S3_ACCESS_KEY_ID: 'app-key',
      S3_SECRET_ACCESS_KEY: '',
    })

    expect(mode.kind).toBe('local')
    expect(mode.missing).toEqual(['S3_SECRET_ACCESS_KEY'])
    expect(describeStorageMode(mode).level).toBe('error')
  })

  it('refuses to build a client config when storage is not configured', () => {
    expect(() => s3ClientConfig({})).toThrow(/not configured/i)
  })
})

describe('object-storage mode', () => {
  it('selects s3 when all three required variables are present', () => {
    const mode = resolveStorageMode(FULL)

    expect(mode.kind).toBe('s3')
    expect(mode.missing).toEqual([])
    expect(mode.bucket).toBe('edc')
    expect(isStorageConfigured(FULL)).toBe(true)
  })

  it('logs the active bucket and endpoint at boot, at INFO', () => {
    const log = describeStorageMode(resolveStorageMode(FULL))

    expect(log.level).toBe('info')
    expect(log.message).toContain('edc')
    expect(log.message).toContain('http://rustfs:9000')
    // The property that must never quietly change.
    expect(log.message).toContain('no presigned URLs')
  })

  it('defaults the bucket and the region so only three variables are truly required', () => {
    const mode = resolveStorageMode({
      S3_ENDPOINT: 'http://rustfs:9000',
      S3_ACCESS_KEY_ID: 'app-key',
      S3_SECRET_ACCESS_KEY: 'app-secret',
    })

    expect(mode.kind).toBe('s3')
    expect(mode.bucket).toBe(DEFAULT_BUCKET)
    expect(mode.region).toBe(DEFAULT_REGION)
  })
})

describe('the client settings that are not optional against a non-AWS store', () => {
  it('forces path-style addressing', () => {
    // Without it the SDK sends `edc.rustfs:9000` and every call fails DNS
    // resolution rather than authorization, which makes the error misleading.
    expect(s3ClientConfig(FULL).forcePathStyle).toBe(true)
  })

  it('opts out of the SDK default checksum behaviour in both directions', () => {
    const config = s3ClientConfig(FULL)

    // Since ~SDK v3.729 checksums are computed and validated on every call.
    // Several S3-compatible stores reject the extra headers outright, and the
    // resulting error names the checksum rather than the store.
    expect(config.requestChecksumCalculation).toBe('WHEN_REQUIRED')
    expect(config.responseChecksumValidation).toBe('WHEN_REQUIRED')
  })

  it('passes the endpoint and credentials through unchanged', () => {
    const config = s3ClientConfig(FULL)

    expect(config.endpoint).toBe('http://rustfs:9000')
    expect(config.credentials).toEqual({
      accessKeyId: 'app-key',
      secretAccessKey: 'app-secret',
    })
  })
})
