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
 * ── ⚠ WHY BOTH CONFIGS ARE BUILT ONCE, IN A SINGLE `beforeAll` ──────────────
 *
 * Importing the real `payload.config` pulls in Payload, the postgres adapter and
 * every collection — roughly 3.8 s of module-graph transform on an unloaded
 * machine. This file used to call `loadConfig()` INSIDE each test body, so the
 * first test in the file paid all of it out of its own 5 s budget and failed at
 * almost exactly 5000 ms on any busy or parallel run. It failed for LATENESS,
 * not for being wrong, and it was the single reason the root `pnpm test` had to
 * stay sequential. (ai-service had the identical `await import('../server.js')`
 * pattern and fixed it the same way.)
 *
 * 🔴 THE FIX IS NOT A BIGGER `testTimeout`. A slow TEST should still fail — that
 * is the signal the 5 s default exists to give. What must not be charged to one
 * test is a slow ONE-TIME SETUP shared by twelve assertions. So the cost moves
 * into a hook, and `vitest.config.ts` gives hooks a realistic budget instead.
 *
 * ⚠ `resetModules` + dynamic import is still load-bearing: the plugin list is
 * built ONCE, at module load, from `process.env`. That is exactly why the two
 * modes cannot share one import, and why the env is swapped between the two
 * builds below rather than per test.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

interface BuiltMedia {
  slug: string
  upload?: { disableLocalStorage?: boolean; handlers?: unknown[] }
  fields: Array<{ name?: string }>
  access: { read: unknown }
}

interface BuiltConfig {
  collections: unknown
  endpoints?: unknown
}

const S3_KEYS = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const

const S3_ENV: Record<(typeof S3_KEYS)[number], string> = {
  S3_ENDPOINT: 'http://rustfs:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'edc',
  S3_ACCESS_KEY_ID: 'app-key',
  S3_SECRET_ACCESS_KEY: 'app-secret',
}

/** One built config, in one storage mode. */
interface Built {
  config: BuiltConfig
  media: BuiltMedia
}

/**
 * ⚠ Each call re-evaluates `payload.config` against the CURRENT `process.env`.
 * The transform is cached by vitest after the first call, so the second mode is
 * cheap; it is the first that used to blow the per-test budget.
 */
async function loadConfig(): Promise<Built> {
  vi.resetModules()
  const mod = await import('./payload.config')
  const config = (await mod.default) as unknown as BuiltConfig
  const media = (config.collections as unknown as BuiltMedia[]).find((c) => c.slug === 'media')!
  return { config, media }
}

let local: Built
let withS3: Built
/** Put `process.env` back exactly as it was found. Set by the hook below. */
let restore: () => void = () => {}

beforeAll(async () => {
  const saved: Record<string, string | undefined> = {}
  for (const key of [...S3_KEYS, 'PAYLOAD_SECRET', 'DATABASE_URI']) saved[key] = process.env[key]
  restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.resetModules()
  }

  process.env.PAYLOAD_SECRET ||= 'test-secret'
  process.env.DATABASE_URI ||= 'postgres://test@localhost:5433/test'

  // Local disk first: the absence of the variables IS the condition under test,
  // so it is asserted from a clean environment rather than from a cleanup.
  for (const key of S3_KEYS) delete process.env[key]
  local = await loadConfig()

  for (const key of S3_KEYS) process.env[key] = S3_ENV[key]
  withS3 = await loadConfig()
})

afterAll(() => restore())

describe('no S3 env — the local-disk fallback', () => {
  it('leaves media on local disk', () => {
    expect(local.media.upload?.disableLocalStorage).toBeFalsy()
    expect(local.media.upload?.handlers ?? []).toHaveLength(0)
  })

  it('still declares the prefix column, so the schema does not depend on the mode', () => {
    expect(local.media.fields.filter((f) => f.name === 'prefix')).toHaveLength(1)
  })
})

describe('S3 env — object storage', () => {
  it('moves media into the bucket', () => {
    expect(withS3.media.upload?.disableLocalStorage).toBe(true)
  })

  it('🔴 serves bytes through an upload handler, which is what keeps the access rule on the file route', () => {
    // Payload runs `checkFileAccess` — `access.read`, ANDed into the filename
    // lookup — and only then loops `upload.handlers`. No handler would mean the
    // access control was disabled; a redirect would mean a presigned URL.
    expect(withS3.media.upload?.handlers).toHaveLength(1)
    // And the rule itself is still a function that returns a constraint, not a
    // boolean and not something the plugin replaced.
    expect(typeof withS3.media.access.read).toBe('function')
  })

  it('🔴 registers no signed-URL endpoint anywhere in the app', () => {
    const paths = ((withS3.config.endpoints ?? []) as Array<{ path: string }>).map((e) =>
      String(e.path),
    )

    expect(paths.some((p) => p.includes('signed-url'))).toBe(false)
  })

  it('has exactly the same media fields as the local-disk build', () => {
    // ⚠ One migration history has to cover both modes: schema push is off, so a
    // column present in one build and absent in the other means every insert
    // fails in whichever deployment lost it.
    const s3Fields = withS3.media.fields.map((f) => f.name).sort()
    const localFields = local.media.fields.map((f) => f.name).sort()

    expect(s3Fields).toEqual(localFields)
    expect(s3Fields).toContain('prefix')
  })
})
