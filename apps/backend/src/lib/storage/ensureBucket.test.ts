/**
 * BUCKET PROVISIONING — the two store asymmetries, and the fact that it repeats.
 *
 * Everything here is about error SHAPES, so no S3 server is involved: what is
 * under test is which status means "go and create it", which means "you are
 * already done", and which means "stop".
 *
 * The three properties:
 *   1. 🔴 A `CreateBucket` 409 is SUCCESS. CreateBucket is idempotent for a ROOT
 *      credential (silent 200) and NOT for a scoped one. This app is
 *      deliberately not root, so the 409 is the ORDINARY path — every boot after
 *      the first. `BucketAlreadyOwnedByYou` was never observed from RustFS rc.1;
 *      it always sent something else, so the status is checked as well as the name.
 *   2. 🔴 A `HeadBucket` 403 does NOT create a bucket and does NOT pass. It means
 *      either "not yours" or "does not exist" and creating one is the wrong
 *      answer to both, so it propagates.
 *   3. It is safe to run again, always. That is the whole design: the store's
 *      IAM database is volume-resident, so provisioning is an operation that
 *      repeats rather than an init container that exits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetEnsureBucketForTests,
  ensureBucket,
  ensureStorageBucketAtBoot,
} from './ensureBucket'
import type { BucketOps } from './client'

/** An AWS SDK error: the status lives on `$metadata`, never on `httpStatus`. */
const awsError = (name: string, httpStatusCode?: number) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode } })

const opsWith = (
  head: () => Promise<void>,
  create: () => Promise<void> = async () => {},
): BucketOps & { headCalls: number; createCalls: number } => {
  const ops = {
    headCalls: 0,
    createCalls: 0,
    headBucket: async () => {
      ops.headCalls++
      return head()
    },
    createBucket: async () => {
      ops.createCalls++
      return create()
    },
  }
  return ops
}

const S3_KEYS = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  __resetEnsureBucketForTests()
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
  __resetEnsureBucketForTests()
})

describe('ensureBucket', () => {
  it('does nothing when the bucket already answers HeadBucket', async () => {
    const ops = opsWith(async () => {})

    await expect(ensureBucket(ops, 'edc')).resolves.toBe('exists')
    expect(ops.createCalls).toBe(0)
  })

  it('creates the bucket on a HeadBucket 404, and only on a 404', async () => {
    const ops = opsWith(async () => {
      throw awsError('NotFound', 404)
    })

    await expect(ensureBucket(ops, 'edc')).resolves.toBe('created')
    expect(ops.createCalls).toBe(1)
  })

  it('🔴 treats a CreateBucket 409 as SUCCESS — the normal path for a scoped key', async () => {
    // RustFS rc.1 sends `BucketAlreadyExists`, not `BucketAlreadyOwnedByYou`.
    const ops = opsWith(
      async () => {
        throw awsError('NotFound', 404)
      },
      async () => {
        throw awsError('BucketAlreadyExists', 409)
      },
    )

    await expect(ensureBucket(ops, 'edc')).resolves.toBe('exists')
  })

  it('accepts BucketAlreadyOwnedByYou too, for stores that do send it', async () => {
    const ops = opsWith(
      async () => {
        throw awsError('NotFound', 404)
      },
      async () => {
        throw awsError('BucketAlreadyOwnedByYou', 409)
      },
    )

    await expect(ensureBucket(ops, 'edc')).resolves.toBe('exists')
  })

  it('accepts a bare 409 even when the error name is useless', async () => {
    // A HEAD/409 with no body leaves the SDK reporting `Unknown`; only the
    // status is real.
    const ops = opsWith(
      async () => {
        throw awsError('NotFound', 404)
      },
      async () => {
        throw awsError('Unknown', 409)
      },
    )

    await expect(ensureBucket(ops, 'edc')).resolves.toBe('exists')
  })

  it('🔴 does NOT create a bucket on a HeadBucket 403 — it propagates instead', async () => {
    const ops = opsWith(async () => {
      throw awsError('Unknown', 403)
    })

    await expect(ensureBucket(ops, 'edc')).rejects.toThrow()
    // The ambiguity is the reason: 403 means "not yours" OR "does not exist",
    // and creating one is the wrong answer to both.
    expect(ops.createCalls).toBe(0)
  })

  it('propagates a HeadBucket 503 — the storage layer being down is not "missing"', async () => {
    const ops = opsWith(async () => {
      throw awsError('Unknown', 503)
    })

    await expect(ensureBucket(ops, 'edc')).rejects.toThrow()
    expect(ops.createCalls).toBe(0)
  })

  it('surfaces a CreateBucket failure that is not a conflict', async () => {
    const ops = opsWith(
      async () => {
        throw awsError('NotFound', 404)
      },
      async () => {
        throw awsError('AccessDenied', 403)
      },
    )

    await expect(ensureBucket(ops, 'edc')).rejects.toThrow()
  })

  it('is safe to run repeatedly — the second run is a no-op, not an error', async () => {
    let created = false
    const ops = opsWith(
      async () => {
        if (!created) throw awsError('NotFound', 404)
      },
      async () => {
        created = true
      },
    )

    await expect(ensureBucket(ops, 'edc')).resolves.toBe('created')
    await expect(ensureBucket(ops, 'edc')).resolves.toBe('exists')
    await expect(ensureBucket(ops, 'edc')).resolves.toBe('exists')
  })
})

describe('ensureStorageBucketAtBoot', () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

  it('does nothing at all when storage is not configured — a local boot must not touch S3', async () => {
    const log = logger()

    await ensureStorageBucketAtBoot(log)

    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('🔴 never throws when the store is unreachable — it logs at ERROR and lets boot continue', async () => {
    // Throwing here would gate the whole product on storage and crash-loop every
    // replica, taking down the admin panel you would use to fix it.
    process.env.S3_ENDPOINT = 'http://127.0.0.1:1'
    process.env.S3_ACCESS_KEY_ID = 'k'
    process.env.S3_SECRET_ACCESS_KEY = 's'
    const log = logger()

    await expect(
      ensureStorageBucketAtBoot(log, {
        attempts: 2,
        delayMs: () => 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()

    expect(log.error).toHaveBeenCalledTimes(1)
    const message = log.error.mock.calls[0][0] as string
    expect(message).toContain('OBJECT STORAGE NOT READY')
    // The operator needs to know boot did not stop, and where the real signal is.
    expect(message).toContain('/api/health/ready')
  })
})
