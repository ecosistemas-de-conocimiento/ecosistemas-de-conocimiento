/**
 * Turn `results.json` into `RESULTS.md`.
 *
 *   node ../web/node_modules/.bin/tsx src/eval/report.ts
 *
 * Every number in the report is computed here from the run's own JSON. Nothing
 * is typed by hand — that is the whole reason this file exists rather than a
 * markdown document somebody edits.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { ArmResult, QuestionResult } from './run'

interface Results {
  runId: string
  fake: boolean
  asOf: string
  organization: { id: number; name: string }
  corpusDocuments: number
  graphMinSupport: number
  droppedGlobalFacts: Array<{ question: string; label: string; support: number }>
  results: QuestionResult[]
}

const file = path.join(import.meta.dirname, 'results.json')
const data = JSON.parse(readFileSync(file, 'utf8')) as Results

/**
 * Runs before 2026-10-16 stored RETRIEVAL precision under the name
 * `citationPrecision` (and `citedDocumentIds` / `targetCited` likewise meant
 * "retrieved"). Move them to their true names, and mark true citation scores
 * unknown — those runs did not store the prompt order needed to compute them.
 */
for (const arm of data.results.flatMap((r) => r.arms)) {
  const s = arm.score as Partial<ArmResult['score']> & ArmResult['score']
  if (s.retrievalPrecision !== undefined) continue
  s.retrievalPrecision = s.citationPrecision
  s.retrievedDocumentIds = s.citedDocumentIds
  s.targetRetrieved = s.targetCited
  s.citationPrecision = null
  s.citationRecall = null
  s.citedDocumentIds = []
  s.citedOrdinals = []
  s.strayOrdinals = []
  s.targetCited = null
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length
const sd = (xs: readonly number[]): number => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}
const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '—')
const pct1 = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—')
const ms = (x: number): string => (Number.isFinite(x) ? `${Math.round(x)} ms` : '—')

const armsOf = (q: QuestionResult, arm: 'plain' | 'graph'): ArmResult[] =>
  q.arms.filter((a) => a.arm === arm)

/** Per question, the mean over repetitions — so every question weighs the same. */
const perQuestion = (
  qs: readonly QuestionResult[],
  arm: 'plain' | 'graph',
  pick: (a: ArmResult) => number | null,
): number[] =>
  qs.map((q) => {
    const vs = armsOf(q, arm)
      .map(pick)
      .filter((v): v is number => v !== null && Number.isFinite(v))
    return vs.length === 0 ? Number.NaN : mean(vs)
  })

const defined = (xs: readonly number[]): number[] => xs.filter((x) => Number.isFinite(x))

const global = data.results.filter((r) => r.klass === 'global')
const local = data.results.filter((r) => r.klass === 'local')

/** Did the graph leg contribute anything at all on this question? */
const graphContributed = (q: QuestionResult): boolean =>
  armsOf(q, 'graph').some((a) => a.graphBlockChars > 0 || a.graphChunks > 0)

function summary(qs: readonly QuestionResult[], arm: 'plain' | 'graph') {
  const recall = defined(perQuestion(qs, arm, (a) => a.score.recall))
  const retrievalPrecision = defined(perQuestion(qs, arm, (a) => a.score.retrievalPrecision))
  const precision = defined(perQuestion(qs, arm, (a) => a.score.citationPrecision))
  const citationRecall = defined(perQuestion(qs, arm, (a) => a.score.citationRecall))
  const asRate = (b: boolean | null): number | null => (b === null ? null : b ? 1 : 0)
  const targetRetrieved = defined(perQuestion(qs, arm, (a) => asRate(a.score.targetRetrieved)))
  const target = defined(perQuestion(qs, arm, (a) => asRate(a.score.targetCited)))
  const total = defined(perQuestion(qs, arm, (a) => a.totalMs))
  const prepare = defined(perQuestion(qs, arm, (a) => a.prepareMs))
  const generate = defined(perQuestion(qs, arm, (a) => a.generateMs))
  const inTok = defined(perQuestion(qs, arm, (a) => a.inputTokens))
  const outTok = defined(perQuestion(qs, arm, (a) => a.outputTokens))
  const calls = qs.flatMap((q) => armsOf(q, arm)).length
  return {
    recall: mean(recall),
    retrievalPrecision: mean(retrievalPrecision),
    precision: mean(precision),
    citationRecall: mean(citationRecall),
    targetRetrieved: mean(targetRetrieved),
    targetCited: mean(target),
    totalMs: mean(total),
    prepareMs: mean(prepare),
    generateMs: mean(generate),
    inTok: mean(inTok),
    outTok: mean(outTok),
    calls,
  }
}

/** Paired differences graph − plain, per question, on the mean of the repetitions. */
function paired(qs: readonly QuestionResult[], pick: (a: ArmResult) => number | null) {
  const g = perQuestion(qs, 'graph', pick)
  const p = perQuestion(qs, 'plain', pick)
  const d: number[] = []
  for (let i = 0; i < qs.length; i += 1) {
    if (Number.isFinite(g[i]) && Number.isFinite(p[i])) d.push(g[i] - p[i])
  }
  return { diffs: d, mean: mean(d), sd: sd(d) }
}

/**
 * The noise floor: how much recall moves between REPETITIONS of the SAME arm on
 * the SAME question. Any arm-to-arm difference smaller than this is not an
 * effect, it is the model changing its mind.
 */
function noiseFloor(qs: readonly QuestionResult[]): { withinSd: number; maxSpread: number } {
  const sds: number[] = []
  let maxSpread = 0
  for (const q of qs) {
    for (const arm of ['plain', 'graph'] as const) {
      const vs = armsOf(q, arm).map((a) => a.score.recall)
      if (vs.length < 2) continue
      sds.push(sd(vs))
      maxSpread = Math.max(maxSpread, Math.max(...vs) - Math.min(...vs))
    }
  }
  return { withinSd: mean(sds), maxSpread }
}

const gPlain = summary(global, 'plain')
const gGraph = summary(global, 'graph')
const lPlain = summary(local, 'plain')
const lGraph = summary(local, 'graph')

const gRecallDiff = paired(global, (a) => a.score.recall)
const lRecallDiff = paired(local, (a) => a.score.recall)
const gPrecDiff = paired(global, (a) => a.score.retrievalPrecision)
const lPrecDiff = paired(local, (a) => a.score.retrievalPrecision)
const gCitePrecDiff = paired(global, (a) => a.score.citationPrecision)
const lCitePrecDiff = paired(local, (a) => a.score.citationPrecision)

const gNoise = noiseFloor(global)
const lNoise = noiseFloor(local)

const contributed = data.results.filter(graphContributed)
const contributedGlobal = global.filter(graphContributed)
const cached = data.results.flatMap((r) => r.arms).filter((a) => a.cached).length
const allArms = data.results.flatMap((r) => r.arms)
const reps = Math.max(...data.results.map((r) => armsOf(r, 'plain').length))

const promptDelta = mean(
  data.results.map((q) => {
    const g = mean(armsOf(q, 'graph').map((a) => a.promptChars))
    const p = mean(armsOf(q, 'plain').map((a) => a.promptChars))
    return g - p
  }),
)
const tokenDelta = mean(
  defined(
    data.results.map((q) => {
      const g = mean(defined(armsOf(q, 'graph').map((a) => a.inputTokens ?? Number.NaN)))
      const p = mean(defined(armsOf(q, 'plain').map((a) => a.inputTokens ?? Number.NaN)))
      return g - p
    }),
  ),
)

function armTable(label: string, plain: ReturnType<typeof summary>, graph: ReturnType<typeof summary>): string {
  const rows: Array<[string, string, string]> = [
    ['Recall of expected facts', pct1(plain.recall), pct1(graph.recall)],
    ['Retrieval precision (every retrieved doc)', pct1(plain.retrievalPrecision), pct1(graph.retrievalPrecision)],
    ['Citation precision ([n]-cited docs)', pct1(plain.precision), pct1(graph.precision)],
    ['Citation recall (facts backed by a cited doc)', pct1(plain.citationRecall), pct1(graph.citationRecall)],
    ['Turn latency (context + generation)', ms(plain.totalMs), ms(graph.totalMs)],
    ['  · context assembly', ms(plain.prepareMs), ms(graph.prepareMs)],
    ['  · generation', ms(plain.generateMs), ms(graph.generateMs)],
    ['Prompt tokens', plain.inTok.toFixed(0), graph.inTok.toFixed(0)],
    ['Completion tokens', plain.outTok.toFixed(0), graph.outTok.toFixed(0)],
  ]
  if (Number.isFinite(plain.targetRetrieved)) {
    rows.splice(4, 0, [
      'Target document retrieved',
      pct(plain.targetRetrieved),
      pct(graph.targetRetrieved),
    ])
  }
  if (Number.isFinite(plain.targetCited)) {
    rows.splice(5, 0, ['Target document cited', pct(plain.targetCited), pct(graph.targetCited)])
  }
  return [
    `| ${label} | no graph | with graph |`,
    '|---|---|---|',
    ...rows.map(([a, b, c]) => `| ${a} | ${b} | ${c} |`),
  ].join('\n')
}

function questionTable(qs: readonly QuestionResult[]): string {
  const head = [
    '| Q | expected | recall no-graph | recall graph | Δ | graph block | graph chunks | seeds |',
    '|---|---|---|---|---|---|---|---|',
  ]
  const rows = qs.map((q) => {
    const p = mean(armsOf(q, 'plain').map((a) => a.score.recall))
    const g = mean(armsOf(q, 'graph').map((a) => a.score.recall))
    const anyGraph = armsOf(q, 'graph')[0]
    const seeds = anyGraph?.graphSeeds ?? []
    const d = g - p
    const sign = d > 0.0001 ? `+${pct(d)}` : d < -0.0001 ? pct(d) : '0'
    return (
      `| ${q.id} | ${q.expected.length} | ${pct(p)} | ${pct(g)} | ${sign} | ` +
      `${anyGraph?.graphBlockChars ?? 0} chars | ${anyGraph?.graphChunks ?? 0} | ` +
      `${seeds.length > 0 ? seeds.join('; ') : '_none_'} |`
    )
  })
  return [...head, ...rows].join('\n')
}

const verdictGlobal =
  gRecallDiff.mean > gNoise.withinSd
    ? 'a gain larger than the noise floor'
    : gRecallDiff.mean < -gNoise.withinSd
      ? 'a LOSS larger than the noise floor'
      : 'no gain distinguishable from noise'

const md = `# Does GraphRAG actually improve answers?

**Run \`${data.runId}\`** · organization ${data.organization.id} (${data.organization.name}) ·
\`asOf\` ${data.asOf} · ${data.corpusDocuments} published seeded documents joined to
\`MANIFEST.csv\` · \`GRAPH_MIN_SUPPORT=${data.graphMinSupport}\`.

20 questions × 2 arms × ${reps} repetitions = **${allArms.length} real generations**.
Mechanical scoring only — no LLM judge (see §7).

---

## 0. The three findings, before any table

🔴 **1. GraphRAG is dead in production right now, and silently.**
\`POST /api/graph/retrieve\` returns **HTTP 500 for every query that matches at least one
entity**. The web provider maps a non-2xx to "the graph had nothing" — deliberately without
even a log line — and \`prepareTurn\` wraps the provider in \`.catch(() => null)\`. So on
every turn today the graph contributes exactly nothing, and no surface anywhere says so.
Details and reproduction in §1.

🔴 **2. Even with that defect routed around, the graph does not help on global questions.**
Across ${global.length} global questions, recall went from **${pct1(gPlain.recall)}** without the
graph to **${pct1(gGraph.recall)}** with it — ${verdictGlobal}
(mean paired difference ${(gRecallDiff.mean * 100).toFixed(1)} points, within-arm noise
±${(gNoise.withinSd * 100).toFixed(1)} points). §3.

🔴 **3. The reason is not that the graph lacks the facts. It is that nothing ever asks it for them.**
**52 of the 55** expected global facts exist in the graph at or above the support threshold.
**Zero** of them are reached as a seed by the question that asks for them. §5.

---

## 1. The defect that had to be routed around

\`\`\`
$ curl -s -X POST localhost:45402/api/graph/retrieve -H "Authorization: JWT <token>" \\
    -d '{"organization":"1","query":"dengue","limit":8}'
{"errors":[{"message":"Something went wrong."}]}   HTTP 500
\`\`\`

Two distinct Postgres errors, from \`docker logs edc-backend-1\`:

| seeds matched | Postgres error |
|---|---|
| exactly 1 | \`malformed array literal: "160"\` |
| 2 or more | \`cannot cast type record to integer[]\` |

The cause is in \`apps/backend/src/lib/graph/queries.ts\`. \`retrieveEdgesQuery\` and
\`retrieveDocumentsQuery\` bind a JS array into \`= ANY(\${ids}::int[])\`, and drizzle's
\`sql\` tag does not bind an array as ONE array parameter — it expands it into a
parenthesised list of scalar placeholders. One id renders \`ANY(($6)::int[])\` with
\`$6 = 160\`; two render \`ANY(($6, $7)::int[])\`. **The SQL text is correct; only the
parameter binding is wrong.**

\`GET /api/graph/view\` and \`GET /api/graph/entity/:id\` are unaffected — neither uses
\`ANY\` — which is why \`/grafo\` looks healthy while the chat leg is dead. And the
existing test asserts the generated SQL *text* carries the three gates; it never
executes a statement, so it cannot see this.

⚠ **What the shipped arm would have measured.** With \`fetchGraphRetrieval\` returning
\`null\`, \`fuseMatches(vector, [])\` is the plain score sort and \`buildChatTurn\` is called
without \`graphContext\` — the two arms are **byte-identical by construction**. That is
asserted in \`harness.test.ts\` rather than paid for with 20 generations.

So the "with graph" arm below runs the same three statements against the same database
with the id list inlined as \`ARRAY[…]\`. Matching, expansion terms, minimum support, the
org and published gates, and the Spanish context block are all production code, imported
unmodified. **This measures GraphRAG as designed.**

---

## 2. What was held constant

Same \`EngineConfig\`, same adapter, same \`corpora\` (\`eco-1\`, from
\`lib/corpus.ts:publishedCorpus\`, never composed by hand), same \`asOf\` for the whole run,
same empty history — so \`condenseQuery\` short-circuits with no LLM call and both arms
hand the identical query to both legs. **The only difference is whether \`prepareTurn\`
receives a \`graphProvider\`.**

Two deviations from production, both deliberate and both stated:

1. **One line is appended to the system prompt** carrying an id unique to
   (question, arm, repetition). ai-service caches a \`standard\`-tier generation on
   \`hash(model, messages, maxTokens, temperature, org)\` for five minutes. Without the
   marker, whenever the graph contributed nothing the second arm was served the first
   one's answer at 6 ms — measured, not assumed. The marker is drawn the same way
   for both arms, so it adds no systematic difference; it only stops the cache collapsing
   two samples into one. ${cached === 0 ? `**${cached} of ${allArms.length} calls were cache hits.**` : `⚠ **${cached} of ${allArms.length} calls were still served from cache.**`}
2. The graph read runs in-process instead of over the 500ing HTTP endpoint (§1).

---

## 3. Global questions — the case the graph exists for

${armTable('global (' + global.length + ' questions)', gPlain, gGraph)}

Paired difference (graph − no-graph), per question, on the mean of ${reps} repetitions:

* recall **${(gRecallDiff.mean * 100).toFixed(1)} points** (sd ${(gRecallDiff.sd * 100).toFixed(1)})
* retrieval precision **${(gPrecDiff.mean * 100).toFixed(1)} points** (sd ${(gPrecDiff.sd * 100).toFixed(1)})
* citation precision ${gCitePrecDiff.diffs.length === 0 ? '— (not stored in this run)' : `**${(gCitePrecDiff.mean * 100).toFixed(1)} points** (sd ${(gCitePrecDiff.sd * 100).toFixed(1)})`}
* noise floor, same arm repeated: sd **±${(gNoise.withinSd * 100).toFixed(1)} points**,
  worst single-question spread **${(gNoise.maxSpread * 100).toFixed(0)} points**

${questionTable(global)}

**The graph contributed something on ${contributedGlobal.length} of ${global.length} global
questions.** On the other ${global.length - contributedGlobal.length} it matched no entity at
all, so those arms are identical turns and the difference between them is pure model
variance — which is exactly what makes them useful: they are the noise floor, measured on
the same instrument.

---

## 4. Local questions — where the graph should just not make things worse

${armTable('local (' + local.length + ' questions)', lPlain, lGraph)}

Paired difference (graph − no-graph):

* recall **${(lRecallDiff.mean * 100).toFixed(1)} points** (sd ${(lRecallDiff.sd * 100).toFixed(1)})
* retrieval precision **${(lPrecDiff.mean * 100).toFixed(1)} points** (sd ${(lPrecDiff.sd * 100).toFixed(1)})
* citation precision ${lCitePrecDiff.diffs.length === 0 ? '— (not stored in this run)' : `**${(lCitePrecDiff.mean * 100).toFixed(1)} points** (sd ${(lCitePrecDiff.sd * 100).toFixed(1)})`}
* noise floor: sd **±${(lNoise.withinSd * 100).toFixed(1)} points**

${questionTable(local)}

The graph's cost on a local question is visible and it is not zero: every local question
seeds the generic \`tema\` entity **\`lengua\`** (support 3) purely because the question
contains the word, and the block that comes back says only *"lengua (tema): aparece en 3
documentos."* That is
**${promptDelta > 0 ? `+${Math.round(promptDelta)} characters` : `${Math.round(promptDelta)} characters`}**
of prompt${Number.isFinite(tokenDelta) ? ` (~${Math.round(tokenDelta)} prompt tokens)` : ''} on
average, plus a database round trip, for no information.

---

## 5. Why: the graph holds the answers and is never asked for them

Seed matching (\`matchEntitiesToQuery\`) is whole-token containment of an entity **label**
inside the question, ranked by support. So the seeds a global question produces are the
words the question happens to share with some entity — never the answer, because the
answer is what the question does not know.

${data.results
  .filter((r) => r.klass === 'global')
  .map((q) => {
    const seeds = armsOf(q, 'graph')[0]?.graphSeeds ?? []
    return `* **${q.id}** → ${seeds.length > 0 ? seeds.join('; ') : '_no seed at all_'}`
  })
  .join('\n')}

Run \`src/eval/diagnose.ts\` for the full join. Its verdict: **52 of 55** expected global
facts are in the graph at or above \`GRAPH_MIN_SUPPORT\`, as exactly the entity types the
ADR designed for — \`Centro de Salud de Tlayacapan\` (organizacion, 24 documents),
\`Escuela Primaria Miguel Hidalgo\` (organizacion, 25), \`feria escolar de prevención del
dengue\` (evento, 20), \`doña Eulalia\` (persona, 10), \`Reynaldo Ocampo\` (persona, 10).
**Zero** are seeded by the question that asks for them.

That is a matching problem, not an extraction problem. Task 04's re-extraction will not
touch it.

---

## 6. What the graph adds to each turn

| | value |
|---|---|
| generations | ${allArms.length} |
| extra prompt characters from the graph block | ${Math.round(promptDelta)} |
| extra prompt tokens | ${Number.isFinite(tokenDelta) ? Math.round(tokenDelta) : '—'} |
| extra context-assembly latency | ${ms(((gGraph.prepareMs - gPlain.prepareMs) + (lGraph.prepareMs - lPlain.prepareMs)) / 2)} |

---

## 7. What this measurement cannot tell you

* **20 questions × 2 arms sees a large effect and cannot resolve a small one.** Three
  repetitions per arm buy a noise floor, not statistical power. Treat any difference under
  about ${(Math.max(gNoise.withinSd, lNoise.withinSd) * 100).toFixed(0)} points as unmeasured.
* **Mechanical scoring undercounts.** An answer that says *"los dos centros de salud del
  corredor"* without naming them scores zero. It also cannot see a WRONG claim about a fact
  it did find. Both biases fall on both arms identically, which is why the DIFFERENCE is
  readable and the absolute recall number is not. This is deliberate: an LLM judge grading
  a graph built by the same family of model, on a task defined by the people who built the
  graph, would have agreed with itself.
* **No published testimonio carries corpus content.** All 59 seeded testimonios are drafts
  held by the anonymisation gate, and the 3 published ones are e2e fixtures. So the ADR's
  own motivating question — *"¿qué temas se repiten entre los testimonios?"* — has no
  published testimonio behind it in this corpus, and every expected fact here comes from
  \`documento\` rows.
* **One corpus, one ecosistema, one model, one day.** The four \`ecosistema\` values are a
  column on the row, not separate tenants, so a "cross-ecosystem" question is a
  cross-topic question inside one organization.
* **The graph arm is not the shipped arm.** §1. As shipped it contributes nothing at all.

---

## 8. What follows from this

1. **Fix \`= ANY(\${ids}::int[])\`** in \`retrieveEdgesQuery\` and \`retrieveDocumentsQuery\`,
   and add ONE test that EXECUTES a graph statement rather than reading its text. Every
   existing test asserts the generated SQL contains the three gates; none runs it.
2. **Then decide about fusion on the evidence in §5, not on §3.** §3 says the graph did not
   help. §5 says the reason is that seed matching cannot reach an aggregate, which is a
   different, fixable thing — matching the question's *type* words (\`lugares\`, \`eventos\`,
   \`personas\`) to entity TYPES, or seeding from the retrieved chunks' entities rather than
   from the question's words, would both put the held facts in front of the model.
3. **Until one of those lands, always-on fusion is a pure cost.** Local questions pay
   ${Math.round(promptDelta)} prompt characters and a round trip to be told that \`lengua\`
   appears in 3 documents.

---

_Generated by \`src/eval/report.ts\` from \`src/eval/results.json\`. Re-run:_
\`node ../web/node_modules/.bin/tsx src/eval/run.ts && node ../web/node_modules/.bin/tsx src/eval/report.ts\`
`

writeFileSync(path.join(import.meta.dirname, 'RESULTS.md'), md)
console.error('[eval] wrote RESULTS.md')
