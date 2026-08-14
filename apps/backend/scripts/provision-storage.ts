/**
 * OBJECT-STORAGE PROVISIONING + CONFORMANCE CHECK.
 *
 *     pnpm --filter @edc/backend provision:storage
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS AN OPERATION THAT RE-RUNS. IT IS NOT AN INIT CONTAINER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * RustFS keeps its IAM database on the DATA VOLUME and no environment variable
 * seeds it. So "provisioned" is not a state the stack reaches once and keeps:
 * `docker compose down -v` un-provisions it, and an init container that already
 * exited will never notice. Every step below is safe to repeat, in any order,
 * any number of times, against a store that is already fully set up. Run it:
 *
 *   · after `docker compose down -v` / any volume wipe,
 *   · when uploads start failing and you need to know WHICH call broke,
 *   · on a brand new environment, before the first upload,
 *   · whenever you want, because it is idempotent.
 *
 * Exit code 0 = the store can do everything this app needs. Non-zero = it
 * cannot, and the failing step is named.
 *
 * ── WHAT IT DOES NOT DO: CREATE THE SCOPED CREDENTIAL ───────────────────────
 *
 * 🔴 Creating an IAM user is NOT an S3 API operation. It goes through the
 * store's admin API, and on MinIO-compatible stores `add-user` takes a body
 * ENCRYPTED with the admin secret (madmin's own AES-GCM/argon2id envelope), not
 * plain JSON. Hand-rolling that from here would be a large amount of
 * unverifiable crypto for one call, and getting it subtly wrong would fail in a
 * way that looks like a permissions problem. So the credential is created with
 * the store's own tooling; this script DETECTS its absence and prints the exact
 * commands. See `printCredentialRecovery` at the bottom.
 *
 * ── THE OPTIONAL ROOT CREDENTIAL ───────────────────────────────────────────
 *
 * A correctly scoped application key usually cannot `CreateBucket` — that is
 * the point of scoping it. Set `S3_ROOT_ACCESS_KEY_ID` / `S3_ROOT_SECRET_ACCESS_KEY`
 * and the bucket step runs as root while every conformance call still runs as
 * the APP credential, which is the only credential whose behaviour matters.
 * Both are read HERE ONLY; the running app never sees them.
 */

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'

import { ensureBucket } from '../src/lib/storage/ensureBucket'
import {
  S3_ENV_VARS,
  getStorageBucket,
  httpStatusOf,
  resolveStorageMode,
  s3ClientConfig,
} from '../src/lib/storage/client'
import type { BucketOps } from '../src/lib/storage/client'

/** Everything this run writes lands here and is deleted again. */
const PROBE_PREFIX = '.provisioning'

const BODY = Buffer.from('edc object storage conformance probe\n'.repeat(64), 'utf8')

/** Minimum S3 multipart part size. Anything smaller is rejected mid-upload. */
const MIN_PART_SIZE = 5 * 1024 * 1024

let failures = 0

const ok = (what: string, detail = '') =>
  console.log(`  ✅ ${what}${detail ? ` — ${detail}` : ''}`)
const bad = (what: string, detail: string) => {
  failures++
  console.error(`  🔴 ${what} — ${detail}`)
}

const describe = (err: unknown): string => {
  const e = err as { name?: string; message?: string } | null
  const status = httpStatusOf(err)
  return `${e?.name ?? 'Error'}${status ? ` (HTTP ${status})` : ''}: ${e?.message ?? String(err)}`
}

const streamToBuffer = async (body: unknown): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function main(): Promise<void> {
  const mode = resolveStorageMode()
  const bucket = getStorageBucket()

  if (mode.kind !== 's3') {
    console.error(
      `\n🔴 Object storage is not configured, so there is nothing to provision.\n` +
        `   Set ${S3_ENV_VARS.join(', ')}` +
        (mode.missing.length > 0 ? ` (missing: ${mode.missing.join(', ')})` : '') +
        `\n   Without them this app stores uploads on local disk, which is a supported\n` +
        `   mode for a bare \`pnpm dev\` — but then you do not need this script.\n`,
    )
    process.exit(1)
  }

  console.log(`\nObject storage: ${mode.endpoint}  bucket "${bucket}"  region ${mode.region}\n`)

  const appConfig = s3ClientConfig()
  const app = new S3Client({ ...appConfig, maxAttempts: 1 })

  // ── 1. The bucket ────────────────────────────────────────────────────────
  console.log('1. Bucket (idempotent)')
  const rootKey = process.env.S3_ROOT_ACCESS_KEY_ID
  const rootSecret = process.env.S3_ROOT_SECRET_ACCESS_KEY
  const bucketClient =
    rootKey && rootSecret
      ? new S3Client({
          ...appConfig,
          credentials: { accessKeyId: rootKey, secretAccessKey: rootSecret },
          maxAttempts: 1,
        })
      : app
  if (bucketClient !== app) {
    console.log('   using S3_ROOT_* for this step; every check below uses the APP credential.')
  }

  const ops: BucketOps = {
    headBucket: async (Bucket) => {
      await bucketClient.send(new HeadBucketCommand({ Bucket }))
    },
    createBucket: async (Bucket) => {
      await bucketClient.send(new CreateBucketCommand({ Bucket }))
    },
  }

  try {
    // ⚠ `ensureBucket` is where the two store asymmetries live: HeadBucket is
    // branched on 404 ONLY (a 403 is ambiguous and propagates), and a
    // CreateBucket 409 counts as success because CreateBucket is idempotent for
    // root and NOT for a scoped key.
    const outcome = await ensureBucket(ops, bucket)
    ok(`bucket "${bucket}"`, outcome)
  } catch (err) {
    bad(`bucket "${bucket}"`, describe(err))
    printCredentialRecovery(bucket, err)
    process.exit(1)
  }

  // ── 2. The S3 surface this app actually uses ─────────────────────────────
  //
  // Every call below appears in `@payloadcms/storage-s3`'s adapter or in this
  // app's own code. Nothing here is a hypothetical: an S3-compatible store that
  // fails any one of them breaks uploads or downloads in production.
  console.log('\n2. S3 surface (as the APP credential)')
  const key = `${PROBE_PREFIX}/probe-${Date.now()}.txt`

  // PutObject with Content-Type — `uploadFile.js` for anything under 50MB.
  try {
    await app.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: BODY,
        ContentType: 'text/plain',
      }),
    )
    ok('PutObject (with Content-Type)')
  } catch (err) {
    bad('PutObject', describe(err))
    printCredentialRecovery(bucket, err)
    process.exit(1)
  }

  // HeadObject — 🔴 the adapter calls this BEFORE streaming and returns HTTP 500
  // outright when `ContentLength` is missing or zero (`getFile.js`:
  // `if (!fileSize) return new Response('Internal Server Error', {status:500})`).
  // A store that omits it does not degrade; every download breaks.
  let headLength: number | undefined
  try {
    const head = await app.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    headLength = head.ContentLength
    if (!headLength) {
      bad(
        'HeadObject ContentLength',
        'missing or zero — the serve route returns HTTP 500 for EVERY download in this state',
      )
    } else if (headLength !== BODY.length) {
      bad('HeadObject ContentLength', `${headLength}, expected ${BODY.length}`)
    } else {
      ok('HeadObject ContentLength', String(headLength))
    }
    if (head.ContentType === 'text/plain') ok('HeadObject ContentType')
    else bad('HeadObject ContentType', `got ${head.ContentType ?? 'nothing'}, expected text/plain`)
    if (head.ETag) ok('HeadObject ETag', head.ETag)
    else bad('HeadObject ETag', 'absent — conditional requests and 304s stop working')
  } catch (err) {
    bad('HeadObject', describe(err))
  }

  // GetObject, plain.
  try {
    const res = await app.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const body = await streamToBuffer(res.Body)
    if (body.equals(BODY)) ok('GetObject (whole object)', `${body.length} bytes`)
    else bad('GetObject', `returned ${body.length} bytes, expected ${BODY.length}`)
  } catch (err) {
    bad('GetObject', describe(err))
  }

  // 🔴 GetObject WITH Range. This is the check that matters most here.
  //
  // The adapter computes `206 Partial Content` and a `Content-Range` header
  // from the HEAD it already did, then asks the store for that range. A store
  // that IGNORES `Range` and returns the whole body produces a response whose
  // headers say "bytes 0-99/2368" while the payload is all 2368 bytes — a
  // corrupt response the client cannot detect. Audio playback with seeking
  // exercises this on nearly every request, not rarely.
  try {
    const start = 10
    const end = 41 // inclusive, 32 bytes
    const res = await app.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` }),
    )
    const body = await streamToBuffer(res.Body)
    const expected = BODY.subarray(start, end + 1)
    if (body.length !== expected.length) {
      bad(
        'GetObject Range',
        `asked for ${expected.length} bytes, got ${body.length}. The store IGNORES Range — ` +
          'every 206 response this app sends would be corrupt (right headers, wrong body).',
      )
    } else if (!body.equals(expected)) {
      bad('GetObject Range', 'returned the right LENGTH but the wrong BYTES')
    } else {
      ok('GetObject Range', `bytes ${start}-${end} honoured`)
    }
  } catch (err) {
    bad('GetObject Range', describe(err))
  }

  // ListObjectsV2 with ContinuationToken — pagination has to actually paginate.
  // `MaxKeys: 1` forces a truncated first page even with two objects.
  const secondKey = `${PROBE_PREFIX}/probe-${Date.now()}-b.txt`
  try {
    await app.send(new PutObjectCommand({ Bucket: bucket, Key: secondKey, Body: BODY }))
    const first = await app.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: PROBE_PREFIX, MaxKeys: 1 }),
    )
    if (!first.IsTruncated || !first.NextContinuationToken) {
      bad(
        'ListObjectsV2 pagination',
        'no NextContinuationToken on a truncated page — a full bucket listing would silently stop at page 1',
      )
    } else {
      const second = await app.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: PROBE_PREFIX,
          MaxKeys: 1,
          ContinuationToken: first.NextContinuationToken,
        }),
      )
      if ((second.Contents ?? []).length > 0) ok('ListObjectsV2 with ContinuationToken')
      else bad('ListObjectsV2 with ContinuationToken', 'second page came back empty')
    }
  } catch (err) {
    bad('ListObjectsV2', describe(err))
  }

  // ⚠ MULTIPART UPLOAD. Not on the original audit list, and it needs to be:
  // `uploadFile.js` switches from `PutObject` to `@aws-sdk/lib-storage`'s
  // `Upload` above 50MB, which is CreateMultipartUpload + UploadPart +
  // CompleteMultipartUpload — three calls the audit never covered. Audio is
  // 10–100× a PDF, so this is the NORMAL path for recordings, not an edge case.
  //
  // Probed with a 5MB part size rather than the adapter's 50MB: the API calls
  // are identical and it moves 6MB instead of 100MB.
  const multipartKey = `${PROBE_PREFIX}/probe-${Date.now()}-multipart.bin`
  try {
    const big = Buffer.alloc(MIN_PART_SIZE + 1024, 7)
    const upload = new Upload({
      client: app,
      params: { Bucket: bucket, Key: multipartKey, Body: big, ContentType: 'audio/mpeg' },
      partSize: MIN_PART_SIZE,
      queueSize: 2,
    })
    await upload.done()
    const head = await app.send(new HeadObjectCommand({ Bucket: bucket, Key: multipartKey }))
    if (head.ContentLength === big.length) {
      ok('Multipart upload', `${big.length} bytes in 2 parts (the path every audio file takes)`)
    } else {
      bad('Multipart upload', `reassembled to ${head.ContentLength} bytes, expected ${big.length}`)
    }
  } catch (err) {
    bad(
      'Multipart upload',
      `${describe(err)} — every upload over 50MB fails in this state, which means every recording`,
    )
  }

  // DeleteObjects (batch) — used when a document and its file are removed
  // together, and by any bulk cleanup.
  try {
    await app.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: [{ Key: secondKey }, { Key: multipartKey }], Quiet: true },
      }),
    )
    ok('DeleteObjects (batch)')
  } catch (err) {
    bad('DeleteObjects', describe(err))
  }

  // DeleteObject — `deleteFile.js`.
  try {
    await app.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    ok('DeleteObject')
  } catch (err) {
    bad('DeleteObject', describe(err))
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  if (failures === 0) {
    console.log(
      `\n✅ Storage is provisioned and every call this app makes works against "${bucket}".\n` +
        '   Files are served THROUGH this app (Payload access control per request).\n' +
        '   No presigned URLs are issued anywhere — see src/lib/storage/plugin.ts.\n',
    )
    process.exit(0)
  }
  console.error(
    `\n🔴 ${failures} check(s) failed. Uploads or downloads WILL break. Do not ship this store.\n`,
  )
  process.exit(1)
}

/**
 * The IAM-store failure, and the only thing that fixes it.
 *
 * 🔴 The store's user database lives on the data volume. Wipe the volume and the
 * app credential stops existing, so every call fails with `InvalidAccessKeyId`
 * long before it reaches a bucket. No amount of restarting helps and no env var
 * re-seeds it — the credential has to be re-created with the store's own admin
 * tooling. Printing the commands here is the difference between a 2-minute fix
 * and an afternoon.
 */
function printCredentialRecovery(bucket: string, err: unknown): void {
  const name = (err as { name?: string } | null)?.name ?? ''
  const status = httpStatusOf(err)
  const looksLikeAuth =
    name === 'InvalidAccessKeyId' ||
    name === 'SignatureDoesNotMatch' ||
    name === 'AccessDenied' ||
    status === 403

  if (!looksLikeAuth) return

  console.error(
    '\n   ⚠ This looks like a CREDENTIAL problem, not a network one.\n' +
      '     A 403 here is ambiguous on purpose: it means EITHER "not yours" OR\n' +
      '     "does not exist". Both have the same fix path.\n' +
      '\n' +
      '     🔴 The store keeps its IAM database on the DATA VOLUME. If the volume was\n' +
      '        wiped (`docker compose down -v`), the app credential no longer exists and\n' +
      '        nothing in this repository can re-create it — creating an IAM user is an\n' +
      '        ADMIN-API call, not an S3 one, and its body is encrypted with the admin\n' +
      '        secret. Re-create it with the store\'s own client, then re-run this script:\n' +
      '\n' +
      '        mc alias set edc "$S3_ENDPOINT" "$S3_ROOT_ACCESS_KEY_ID" "$S3_ROOT_SECRET_ACCESS_KEY"\n' +
      `        mc mb --ignore-existing edc/${bucket}\n` +
      '        mc admin user add edc "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"\n' +
      `        mc admin policy create edc edc-app /path/to/policy.json   # s3:* on ${bucket} and ${bucket}/*\n` +
      '        mc admin policy attach edc edc-app --user "$S3_ACCESS_KEY_ID"\n' +
      '\n' +
      '     Every one of those is safe to re-run. That is the whole point: provisioning\n' +
      '     has to be repeatable, because a volume wipe undoes it.\n',
  )
}

/**
 * 🔴 TOP-LEVEL AWAIT, AND IT IS LOAD-BEARING. `payload run` calls
 * `process.exit(0)` the moment the dynamic `import()` of this file RESOLVES. A
 * `main().catch(...)` at module scope is not awaited, so the process would be
 * killed at `main()`'s FIRST await — measured here: the script printed its
 * header, reached the bucket step, and exited **0** having done nothing and
 * checked nothing. A provisioning script that reports success from a run that
 * never happened is worse than no script. Same defect, same fix, as
 * `src/seed/demo.cli.ts` — read the block at the top of that file.
 *
 * This file is a DEDICATED entry point that nothing imports, so a side effect at
 * module scope is safe.
 */
await main().catch((err) => {
  console.error('\n🔴 provisioning failed unexpectedly:', describe(err), '\n')
  process.exit(1)
})
