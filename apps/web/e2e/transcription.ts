import { stackVar } from './env';

/**
 * Is there a transcription backend for `journey.spec.ts` and `live-mic.spec.ts`?
 * `null` = yes; otherwise the reason, for `test.skip(…, reason)`.
 *
 * Both specs need a real Whisper behind audio-service. On this stack that is
 * the DGX Spark (`WHISPER_BACKEND=remote`), a borrowed box that is often off;
 * without it the upload sits in "transcribiendo…" until the test times out,
 * which reads as a product failure when it is a missing machine.
 *
 *   1. `E2E_TRANSCRIPTION=0` → skip; `=1` → run without probing.
 *   2. audio-service `GET /health/ready` (unauthenticated) must answer 200.
 *      `EDC_AUDIO_URL`, else `LIVE_AUDIO_URL`, else the local host port.
 *   3. With `WHISPER_BACKEND=remote`, `WHISPER_REMOTE_URL` must answer at all:
 *      any HTTP status counts (its proxy 401s without the token, which this
 *      never reads); only a network failure or timeout means "off". audio-
 *      service's own readiness cannot say this: it reports ready while the
 *      Spark is down, on purpose (`services/audio-service/app/remote_transcriber.py`).
 *
 * 🔴 Never prints a URL or a value from `infra/.env`; reasons name the variable.
 */

const PROBE_TIMEOUT_MS = 5_000;

async function answers(url: string): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

let cached: Promise<string | null> | null = null;

export function transcriptionUnavailable(): Promise<string | null> {
  cached ??= probe();
  return cached;
}

async function probe(): Promise<string | null> {
  const forced = process.env.E2E_TRANSCRIPTION;
  if (forced === '0') return 'transcription disabled for this run (E2E_TRANSCRIPTION=0)';
  if (forced === '1') return null;

  const audioUrl = (
    process.env.EDC_AUDIO_URL ??
    process.env.LIVE_AUDIO_URL ??
    `http://localhost:${stackVar('AUDIO_HOST_PORT') ?? '45403'}`
  ).replace(/\/+$/, '');
  const ready = await answers(`${audioUrl}/health/ready`);
  if (!ready) return 'audio-service is unreachable (EDC_AUDIO_URL / AUDIO_HOST_PORT); set E2E_TRANSCRIPTION=1 to run anyway';
  if (!ready.ok) return `audio-service is not ready (/health/ready answered ${ready.status}); set E2E_TRANSCRIPTION=1 to run anyway`;

  if ((stackVar('WHISPER_BACKEND') ?? 'local') === 'remote') {
    const remote = stackVar('WHISPER_REMOTE_URL');
    if (!remote) return 'WHISPER_BACKEND=remote but WHISPER_REMOTE_URL is empty';
    if (!(await answers(`${remote.replace(/\/+$/, '')}/health`))) {
      return 'the remote Whisper (WHISPER_REMOTE_URL, the Spark) does not answer; set E2E_TRANSCRIPTION=1 to run anyway';
    }
  }
  return null;
}
