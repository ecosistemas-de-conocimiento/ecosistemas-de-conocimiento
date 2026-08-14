/**
 * IDEMPOTENT BUCKET PROVISIONING.
 *
 * 🔴 THIS IS AN OPERATION THAT RE-RUNS, NOT AN INIT STEP THAT EXITS. RustFS
 * keeps its IAM database on the data VOLUME and no environment variable seeds
 * it, so "provisioned" is not a state the stack reaches once — a volume wipe
 * un-provisions it, and a one-shot init container that already exited will
 * never notice. Everything here is therefore safe to run again, on every boot
 * and from the CLI, as many times as anybody likes:
 *
 *   · `ensureStorageBucketAtBoot()` runs from `payload.config.ts#onInit`, which
 *     fires on every start and every `next dev` hot reload.
 *   · `pnpm --filter @edc/backend provision:storage` runs the same primitive
 *     plus a full S3-surface conformance check.
 *
 * ⚠ WHAT IT DOES NOT DO: create the scoped credential. See
 *   `scripts/provision-storage.ts` for why that one step cannot live here.
 *
 * 🔴 It is NOT disaster recovery. If the volume is wiped, the app credential
 * stops authenticating at all (`InvalidAccessKeyId`) and never reaches this
 * code. All this buys is that a NEW environment comes up without a manual
 * `mc mb`.
 */

import { getBucketOps, getStorageBucket, httpStatusOf, isStorageConfigured } from './client'
import type { BucketOps } from './client'

/**
 * `CreateBucket` conflict codes.
 *
 * ⚠ `BucketAlreadyOwnedByYou` was NEVER observed from RustFS rc.1 (measured by
 * the user, 2026-08). It is accepted anyway because AWS and MinIO both send it,
 * and a list that only matches the store we happen to run today is a trap for
 * whoever swaps the store.
 */
const ALREADY_EXISTS = new Set(['BucketAlreadyExists', 'BucketAlreadyOwnedByYou'])

const nameOf = (err: unknown): string => (err as { name?: string } | null)?.name ?? ''

export type EnsureOutcome = 'exists' | 'created'

/**
 * Ensure `bucket` exists. Returns how it got there; throws if it could not.
 *
 * Two error shapes carry the entire design, and both are asymmetries that only
 * show up against a real store:
 *
 * 1. 🔴 **`HeadBucket` is branched on 404 AND NOTHING ELSE.** A 403 there is
 *    ambiguous by construction: S3 and its clones answer 403 both for "this
 *    bucket exists but is not yours" and for "it does not exist and you may not
 *    find out". Creating a bucket is the wrong answer to both, so a 403
 *    PROPAGATES as a failure rather than being swallowed or acted on. The 403
 *    also arrives with no body (HEAD), so `err.name` is the useless `'Unknown'`
 *    and only `$metadata.httpStatusCode` is real.
 *
 * 2. 🔴 **A `CreateBucket` 409 is SUCCESS, not failure.** `CreateBucket` is
 *    idempotent for the ROOT credential only. A scoped IAM credential gets a
 *    409 instead, and this app is deliberately not root, so treating the 409 as
 *    an error would fail every boot after the first.
 *
 *    ✅ MEASURED on `rustfs/rustfs:1.0.0-rc.1`: `CreateBucket` on an EXISTING
 *    bucket as ROOT returns a silent **200**, and `HeadBucket` on a MISSING
 *    bucket returns **404** — so on this build the happy path never reaches the
 *    409 branch at all.
 *
 *    ⚠ THE BRANCH STAYS ANYWAY, and is not "elaborate machinery": it is one
 *    `if`. The scoped-credential 409 was measured on a different credential
 *    shape than the one available to test here, the app is meant to run
 *    non-root, and this is also the concurrent-replica path — two replicas
 *    racing means one creates and the other gets a conflict. Removing it buys
 *    nothing and costs a crash-loop the day the credential is scoped properly.
 *
 *    The status is checked as well as the name because the name is
 *    store-specific.
 */
export async function ensureBucket(ops: BucketOps, bucket: string): Promise<EnsureOutcome> {
  try {
    await ops.headBucket(bucket)
    return 'exists'
  } catch (err) {
    // 404 is the ONLY status that means "missing — go and make it".
    if (httpStatusOf(err) !== 404) throw err
  }

  try {
    await ops.createBucket(bucket)
    return 'created'
  } catch (err) {
    if (ALREADY_EXISTS.has(nameOf(err)) || httpStatusOf(err) === 409) return 'exists'
    throw err
  }
}

// ---------------------------------------------------------------------------
// Boot wiring
// ---------------------------------------------------------------------------

export interface BootRetryPolicy {
  attempts: number
  /** Delay before attempt N (1-indexed after the first). */
  delayMs: (attempt: number) => number
  sleep: (ms: number) => Promise<void>
}

/**
 * ⚠ RETRY IS NOT POLITENESS. RustFS answers 200 on its control plane while its
 * storage layer still returns 503, so a backend that boots faster than the store
 * would fail a perfectly healthy cold start. Six attempts over ~30s.
 */
export const DEFAULT_BOOT_RETRY: BootRetryPolicy = {
  attempts: 6,
  delayMs: (attempt) => Math.min(1_000 * 2 ** (attempt - 1), 10_000),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

// `onInit` re-runs on every `next dev` hot reload. One bootstrap per process is
// the point; repeating it per reload is noise and traffic.
let alreadyEnsured = false

interface Logger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

/**
 * Run the bootstrap. Called from `onInit`.
 *
 * 🔴 IT NEVER THROWS, and that is deliberate. Throwing gates the whole product
 * on storage and crash-loops every replica — a slow-but-healthy store would
 * restart the container into the same race forever, and the admin panel you
 * would use to fix it goes down with it. `/api/health/ready` carries the signal
 * instead, because readiness restarts nothing.
 */
export async function ensureStorageBucketAtBoot(
  logger: Logger,
  policy: BootRetryPolicy = DEFAULT_BOOT_RETRY,
): Promise<void> {
  if (alreadyEnsured) return
  alreadyEnsured = true

  if (!isStorageConfigured()) return // `describeStorageMode` already said so.

  const bucket = getStorageBucket()
  let lastError = 'unknown'

  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      const outcome = await ensureBucket(await getBucketOps(), bucket)
      logger.info(
        outcome === 'created'
          ? `[storage] created bucket "${bucket}".`
          : `[storage] bucket "${bucket}" present.`,
      )
      return
    } catch (err) {
      lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      if (attempt === policy.attempts) break
      const delay = policy.delayMs(attempt)
      logger.warn(
        `[storage] bucket "${bucket}" not ready (attempt ${attempt}/${policy.attempts}): ${lastError} — retrying in ${delay}ms.`,
      )
      await policy.sleep(delay)
    }
  }

  logger.error(
    `[storage] OBJECT STORAGE NOT READY: could not ensure bucket "${bucket}" after ` +
      `${policy.attempts} attempts (${lastError}). Boot CONTINUES — /api/health/ready ` +
      'reports down/503 until this clears, and uploads fail meanwhile. Check S3_ENDPOINT, ' +
      `the app credential, and that its policy grants s3:* on arn:aws:s3:::${bucket} AND ` +
      `arn:aws:s3:::${bucket}/*. An InvalidAccessKeyId here means the store lost its IAM ` +
      'volume and needs `pnpm provision:storage` (and the credential re-created), not a restart.',
  )
}

/** Test seam — lets a test run the bootstrap more than once per process. */
export const __resetEnsureBucketForTests = (): void => {
  alreadyEnsured = false
}
