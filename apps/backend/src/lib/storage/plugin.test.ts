/**
 * 🔴 THE ACCESS-CONTROL PROPERTY, ASSERTED ON THE REAL PLUGIN OUTPUT.
 *
 * `Media.ts` enforces read access as a WHERE constraint that Payload ANDs into
 * `GET /api/media/file/:filename`. Moving the bytes into a bucket is only safe
 * because the S3 adapter runs as an `upload.handlers` entry, INSIDE the request,
 * AFTER `checkFileAccess`. A presigned URL would leave that chain entirely, and
 * every rule in `Media.ts` — the uploader-only draft rule included — would apply
 * to nothing for the life of the link.
 *
 * The plugin can be configured to do exactly that, with four ordinary-looking
 * options, none of which fails loudly. So this file runs the real plugin over a
 * real-shaped config and asserts the properties, rather than trusting that
 * nobody will ever add a flag.
 *
 * ⚠ These tests will fail if someone sets `signedDownloads`, `clientUploads`,
 * `disablePayloadAccessControl` or `generateFileURL`. That is the point. If a
 * future change genuinely needs one, it needs a decision record, not a green
 * test suite edited to match.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config } from 'payload'

import { storagePlugins } from './plugin'

const S3_KEYS = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const

let saved: Record<string, string | undefined>

const configureS3 = () => {
  process.env.S3_ENDPOINT = 'http://rustfs:9000'
  process.env.S3_REGION = 'us-east-1'
  process.env.S3_BUCKET = 'edc'
  process.env.S3_ACCESS_KEY_ID = 'app-key'
  process.env.S3_SECRET_ACCESS_KEY = 'app-secret'
}

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

/** A config shaped like ours, cut down to what the plugin actually reads. */
const baseConfig = (): Config =>
  ({
    collections: [
      {
        slug: 'media',
        fields: [{ name: 'alt', type: 'text' }],
        upload: { mimeTypes: ['application/pdf'] },
      },
      { slug: 'documents', fields: [] },
    ],
    endpoints: [],
  }) as unknown as Config

type BuiltCollection = {
  slug: string
  upload?: {
    disableLocalStorage?: boolean
    handlers?: unknown[]
  }
  fields?: Array<{ name?: string }>
}

const applyPlugins = (): Config => {
  const plugins = storagePlugins()
  expect(plugins).toHaveLength(1)
  return plugins[0](baseConfig()) as Config
}

const mediaOf = (config: Config): BuiltCollection =>
  (config.collections as unknown as BuiltCollection[]).find((c) => c.slug === 'media')!

describe('local-disk fallback', () => {
  it('contributes NO plugin when object storage is not configured', () => {
    // The empty list IS the fallback: with no plugin, Payload never sets
    // `disableLocalStorage` and `media` keeps writing to ./media/.
    expect(storagePlugins()).toEqual([])
  })
})

describe('object storage', () => {
  beforeEach(configureS3)

  it('takes media off local disk', () => {
    expect(mediaOf(applyPlugins()).upload?.disableLocalStorage).toBe(true)
  })

  it('leaves collections that are not media alone', () => {
    const documents = (applyPlugins().collections as unknown as BuiltCollection[]).find(
      (c) => c.slug === 'documents',
    )!

    expect(documents.upload).toBeUndefined()
  })

  it('🔴 registers the S3 handler as an upload handler, which is what keeps the access rule on the byte route', () => {
    const handlers = mediaOf(applyPlugins()).upload?.handlers

    // Payload's static route runs `checkFileAccess` — which executes
    // `access.read` and ANDs its WHERE constraint into the filename lookup —
    // and ONLY THEN loops `upload.handlers`. So a registered handler is a
    // handler that runs behind the access check.
    //
    // The plugin pushes it under `if (!options.disablePayloadAccessControl)`.
    // Setting that option removes the handler and points `url` at the bucket
    // instead: a total bypass. An empty list here would be that bug.
    expect(handlers).toHaveLength(1)
    expect(typeof handlers?.[0]).toBe('function')
  })

  it('🔴 registers NO signed-URL endpoint — browsers never get a presigned PUT', () => {
    // `clientUploads` would add `/storage-s3-generate-signed-url`, handing
    // browsers presigned PUT URLs that write to the bucket without Payload
    // seeing the request at all.
    const endpoints = (applyPlugins().endpoints ?? []) as Array<{ path?: string }>

    expect(endpoints.some((e) => String(e.path).includes('signed-url'))).toBe(false)
    expect(endpoints).toHaveLength(0)
  })

  it('keeps the prefix field the collection declares, rather than replacing the schema', () => {
    // The column has to exist in BOTH storage modes — schema push is off, so a
    // field that only appears when the plugin is active means a missing column
    // and a failing insert in the other mode.
    const config = baseConfig()
    ;(config.collections as unknown as BuiltCollection[])[0].fields = [
      { name: 'alt' },
      { name: 'prefix' },
    ]
    const built = storagePlugins()[0](config) as Config
    const fields = mediaOf(built).fields ?? []

    expect(fields.filter((f) => f.name === 'prefix')).toHaveLength(1)
  })
})
