/**
 * STORAGE READINESS.
 *
 * 🔴 THE FACT THIS EXISTS TO ENCODE: RustFS's own `/health` and `/health/ready`
 * are LIVENESS ONLY. Measured against `rustfs/rustfs:1.0.0-rc.1` — both answer
 * 200, `/health/ready` reporting `"storage":{"ready":true}`, while every S3 call
 * against the same process returns 503. A reassuring name on an endpoint that
 * lies is worse than no endpoint. So readiness here does a REAL S3 CALL and
 * nothing else.
 *
 * The four properties:
 *   1. Storage is only DECLARED when it is configured. Local disk is a supported
 *      mode, not a fault, and emitting `storage: ok` for a store that does not
 *      exist is the fabricated green this contract exists to stop.
 *   2. An unreachable store takes the service `down` ⇒ 503. No third state.
 *   3. 🔴 The 403 ambiguity resolves to DOWN, and reports `http_403` so an
 *      operator can tell "credential or policy" from `http_404` (bucket gone)
 *      and `http_503` (storage layer down under a healthy control plane).
 *   4. The AWS SDK's error message never reaches the unauthenticated body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DOWN_AFTER_CONSECUTIVE_FAILURES,
  __resetReadinessStateForTests,
  classifyError,
  declaredDependencies,
  httpStatusFor,
  probeAll,
  type Dependency,
} from './readiness'

/** An AWS SDK error: the status lives on `$metadata`, never on `httpStatus`. */
const awsError = (name: string, httpStatusCode: number, message: string) =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode } })

const S3_KEYS = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const
let saved: Record<string, string | undefined>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  __resetReadinessStateForTests()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  saved = {}
  for (const key of S3_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  errorSpy.mockRestore()
  for (const key of S3_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  __resetReadinessStateForTests()
})

const configureS3 = () => {
  process.env.S3_ENDPOINT = 'http://rustfs:9000'
  process.env.S3_ACCESS_KEY_ID = 'app-key'
  process.env.S3_SECRET_ACCESS_KEY = 'app-secret'
}

const failing = (err: unknown): Dependency => ({
  name: 'storage',
  probe: async () => {
    throw err
  },
})

describe('declaration', () => {
  it('omits the storage check entirely on a local-disk boot', () => {
    // Not `ok` — OMITTED. There is no object storage in this mode that could be
    // down, and a monitor must not be able to assert on one.
    expect(declaredDependencies().map((d) => d.name)).toEqual(['database', 'ai-service'])
  })

  it('declares storage as soon as it is configured', () => {
    configureS3()

    expect(declaredDependencies().map((d) => d.name)).toEqual([
      'database',
      'ai-service',
      'storage',
    ])
  })
})

describe('an unreachable store takes the service down', () => {
  it('reports down and 503 once storage has failed twice in a row', async () => {
    const dep = failing(awsError('Unknown', 503, 'Service Unavailable'))

    // Rule 4c: one dropped packet is not an outage.
    const first = await probeAll([dep])
    expect(first.status).toBe('ok')
    expect(first.checks.storage.error).toBe('http_503')

    const second = await probeAll([dep])
    expect(second.status).toBe('down')
    expect(second.checks.storage.status).toBe('down')
    expect(httpStatusFor(second)).toBe(503)
    expect(DOWN_AFTER_CONSECUTIVE_FAILURES).toBe(2)
  })

  it('reports down when the store refuses the connection outright', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const dep = failing(refused)

    await probeAll([dep])
    const report = await probeAll([dep])

    expect(report.status).toBe('down')
    expect(report.checks.storage.error).toBe('ECONNREFUSED')
  })
})

describe('the HeadBucket 403 ambiguity', () => {
  it('🔴 treats a 403 as DOWN, never as healthy', async () => {
    // A 403 means "not yours" OR "does not exist" — the store will not say
    // which. Both mean this app cannot serve or store files, which is the only
    // question readiness asks.
    const dep = failing(awsError('Unknown', 403, 'Forbidden'))

    await probeAll([dep])
    const report = await probeAll([dep])

    expect(report.status).toBe('down')
  })

  it('reports the status code, so the two readings stay distinguishable to a human', async () => {
    // A HEAD has no body, so the SDK reports the useless name `Unknown`. Only
    // `$metadata.httpStatusCode` carries anything.
    expect(classifyError(awsError('Unknown', 403, 'Forbidden'))).toBe('http_403')
    expect(classifyError(awsError('NotFound', 404, 'Not Found'))).toBe('http_404')
    expect(classifyError(awsError('Unknown', 503, 'Service Unavailable'))).toBe('http_503')
  })
})

describe('redaction on an unauthenticated route', () => {
  it('never leaks the SDK error message or the credential into the body', async () => {
    const leaky = awsError(
      'InvalidAccessKeyId',
      403,
      'The Access Key Id AKIAEXAMPLE you provided does not exist in our records',
    )
    const dep = failing(leaky)

    await probeAll([dep])
    const report = await probeAll([dep])

    const body = JSON.stringify(report)
    expect(body).not.toContain('AKIAEXAMPLE')
    expect(body).not.toContain('does not exist in our records')
    expect(report.checks.storage.error).toBe('http_403')
    // The real error exists in exactly one place.
    expect(errorSpy).toHaveBeenCalled()
  })
})
