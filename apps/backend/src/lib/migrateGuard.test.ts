import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `scripts/migrate.sh` is the container's migrate step. It exists because
 * `payload migrate` can exit 0 having printed nothing and run nothing (dev,
 * 2026-10-26: 2 of 12 cold runs under CPU contention). The exit code alone is
 * not proof, so the script requires Payload's closing `Done.` line.
 */
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/migrate.sh')

/** A fake `payload` binary: `body` is the shell it runs. Counts its calls. */
function fakePayload(body: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-guard-'))
  const bin = path.join(dir, 'payload')
  const calls = path.join(dir, 'calls')
  writeFileSync(bin, `#!/bin/sh\necho x >> "${calls}"\n${body}\n`)
  chmodSync(bin, 0o755)
  const run = () =>
    spawnSync('sh', [script], {
      env: { ...process.env, PAYLOAD_BIN: bin, MIGRATE_RETRY_DELAY_S: '0' },
      encoding: 'utf8',
    })
  const callCount = () => {
    try {
      return execFileSync('wc', ['-l', calls], { encoding: 'utf8' }).trim().split(' ')[0]
    } catch {
      return '0'
    }
  }
  return { run, callCount }
}

describe('scripts/migrate.sh', () => {
  it('passes when payload migrate prints Done.', () => {
    const fake = fakePayload(`echo 'INFO: Migrated: x'; echo 'INFO: \x1b[36mDone.\x1b[39m'; exit 0`)
    const res = fake.run()
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Migrated: x')
    expect(fake.callCount()).toBe('1')
  })

  it('fails after retries when payload exits 0 silently', () => {
    const fake = fakePayload('exit 0')
    const res = fake.run()
    expect(res.status).not.toBe(0)
    expect(res.stderr).toMatch(/silent|Done\./)
    expect(fake.callCount()).toBe('3')
  })

  it('retries a silent exit and passes once Done. appears', () => {
    const fake = fakePayload(
      `[ "$(wc -l < "$(dirname "$0")/calls")" -ge 2 ] && { echo 'INFO: Done.'; exit 0; }; exit 0`,
    )
    const res = fake.run()
    expect(res.status).toBe(0)
    expect(fake.callCount()).toBe('2')
  })

  it('fails at once, without retrying, when payload migrate exits non-zero', () => {
    const fake = fakePayload(`echo 'ERROR: Error running migration y'; exit 1`)
    const res = fake.run()
    expect(res.status).not.toBe(0)
    expect(fake.callCount()).toBe('1')
  })
})
