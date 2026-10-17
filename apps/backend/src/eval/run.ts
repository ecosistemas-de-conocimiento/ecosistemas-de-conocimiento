/**
 * The driver. Two arms per question, everything else identical.
 *
 *   node ../web/node_modules/.bin/tsx src/eval/run.ts --fake     # no inference
 *   node ../web/node_modules/.bin/tsx src/eval/run.ts            # ~40 real calls
 *   node ../web/node_modules/.bin/tsx src/eval/run.ts --expand   # + query expansion
 *   node ../web/node_modules/.bin/tsx src/eval/run.ts --no-rerank  # rerank off
 *
 * Run from `apps/backend`. Writes `src/eval/results.json`; `report.ts` turns
 * that into `RESULTS.md`.
 *
 * ── WHAT IS HELD CONSTANT BETWEEN THE ARMS ─────────────────────────────────
 *
 * Same `EngineConfig`, same adapter, same corpora, same `asOf` (one value for
 * the whole run), same user message, same empty history — so `condenseQuery`
 * short-circuits without an LLM call and BOTH arms hand the graph and the
 * vector leg the identical query. The ONLY difference is whether
 * `prepareTurn` is given a `graphProvider`.
 *
 * ── `--expand`: QUERY EXPANSION ON BOTH ARMS ───────────────────────────────
 *
 * Production wraps the engine's client in `withQueryExpansion` (default ON,
 * `QUERY_EXPANSION`). This harness leaves it OFF unless `--expand` is passed,
 * so runs stay comparable with the baselines recorded before it existed. To
 * measure its effect, run once without and once with the flag; `results.json`
 * records which (`queryExpansion`) and each arm's `expansion` trace.
 *
 * It is the PRODUCTION module, imported from `apps/web`, not a copy: it reads
 * no `$env`. As in production, only the engine's retrieve is wrapped — the
 * graph provider and the answer's generate use the plain client.
 *
 * ── RERANK: ON BY DEFAULT, AS IN PRODUCTION; `--no-rerank` TO COMPARE ───────
 *
 * Both arms get the PRODUCTION retrieval policy, `chatRetrievalPolicy` from
 * `apps/web/src/lib/server/engine/rerank.ts` (imported, not copied): a
 * cross-encoder rerank on each corpus retrieve, which production turns on with
 * `CHAT_RERANK` (default on). `--no-rerank` passes no policy, which is the
 * engine's pre-policy retrieval and what every run before 2026-10-17 measured.
 * `results.json` records which (`rerank`) and each arm's `rerankedRetrieves`
 * — how many retrieves came back with `rerank` in ai-service's `legs`, so a
 * reranker that silently fell back is visible.
 *
 * ⚠ The expansion call carries NO run marker. Within five minutes both arms and
 * every repetition of a question get the router-cached rewordings — the same
 * variants on both arms, so the graph comparison stays clean — and every arm
 * after the first reports that call at ~0 ms and $0. Read the expansion's cost
 * off the first repetition's `plain` arm.
 *
 * ⚠ ARM ORDER IS INTERLEAVED PER QUESTION (no-graph then graph, immediately)
 * rather than all of one arm then all of the other. The model is nondeterministic
 * and the service is shared; running one arm an hour after the other would let
 * drift in the deployment masquerade as an effect.
 *
 * ⚠ `--fake` swaps ONLY the AIClient. The ground truth, the corpus join, the
 * graph reads, the fusion, the turn assembly and the scoring all run for real.
 * That is the dry run `sprint0/00-context.md` demands before paying for
 * inference — "do not loop over real inference while iterating".
 *
 * ── 🔴 THE RUN MARKER, AND WHY THE MEASUREMENT NEEDS ONE ───────────────────
 *
 * ai-service caches a generation on `hash(model, messages, maxTokens,
 * temperature, org)` for five minutes, and skips the cache only for the `deep`
 * and `maximum` tiers (`services/ai-service/src/services/ai/router/router.ts`).
 * Chat runs at `standard`, so it caches.
 *
 * That silently destroys this experiment. Whenever the graph contributes
 * nothing the two arms build the IDENTICAL prompt, so the second arm is served
 * the first one's answer at `durationMs: 0` and `costUsd: 0` — and the graph
 * arm, the one that runs second, would be reported as instant and free on
 * exactly the questions where it did nothing. Measured, not assumed: the
 * pre-flight pair came back with the same text, 6907 ms / $0.00078 and
 * 6 ms / $0.
 *
 * So every call appends ONE line to the system prompt carrying an id unique to
 * (question, arm, repetition). Both arms are marked the same way and the ids
 * are drawn the same way, so the marker introduces no systematic difference
 * between them — it only stops the cache from collapsing two independent
 * samples into one, and it restores the model nondeterminism the noise floor is
 * estimated from.
 *
 * ⚠ It IS a deviation from the production prompt, and the report says so.
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { prepareTurn, type GraphProvider, type RetrievedChunk } from '@edc/chat-engine/core'

import { loadCorpus, loadUnpublishedSims, type CorpusDoc } from './corpus'
import { selectJson } from './db'
import { CHAT_ENGINE_CONFIG, makeEvalAIClient, makeEvalAdapter, type EvalAIClient } from './engine'
import { EVAL_ORGANIZATION_ID, EVAL_PUBLISHED_CORPUS, loadEvalEnv, type EvalEnv } from './env'
import { expandGraphQuery, graphContextParagraph, readGraphRetrieval } from './graph'
import { withQueryExpansion, type ExpansionTrace } from '../../../web/src/lib/server/engine/expand'
import { chatRetrievalPolicy } from '../../../web/src/lib/server/engine/rerank'
import { buildQuestions, type EvalQuestion } from './questions'
import {
  orderedSources,
  retrievedDocumentIds,
  scoreWithSources,
  type Provenance,
  type QuestionScore,
  type Source,
} from './score'

export type Arm = 'novector' | 'plain' | 'graph'

export interface ArmResult {
  arm: 'plain' | 'graph'
  /** 1-based repetition. Several samples per arm, so noise can be told from effect. */
  rep: number
  answer: string
  /** Characters in the assembled user turn — the prompt tax the graph adds. */
  promptChars: number
  /** ai-service served this from its five-minute router cache. Should be false. */
  cached: boolean
  prepareMs: number
  generateMs: number
  totalMs: number
  retrieveCalls: number
  retrieveMs: number
  /** Retrieves whose `legs` included `rerank` — the cross-encoder really ran. */
  rerankedRetrieves?: number
  graphMs: number
  graphSeeds: string[]
  graphBlockChars: number
  graphChunks: number
  fusedChunks: number
  fusedFromGraph: number
  costUsd: number
  traceId: string
  inputTokens: number | null
  outputTokens: number | null
  /** Server-side generation time from ai-service's own `traces` row. */
  serverMs: number | null
  /**
   * The prompt's sources IN PROMPT ORDER — `sources[i].n` is the `[n]` the
   * model saw. Stored so a run can be re-scored (`scoreWithSources`) without
   * paying for it again. Runs before 2026-10-16 lack it.
   */
  sources?: Source[]
  /** The query expansion this arm ran (`--expand` only). */
  expansion?: Omit<ExpansionTrace, 'query'>
  score: QuestionScore
}

export interface QuestionResult {
  id: string
  klass: 'local' | 'global'
  text: string
  expected: string[]
  support: Record<string, number>
  targetDocumentId: number | null
  arms: ArmResult[]
}

/** `GRAPH_EXPANSION_TOPK` / `GRAPH_TIMEOUT_MS` — `apps/web/src/lib/server/graph.ts`. */
const GRAPH_EXPANSION_TOPK = 5
const GRAPH_TIMEOUT_MS = 4000
const GRAPH_PATH_TAG = 'graph'
const GRAPH_RETRIEVE_LIMIT = 8

async function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface GraphTrace {
  ms: number
  seeds: string[]
  blockChars: number
  chunks: number
}

/**
 * `makeGraphProvider` from `apps/web/src/lib/server/graph.ts`, with the backend
 * call made in-process instead of over the HTTP endpoint that 500s. Same four
 * steps, same order, same deadline, same `metadata.path` tag.
 */
function makeEvalGraphProvider(
  env: EvalEnv,
  aiClient: EvalAIClient,
  trace: GraphTrace,
): GraphProvider {
  return async (condensedQuery: string) => {
    const query = (condensedQuery ?? '').trim()
    if (!query) return null
    const started = Date.now()

    const retrieval = await withDeadline(
      readGraphRetrieval(env, {
        organizationId: EVAL_ORGANIZATION_ID,
        query,
        limit: GRAPH_RETRIEVE_LIMIT,
      }).catch(() => null),
      GRAPH_TIMEOUT_MS,
      null,
    )
    if (!retrieval || retrieval.entities.length === 0) {
      trace.ms = Date.now() - started
      return null
    }
    trace.seeds = retrieval.entities.map((e) => `${e.label} (${e.type}, ${e.support})`)

    const context = graphContextParagraph(retrieval)
    trace.blockChars = context.length

    let chunks: RetrievedChunk[] = []
    const expanded = expandGraphQuery(query, retrieval.terms)
    const remaining = GRAPH_TIMEOUT_MS - (Date.now() - started)
    if (expanded !== query && remaining > 0) {
      const result = await withDeadline(
        aiClient
          .retrieve({
            orgId: env.orgKey,
            scopeId: 'eval',
            corpus: EVAL_PUBLISHED_CORPUS,
            query: expanded,
            topK: GRAPH_EXPANSION_TOPK,
          })
          .catch(() => null),
        remaining,
        null,
      )
      chunks = (result?.matches ?? []).map((m) => ({
        documentId: m.documentId,
        chunkId: m.chunkId,
        score: m.score,
        text: m.text,
        corpus: EVAL_PUBLISHED_CORPUS,
        metadata: { ...(m.metadata ?? {}), path: GRAPH_PATH_TAG },
      }))
    }
    trace.chunks = chunks.length
    trace.ms = Date.now() - started

    if (!context && chunks.length === 0) return null
    return { ...(chunks.length > 0 ? { chunks } : {}), ...(context ? { context } : {}) }
  }
}

// ── The fake client, for the dry run ───────────────────────────────────────

/**
 * A deterministic stand-in for ai-service.
 *
 * ⚠ Its `generateSync` ECHOES the context blocks it was handed. That is on
 * purpose: with a fake that answers a constant, every scoring path would report
 * zero and a broken retrieve would look exactly like a working one. Echoing
 * makes the dry run exercise recall, citation precision and the graph block for
 * real — the numbers are meaningless, the CODE PATHS are all covered.
 */
function makeFakeAIClient(real: EvalAIClient): EvalAIClient {
  return {
    calls: real.calls,
    reset: () => real.reset(),
    retrieve: (req) => real.retrieve(req),
    async ingest() {
      return { ingested: 0, documentIds: [] }
    },
    async generateSync(req) {
      const user = req.messages[req.messages.length - 1]?.content ?? ''
      real.calls.push({ kind: 'generate', ms: 1, traceId: 'fake', costUsd: 0 })
      return {
        text: `[FAKE]\n${user.slice(0, 6000)}`,
        modelUsed: 'fake',
        provider: 'fake',
        costUsd: 0,
        traceId: 'fake',
      }
    },
  }
}

// ── One arm ────────────────────────────────────────────────────────────────

/**
 * The one line appended to the system prompt. See the module header — without
 * it the router cache serves arm B arm A's answer at zero cost and zero time.
 */
function runMarker(runId: string, questionId: string, arm: string, rep: number): string {
  return `\n\n(Ejecución de evaluación ${runId}-${questionId}-${arm}-${rep}.)`
}

async function runArm(args: {
  env: EvalEnv
  question: EvalQuestion
  arm: 'plain' | 'graph'
  rep: number
  asOf: string
  organizationName: string
  organizationDescription: string | null
  fake: boolean
  expand: boolean
  rerank: boolean
  runId: string
  docs: readonly CorpusDoc[]
}): Promise<ArmResult> {
  const { env, question, arm } = args
  const unitKey = `eval:${args.runId}:${question.id}:${arm}:${args.rep}`
  const config = {
    ...CHAT_ENGINE_CONFIG,
    systemPrompt:
      CHAT_ENGINE_CONFIG.systemPrompt +
      runMarker(args.runId, question.id, arm, args.rep),
  }
  const real = makeEvalAIClient({
    env,
    organizationId: EVAL_ORGANIZATION_ID,
    asOf: args.asOf,
    allowedCorpora: [EVAL_PUBLISHED_CORPUS],
    unitKeyFor: () => unitKey,
  })
  const aiClient = args.fake ? makeFakeAIClient(real) : real

  const adapter = makeEvalAdapter({
    organizationName: args.organizationName,
    organizationDescription: args.organizationDescription,
    corpora: [EVAL_PUBLISHED_CORPUS],
  })

  const trace: GraphTrace = { ms: 0, seeds: [], blockChars: 0, chunks: 0 }
  const graphProvider = arm === 'graph' ? makeEvalGraphProvider(env, aiClient, trace) : undefined

  // `--expand`: the engine's retrieve searches the rewordings too. The graph
  // provider above and the generate below keep the plain client, as in
  // `apps/web/src/routes/api/generate/+server.ts`.
  let expansion: ArmResult['expansion']
  const turnClient = args.expand
    ? withQueryExpansion(aiClient, {
        surface: config.surface,
        orgId: env.orgKey,
        scopeId: `eval-${question.id}`,
        userId: 'eval',
        onExpansion: ({ variants, ms, costUsd }) => {
          expansion = { variants, ms, costUsd }
        },
      })
    : aiClient

  const policy = chatRetrievalPolicy(args.rerank)
  const t0 = Date.now()
  const prepared = await prepareTurn({
    config,
    aiClient: turnClient,
    adapter,
    orgId: env.orgKey,
    userId: 'eval',
    scopeId: `eval-${question.id}`,
    threadId: `eval-${question.id}-${arm}`,
    scope: { refs: [{ kind: 'org' }] },
    history: [],
    userMessage: question.text,
    inlineRefs: [],
    includePassageText: 1200,
    ...(graphProvider ? { graphProvider } : {}),
    // The production policy; `--no-rerank` → none (see the module header).
    ...(policy ? { retrievalPolicy: policy } : {}),
  })
  const prepareMs = Date.now() - t0

  const t1 = Date.now()
  const generation = await aiClient.generateSync({
    surface: config.surface,
    orgId: env.orgKey,
    scopeId: `eval-${question.id}`,
    userId: 'eval',
    messages: prepared.messages,
    effort: config.chatEffort,
    maxTokens: config.chatMaxTokens,
  })
  const generateMs = Date.now() - t1

  const retrieves = aiClient.calls.filter((c) => c.kind === 'retrieve')
  const sources = orderedSources(prepared.provenance as Provenance | null)
  const fusedFromGraph = prepared.matches.filter(
    (m) => (m.metadata as Record<string, unknown> | null | undefined)?.path === GRAPH_PATH_TAG,
  ).length

  return {
    arm,
    rep: args.rep,
    answer: generation.text,
    promptChars: prepared.messages[prepared.messages.length - 1].content.length,
    cached: false,
    prepareMs,
    generateMs,
    totalMs: prepareMs + generateMs,
    retrieveCalls: retrieves.length,
    retrieveMs: retrieves.reduce((a, c) => a + c.ms, 0),
    rerankedRetrieves: retrieves.filter((c) => c.legs?.includes('rerank')).length,
    graphMs: trace.ms,
    graphSeeds: trace.seeds,
    graphBlockChars: prepared.graphContext.length,
    graphChunks: trace.chunks,
    fusedChunks: prepared.matches.length,
    fusedFromGraph,
    costUsd: generation.costUsd,
    traceId: generation.traceId,
    inputTokens: null,
    outputTokens: null,
    serverMs: null,
    sources,
    ...(expansion ? { expansion } : {}),
    score: scoreWithSources(question, generation.text, sources, args.docs),
  }
}

// ── Token backfill ─────────────────────────────────────────────────────────

/**
 * `POST /v1/generate/sync` returns `costUsd` and `traceId` and NOTHING ELSE
 * about spend — no token counts, no duration. ai-service keeps both in its own
 * `traces` table (`edc_ai`), so the harness reads them back afterwards.
 *
 * 🔴 IT JOINS ON `metadata->>'unitKey'`, NOT ON `traceId`. The id the response
 * returns is NOT `traces.id` — the router mints its own and files the returned
 * one inside `metadata`. Joining on the obvious column silently matches nothing
 * and every token count comes back null. `unitKey` is unique per call here by
 * construction (`eval:<run>:<question>:<arm>:<rep>`), which is why each call
 * gets its own rather than reusing the session id the way production does.
 */
async function backfillTokens(env: EvalEnv, results: QuestionResult[]): Promise<void> {
  const rows = await selectJson<{
    unit_key: string
    input_tokens: number | null
    output_tokens: number | null
    duration_ms: number | null
    cached: boolean | null
  }>(
    env,
    env.aiDb,
    `SELECT metadata->>'unitKey' AS unit_key,
            (token_usage->>'inputTokens')::int  AS input_tokens,
            (token_usage->>'outputTokens')::int AS output_tokens,
            duration_ms,
            (metadata->>'cached')::boolean AS cached
       FROM traces
      WHERE metadata->>'unitKey' LIKE 'eval:${runId}:%'`,
  )
  const byKey = new Map(rows.map((r) => [r.unit_key, r]))
  for (const result of results) {
    for (const arm of result.arms) {
      const row = byKey.get(`eval:${runId}:${result.id}:${arm.arm}:${arm.rep}`)
      if (!row) continue
      arm.inputTokens = row.input_tokens
      arm.outputTokens = row.output_tokens
      arm.serverMs = row.duration_ms
      arm.cached = row.cached === true
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const fake = process.argv.includes('--fake')
const expand = process.argv.includes('--expand')
const rerank = !process.argv.includes('--no-rerank')
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)
/**
 * Samples per arm per question.
 *
 * ⚠ THREE, NOT ONE, AND THAT IS THE POINT OF THE WHOLE BUDGET. A single sample
 * per arm cannot tell a one-fact difference from the model changing its mind.
 * The pre-flight showed a chat turn costs ~$0.0008 and ~7 s, so three
 * repetitions is 120 calls, roughly $0.10 and well inside the approved budget
 * of "~30 min, under $1" — and it buys the only thing that makes a 20-question
 * comparison readable at all: a noise floor measured on the same instrument.
 */
const reps = Number(process.argv.find((a) => a.startsWith('--reps='))?.slice('--reps='.length) ?? 3)

const env = loadEvalEnv()
const runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)

// 🔴 ONE `asOf` for the whole run, taken once. Both arms of every question are
// scoped to the same instant, so a document published mid-run cannot appear in
// one arm and not the other.
const asOf = new Date().toISOString()

const [org] = await selectJson<{ name: string; description: string | null }>(
  env,
  env.backendDb,
  `SELECT name, description FROM organizations WHERE id = ${EVAL_ORGANIZATION_ID}`,
)
if (!org) throw new Error(`[eval] organization ${EVAL_ORGANIZATION_ID} not found`)

const docs = await loadCorpus(env)
const { questions, droppedGlobalFacts, skippedLocal } = buildQuestions(docs, {
  unpublishedSims: await loadUnpublishedSims(env),
  warn: (m) => console.error(m),
})
const selected = only ? questions.filter((q) => only.split(',').includes(q.id)) : questions

console.error(
  `[eval] ${docs.length} published corpus documents joined; ` +
    `${selected.length} questions; fake=${fake}; expand=${expand}; rerank=${rerank}; asOf=${asOf}`,
)
for (const d of droppedGlobalFacts) {
  console.error(`[eval] dropped ${d.question} "${d.label}" — support ${d.support} < 3`)
}

// 🔴 PROVE RETRIEVAL WORKS BEFORE SPENDING ANYTHING. An unauthorised corpus name
// or a missing `asOf` both yield zero chunks with no error anywhere, and 40
// paid calls would then measure the empty set.
{
  const probe = makeEvalAIClient({
    env,
    organizationId: EVAL_ORGANIZATION_ID,
    asOf,
    allowedCorpora: [EVAL_PUBLISHED_CORPUS],
    unitKeyFor: () => 'eval:probe',
  })
  const res = await probe.retrieve({
    orgId: env.orgKey,
    scopeId: 'eval',
    corpus: EVAL_PUBLISHED_CORPUS,
    query: 'traducción en salud',
    topK: 3,
  })
  if (res.matches.length === 0) {
    throw new Error(
      `[eval] the retrieval probe returned zero chunks from ${EVAL_PUBLISHED_CORPUS}. ` +
        'Refusing to run: every answer would be ungrounded and the measurement void.',
    )
  }
  console.error(`[eval] retrieval probe OK — ${res.matches.length} chunks`)
}

const results: QuestionResult[] = []
for (const question of selected) {
  const arms: ArmResult[] = []
  // Interleaved per repetition, not all of one arm then all of the other: the
  // service is shared and the model is nondeterministic, so separating the arms
  // in time would let drift in the deployment masquerade as an effect.
  for (let rep = 1; rep <= reps; rep += 1) {
    for (const arm of ['plain', 'graph'] as const) {
      const started = Date.now()
      const result = await runArm({
        env,
        question,
        arm,
        rep,
        asOf,
        organizationName: org.name,
        organizationDescription: org.description,
        fake,
        expand,
        rerank,
        runId,
        docs,
      })
      arms.push(result)
      console.error(
        `[eval] ${question.id} r${rep} ${arm.padEnd(5)} ` +
          `${String(Date.now() - started).padStart(6)}ms ` +
          `recall=${result.score.found.length}/${question.expected.length} ` +
          `retrieved=${result.score.retrievedDocumentIds.length} ` +
          `cited=${result.score.citedDocumentIds.length} ` +
          `graphBlock=${result.graphBlockChars} graphChunks=${result.graphChunks}`,
      )
    }
  }
  results.push({
    id: question.id,
    klass: question.klass,
    text: question.text,
    expected: question.expected.map((f) => f.label),
    support: question.support,
    targetDocumentId: question.targetDocumentId,
    arms,
  })
}

if (!fake) await backfillTokens(env, results)

const out = {
  runId,
  fake,
  queryExpansion: expand,
  rerank,
  asOf,
  organization: { id: EVAL_ORGANIZATION_ID, name: org.name },
  corpusDocuments: docs.length,
  graphMinSupport: env.graphMinSupport,
  droppedGlobalFacts,
  /** Local questions whose target is a draft on this stack — not scored. */
  skippedLocal,
  results,
}
const target = path.join(import.meta.dirname, fake ? 'results.fake.json' : 'results.json')
writeFileSync(target, JSON.stringify(out, null, 2))
console.error(`[eval] wrote ${target}`)

// Keep the runner honest about what it actually spent.
const spend = results.flatMap((r) => r.arms).reduce((a, x) => a + x.costUsd, 0)
const expansionSpend = results
  .flatMap((r) => r.arms)
  .reduce((a, x) => a + (x.expansion?.costUsd ?? 0), 0)
const calls = results.flatMap((r) => r.arms).length
const cachedCalls = results.flatMap((r) => r.arms).filter((a) => a.cached).length
console.error(`[eval] total generation cost: $${spend.toFixed(4)} over ${calls} calls`)
if (expand) console.error(`[eval] query expansion cost: $${expansionSpend.toFixed(4)}`)
if (cachedCalls > 0) {
  console.error(
    `[eval] 🔴 ${cachedCalls} of ${calls} calls were served from ai-service's router ` +
      'cache. Their latency and cost are not real. See the run marker in the module header.',
  )
}

export { retrievedDocumentIds }
