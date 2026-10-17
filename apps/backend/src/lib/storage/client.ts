/**
 * OBJECT STORAGE — the one place that knows how to talk to the store.
 *
 * Shared by everything that touches S3 outside of uploads themselves:
 *   · `plugin.ts`          — builds the `s3Storage(...)` config for Payload.
 *   · `ensureBucket.ts`    — the idempotent bucket bootstrap.
 *   · `probe.ts`           — the readiness probe (`lib/readiness.ts` declares it).
 *   · `scripts/provision-storage.ts` — the re-runnable provisioning CLI.
 *
 * ⚠ `s3ClientConfig()` IS THE SINGLE SOURCE OF TRUTH and it is handed to the
 * Payload plugin verbatim. A probe that authenticates differently from the
 * uploads is not evidence about the uploads, so there is deliberately no second
 * place where an endpoint or a credential is assembled.
 *
 * The store is RustFS (`rustfs/rustfs:1.0.0-rc.1`), LOCAL AND DEV ONLY. It
 * speaks the S3 API; every constant below is about surviving the ways in which
 * an S3-compatible store is not S3.
 */

/** Every variable this module reads. Named to match the sibling app it came from, deliberately. */
export const S3_ENV_VARS = [
  'S3_ENDPOINT',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const

/** Bucket default. Overridable, but every environment is expected to set it. */
export const DEFAULT_BUCKET = 'edc'
/**
 * Region default. RustFS ignores it; the AWS SDK refuses to build a client
 * without one, and SigV4 signs over it, so it must simply be consistent.
 */
export const DEFAULT_REGION = 'us-east-1'

type Env = Record<string, string | undefined>

/**
 * Which backend files are stored in, and why.
 *
 * Three outcomes, and the middle one is the reason this is a function rather
 * than a boolean:
 *
 *   · `s3`    — all three required vars present.
 *   · `local` with `missing: []` — none of them set. The intended bare
 *     `pnpm dev` path: files land under `./media/` per Payload's `staticDir`.
 *   · 🔴 `local` with `missing: [...]` — SOME of them set. This is a
 *     misconfiguration, not a choice, and it is the failure mode that actually
 *     bites: somebody sets `S3_ENDPOINT` in a deployed environment, forgets the
 *     secret, and every upload silently lands on a container filesystem that
 *     the next redeploy throws away. Boot logs this at ERROR — see
 *     `describeStorageMode`.
 */
export interface StorageMode {
  kind: 's3' | 'local'
  /** Required vars that are absent. Non-empty ⇒ PARTIAL configuration. */
  missing: string[]
  bucket: string
  region: string
  endpoint?: string
}

export function resolveStorageMode(env: Env = process.env): StorageMode {
  /**
   * ⚠ ABSENT AND EMPTY-STRING BOTH COUNT AS "NOT SET", and that is a contract
   * with the compose file, not an accident of `!`.
   *
   * The five variables reach a container through `env_file:` rather than an
   * `environment:` block precisely because compose CANNOT EXPRESS ABSENT:
   * `${S3_ENDPOINT:-}` sets an empty string, and the fallback would then hinge
   * on how this line reads. Keying on truthiness makes both spellings mean the
   * same thing, so a commented-out env_file and an empty variable behave
   * identically instead of differing in a way nobody would think to test.
   */
  const missing = S3_ENV_VARS.filter((name) => !env[name])
  const bucket = env.S3_BUCKET || DEFAULT_BUCKET
  const region = env.S3_REGION || DEFAULT_REGION

  if (missing.length === 0) {
    return { kind: 's3', missing: [], bucket, region, endpoint: env.S3_ENDPOINT }
  }
  // Partial config keeps `missing` populated so the caller can shout about it.
  // A clean fallback reports `missing: []` even though nothing is set.
  return {
    kind: 'local',
    missing: missing.length === S3_ENV_VARS.length ? [] : [...missing],
    bucket,
    region,
    endpoint: env.S3_ENDPOINT,
  }
}

/** Is object storage wired up in this environment at all? */
export const isStorageConfigured = (env: Env = process.env): boolean =>
  resolveStorageMode(env).kind === 's3'

export const getStorageBucket = (env: Env = process.env): string =>
  env.S3_BUCKET || DEFAULT_BUCKET

/**
 * 🔴 A ONE-LINE BOOT MESSAGE THAT SAYS WHICH MODE IS ACTIVE.
 *
 * Non-negotiable: "did this process put my file on disk or in the bucket" must
 * be answerable from the boot log alone, without reading env or code. The
 * severity is part of the answer — `error` for a partial config, `info`
 * otherwise.
 */
export function describeStorageMode(mode: StorageMode): {
  level: 'info' | 'error'
  message: string
} {
  if (mode.kind === 's3') {
    return {
      level: 'info',
      message: `[storage] OBJECT STORAGE — bucket "${mode.bucket}" at ${mode.endpoint} (region ${mode.region}, path-style). Files are served THROUGH this app; no presigned URLs.`,
    }
  }
  if (mode.missing.length > 0) {
    return {
      level: 'error',
      message: `[storage] MISCONFIGURED — object storage is PARTIALLY configured (missing: ${mode.missing.join(', ')}), so this process FELL BACK TO LOCAL DISK (./media). Uploads will not survive a redeploy. Set every one of ${S3_ENV_VARS.join(', ')}, or none of them.`,
    }
  }
  return {
    level: 'info',
    message: `[storage] LOCAL DISK (./media) — no ${S3_ENV_VARS.join('/')} set. Fine for a bare \`pnpm dev\`; NOT durable anywhere else.`,
  }
}

/**
 * The S3 client configuration, shared by the Payload plugin and every direct
 * call this app makes.
 *
 * Throws when storage is not configured — callers must check `isStorageConfigured`
 * first. Returning a half-built config would push the failure to the first
 * upload instead of to boot.
 */
export function s3ClientConfig(env: Env = process.env) {
  const mode = resolveStorageMode(env)
  if (mode.kind !== 's3') {
    throw new Error(
      `object storage is not configured — set ${S3_ENV_VARS.join(', ')} (missing: ${
        mode.missing.length > 0 ? mode.missing.join(', ') : S3_ENV_VARS.join(', ')
      })`,
    )
  }
  return {
    endpoint: env.S3_ENDPOINT as string,
    region: mode.region,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID as string,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
    },
    /**
     * 🔴 REQUIRED. RustFS — like the MinIO it replaces — has no virtual-hosted
     * bucket subdomains. Without this the SDK sends `edc.rustfs:9000` and every
     * call fails DNS resolution, not authorization, so the error is misleading.
     */
    forcePathStyle: true,
    /**
     * 🔧 Two inert lines against newer AWS SDK behaviour, kept regardless of
     * which store is behind the endpoint.
     *
     * Since ~v3.729 the SDK computes a CRC32 checksum on EVERY request and
     * demands one back on every response. Real S3 is fine with it; several
     * S3-compatible stores reject the extra `x-amz-checksum-*` /
     * `x-amz-trailer` headers outright, and the resulting error names the
     * checksum, not the store. `WHEN_REQUIRED` restores the pre-3.729
     * behaviour: checksums only where the API mandates them.
     */
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    responseChecksumValidation: 'WHEN_REQUIRED' as const,
  }
}

/**
 * The bucket-level calls this app makes outside of uploads, as a narrow port.
 *
 * Injecting these keeps the decision logic in `ensureBucket.ts` and `probe.ts`
 * testable without an S3 server: what is under test there is entirely "which
 * error shape means what", never the wire protocol.
 */
export interface BucketOps {
  headBucket: (bucket: string) => Promise<void>
  createBucket: (bucket: string) => Promise<void>
}

/**
 * Read one object's bytes out of the bucket.
 *
 * 🔴 THIS EXISTS BECAUSE THE SERVER SOMETIMES NEEDS THE BYTES ITSELF, not just
 * to serve them. Text extraction (pdf/docx) and audio transcription both have
 * to hand the actual content to something else — `unpdf`, `mammoth`, or a
 * multipart POST to audio-service. Before object storage those read straight off
 * `./media/<filename>`; once uploads moved to S3 that path no longer exists and
 * BOTH pipelines broke with `ENOENT` / "Unable to open file as blob".
 *
 * ⚠ This buffers the whole object in memory, which the disk path deliberately
 * did not (`fs.openAsBlob` is file-backed and streams lazily). That is a real
 * regression in peak memory and it is bounded only by the upload size cap. It
 * is accepted here because the alternative — plumbing a stream all the way into
 * undici's FormData — is a bigger change than the bug warrants, and because
 * every consumer below needs a contiguous buffer anyway. If uploads ever get
 * large enough for this to hurt, stream to a temp file and hand back a
 * file-backed Blob rather than growing the heap.
 */
export async function getObjectBytes(
  key: string,
  bucket: string = getStorageBucket(),
): Promise<{ bytes: Buffer; contentType: string | null }> {
  const mod = await import('@aws-sdk/client-s3')
  const client = new mod.S3Client(s3ClientConfig())
  const res = await client.send(new mod.GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!res.Body) throw new Error(`object ${bucket}/${key} returned no body`)
  const bytes = Buffer.from(await res.Body.transformToByteArray())
  return { bytes, contentType: res.ContentType ?? null }
}

let cachedOps: BucketOps | null = null

/**
 * Build (once per process) the real S3-backed `BucketOps`.
 *
 * The SDK is imported lazily so that a local-disk boot never loads it, and so
 * that the test suite can exercise every caller without resolving it.
 */
export async function getBucketOps(): Promise<BucketOps> {
  if (cachedOps) return cachedOps

  const mod = await import('@aws-sdk/client-s3')
  const client = new mod.S3Client({
    ...s3ClientConfig(),
    /**
     * ⚠ The client carries its OWN deadline. Readiness bounds each probe at 3s
     * (`PROBE_TIMEOUT_MS`) with a race, but a losing race leaves the socket open;
     * an S3 call that can hang forever leaks one per probe interval.
     *
     * `maxAttempts: 1` because retrying is the caller's job — the SDK's
     * 3-attempt default would silently triple every deadline.
     *
     * Timeouts are plain options rather than a constructed `NodeHttpHandler`:
     * `@smithy/node-http-handler` is a transitive dependency, not a declared
     * one, and importing it directly breaks under pnpm's strict layout.
     */
    maxAttempts: 1,
    requestHandler: { requestTimeout: 3_000, connectionTimeout: 2_000 },
  })

  cachedOps = {
    headBucket: async (Bucket) => {
      await client.send(new mod.HeadBucketCommand({ Bucket }))
    },
    createBucket: async (Bucket) => {
      await client.send(new mod.CreateBucketCommand({ Bucket }))
    },
  }
  return cachedOps
}

/**
 * 🔴 Read the HTTP status off an AWS SDK error — the ONLY safe way to classify
 * a bucket-level failure.
 *
 * A `HeadBucket` is a HEAD: there is no response body, so the SDK has nothing to
 * parse an error code out of and reports the useless `err.name === 'Unknown'`.
 * Every branch that decides anything must key off `$metadata.httpStatusCode`.
 */
export const httpStatusOf = (err: unknown): number | undefined =>
  (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode

/** Test seam — lets a test rebuild the client with different env. */
export const __resetBucketOpsForTests = (): void => {
  cachedOps = null
}
