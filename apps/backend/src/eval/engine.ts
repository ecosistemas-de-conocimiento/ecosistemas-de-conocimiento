/**
 * The production chat turn, callable from a script.
 *
 * `prepareTurn()` and the generate call are `@edc/chat-engine`'s own — the
 * engine is the thing under test and nothing about it is reimplemented here.
 * What this file supplies is the three seams `apps/web` supplies in production,
 * rebuilt against the same contracts:
 *
 *   · `EngineConfig`  — a copy of `apps/web/src/lib/server/engine/config.ts`
 *                       (which imports `$env/dynamic/private` and cannot be
 *                       imported from `apps/backend`). Same system prompt, and
 *                       everything else inherited from `DEFAULT_ENGINE_CONFIG`.
 *   · `DomainAdapter` — `scopeHierarchy` returns the same deterministic summary
 *                       shape `makeChatDomainAdapter` builds, for a conversation
 *                       with NO attached documents. The other five methods are
 *                       never reached by `prepareTurn` with no inline refs.
 *   · `AIClient`      — `retrieve` and `generateSync` over HTTP, reproducing
 *                       `makeEngineAIClient`'s gates.
 *
 * 🔴 THE THREE RETRIEVAL INVARIANTS, KEPT THE SAME WAY apps/web KEEPS THEM
 *
 *  1. `asOf` on every retrieve. One value per run, set once, asserted non-empty
 *     before any call goes out. Without it ai-service returns end-dated chunks
 *     from unpublished documents.
 *  2. `allowedCorpora` is a closed set. `retrieveContext` ALWAYS appends
 *     `chat:thread:<threadId>`; the gate drops it with no network call, exactly
 *     as production does — otherwise every turn pays a 404 round trip.
 *  3. The corpus name is `publishedCorpus(1)` from `lib/corpus.ts`, not a
 *     string typed here. An unauthorised name returns empty WITH NO NETWORK
 *     CALL, which looks identical to a graph miss.
 *
 * ⚠ ONE DELIBERATE DIFFERENCE FROM `respond()`: this file calls `prepareTurn`
 * and `generateSync` separately, which is exactly what `respond()` does
 * internally, so that context latency and generation latency can be reported
 * apart. Nothing else changes.
 */

import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from '@edc/chat-engine/core'
import type { AIClient, DomainAdapter } from '@edc/chat-engine/core'

import type { EvalEnv } from './env'

/** `apps/web/src/lib/server/engine/config.ts:CHAT_ENGINE_CONFIG`, copied. */
export const CHAT_ENGINE_CONFIG: EngineConfig = {
  ...DEFAULT_ENGINE_CONFIG,
  surface: 'chat',
  systemPrompt:
    'Eres un asistente que ayuda a una persona a consultar los documentos de su ' +
    'ecosistema de conocimiento. Tienes acceso a un resumen del contexto (el ' +
    'ecosistema y los documentos de la conversación) y a fragmentos recuperados ' +
    'de esos documentos.\n\n' +
    'Puedes razonar, proponer ideas y aportar conocimiento general. Pero cuando ' +
    'afirmes hechos sobre el ecosistema o sus documentos, básate en el resumen ' +
    'y en el contenido recuperado; no inventes detalles. Distingue con claridad ' +
    'entre lo que consta en el contexto y tus propias sugerencias. Si el contexto ' +
    'no alcanza para responder algo, dilo explícitamente.\n\n' +
    'Responde en español, de forma clara y concisa. Usa Markdown (encabezados, ' +
    'listas, código) cuando ayude a la lectura.',
}

/**
 * `makeChatDomainAdapter`'s `scopeHierarchy`, for a conversation with no
 * attached documents.
 *
 * ⚠ The summary names the ecosistema and nothing else, which is what a chat
 * opened against the shared corpus looks like. Adding documents here would give
 * BOTH arms extra context and change what the question is measuring.
 */
export function makeEvalAdapter(args: {
  organizationName: string
  organizationDescription: string | null
  corpora: readonly string[]
}): DomainAdapter {
  const summaryText = `Ecosistema: ${args.organizationName}.${
    args.organizationDescription ? ` ${args.organizationDescription}` : ''
  }`
  return {
    async scopeHierarchy() {
      return { summaryText, corpora: args.corpora.map((corpus) => ({ corpus })) }
    },
    async searchEntities() {
      return []
    },
    async resolveEntity() {
      return ''
    },
    async syncEntity() {},
    async backfill() {},
    async summary() {
      return summaryText
    },
  }
}

// ── The AIClient ───────────────────────────────────────────────────────────

/** `DEFAULT_TOPK` in `apps/web/src/lib/server/engine/aiClient.ts`. */
const DEFAULT_TOPK = 5

export interface CallRecord {
  kind: 'retrieve' | 'generate'
  ms: number
  corpus?: string
  chunks?: number
  traceId?: string
  costUsd?: number
  /** ai-service's `legs` for a retrieve — `rerank` there means it really ran. */
  legs?: string[]
  /** The rerank request failed and was retried without it. */
  rerankFallback?: boolean
}

export interface EvalAIClient extends AIClient {
  /** Every upstream call this client made, in order. Reset per question+arm. */
  readonly calls: CallRecord[]
  reset(): void
}

export interface EvalAIClientOptions {
  env: EvalEnv
  /** ISO instant every retrieve is scoped to. 🔴 Without it, zero chunks. */
  asOf: string
  /** The closed set of corpus names this client may touch. */
  allowedCorpora: readonly string[]
  /** Attribution key on the generate unit. Unique per call, for trace lookup. */
  unitKeyFor: () => string
}

export function makeEvalAIClient(opts: EvalAIClientOptions): EvalAIClient {
  const asOf = opts.asOf.trim()
  if (!asOf) {
    throw new Error(
      '[eval] refusing to build a client without `asOf`. Every retrieve would ' +
        'silently return zero chunks and the whole run would measure nothing.',
    )
  }
  const allowed = new Set(opts.allowedCorpora)
  const calls: CallRecord[] = []

  const headers = {
    authorization: `Bearer ${opts.env.aiServiceApiKey}`,
    accept: 'application/json',
    'content-type': 'application/json',
  }

  return {
    calls,
    reset() {
      calls.length = 0
    },

    async retrieve(req) {
      // Gate 2. `retrieveContext` always appends the per-thread corpus; drop it
      // here, with no network call, exactly as `makeEngineAIClient` does.
      if (!allowed.has(req.corpus)) return { matches: [] }
      const topK = req.topK && req.topK > 0 ? req.topK : DEFAULT_TOPK
      const started = Date.now()
      const payload: Record<string, unknown> = {
        corpus: req.corpus,
        query: req.query,
        topK,
        asOf, // Gate 1.
        ...(req.filter ? { filter: req.filter } : {}),
        // Only when the turn's policy asked (`rerank.ts`, `--no-rerank` here).
        ...(req.rerank === true ? { rerank: true } : {}),
      }
      const post = (p: Record<string, unknown>) =>
        fetch(`${opts.env.aiServiceUrl}/v1/retrieve`, {
          method: 'POST',
          headers,
          body: JSON.stringify(p),
        })
      let res = await post(payload)
      // The same fallback as `retrieveScoped` in apps/web: a failing rerank
      // request is retried once without it, never dropped.
      let rerankFallback = false
      if (!res.ok && payload.rerank === true) {
        const { rerank: _dropped, ...plain } = payload
        rerankFallback = true
        res = await post(plain)
      }
      const ms = Date.now() - started
      if (!res.ok) {
        calls.push({ kind: 'retrieve', ms, corpus: req.corpus, chunks: 0, rerankFallback })
        return { matches: [] }
      }
      const body = (await res.json()) as {
        legs?: string[]
        chunks?: Array<{
          chunkId: string
          documentId: string
          score: number
          denseScore?: number
          lexicalScore?: number
          rerankScore?: number
          text: string
          metadata?: Record<string, unknown>
        }>
      }
      // Leg scores forwarded exactly as `makeEngineAIClient` does: under rerank
      // `score` is the cross-encoder value, and the cosine is `denseScore`.
      const matches = (body.chunks ?? []).map((c) => ({
        documentId: c.documentId,
        chunkId: c.chunkId,
        score: c.score,
        ...(typeof c.denseScore === 'number' ? { denseScore: c.denseScore } : {}),
        ...(typeof c.lexicalScore === 'number' ? { lexicalScore: c.lexicalScore } : {}),
        ...(typeof c.rerankScore === 'number' ? { rerankScore: c.rerankScore } : {}),
        text: c.text,
        ...(c.metadata ? { metadata: c.metadata } : {}),
      }))
      calls.push({
        kind: 'retrieve',
        ms,
        corpus: req.corpus,
        chunks: matches.length,
        ...(body.legs ? { legs: body.legs } : {}),
        ...(rerankFallback ? { rerankFallback } : {}),
      })
      return { matches }
    },

    async generateSync(req) {
      // `buildChatUnitRequest` + `partitionMessages`, copied from
      // `apps/web/src/lib/server/engine/wire.ts`. Same bytes on the wire.
      let i = 0
      const systemParts: string[] = []
      for (; i < req.messages.length; i += 1) {
        const m = req.messages[i]
        if (!m || m.role !== 'system') break
        systemParts.push(m.content)
      }
      const rest = req.messages.slice(i)
      const systemJoined = systemParts.join('\n\n').trim()
      const systemPrompt = systemJoined.length > 0 ? systemJoined : undefined
      const only = rest.length === 1 ? rest[0] : undefined
      const userPrompt =
        only && only.role === 'user'
          ? only.content
          : `${rest.map((m) => `${m.role}:\n${m.content}`).join('\n\n')}\n\n` +
            'Responde como el asistente para el último turno del usuario.'

      const started = Date.now()
      const res = await fetch(`${opts.env.aiServiceUrl}/v1/generate/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          unit: {
            unitKey: opts.unitKeyFor(),
            unitType: 'chat',
            input: { userPrompt },
            ...(systemPrompt ? { systemPrompt } : {}),
            // `PROMPT_SOURCE` is unset on this stack, so the override is sent.
            specOverride: { promptTemplate: '{{{userPrompt}}}' },
          },
          ...(req.effort ? { effortLevel: req.effort } : {}),
        }),
      })
      const ms = Date.now() - started
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`[eval] /v1/generate/sync ${res.status}: ${detail.slice(0, 400)}`)
      }
      const body = (await res.json()) as {
        text?: string
        parsed?: unknown
        modelUsed?: string
        provider?: string
        costUsd?: number
        traceId?: string
        systemPromptApplied?: boolean
      }
      // The same assertion `AIServiceClient.generateSync` makes. A silently
      // dropped system prompt would change the answer and nothing would say so.
      if (systemPrompt && body.systemPromptApplied !== true) {
        throw new Error('[eval] ai-service did not apply the system prompt')
      }
      calls.push({ kind: 'generate', ms, traceId: body.traceId, costUsd: body.costUsd })
      return {
        text: body.text ?? '',
        parsed: body.parsed,
        modelUsed: body.modelUsed ?? 'unknown',
        provider: body.provider ?? 'unknown',
        costUsd: body.costUsd ?? 0,
        traceId: body.traceId ?? '',
      }
    },

    async ingest() {
      return { ingested: 0, documentIds: [] }
    },
  }
}
