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
   * Of the DISTINCT documents cited, the share whose own text contains at least
   * one expected fact.
   *
   * ⚠ `null` when nothing was cited — an answer with no citations has no
   * citation precision, and scoring it 0 would confuse "cited badly" with
   * "cited nothing". They are different failures.
   */
  citationPrecision: number | null
  citedDocumentIds: number[]
  /** LOCAL only: was the one document the question is about cited? */
  targetCited: boolean | null
}

/**
 * The Payload document ids behind a provenance.
 *
 * 🔴 `metadata.docId` — NOT `documentId`, which is ai-service's own uuid for
 * its copy of the document. Both retrieval legs carry `docId`
 * (`apps/backend/src/lib/contentKind.ts:chunkMetadata`), and it is the only key
 * that joins a citation back to `documents.id`.
 */
export function citedDocumentIds(provenance: Provenance | null): number[] {
  if (!provenance) return []
  const ids = new Set<number>()
  for (const chunk of provenance.chunks) {
    const raw = chunk.metadata?.docId
    const n = Number(typeof raw === 'string' || typeof raw === 'number' ? raw : Number.NaN)
    if (Number.isInteger(n)) ids.add(n)
  }
  return [...ids].sort((a, b) => a - b)
}

export function scoreAnswer(
  question: EvalQuestion,
  answer: string,
  provenance: Provenance | null,
  docs: readonly CorpusDoc[],
): QuestionScore {
  const found: string[] = []
  const missing: string[] = []
  for (const fact of question.expected) {
    if (containsAny(answer, fact.aliases)) found.push(fact.label)
    else missing.push(fact.label)
  }

  const cited = citedDocumentIds(provenance)
  let citationPrecision: number | null = null
  if (cited.length > 0) {
    const supporting = new Set<number>()
    for (const fact of question.expected) {
      for (const id of factDocuments(docs, fact)) supporting.add(id)
    }
    const hits = cited.filter((id) => supporting.has(id)).length
    citationPrecision = hits / cited.length
  }

  return {
    found,
    missing,
    recall: question.expected.length === 0 ? 0 : found.length / question.expected.length,
    citationPrecision,
    citedDocumentIds: cited,
    targetCited:
      question.targetDocumentId === null ? null : cited.includes(question.targetDocumentId),
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
