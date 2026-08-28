/**
 * THE ai-service CLIENT FOR EXTRACTION, AND WHY IT IS NOT `getAppAIClient()`.
 *
 * 🔴 MEASURED, NOT ASSUMED: one `deep`-tier extraction window against the local
 * ai-service (`edc-ai-service-1`, 2026-08-28) took **120 seconds** end to end —
 * `POST /v1/generate/sync` answered 200 after 120,008 ms. The `deep` tier runs
 * two validation passes over ~3500 output tokens, so that is the shape of a
 * normal call, not an outlier.
 *
 * `@edc/ai-client`'s DEFAULT REQUEST TIMEOUT IS 30 SECONDS
 * (`packages/ai-client/src/index.ts:23`), and `lib/aiClient.ts` constructs both
 * shared clients without overriding it. With that timeout, EVERY extraction
 * window would abort at 30 s, every document would land on
 * `graphStatus: 'failed'`, and the corpus graph would never contain a single
 * row. The failure would look like "ai-service is flaky" rather than like a
 * misconfigured timeout, which is the worst kind of wrong.
 *
 * ⚠ RAISING THE SHARED CLIENT'S TIMEOUT WOULD BE WORSE. `getAppAIClient()` is a
 * memoised singleton used by the ingest enqueue path, where 30 s is the right
 * budget: `POST /v1/ingest` returns as soon as the job is queued, so a slow
 * answer there means something is wrong and failing fast is correct. Extraction
 * is the only caller that legitimately waits minutes. One timeout cannot serve
 * both, so extraction gets its own client and the ingest path is left alone.
 *
 * ⚠ IT IS STILL THE SAME CREDENTIAL AND THE SAME DEPLOYMENT.
 * {@link getAppAIClient} is called first, purely so the "is this configured at
 * all" question is answered by the module that owns it — the thrown message an
 * operator sees is identical whichever path asked.
 *
 * ── 🔴 A LONGER CLIENT TIMEOUT IS NECESSARY BUT NOT SUFFICIENT ─────────────
 *
 * The same measurement showed ai-service answering 200 at exactly 120,008 ms
 * with NO usable completion. That is ai-service's OWN wall-clock cap:
 * `LLM_REQUEST_TIMEOUT_MS` defaults to `120_000`
 * (`services/ai-service/src/config/env.ts:208`), and the router composes it into
 * the provider call's abort signal (`router.ts:208,219`). The model was still
 * generating when that fired, so the response validated against nothing and
 * `parsed` was withheld — which reaches us as a failed window.
 *
 * So on a deployment left at the default, ONE `deep` extraction window over a
 * ~1.2k-character Spanish document did not finish in time. Three levers exist
 * and choosing between them is an owner decision, not this file's:
 *
 *   · raise `LLM_REQUEST_TIMEOUT_MS` on ai-service;
 *   · lower the effort tier (ADR §5.2 specifies `deep`; changing it changes
 *     extraction quality, so it is a design decision);
 *   · lower `GRAPH_EXTRACT_WINDOW_CHARS` so each call asks for less.
 *
 * ⚠ WHATEVER IS CHOSEN, THIS TIMEOUT MUST STAY ABOVE ai-service's. If the
 * client aborts first, the server's answer — including the flags that say WHY
 * it failed — is never seen, and every failure looks like a network fault.
 */

import type { GraphGenerateClient } from './extract'

/**
 * How long one extraction window may take.
 *
 * ⚠ 180 s, against a MEASURED 120 s, is deliberate headroom rather than a
 * guess: the measurement is one call, on one deployment, on one document, and a
 * longer window or a busier provider moves it. It is an env var because the
 * right value is a property of the deployment, not of this code.
 */
export const graphRequestTimeoutMs = (): number => {
  const raw = process.env.GRAPH_EXTRACT_TIMEOUT_MS
  const n = raw == null || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 180_000
}

let cached: GraphGenerateClient | null = null

/** Test seam — drops the memoised client so an env change takes effect. */
export function __resetGraphClientForTests(): void {
  cached = null
}

/**
 * The client extraction calls, memoised per process like the shared ones.
 *
 * Throws the same errors `getAppAIClient()` throws when ai-service is not
 * configured; callers record that on `graphStatus` rather than crashing.
 */
export async function getGraphAIClient(): Promise<GraphGenerateClient> {
  if (cached) return cached

  // ⚠ FIRST, so configuration errors come from the module that owns them and
  // an operator gets one message, not two spellings of the same one.
  const { getAppAIClient } = await import('@/lib/aiClient')
  getAppAIClient()

  // `AIClient` keeps its `HttpClient` deps private, so the timeout cannot be
  // changed on an existing instance. Same two variables `lib/aiClient.ts`
  // reads, and they have just been validated by the call above.
  const baseUrl = (process.env.AI_SERVICE_URL ?? '').replace(/\/+$/, '')
  const apiKey = process.env.AI_SERVICE_API_KEY ?? ''

  const { AIClient } = await import('@edc/ai-client')
  cached = new AIClient({
    baseUrl,
    apiKey,
    timeoutMs: graphRequestTimeoutMs(),
  }) as unknown as GraphGenerateClient
  return cached
}
