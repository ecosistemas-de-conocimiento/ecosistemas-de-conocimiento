/**
 * IS THE LIVE STACK THERE? Answered ONCE, before any test runs, with a short
 * timeout.
 *
 * ⚠ These tests exist to exercise the real thing. If the stack is down they
 * must SKIP LOUDLY — never hang on a socket that will not answer, and never
 * quietly pass because a `catch` swallowed the connection error. The banner
 * below is the whole point: it names the URL that did not answer and the command
 * that would fix it.
 */

import { AUDIO_SERVICE_URL, BACKEND_URL, envFilePath } from './env'

export interface StackProbe {
  up: boolean
  reason: string
}

async function ping(url: string, timeoutMs = 4000): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return `${url} answered ${res.status}`
    return null
  } catch (err) {
    return `${url} is unreachable (${err instanceof Error ? err.message : String(err)})`
  }
}

async function probe(): Promise<StackProbe> {
  if (!envFilePath()) {
    return {
      up: false,
      reason:
        'infra/.env was not found, so the suite has no credentials for the stack. ' +
        'Set EDC_E2E_ENV_FILE=/path/to/infra/.env.',
    }
  }
  const backend = await ping(`${BACKEND_URL}/api/health`)
  if (backend) return { up: false, reason: backend }
  return { up: true, reason: '' }
}

export const stack: StackProbe = await probe()

if (!stack.up) {
  console.error(
    [
      '',
      '='.repeat(78),
      '  BACKEND E2E SUITE SKIPPED — the live stack is not reachable.',
      '',
      `  ${stack.reason}`,
      '',
      '  These tests run against the RUNNING containers. Start them with:',
      '      cd infra && docker compose up -d --wait',
      `  Then re-run:  pnpm --filter @edc/backend test:e2e`,
      '',
      `  Backend expected at: ${BACKEND_URL}`,
      `  Audio expected at:   ${AUDIO_SERVICE_URL}`,
      '='.repeat(78),
      '',
    ].join('\n'),
  )
}

/** `describe.skipIf(stackDown)` — the guard every spec file opens with. */
export const stackDown = !stack.up

/**
 * IS AUDIO ON? Audio is OPT-IN: the core compose file forces the backend's
 * `AUDIO_SERVICE_URL` empty, and only `infra/docker-compose.audio.yml` starts
 * audio-service and points the backend at it. Without that file every audio
 * upload fails with "transcription is off", by design — so the audio suite
 * SKIPS, loudly, naming the file, instead of reporting nine failures.
 *
 * ⚠ Checked only when the backend is up; a down stack already has its banner.
 */
async function probeAudio(): Promise<StackProbe> {
  if (!stack.up) return { up: false, reason: stack.reason }
  const audio = await ping(`${AUDIO_SERVICE_URL}/health`)
  if (audio) return { up: false, reason: audio }
  return { up: true, reason: '' }
}

export const audioStack: StackProbe = await probeAudio()

if (stack.up && !audioStack.up) {
  console.error(
    [
      '',
      '='.repeat(78),
      '  AUDIO E2E SUITE SKIPPED — audio-service is not reachable.',
      '',
      `  ${audioStack.reason}`,
      '',
      '  Audio is opt-in. Add the audio compose file to the stack:',
      '      docker compose -f docker-compose.yml -f docker-compose.override.yml \\',
      '                     -f docker-compose.audio.yml up -d --wait',
      '  and point E2E_AUDIO_SERVICE_URL at its host port if it is not 45403.',
      '='.repeat(78),
      '',
    ].join('\n'),
  )
}

/** `describe.skipIf(audioDown)` — the audio suite's guard. Implies `stackDown`. */
export const audioDown = !audioStack.up
