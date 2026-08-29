import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Payload } from 'payload'
import { seedAdmin, DEFAULT_SEED_ADMIN_EMAIL } from './admin'
import { BOOT_SEED_ENVS, MANUAL_SEED_ENVS } from './env-gate'

/**
 * ⚠ The admin / service account is deliberately OUTSIDE the demo-seed gate, and
 * it has no default password.
 *
 * Two separations are being pinned here, and they pull in opposite directions:
 *
 *   · Narrowing the DEMO gate must never take the admin down with it. An
 *     environment with no way in is worse than one with no demo content.
 *   · No environment, however local it looks, may get a committed credential.
 *     This backend holds the token signing key.
 *
 * `src/seed/admin.ts` imports only a TYPE from payload, so it runs here against
 * a fake Payload with no database and no boot.
 */

interface FakePayload {
  payload: Payload
  created: Array<Record<string, unknown>>
  warnings: unknown[]
  errors: unknown[]
}

/** Minimal Payload stand-in: enough surface for seedAdmin, nothing more. */
function fakePayload(userCount = 0): FakePayload {
  const created: Array<Record<string, unknown>> = []
  const warnings: unknown[] = []
  const errors: unknown[] = []
  const payload = {
    count: vi.fn(async () => ({ totalDocs: userCount })),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      created.push(args.data)
      return { id: 1, ...args.data }
    }),
    logger: {
      info: vi.fn(),
      warn: vi.fn((...args: unknown[]) => {
        warnings.push(args)
      }),
      error: vi.fn((...args: unknown[]) => {
        errors.push(args)
      }),
    },
  } as unknown as Payload
  return { payload, created, warnings, errors }
}

const TOUCHED = ['EDC_ENV', 'NODE_ENV', 'SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD', 'SEED_DOMAIN']

/**
 * `process.env` is typed with read-only well-known keys (NODE_ENV) under Next's
 * ambient types. seedAdmin reads `process.env` directly, so a test must mutate
 * the real object — this alias is the write handle.
 */
const env = process.env as Record<string, string | undefined>

let saved: Record<string, string | undefined> = {}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete env[key]
  else env[key] = value
}

beforeEach(() => {
  saved = {}
  for (const key of TOUCHED) saved[key] = env[key]
})

afterEach(() => {
  for (const key of TOUCHED) setEnv(key, saved[key])
})

describe('seedAdmin is NOT gated by EDC_ENV', () => {
  // Every environment label, including the ones BOTH demo tiers deny.
  const everyEnv = [
    'local',
    'dev',
    'stage',
    'staging',
    'prod',
    'production',
    'demo',
    'demo-0',
    'demo-1',
    'test',
    'banana',
  ]

  it.each(everyEnv)('creates the admin when EDC_ENV=%s', async (envLabel) => {
    setEnv('EDC_ENV', envLabel)
    setEnv('NODE_ENV', undefined)
    setEnv('SEED_ADMIN_EMAIL', 'ops@example.org')
    setEnv('SEED_ADMIN_PASSWORD', 'a-real-secret')

    const { payload, created } = fakePayload(0)
    await seedAdmin(payload)

    expect(created).toHaveLength(1)
    expect(created[0].email).toBe('ops@example.org')
  })

  it('creates the admin with EDC_ENV entirely UNSET', async () => {
    setEnv('EDC_ENV', undefined)
    setEnv('NODE_ENV', undefined)
    setEnv('SEED_ADMIN_EMAIL', 'ops@example.org')
    setEnv('SEED_ADMIN_PASSWORD', 'a-real-secret')

    const { payload, created } = fakePayload(0)
    await seedAdmin(payload)

    expect(created).toHaveLength(1)
  })

  it('creates the admin on a hosted production build outside the demo allowlist', async () => {
    // The exact configuration the demo gate denies — admin must still land.
    setEnv('EDC_ENV', 'prod')
    setEnv('NODE_ENV', 'production')
    setEnv('SEED_ADMIN_EMAIL', 'ops@example.org')
    setEnv('SEED_ADMIN_PASSWORD', 'a-real-secret')
    expect(BOOT_SEED_ENVS as readonly string[]).not.toContain('prod')
    expect(MANUAL_SEED_ENVS as readonly string[]).not.toContain('prod')

    const { payload, created } = fakePayload(0)
    await seedAdmin(payload)

    expect(created).toHaveLength(1)
    expect(created[0].email).toBe('ops@example.org')
  })

  it('is not influenced by SEED_DOMAIN in either direction', async () => {
    setEnv('EDC_ENV', 'prod')
    setEnv('NODE_ENV', undefined)
    setEnv('SEED_DOMAIN', '0')
    setEnv('SEED_ADMIN_EMAIL', 'ops@example.org')
    setEnv('SEED_ADMIN_PASSWORD', 'a-real-secret')

    const { payload, created } = fakePayload(0)
    await seedAdmin(payload)

    expect(created).toHaveLength(1)
  })
})

describe('the credential rules', () => {
  it('is idempotent — no create when a user already exists', async () => {
    setEnv('EDC_ENV', 'local')
    setEnv('SEED_ADMIN_PASSWORD', 'a-real-secret')
    const { payload, created } = fakePayload(1)
    await seedAdmin(payload)
    expect(created).toHaveLength(0)
  })

  // 🔴 THE REGRESSION THIS FILE EXISTS FOR. The product backend this merged
  // from fell back to a committed password below production. It must not come
  // back — not for `local`, not for an unset NODE_ENV, not for anything.
  it.each(['local', 'dev', 'demo-0', undefined])(
    'REFUSES to invent a password when SEED_ADMIN_PASSWORD is unset (EDC_ENV=%s)',
    async (envLabel) => {
      setEnv('EDC_ENV', envLabel)
      setEnv('NODE_ENV', undefined)
      setEnv('SEED_ADMIN_EMAIL', undefined)
      setEnv('SEED_ADMIN_PASSWORD', undefined)

      const { payload, created, warnings } = fakePayload(0)
      await seedAdmin(payload)

      expect(created).toHaveLength(0)
      expect(warnings).toHaveLength(1)
    },
  )

  it('NEVER throws — a boot must not die on a seeding problem', async () => {
    setEnv('EDC_ENV', 'prod')
    setEnv('NODE_ENV', 'production')
    setEnv('SEED_ADMIN_EMAIL', 'ops@example.org')
    setEnv('SEED_ADMIN_PASSWORD', 'a-real-secret')

    const { payload, errors } = fakePayload(0)
    // Make the write blow up the way a database problem would.
    ;(payload.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connection refused'),
    )

    await expect(seedAdmin(payload)).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  it('defaults only the EMAIL, never the password', async () => {
    setEnv('EDC_ENV', 'local')
    setEnv('SEED_ADMIN_EMAIL', undefined)
    setEnv('SEED_ADMIN_PASSWORD', 'a-real-secret')

    const { payload, created } = fakePayload(0)
    await seedAdmin(payload)

    expect(created).toHaveLength(1)
    expect(created[0].email).toBe(DEFAULT_SEED_ADMIN_EMAIL)
    // 🔴 The default must be an address Payload's own `email` validation
    // ACCEPTS. It was `admin@localhost` once; Payload rejects a bare hostname,
    // so a fresh boot with only `SEED_ADMIN_PASSWORD` set created no admin —
    // and therefore no seeded documents, since every one needs an uploader.
    // The symptom was an empty demo, which points nowhere near this line.
    expect(DEFAULT_SEED_ADMIN_EMAIL).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i)
  })

  it('creates the bootstrap account as an ACTIVE platform admin', async () => {
    // Without both flags the first account cannot grant anyone else access,
    // which makes the whole bootstrap pointless.
    setEnv('EDC_ENV', 'local')
    setEnv('SEED_ADMIN_PASSWORD', 'a-real-secret')

    const { payload, created } = fakePayload(0)
    await seedAdmin(payload)

    expect(created[0].isPlatformAdmin).toBe(true)
    expect(created[0].isActive).toBe(true)
  })
})
