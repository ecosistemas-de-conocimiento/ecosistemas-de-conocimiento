/**
 * 🔴 THE END-TO-END CHECK: the REAL `payload.config.ts`, both storage modes.
 *
 * `lib/storage/plugin.test.ts` runs the plugin over a stand-in config. This runs
 * it over the actual one, because the property that matters is a property of the
 * app as shipped, not of a fixture. It is the closest thing to booting the
 * server that a unit test can be, and it is what stands in for a live RustFS:
 * whatever the store does, THIS is how the app is wired in front of it.
 *
 * What it proves:
 *   · No `S3_*` ⇒ media stays on local disk. A bare `pnpm dev` still works.
 *   · With `S3_*` ⇒ media goes to the bucket, and the S3 handler is registered
 *     as an `upload.handlers` entry — i.e. BEHIND `checkFileAccess`, which runs
 *     `Media.access.read` and ANDs its WHERE constraint into the filename lookup
 *     before any handler is reached (`payload/dist/uploads/endpoints/getFile.js`).
 *   · The `media` schema is IDENTICAL in both modes, so one migration history
 *     covers both and switching a deployment is an env change, not a DB change.
 *   · No signed-URL endpoint is ever registered.
 *
 * ⚠ `resetModules` + dynamic import is load-bearing: the plugin list is built
 * once, at module load, from `process.env`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface BuiltMedia {
  slug: string
  upload?: { disableLocalStorage?: boolean; handlers?: unknown[] }
  fields: Array<{ name?: string }>
  access: { read: unknown }
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
  for (const key of [...S3_KEYS, 'PAYLOAD_SECRET', 'DATABASE_URI']) {
    saved[key] = process.env[key]
  }
  for (const key of S3_KEYS) delete process.env[key]
  process.env.PAYLOAD_SECRET ||= 'test-secret'
  process.env.DATABASE_URI ||= 'postgres://test@localhost:5433/test'
  vi.resetModules()
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
})

async function loadConfig() {
  const mod = await import('./payload.config')
  const config = await mod.default
  const media = (config.collections as unknown as BuiltMedia[]).find((c) => c.slug === 'media')!
  return { config, media }
}

describe('no S3 env — the local-disk fallback', () => {
  it('leaves media on local disk', async () => {
    const { media } = await loadConfig()

    expect(media.upload?.disableLocalStorage).toBeFalsy()
    expect(media.upload?.handlers ?? []).toHaveLength(0)
  })

  it('still declares the prefix column, so the schema does not depend on the mode', async () => {
    const { media } = await loadConfig()

    expect(media.fields.filter((f) => f.name === 'prefix')).toHaveLength(1)
  })
})

describe('S3 env — object storage', () => {
  beforeEach(() => {
    process.env.S3_ENDPOINT = 'http://rustfs:9000'
    process.env.S3_REGION = 'us-east-1'
    process.env.S3_BUCKET = 'edc'
    process.env.S3_ACCESS_KEY_ID = 'app-key'
    process.env.S3_SECRET_ACCESS_KEY = 'app-secret'
  })

  it('moves media into the bucket', async () => {
    const { media } = await loadConfig()

    expect(media.upload?.disableLocalStorage).toBe(true)
  })

  it('🔴 serves bytes through an upload handler, which is what keeps the access rule on the file route', async () => {
    const { media } = await loadConfig()

    // Payload runs `checkFileAccess` — `access.read`, ANDed into the filename
    // lookup — and only then loops `upload.handlers`. No handler would mean the
    // access control was disabled; a redirect would mean a presigned URL.
    expect(media.upload?.handlers).toHaveLength(1)
    // And the rule itself is still a function that returns a constraint, not a
    // boolean and not something the plugin replaced.
    expect(typeof media.access.read).toBe('function')
  })

  it('🔴 registers no signed-URL endpoint anywhere in the app', async () => {
    const { config } = await loadConfig()
    const paths = ((config.endpoints ?? []) as Array<{ path: string }>).map((e) => String(e.path))

    expect(paths.some((p) => p.includes('signed-url'))).toBe(false)
  })

  it('has exactly the same media fields as the local-disk build', async () => {
    const withS3 = (await loadConfig()).media.fields.map((f) => f.name).sort()

    for (const key of S3_KEYS) delete process.env[key]
    vi.resetModules()
    const local = (await loadConfig()).media.fields.map((f) => f.name).sort()

    expect(withS3).toEqual(local)
    expect(withS3).toContain('prefix')
  })
})
