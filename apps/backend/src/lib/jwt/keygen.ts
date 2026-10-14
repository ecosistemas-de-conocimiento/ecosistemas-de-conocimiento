/**
 * `npm run keygen` — generate the IdP's Ed25519 signing keypair.
 *
 * Prints two paste-ready env lines to STDOUT and writes NO files. The private
 * key exists only in this process's stdout; nothing is persisted here on purpose
 * (the private key lives in env/secrets, never on disk in the repo).
 *
 * Usage:
 *   npm run keygen                      # print
 *   npm run keygen >> .env              # append (review before committing!)
 *
 * Never commit AUTH_PRIVATE_KEY. In deployed envs it belongs in the platform's
 * secret store, alongside a bumped AUTH_KEY_ID on rotation.
 */

import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose'

const ALG = 'EdDSA'
const CRV = 'Ed25519'

/** PEM -> single-line env value, newlines escaped as literal `\n`. */
function escapePem(pem: string): string {
  return pem.trim().replace(/\r\n/g, '\n').replace(/\n/g, '\\n')
}

async function main(): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, {
    crv: CRV,
    extractable: true,
  })

  const privatePem = await exportPKCS8(privateKey)
  const publicPem = await exportSPKI(publicKey)

  const lines = [
    `# Ed25519 (EdDSA) signing keypair for the identity provider.`,
    `# Generated ${new Date().toISOString()}. Paste into .env or your secret store.`,
    `# Bump AUTH_KEY_ID whenever you replace these; consumers key off it via JWKS.`,
    `AUTH_PRIVATE_KEY=${escapePem(privatePem)}`,
    `AUTH_PUBLIC_KEY=${escapePem(publicPem)}`,
  ]

  process.stdout.write(`${lines.join('\n')}\n`)
}

// 🔴 Top-level `await`, not a bare `main().catch(...)`: `payload run` calls
// `process.exit(0)` as soon as this module's import resolves, which killed the
// un-awaited `main()` before it printed anything. See `keygen.test.ts`.
await main().catch((err: unknown) => {
  console.error('[keygen] failed to generate an Ed25519 keypair:', err)
  process.exit(1)
})
