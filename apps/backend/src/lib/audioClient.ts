/**
 * Server-only client for `services/audio-service`.
 *
 * ── WHY THIS IS NOT IN `@edc/ai-client` ──────────────────────────────────────
 *
 * `@edc/ai-client` is the *ai-service* client. audio-service is a different
 * service with a different key and a different surface, and there is exactly ONE
 * consumer of it (this backend). A package would buy versioning overhead and no
 * reuse. Promote it the day a second consumer appears; until then this file is
 * the whole client.
 *
 * ── ⚠ WHAT THIS CLIENT DOES **NOT** DECIDE ───────────────────────────────────
 *
 * 🔴 IT NEVER NAMES A CORPUS AND NEVER TOUCHES ai-service. Audio is not a
 * parallel pipeline: this client's only job is to turn a file into text. The
 * text then re-enters `enqueueIngestForDoc` — the same function an uploaded PDF
 * goes through — which is the only place a corpus name is resolved
 * (`lib/corpus.ts`).
 *
 * 🔴 AUDIO-SERVICE PROVIDES NO PER-ECOSISTEMA ISOLATION IN THIS DEPLOYMENT, for
 * exactly the reason `lib/corpus.ts` already records about ai-service: it
 * derives `{org, project}` from a BOOT-TIME `API_KEYS` map, never from the
 * request. This backend uses ONE audio-service key for every ecosistema, so from
 * audio-service's point of view every tenant is the same org. Isolation is
 * enforced HERE — by Payload access control on `documents`, and by the corpus
 * name derived in `lib/corpus.ts`. If that ever has to change it is one API key
 * per ecosistema in audio-service's `API_KEYS`, which the service already
 * supports, not a code change.
 *
 * ⚠ THE `metadata` WE SEND IS DECORATIVE. `organizationId` / `uploadedById` ride
 * along for log correlation only. Nothing on the way back may use audio-service's
 * echo of them to decide anything: the callback's `externalId` names a document
 * ROW, and the row is the source of truth for who owns it.
 *
 * ── The callback secret ──────────────────────────────────────────────────────
 *
 * audio-service signs with `X-AIService-*` and the SAME scheme ai-service uses,
 * on purpose (see `services/audio-service/app/callbacks.py`). So there is one
 * verifier (`lib/hmac.ts`), one receiver route, and one `CALLBACK_SECRET`. The
 * `callbackSecret` on audio-service's API key entry MUST equal this backend's
 * `CALLBACK_SECRET`.
 */

import { postStreaming } from './streamingPost'

/** Env var names, so log lines and tests never hand-type a string that can drift. */
export const AUDIO_SERVICE_URL_VAR = 'AUDIO_SERVICE_URL'
export const AUDIO_SERVICE_API_KEY_VAR = 'AUDIO_SERVICE_API_KEY'

/** Spanish. audio-service defaults to `es` too; we are explicit rather than lucky. */
export const TRANSCRIBE_LANGUAGE = 'es'

/** Base URL with trailing slashes stripped, mirroring `aiClient.ts`. */
export function audioServiceBaseUrl(): string | null {
  const raw = process.env[AUDIO_SERVICE_URL_VAR] ?? ''
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  if (!/^https?:\/\/.+/i.test(trimmed)) return null
  return trimmed
}

export function audioServiceApiKey(): string | null {
  const raw = process.env[AUDIO_SERVICE_API_KEY_VAR]
  return raw && raw.trim() ? raw.trim() : null
}

/** Which required pieces are missing or unusable. Empty ⇒ audio uploads work. */
export function missingAudioServiceConfig(): string[] {
  const missing: string[] = []
  const raw = (process.env[AUDIO_SERVICE_URL_VAR] ?? '').trim()
  if (!raw) {
    missing.push(AUDIO_SERVICE_URL_VAR)
  } else if (!audioServiceBaseUrl()) {
    missing.push(`${AUDIO_SERVICE_URL_VAR} (set, but not an absolute http(s):// URL)`)
  }
  if (!audioServiceApiKey()) missing.push(AUDIO_SERVICE_API_KEY_VAR)
  return missing
}

export function audioServiceConfigured(): boolean {
  return missingAudioServiceConfig().length === 0
}

// ---------------------------------------------------------------------------
// POST /v1/transcribe
// ---------------------------------------------------------------------------

/**
 * The audio bytes, as something that can be READ ONCE AS A STREAM and knows its
 * length up front.
 *
 * A `Blob` fits (`fs.openAsBlob(path)` is a file-backed one), and so does an S3
 * response stream with its `ContentLength` (`openObjectStream`). ⚠ Never a
 * Buffer: a recording can be as large as the 200 MB upload cap, and every copy
 * of it in the backend's heap is that size again. See `openMediaStream`.
 *
 * `stream()` may only be called once — an S3 body cannot be rewound.
 */
export interface AudioBody {
  readonly size: number
  stream(): ReadableStream<Uint8Array>
}

export interface TranscribeRequest {
  body: AudioBody
  filename: string
  contentType?: string | null
  /** The `documents` row id. Echoed on every callback; the join key back. */
  externalId: string
  title?: string | null
  /**
   * ⚠ Scoped to our `(org, project)` at audio-service. A repeat returns 200 with
   * the ORIGINAL id and does not re-transcribe — which is what makes a
   * double-fire of the afterChange hook free. It also means a retry after a real
   * failure MUST use a different key, or it silently re-adopts the failed job.
   */
  idempotencyKey: string
  callbackUrl?: string
  metadata?: Record<string, unknown>
  language?: string
}

export interface TranscribeAccepted {
  ok: true
  transcribeId: string
  /** audio-service recognised the idempotency key and returned the original job. */
  deduplicated: boolean
  /** Known already at 202 — ffprobe runs inline. Drives the UI's honest ETA. */
  durationSeconds: number | null
}

export interface TranscribeRejected {
  ok: false
  /**
   * ⚠ `permanent: true` ⇒ re-sending the same bytes produces the same answer
   * (415 wrong format, 413 too big/too long, 400 malformed). The user must
   * change something. `permanent: false` is infrastructure — but we still fail
   * the row rather than retrying here: audio-service owns retries, and a retry
   * from this side would double-transcribe.
   */
  permanent: boolean
  /** audio-service's `{error}` code, or a synthetic one for transport failures. */
  code: string
  message: string
}

export type TranscribeResult = TranscribeAccepted | TranscribeRejected

/** RFC 7578 escaping for a quoted header parameter, the same as undici's `FormData`. */
const quoted = (value: string): string =>
  value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22')

/**
 * A `multipart/form-data` body that STREAMS its one file part.
 *
 * 🔴 WHY NOT `FormData`: undici's `FormData` only takes a real `Blob`, and a
 * Blob cannot be built from a stream without reading it whole. That forced the
 * S3 path to buffer every recording (audit I-10). This writes the same wire
 * format by hand: the file part first, as `FormData` did, then the text fields,
 * with the file's chunks passed through one at a time as `fetch` pulls them.
 *
 * The length is exact (part headers + `file.size` + trailer), so the request
 * carries a `Content-Length` rather than going chunked.
 */
export function streamingMultipart(
  file: { body: AudioBody; filename: string; contentType?: string | null },
  fields: ReadonlyArray<readonly [string, string]>,
): { body: ReadableStream<Uint8Array>; contentType: string; contentLength: number } {
  const enc = new TextEncoder()
  const boundary = `----edc-audio-${crypto.randomUUID()}`
  const head = enc.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${quoted(file.filename)}"\r\n` +
      `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`,
  )
  const tail = enc.encode(
    '\r\n' +
      fields
        .map(
          ([name, value]) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"\r\n\r\n${value}\r\n`,
        )
        .join('') +
      `--${boundary}--\r\n`,
  )

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let done = false
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (done) return
        if (!reader) {
          // Opened on the first pull, so nothing is read before fetch wants it.
          reader = file.body.stream().getReader()
          controller.enqueue(head)
          return
        }
        const chunk = await reader.read()
        if (!chunk.done) {
          controller.enqueue(chunk.value)
          return
        }
        done = true
        controller.enqueue(tail)
        controller.close()
      },
      async cancel(reason) {
        await reader?.cancel(reason)
      },
    },
    // ⚠ 0, not the default 1: with 1 the stream pulls once at construction and
    // opens the file before `fetch` has even connected.
    { highWaterMark: 0 },
  )

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: head.byteLength + file.body.size + tail.byteLength,
  }
}

/**
 * Submit one file for transcription. Never throws — every failure comes back as
 * a `TranscribeRejected` so the caller can record it on the row.
 */
export async function submitTranscription(
  req: TranscribeRequest,
): Promise<TranscribeResult> {
  const base = audioServiceBaseUrl()
  const key = audioServiceApiKey()
  if (!base || !key) {
    return {
      ok: false,
      permanent: true,
      code: 'audio_service_not_configured',
      message: `audio-service is not configured (missing: ${missingAudioServiceConfig().join(', ')}).`,
    }
  }

  const fields: Array<[string, string]> = [
    ['language', req.language ?? TRANSCRIBE_LANGUAGE],
    ['externalId', req.externalId],
    ['idempotencyKey', req.idempotencyKey],
  ]
  if (req.title) fields.push(['title', req.title])
  if (req.callbackUrl) fields.push(['callbackUrl', req.callbackUrl])
  if (req.metadata) fields.push(['metadata', JSON.stringify(req.metadata)])
  // The filename is what audio-service sees. It uses the extension as a cheap
  // pre-filter before ffprobe, so it must survive.
  const multipart = streamingMultipart(
    { body: req.body, filename: req.filename, contentType: req.contentType },
    fields,
  )

  let res: Response
  try {
    // ⚠ `postStreaming`, not `fetch`: Node 22's `fetch` held a streamed body
    // in memory. See `lib/streamingPost.ts`.
    res = await postStreaming(`${base}/v1/transcribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': multipart.contentType,
        // ⚠ Declared, not chunked: audio-service's size guard answers a clean
        // 413 off this header before it reads a byte (`app/limits.py`).
        'Content-Length': String(multipart.contentLength),
      },
      body: multipart.body,
    })
  } catch (err) {
    return {
      ok: false,
      permanent: false,
      code: 'audio_service_unreachable',
      message: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    }
  }

  const payload = (await res.json().catch(() => ({}))) as {
    transcribeId?: string
    deduplicated?: boolean
    durationSeconds?: number
    error?: string
    message?: string
  }

  // 202 = fresh job, 200 = idempotency hit. Both carry a usable transcribeId.
  if (res.ok && typeof payload.transcribeId === 'string' && payload.transcribeId) {
    return {
      ok: true,
      transcribeId: payload.transcribeId,
      deduplicated: payload.deduplicated === true,
      durationSeconds:
        typeof payload.durationSeconds === 'number' ? payload.durationSeconds : null,
    }
  }

  if (res.ok) {
    // 2xx with no id: nothing was scheduled, so promising the user a
    // transcription would be a lie. Treat as a transport-shaped failure.
    return {
      ok: false,
      permanent: false,
      code: 'audio_service_bad_response',
      message: `audio-service returned ${res.status} without a transcribeId.`,
    }
  }

  return {
    ok: false,
    // 4xx is the user's file, not our infrastructure. 401/403 is OUR key being
    // wrong — permanent for this upload either way, and the operator needs the
    // log line rather than five more attempts.
    permanent: res.status >= 400 && res.status < 500,
    code: typeof payload.error === 'string' && payload.error ? payload.error : `http_${res.status}`,
    message:
      typeof payload.message === 'string' && payload.message
        ? payload.message.slice(0, 300)
        : `audio-service responded ${res.status}`,
  }
}

// ---------------------------------------------------------------------------
// GET /v1/transcribe/:id
// ---------------------------------------------------------------------------

/**
 * Fetch the full transcript text.
 *
 * ⚠ ONLY needed when the callback says `truncated: true` — above
 * `CALLBACK_MAX_TRANSCRIPT_CHARS` (200k by default) audio-service omits the text
 * from the webhook rather than POSTing a multi-megabyte body through a proxy
 * that may well cap it.
 *
 * ⚠ Time-limited. audio-service is Redis-only and the transcript has a TTL
 * (`TRANSCRIPT_TTL_SECONDS`, 24h by default). After that it answers 404, this
 * returns null and the audio has to be re-uploaded — which is why the receiver
 * persists the text onto the row the moment it has it.
 *
 * 🔴 THROWS on anything that might work on a second try: no config, a network
 * error, a 5xx, a 429, a body that is not JSON. Returning null there failed the
 * row as "no speech" and answered 200, and a delivered callback makes
 * audio-service cut the transcript's TTL to 1 h and never retry, so the text was
 * lost (audit 2026-11-10, C-04). Thrown, it reaches the receiver as a 500 and
 * audio-service delivers again. Null means only "gone" (404) or "nothing said".
 *
 * `includeSegments=false`: a 2-hour recording is thousands of segments and
 * nothing downstream reads word timings.
 */
export async function fetchTranscriptText(transcribeId: string): Promise<string | null> {
  const base = audioServiceBaseUrl()
  const key = audioServiceApiKey()
  if (!base || !key) throw new Error('audio-service is not configured; cannot fetch the transcript')

  let res: Response
  try {
    res = await fetch(
      `${base}/v1/transcribe/${encodeURIComponent(transcribeId)}?includeSegments=false`,
      { headers: { Authorization: `Bearer ${key}` } },
    )
  } catch (err) {
    throw new Error(`audio-service transcript fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`audio-service transcript fetch responded ${res.status}`)
  }

  let body: { transcript?: { text?: unknown } | null } | null
  try {
    body = (await res.json()) as typeof body
  } catch {
    throw new Error('audio-service transcript fetch returned a body that is not JSON')
  }
  const text = body?.transcript?.text
  return typeof text === 'string' && text.trim() ? text : null
}

// ---------------------------------------------------------------------------
// Boot check
// ---------------------------------------------------------------------------

/** Same shape as `callbackConfig.ts`'s logger, for the same reason. */
export type BootLogger = {
  error: (msg: string) => void
  warn: (msg: string) => void
  info: (msg: string) => void
}

/**
 * Boot-time check — called from `onInit`.
 *
 * ⚠ NEVER THROWS. Audio is one feature; PDFs, DOCX, markdown notes, chat and
 * login all work without it. Crash-looping every replica over a missing audio
 * key would take down the admin panel you would fix it from.
 *
 * Unlike the ai-service callback check, a missing audio config is NOT silent at
 * runtime: `startTranscription` fails the row with a visible, retryable error
 * instead of leaving it stuck. This log exists so an operator learns about it
 * before a user does.
 */
export function checkAudioServiceConfig(logger: BootLogger): void {
  const missing = missingAudioServiceConfig()
  if (missing.length === 0) {
    logger.info(`[audio-service] transcription configured → ${audioServiceBaseUrl()}`)
    return
  }
  const consequence =
    'audio uploads will be rejected with ingestStatus="failed" and a visible error; ' +
    'PDF/DOCX/markdown are unaffected'
  if (process.env.NODE_ENV === 'production') {
    logger.error(
      `[audio-service] NOT CONFIGURED — missing: ${missing.join(', ')}. ${consequence}. ` +
        `Note the callback secret is NOT a separate variable: audio-service signs with the same ` +
        `scheme as ai-service, so its API key's \`callbackSecret\` must equal this backend's CALLBACK_SECRET.`,
    )
    return
  }
  logger.warn(
    `[audio-service] transcription is off — missing: ${missing.join(', ')}. ${consequence}.`,
  )
}
