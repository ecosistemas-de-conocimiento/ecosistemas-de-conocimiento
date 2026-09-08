/**
 * The diagnostic that decides WHICH failure the graph has.
 *
 *   node ../web/node_modules/.bin/tsx src/eval/diagnose.ts
 *
 * A global question the graph does not help with has two very different
 * causes, and they need opposite fixes:
 *
 *   A. **The graph does not hold the fact.** Extraction missed it. The fix is
 *      re-extraction — sprint0 task 04.
 *   B. **The graph holds the fact, and the matcher never reaches it.** The fix
 *      is in the seeder. This is what the 2026-09-05 run found: 52 of 55
 *      expected global facts were in the graph and NONE was reached as a seed,
 *      because `matchEntitiesToQuery` requires whole-token containment of an
 *      entity LABEL in the question, and a global question names the ANSWER's
 *      category rather than the answer.
 *
 *      ⚠ This script now calls `seedEntitiesForQuery`, the three-tier seeder
 *      that replaced it at the call site (`readGraphRetrieval`). Re-running it
 *      is the direct before/after measure of any change to that seeder — no
 *      inference, no money.
 *
 * Telling them apart costs no inference and no money: it is a join between the
 * expected facts and `graph_entities` at or above the support threshold.
 *
 * ⚠ It also reports the seeds each question actually produces, which is the
 * other half of the answer — a fact can be one hop from a seed and still never
 * enter the block, because the block lists at most
 * `CONTEXT_MAX_NEIGHBOURS` = 3 neighbours per seed.
 */

import { matchableEntitiesQuery, seedEntitiesForQuery, toCount } from '../lib/graph/queries'
import type { MatchableEntity } from '../lib/graph/queries'
import type { GraphEntityType } from '../lib/graph/types'
import { loadCorpus } from './corpus'
import { selectJson, toExecutableSql } from './db'
import { EVAL_ORGANIZATION_ID, loadEvalEnv } from './env'
import { buildQuestions } from './questions'
import { containsAny } from './text'

const env = loadEvalEnv()
const docs = await loadCorpus(env)
const { questions } = buildQuestions(docs)

const rows = await selectJson<Record<string, unknown>>(
  env,
  env.backendDb,
  toExecutableSql(matchableEntitiesQuery(EVAL_ORGANIZATION_ID, env.graphMinSupport)),
)
const entities: MatchableEntity[] = rows.map((r) => ({
  id: Number(r.id),
  type: String(r.type) as GraphEntityType,
  label: String(r.label ?? ''),
  support: toCount(r.support),
  canonicalKey: String(r.canonical_key ?? ''),
}))

console.log(`# Graph diagnostic\n`)
console.log(
  `${entities.length} entities at support >= ${env.graphMinSupport} in organization ` +
    `${EVAL_ORGANIZATION_ID}; ${docs.length} published corpus documents.\n`,
)

interface Line {
  question: string
  fact: string
  corpusSupport: number
  graphLabel: string | null
  graphType: string | null
  graphSupport: number | null
  seeded: boolean
}

const lines: Line[] = []
for (const question of questions) {
  if (question.klass !== 'global') continue
  const seeds = seedEntitiesForQuery(entities, question.text, 8)
  const seedIds = new Set(seeds.map((s) => s.id))
  for (const fact of question.expected) {
    // The best graph entity for this fact: the one with the highest support
    // whose label names it.
    const hits = entities
      .filter((e) => containsAny(e.label, fact.aliases))
      .sort((a, b) => b.support - a.support)
    const best = hits[0] ?? null
    lines.push({
      question: question.id,
      fact: fact.label,
      corpusSupport: docs.filter((d) => containsAny(d.text, fact.aliases)).length,
      graphLabel: best?.label ?? null,
      graphType: best?.type ?? null,
      graphSupport: best?.support ?? null,
      seeded: best ? seedIds.has(best.id) : false,
    })
  }
  console.log(
    `**${question.id}** seeds: ${
      seeds.map((s) => `${s.label} (${s.type}, ${s.support})`).join('; ') || '_none_'
    }`,
  )
}

console.log('\n| Q | expected fact | docs | in graph as | graph support | seeded? |')
console.log('|---|---|---|---|---|---|')
for (const l of lines) {
  console.log(
    `| ${l.question} | ${l.fact} | ${l.corpusSupport} | ${
      l.graphLabel ? `\`${l.graphLabel}\` (${l.graphType})` : '**absent**'
    } | ${l.graphSupport ?? '—'} | ${l.seeded ? 'yes' : 'no'} |`,
  )
}

const held = lines.filter((l) => l.graphLabel !== null).length
const seeded = lines.filter((l) => l.seeded).length
console.log(
  `\n**${held} of ${lines.length}** expected global facts exist in the graph at or above ` +
    `the threshold. **${seeded}** of them are reached as a seed by the question that ` +
    'asks for them.',
)
