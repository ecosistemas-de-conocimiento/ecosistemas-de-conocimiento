/**
 * WIRING PAYLOAD'S S3 ADAPTER ONTO `media` — and the one property that must
 * survive it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 FILES ARE SERVED THROUGH THIS APP. THERE ARE NO PRESIGNED URLS. EVER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Media.ts` enforces read access as a WHERE CONSTRAINT, and Payload's static
 * handler ANDs it into the lookup behind `GET /api/media/file/:filename`. The
 * ONLY reason that keeps working with the bytes in a bucket is that the S3
 * adapter runs as an `upload.handlers` entry — i.e. AFTER the access check,
 * inside the same request.
 *
 * Read `payload/dist/uploads/endpoints/getFile.js`: it calls `checkFileAccess`
 * FIRST (which runs `access.read`, ANDs the returned constraint with
 * `filename`, and `throw Forbidden` when no row matches), and only then loops
 * `collection.upload.handlers`. Read `@payloadcms/plugin-cloud-storage`'s
 * `plugin.js`: it pushes `adapter.staticHandler` into those handlers under
 * `if (!options.disablePayloadAccessControl)`.
 *
 * A presigned URL leaves that chain entirely. Whoever holds the link reads the
 * bytes: no session, no membership check, no uploader-only draft rule, no
 * expiry the product controls. Every rule in `Media.ts` becomes decorative for
 * the lifetime of the link — and links get pasted into chats and logs.
 *
 * ⚠ FOUR OPTIONS WOULD BREAK THIS, and all four are LEFT UNSET on purpose. This
 * is the easy accident: they are ordinary-looking performance or convenience
 * flags, and none of them fails loudly.
 *
 *   · `signedDownloads`             — makes `staticHandler` return
 *                                     `Response.redirect(presignedUrl, 302)`.
 *                                     The access check still runs, but the
 *                                     bytes then come from a URL that outlives
 *                                     it by up to 2h and is shareable.
 *   · `disablePayloadAccessControl` — stops registering `staticHandler` as an
 *                                     upload handler at all and points `url`
 *                                     straight at the bucket. Total bypass.
 *   · `clientUploads`               — registers `/storage-s3-generate-signed-url`
 *                                     and hands presigned PUT URLs to browsers.
 *   · `generateFileURL`             — overrides the app-relative `url` with
 *                                     whatever you return, e.g. a CDN origin
 *                                     nobody authenticates against.
 *
 * If a future change needs one of these, it needs a decision record first, not
 * a config edit.
 *
 * ⚠ Cost of doing it this way, written down so nobody "optimises" it away:
 * every byte of every download crosses this Node process. For 10–100 MB audio
 * that is real bandwidth and real event-loop time. It is the price of the
 * access rule, and the access rule is the product.
 */

import { s3Storage } from '@payloadcms/storage-s3'
import type { Plugin } from 'payload'

import { isStorageConfigured, s3ClientConfig, getStorageBucket } from './client'

/**
 * The plugin list for `buildConfig({ plugins })`.
 *
 * Empty when object storage is not configured — which is what keeps a bare
 * `pnpm dev` working. With no plugin, Payload's own `disableLocalStorage`
 * stays false and `media` writes to `./media/` exactly as before.
 */
export function storagePlugins(): Plugin[] {
  if (!isStorageConfigured()) return []
  return [buildS3Plugin()]
}

function buildS3Plugin(): Plugin {
  return s3Storage({
    collections: {
      /**
       * `media` is the only upload collection in this app.
       *
       * Empty object = every default. In particular the four dangerous options
       * documented above stay unset, and `prefix` is NOT passed here: the
       * per-object key prefix is a real field declared on the collection and
       * stamped per row by `bindMediaToEcosystem`, so the database schema is
       * identical whether or not this plugin is active. See `Media.ts`.
       */
      media: {},
    },
    bucket: getStorageBucket(),
    config: s3ClientConfig(),
  })
}
