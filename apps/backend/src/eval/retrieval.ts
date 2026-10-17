/**
 * Retrieval-only comparison: dense vs hybrid, with and without rerank (audit
 * C-4). No answer generation, so a run costs only the query embeddings (and
 * the reranker, when a stack has it).
 *
 *   cd apps/backend && npx payload run src/eval/retrieval.ts
 *   EVAL_REPO_ROOT=/path/to/checkout-with-infra-env npx payload run src/eval/retrieval.ts
 *   … --expand    also run `dense+expansion` on the harness questions (one
 *                 `quick` model call per question: the only paid generation)
 *   … --topk=10   per-corpus depth (default 5, what chat sends)
 *
 * Writes `src/eval/retrieval-results.json` and prints the table.
 *
 * ── THE ARMS SEND WHAT CHAT SENDS ───────────────────────────────────────────
 *
 * The eval ecosistema has no drafts, so each arm is the request
 * `apps/web/src/lib/server/engine/aiClient.ts` sends for the PUBLISHED corpus:
 *
 *   · dense          `POST /v1/retrieve`        { corpus, query, topK, asOf }
 *   · dense+rerank   the same + `rerank: true` (`retrieveScoped`)
 *   · hybrid         `POST /v1/retrieve/multi`  { corpora: [corpus], query,
 *                    topK, limit: 8, mode: 'hybrid', asOf } (`retrieveMultiScoped`)
 *   · hybrid+rerank  the same + `rerank: true`: ONE rerank after fusion, over
 *                    the fused list only (topK chunks for one corpus)
 *   · dense+expansion (`--expand`) the dense arm through apps/web's
 *                    `withQueryExpansion`, as chat's dense path runs it today.
 *                    The hybrid path does not expand.
 *
 * 🔴 A rerank arm runs only when a probe shows the cross-encoder really ran
 * (`legs` includes `rerank`). ai-service no-ops `rerank: true` when the server
 * has it off, and a silent no-op would report the plain ranking as "rerank".
 *
 * ── THE LABELS ───────────────────────────────────────────────────────────────
 *
 *   · `harness` — the 20 questions of `questions.ts`, the same labels `run.ts`
 *     scores. Local (one target document): MRR = 1 / rank of the first chunk
 *     from the target; recall@k = the target is in the top k. Global: recall@k
 *     = share of expected facts named in the top-k chunks' TEXT; MRR = 1 / rank
 *     of the first chunk naming any expected fact.
 *   · `local-all` — the same local template for EVERY published document whose
 *     manifest name is unique and appears in its own text (testimonios are
 *     redacted, so they mostly drop out). Single-document MRR and recall@k.
 *
 * Read-only: SELECTs through `db.ts`, retrieves against ai-service.
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { withQueryExpansion } from '../../../web/src/lib/server/engine/expand'
import { loadCorpus, loadUnpublishedSims, type CorpusDoc } from './corpus'
import { makeEvalAIClient } from './engine'
import { EVAL_ORGANIZATION_ID, EVAL_PUBLISHED_CORPUS, loadEvalEnv } from './env'
import { buildQuestions, type EvalQuestion } from './questions'
import { containsAny } from './text'

type ArmName = 'dense' | 'dense+rerank' | 'hybrid' | 'hybrid+rerank' | 'dense+expansion'

interface Chunk {
  text: string
  metadata?: Record<string, unknown>
}

interface Label {
  set: 'harness' | 'local-all'
  id: string
  klass: 'local' | 'global'
  text: string
  targetDocumentId: number | null
  expected: EvalQuestion['expected']
}

const topK = Number(process.argv.find((a) => a.startsWith('--topk='))?.slice('--topk='.length) ?? 5)
const expand = process.argv.includes('--expand')
/** `DEFAULT_MERGED_CAP` — the `limit` chat's hybrid policy sends. */
const LIMIT = 8

const env = loadEvalEnv(process.env.EVAL_REPO_ROOT || undefined)
const asOf = new Date().toISOString()
const headers = {
  authorization: `Bearer ${env.aiServiceApiKey}`,
  'x-ai-org': `eco-${EVAL_ORGANIZATION_ID}`,
  accept: 'application/json',
  'content-type': 'application/json',
}

/**
 * ai-service allows 100 requests a minute per key (`lib/aiRetry.ts`). Space
 * the calls under that and wait out a 429 with the server's `retryAfterMs`.
 * The latency column times the successful request only.
 */
const SPACING_MS = 700
let lastCall = 0
/** Wall time of the last successful request, excluding spacing and 429 waits. */
let lastRequestMs = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function post(route: string, body: Record<string, unknown>): Promise<{
  chunks: Chunk[]
  legs?: string[]
}> {
  for (let attempt = 1; ; attempt += 1) {
    const wait = lastCall + SPACING_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()
    const t0 = Date.now()
    const res = await fetch(`${env.aiServiceUrl}${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (res.status === 429 && attempt < 10) {
      const info = (await res.json().catch(() => ({}))) as { retryAfterMs?: number }
      await sleep((info.retryAfterMs ?? 10_000) + 250)
      continue
    }
    if (!res.ok) throw new Error(`${route} answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const parsed = (await res.json()) as { chunks: Chunk[]; legs?: string[] }
    lastRequestMs = Date.now() - t0
    return parsed
  }
}

const dense = (query: string, rerank = false) =>
  post('/v1/retrieve', {
    corpus: EVAL_PUBLISHED_CORPUS,
    query,
    topK,
    asOf,
    ...(rerank ? { rerank: true } : {}),
  })

const hybrid = (query: string, rerank = false) =>
  post('/v1/retrieve/multi', {
    corpora: [EVAL_PUBLISHED_CORPUS],
    query,
    topK,
    limit: LIMIT,
    mode: 'hybrid',
    asOf,
    ...(rerank ? { rerank: true } : {}),
  })

const expansionClient = makeEvalAIClient({
  env,
  organizationId: EVAL_ORGANIZATION_ID,
  asOf,
  allowedCorpora: [EVAL_PUBLISHED_CORPUS],
  unitKeyFor: () => 'eval:retrieval:expansion',
})
let expansionCostUsd = 0
const expanded = withQueryExpansion(expansionClient, {
  surface: 'chat',
  orgId: env.orgKey,
  scopeId: 'eval-retrieval',
  userId: 'eval',
  onExpansion: (t) => {
    expansionCostUsd += t.costUsd ?? 0
  },
})

async function runArm(arm: ArmName, query: string): Promise<Chunk[]> {
  switch (arm) {
    case 'dense':
      return (await dense(query)).chunks
    case 'dense+rerank':
      return (await dense(query, true)).chunks
    case 'hybrid':
      return (await hybrid(query)).chunks
    case 'hybrid+rerank':
      return (await hybrid(query, true)).chunks
    case 'dense+expansion': {
      // One model call + four retrieves through the eval client, which has no
      // 429 retry: leave the rate limit room first.
      await sleep(5_000)
      const t0 = Date.now()
      const before = expansionClient.calls.length
      const r = await expanded.retrieve({
        orgId: env.orgKey,
        scopeId: 'eval-retrieval',
        corpus: EVAL_PUBLISHED_CORPUS,
        query,
        topK,
      })
      lastRequestMs = Date.now() - t0
      const empty = expansionClient.calls.slice(before).filter((c) => c.kind === 'retrieve' && c.chunks === 0)
      if (empty.length > 0) console.error(`[eval] ⚠ ${empty.length} expansion retrieves came back empty`)
      return r.matches
    }
  }
}

const docIdOf = (c: Chunk): number | null => {
  const v = c.metadata?.docId
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

interface Score {
  rr: number
  /** recall at 1, 3, 5 and topK (k capped by what came back). */
  recall: Record<number, number>
}

const KS = [...new Set([1, 3, 5, topK])].sort((a, b) => a - b)

function score(label: Label, chunks: Chunk[]): Score {
  const recall: Record<number, number> = {}
  if (label.klass === 'local') {
    const rank = chunks.findIndex((c) => docIdOf(c) === label.targetDocumentId) + 1
    for (const k of KS) recall[k] = rank > 0 && rank <= k ? 1 : 0
    return { rr: rank > 0 ? 1 / rank : 0, recall }
  }
  const named = (c: Chunk) => label.expected.some((f) => containsAny(c.text, f.aliases))
  const rank = chunks.findIndex(named) + 1
  for (const k of KS) {
    const head = chunks.slice(0, k)
    const found = label.expected.filter((f) => head.some((c) => containsAny(c.text, f.aliases)))
    recall[k] = label.expected.length > 0 ? found.length / label.expected.length : 0
  }
  return { rr: rank > 0 ? 1 / rank : 0, recall }
}

function localAllLabels(docs: readonly CorpusDoc[]): Label[] {
  const nameCount = new Map<string, number>()
  for (const d of docs) nameCount.set(d.manifest.nombre, (nameCount.get(d.manifest.nombre) ?? 0) + 1)
  return docs
    .filter((d) => d.manifest.nombre && nameCount.get(d.manifest.nombre) === 1)
    .filter((d) => containsAny(d.text, [d.manifest.nombre]))
    .map((d) => ({
      set: 'local-all' as const,
      id: d.sim,
      klass: 'local' as const,
      text:
        `Según los documentos publicados, ¿qué lengua habla ${d.manifest.nombre}, de qué ` +
        'comunidad viene y en qué lugar colabora?',
      targetDocumentId: d.documentId,
      expected: [],
    }))
}

// ── Main ───────────────────────────────────────────────────────────────────

const docs = await loadCorpus(env)
const { questions } = buildQuestions(docs, {
  unpublishedSims: await loadUnpublishedSims(env),
  warn: (m) => console.error(m),
})
const harness: Label[] = questions.map((q) => ({
  set: 'harness',
  id: q.id,
  klass: q.klass,
  text: q.text,
  targetDocumentId: q.targetDocumentId,
  expected: q.expected,
}))
const localAll = localAllLabels(docs)

// Probe: does this stack really rerank? `legs` names `rerank` only if it ran.
const probe = await dense('traducción en salud', true)
if (probe.chunks.length === 0) {
  throw new Error(`[eval] the probe returned zero chunks from ${EVAL_PUBLISHED_CORPUS}; refusing to run.`)
}
const rerankRuns = (probe.legs ?? []).includes('rerank')
const arms: ArmName[] = ['dense', 'hybrid']
if (rerankRuns) arms.push('dense+rerank', 'hybrid+rerank')
const skippedArms = rerankRuns ? [] : ['dense+rerank', 'hybrid+rerank']
console.error(
  `[eval] ${docs.length} published docs; harness ${harness.length} labels, local-all ${localAll.length}; ` +
    `topK=${topK}; asOf=${asOf}; probe legs=${JSON.stringify(probe.legs)}; ` +
    (rerankRuns ? 'rerank arms ON' : '🔴 rerank does NOT run on this stack: rerank arms skipped'),
)

interface Row {
  set: Label['set']
  id: string
  klass: Label['klass']
  arm: ArmName
  ms: number
  rr: number
  recall: Record<number, number>
  docIds: (number | null)[]
}
const rows: Row[] = []
const started = Date.now()
for (const label of [...harness, ...localAll]) {
  // Interleaved per label, so drift in a shared service hits every arm alike.
  const labelArms: ArmName[] =
    expand && label.set === 'harness' ? [...arms, 'dense+expansion'] : arms
  for (const arm of labelArms) {
    const chunks = await runArm(arm, label.text)
    const s = score(label, chunks)
    rows.push({
      set: label.set,
      id: label.id,
      klass: label.klass,
      arm,
      ms: lastRequestMs,
      rr: s.rr,
      recall: s.recall,
      docIds: chunks.map(docIdOf),
    })
  }
  if (rows.length % 40 < labelArms.length) {
    console.error(`[eval] ${rows.length} retrieves, ${Math.round((Date.now() - started) / 1000)} s`)
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)]! : NaN
}
const groups: Array<{ set: string; klass: string }> = [
  { set: 'harness', klass: 'local' },
  { set: 'harness', klass: 'global' },
  { set: 'local-all', klass: 'local' },
]
const table: string[] = [
  `| labels | n | arm | MRR@${topK} | ${KS.map((k) => `recall@${k}`).join(' | ')} | median ms |`,
  `| --- | --- | --- | --- | ${KS.map(() => '---').join(' | ')} | --- |`,
]
const summary: Record<string, unknown>[] = []
for (const g of groups) {
  for (const arm of [...arms, ...(expand && g.set === 'harness' ? (['dense+expansion'] as const) : [])]) {
    const rs = rows.filter((r) => r.set === g.set && r.klass === g.klass && r.arm === arm)
    if (rs.length === 0) continue
    const mrr = mean(rs.map((r) => r.rr))
    const rec = KS.map((k) => mean(rs.map((r) => r.recall[k] ?? 0)))
    const ms = median(rs.map((r) => r.ms))
    summary.push({ ...g, arm, n: rs.length, mrr, recall: Object.fromEntries(KS.map((k, i) => [k, rec[i]])), medianMs: ms })
    table.push(
      `| ${g.set} ${g.klass} | ${rs.length} | ${arm} | ${mrr.toFixed(3)} | ${rec.map((x) => x.toFixed(3)).join(' | ')} | ${ms} |`,
    )
  }
}

const out = {
  measuredAt: new Date().toISOString(),
  aiServiceUrl: env.aiServiceUrl,
  corpus: EVAL_PUBLISHED_CORPUS,
  asOf,
  topK,
  limit: LIMIT,
  rerankRuns,
  skippedArms,
  probeLegs: probe.legs ?? null,
  expansionCostUsd,
  wallMs: Date.now() - started,
  summary,
  rows,
}
const target = path.join(import.meta.dirname, `retrieval-results.topk${topK}.json`)
writeFileSync(target, JSON.stringify(out, null, 2))
console.log(table.join('\n'))
console.error(`[eval] wrote ${target}; wall ${out.wallMs} ms; expansion $${expansionCostUsd.toFixed(4)}`)
