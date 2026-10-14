/**
 * `pnpm --filter @edc/backend keygen` must actually print a keypair.
 *
 * 🔴 `payload run` calls `process.exit(0)` the moment the dynamic `import()` of
 * the script RESOLVES. A `main().catch(...)` at module scope is not awaited, so
 * the process died at `generateKeyPair`'s first await and exited 0 having
 * printed NOTHING — measured 2026-10-14 while building a fresh Coolify-style
 * `.env`. Same defect as `src/seed/demo.cli.ts` and
 * `scripts/provision-storage.ts`. This runs the real command, so it fails if
 * the top-level `await` is ever dropped again.
 */

import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { beforeAll, describe, expect, it } from 'vitest'

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

let stdout = ''

beforeAll(async () => {
  const payloadBin = path.join(backendDir, 'node_modules/.bin/payload')
  const result = await promisify(execFile)(payloadBin, ['run', 'src/lib/jwt/keygen.ts'], {
    cwd: backendDir,
  })
  stdout = result.stdout
})

describe('keygen CLI', () => {
  it('prints a PKCS#8 private key and an SPKI public key, one line each', () => {
    expect(stdout).toMatch(/^AUTH_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\\n.+$/m)
    expect(stdout).toMatch(/^AUTH_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\\n.+$/m)
  })
})
