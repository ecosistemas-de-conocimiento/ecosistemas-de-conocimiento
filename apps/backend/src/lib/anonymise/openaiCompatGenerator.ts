/**
 * The detector's SELF-HOSTED backend: one OpenAI-compatible chat endpoint (a
 * llama.cpp server behind a Bearer-token proxy), called directly with `fetch`.
 *
 * 🔴 WHY THIS EXISTS: through ai-service, the raw testimony reaches a hosted
 * model (OpenRouter). Pointed at our own box, it never leaves our hosts.
 *
 * ⚠ NOT FAIL-CLOSED ANY MORE BY DEFAULT (owner decision, 2026-10-21): when
 * this box is unavailable, `detector.ts` sends that call to ai-service — a
 * hosted model — through `fallbackGenerator.ts`. `ANONYMISE_DETECT_FALLBACK=none`
 * restores fail-closed: an unreachable box throws and the document is HELD.
 *
 * ⚠ ai-service traces and usage logging do NOT see these calls. Each call logs
 * one line (latency, token counts from `usage`) instead. Never the text.
 *
 * Error shape matches what `aiRetry.ts` classifies: HTTP failures carry a
 * numeric `status` (429/5xx retried, the rest permanent), our own deadline is a
 * `RequestAbortedError` with `reason: 'timeout'`, and a network fault is the
 * platform's `TypeError: fetch failed`, passed through untouched.
 */

import type { SyncGenerator } from './detector'

export const ANONYMISE_DETECT_URL_VAR = 'ANONYMISE_DETECT_URL'
export const ANONYMISE_DETECT_API_KEY_VAR = 'ANONYMISE_DETECT_API_KEY'
export const ANONYMISE_DETECT_MODEL_VAR = 'ANONYMISE_DETECT_MODEL'

/**
 * Same reply cap and temperature ai-service applies at `quick` effort (quoted:
 * `services/ai-service/src/services/registry/resolve.ts`, `EFFORT_PROFILES.quick`
 * → `maxOutputTokens: 400`, `temperature: 0.3`). `chunk.ts` sizes chunks
 * against that 400-token cap.
 */
export const DETECT_MAX_TOKENS = 400
export const DETECT_TEMPERATURE = 0.3

/** Fallback per-call deadline when the caller passes none. */
const DEFAULT_TIMEOUT_MS = 90_000

export interface OpenAICompatOptions {
  /** Base URL, without `/v1/chat/completions`. */
  baseUrl: string
  apiKey?: string
  model: string
  fetch?: typeof fetch
  log?: (line: string) => void
}

/** HTTP failure. `status` is what `aiRetry.ts` reads. The body is NOT kept: it may echo the prompt. */
export class OpenAICompatHttpError extends Error {
  override name = 'OpenAICompatHttpError'
  constructor(
    readonly status: number,
    readonly retryAfterMs: number,
  ) {
    super(`anonymise-detect backend answered HTTP ${status}`)
  }
}

/** Our own deadline. Same name and `reason` as `@edc/ai-client`'s, so `isTransient` retries it. */
export class RequestAbortedError extends Error {
  override name = 'RequestAbortedError'
  readonly reason = 'timeout' as const
  constructor(timeoutMs: number) {
    super(`anonymise-detect backend timed out after ${timeoutMs} ms`)
  }
}

function retryAfterMs(header: string | null): number {
  const s = Number(header)
  return Number.isFinite(s) && s > 0 ? s * 1000 : 0
}

interface ChatCompletion {
  model?: string
  choices?: { message?: { content?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * ⚠ The detector's `specOverride` is always the identity template
 * `{{{userPrompt}}}`, so the user message IS `userPrompt`; no Handlebars here.
 */
export function openaiCompatGenerator(opts: OpenAICompatOptions): SyncGenerator {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
  const doFetch = opts.fetch ?? fetch
  const log = opts.log ?? ((line: string) => console.info(line))

  return {
    generate: {
      async sync(req, callOpts) {
        const timeoutMs = callOpts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        const started = Date.now()
        try {
          const messages = [
            ...(req.unit.systemPrompt ? [{ role: 'system', content: req.unit.systemPrompt }] : []),
            { role: 'user', content: req.unit.input.userPrompt },
          ]
          let res: Response
          try {
            res = await doFetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
              },
              body: JSON.stringify({
                model: opts.model,
                messages,
                max_tokens: DETECT_MAX_TOKENS,
                temperature: DETECT_TEMPERATURE,
                stream: false,
                // Qwen3 hybrid models honour it; the Instruct-2507 build and other servers ignore it.
                chat_template_kwargs: { enable_thinking: false },
              }),
              signal: controller.signal,
            })
          } catch (err) {
            if (controller.signal.aborted) throw new RequestAbortedError(timeoutMs)
            throw err
          }
          if (!res.ok) {
            log(`[anonymise-detect] openai-compat HTTP ${res.status} after ${Date.now() - started} ms`)
            throw new OpenAICompatHttpError(res.status, retryAfterMs(res.headers.get('retry-after')))
          }
          let body: ChatCompletion
          try {
            body = (await res.json()) as ChatCompletion
          } catch (err) {
            if (controller.signal.aborted) throw new RequestAbortedError(timeoutMs)
            throw err
          }
          const text = body.choices?.[0]?.message?.content
          if (typeof text !== 'string') throw new Error('anonymise-detect backend returned no message content')
          const u = body.usage ?? {}
          log(
            `[anonymise-detect] openai-compat ${body.model ?? opts.model} ${Date.now() - started} ms` +
              ` in=${u.prompt_tokens ?? '?'} out=${u.completion_tokens ?? '?'}`,
          )
          return { text, modelUsed: body.model ?? opts.model }
        } finally {
          clearTimeout(timer)
        }
      },
    },
  }
}

/** The configured self-hosted generator, or `null` when `ANONYMISE_DETECT_URL` is unset. */
export function openaiCompatFromEnv(
  env: Record<string, string | undefined> = process.env,
  extra: Pick<OpenAICompatOptions, 'fetch' | 'log'> = {},
): { generator: SyncGenerator; model: string; host: string } | null {
  const baseUrl = (env[ANONYMISE_DETECT_URL_VAR] ?? '').trim()
  if (baseUrl === '') return null
  // 🔴 A URL without a model is a misconfiguration, not "use ai-service" and not a
  // fallback case: throw → HOLD.
  const model = (env[ANONYMISE_DETECT_MODEL_VAR] ?? '').trim()
  if (model === '') {
    throw new Error(`${ANONYMISE_DETECT_URL_VAR} is set but ${ANONYMISE_DETECT_MODEL_VAR} is not`)
  }
  const apiKey = (env[ANONYMISE_DETECT_API_KEY_VAR] ?? '').trim() || undefined
  let host: string
  try {
    host = new URL(baseUrl).host
  } catch {
    throw new Error(`${ANONYMISE_DETECT_URL_VAR} is not a valid URL`)
  }
  return {
    generator: openaiCompatGenerator({ baseUrl, model, ...(apiKey ? { apiKey } : {}), ...extra }),
    model,
    host,
  }
}
