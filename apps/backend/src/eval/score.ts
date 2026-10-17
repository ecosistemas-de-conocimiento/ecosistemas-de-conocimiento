/**
 * MECHANICAL scoring. No model is asked anything.
 *
 * 🔴 WHY NOT AN LLM JUDGE — `sprint0/01-quality-test.md` is explicit, and the
 * reasoning is worth keeping next to the code that obeys it: a model grading a
 * graph built by the same family of model, on a task defined by the people who
 * built the graph, is the wrong instrument. It would agree with itself.
 *
 * ⚠ WHAT MECHANICAL SCORING COSTS, stated here and again in the report. It
 * UNDERCOUNTS: an answer that says *"los dos centros de salud del corredor"*
 * without naming them scores zero. It also cannot see a WRONG statement about a
 * fact it did find. Both biases fall on both arms identically, which is why a
 * DIFFERENCE between arms is readable and an absolute recall number is not.
 */

import type { CorpusDoc, Fact } from './corpus'
import { factDocuments } from './corpus'
import { containsAny } from './text'
import type { EvalQuestion } from './questions'

export interface Provenance {
  chunks: Array<{
    chunkId: string
    documentId: string
    score: number
    corpus: string
    metadata: Record<string, unknown> | null
    text?: string
  }>
}

export interface QuestionScore {
  /** Expected facts the answer names, by label. */
  found: string[]
  missing: string[]
  recall: number
  /**
   * Of the DISTINCT documents RETRIEVED into the prompt, the share whose own
   * text contains at least one expected fact.
   *
   * ⚠ This is the number earlier runs (≤ 2026-09-08) called "citation
   * precision". It is not: chat-engine's provenance holds EVERY retrieved match
   * (`packages/chat-engine/src/core/turn.ts` builds it from `retrievedMatches`),
   * whether or not the answer cites it. With topK 5 and one target document,
   * its floor on a local question is 1/5.
   *
   * `null` when nothing was retrieved.
   */
  retrievalPrecision: number | null
  retrievedDocumentIds: number[]
  /** LOCAL only: was the one document the question is about RETRIEVED? */
  targetRetrieved: boolean | null
  /**
   * Of the DISTINCT documents the answer CITES with an in-range `[n]` marker,
   * the share whose own text contains at least one expected fact.
   *
   * ⚠ `null` when the answer carries no in-range marker — "cited nothing" and
   * "cited badly" are different failures.
   */
  citationPrecision: number | null
  /**
   * Of the expected facts, the share with at least one supporting document
   * among the cited ones. 0 when nothing is cited; `null` only when the
   * question expects no facts.
   */
  citationRecall: number | null
  citedDocumentIds: number[]
  /** In-range `[n]` ordinals the answer uses, distinct, in first-use order. */
  citedOrdinals: number[]
  /** `[n]` markers with no n-th source — the model invented a citation. */
  strayOrdinals: number[]
  /** LOCAL only: does the answer CITE the one document the question is about? */
  targetCited: boolean | null
}

/**
 * One prompt source, in PROMPT ORDER. `n` is the `[n]` the model saw.
 *
 * The ordinal is the 1-based array index over the engine's `retrievedMatches`:
 * `buildChatTurn` renders `[${i + 1}] ${m.text}` and builds `provenance.chunks`
 * from the same array in the same order (`packages/chat-engine/src/core/turn.ts`),
 * and `provenanceToCitations` numbers the UI's citation cards the same way
 * (`core/citation.ts`). So `provenance.chunks[n - 1]` IS source `[n]`.
 */
export interface Source {
  n: number
  chunkId: string
  /** Payload `documents.id` from `metadata.docId`; `null` when absent. */
  docId: number | null
  score: number
}

function payloadDocId(chunk: Provenance['chunks'][number]): number | null {
  const raw = chunk.metadata?.docId
  const n = Number(typeof raw === 'string' || typeof raw === 'number' ? raw : Number.NaN)
  return Number.isInteger(n) ? n : null
}

/** The prompt's sources, in prompt order — what `results.json` stores for re-scoring. */
export function orderedSources(provenance: Provenance | null): Source[] {
  if (!provenance) return []
  return provenance.chunks.map((c, i) => ({
    n: i + 1,
    chunkId: c.chunkId,
    docId: payloadDocId(c),
    score: c.score,
  }))
}

/**
 * The Payload document ids behind a provenance — every RETRIEVED document,
 * cited or not.
 *
 * 🔴 `metadata.docId` — NOT `documentId`, which is ai-service's own uuid for
 * its copy of the document. Both retrieval legs carry `docId`
 * (`apps/backend/src/lib/contentKind.ts:chunkMetadata`), and it is the only key
 * that joins a citation back to `documents.id`.
 */
export function retrievedDocumentIds(provenance: Provenance | null): number[] {
  return distinctDocIds(orderedSources(provenance))
}

function distinctDocIds(sources: readonly Source[]): number[] {
  const ids = new Set<number>()
  for (const s of sources) if (s.docId !== null) ids.add(s.docId)
  return [...ids].sort((a, b) => a - b)
}

/**
 * The `[n]` markers in an answer. Same pattern as chat-engine's
 * `splitContentByCitations` (`core/citation.ts`): a bracketed run of
 * comma-separated integers — `[1]`, `[1, 2]`, and `[1][2]` as two runs.
 * A test pins the two parsers together.
 *
 * `ordinals`: in range (1..sourceCount), distinct, in first-use order.
 * `stray`: out of range, distinct, in first-use order.
 */
export function parseCitationMarkers(
  answer: string,
  sourceCount: number,
): { ordinals: number[]; stray: number[] } {
  const ordinals: number[] = []
  const stray: number[] = []
  for (const run of answer.match(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g) ?? []) {
    for (const n of (run.match(/\d+/g) ?? []).map(Number)) {
      const into = n >= 1 && n <= sourceCount ? ordinals : stray
      if (!into.includes(n)) into.push(n)
    }
  }
  return { ordinals, stray }
}

export function scoreAnswer(
  question: EvalQuestion,
  answer: string,
  provenance: Provenance | null,
  docs: readonly CorpusDoc[],
): QuestionScore {
  return scoreWithSources(question, answer, orderedSources(provenance), docs)
}

/** Score from stored `sources` — re-scores a `results.json` arm without re-running it. */
export function scoreWithSources(
  question: EvalQuestion,
  answer: string,
  sources: readonly Source[],
  docs: readonly CorpusDoc[],
): QuestionScore {
  const found: string[] = []
  const missing: string[] = []
  for (const fact of question.expected) {
    if (containsAny(answer, fact.aliases)) found.push(fact.label)
    else missing.push(fact.label)
  }

  const supportByFact = question.expected.map((fact) => factDocuments(docs, fact))
  const supporting = new Set<number>(supportByFact.flatMap((s) => [...s]))
  const precisionOf = (ids: readonly number[]): number | null =>
    ids.length === 0 ? null : ids.filter((id) => supporting.has(id)).length / ids.length

  const retrieved = distinctDocIds(sources)
  const { ordinals, stray } = parseCitationMarkers(answer, sources.length)
  const cited = distinctDocIds(ordinals.map((n) => sources[n - 1]))
  const target = question.targetDocumentId

  return {
    found,
    missing,
    recall: question.expected.length === 0 ? 0 : found.length / question.expected.length,
    retrievalPrecision: precisionOf(retrieved),
    retrievedDocumentIds: retrieved,
    targetRetrieved: target === null ? null : retrieved.includes(target),
    citationPrecision: precisionOf(cited),
    citationRecall:
      supportByFact.length === 0
        ? null
        : supportByFact.filter((s) => cited.some((id) => s.has(id))).length / supportByFact.length,
    citedDocumentIds: cited,
    citedOrdinals: ordinals,
    strayOrdinals: stray,
    targetCited: target === null ? null : cited.includes(target),
  }
}

/** Mean of the defined values, or `null` when there are none. */
export function meanOf(values: readonly (number | null)[]): number | null {
  const defined = values.filter((v): v is number => v !== null && Number.isFinite(v))
  if (defined.length === 0) return null
  return defined.reduce((a, b) => a + b, 0) / defined.length
}

/** A fact that has no supporting document at all is a broken expectation. */
export function unsupportedFacts(facts: readonly Fact[], docs: readonly CorpusDoc[]): Fact[] {
  return facts.filter((f) => factDocuments(docs, f).size === 0)
}
