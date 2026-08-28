/**
 * `planGraphRetry` — the rule behind `POST /api/documents/:id/graph-retry`,
 * pure so it can be tested without an HTTP request.
 *
 * ⚠ It is DELIBERATELY WIDER than `planIngestRetry`. Ingest retry demands a
 * terminal failure because re-running a transcription costs CPU-hours; graph
 * re-extraction replaces the document's rows wholesale in one transaction, so
 * re-running a `ready` document is how you adopt a new prompt version on one
 * document without a corpus-wide backfill.
 */
import { describe, expect, it } from 'vitest'

import { GRAPH_STALE_RUN_MS, planGraphRetry } from './Documents'

const doc = (over: Record<string, unknown> = {}) => ({
  extractedText: 'un texto suficientemente largo',
  graphStatus: 'ready',
  updatedAt: new Date().toISOString(),
  ...over,
})

const agoMs = (ms: number) => new Date(Date.now() - ms).toISOString()

describe('planGraphRetry', () => {
  it('allows a re-run of a document whose graph is already ready', () => {
    expect(planGraphRetry(doc())).toBeNull()
  })

  it('allows a re-run after a failure, and after a skip', () => {
    expect(planGraphRetry(doc({ graphStatus: 'failed' }))).toBeNull()
    expect(planGraphRetry(doc({ graphStatus: 'skipped' }))).toBeNull()
    expect(planGraphRetry(doc({ graphStatus: 'n/a' }))).toBeNull()
  })

  it('refuses while a RECENT run is in flight, so two replaces cannot interleave', () => {
    for (const status of ['extracting', 'pending']) {
      expect(planGraphRetry(doc({ graphStatus: status }))?.reason).toMatch(
        /Ya se está construyendo/,
      )
    }
  })

  describe('🔴 a lost run must be retryable', () => {
    // The design's headline risk: a restart mid-extraction leaves the row at
    // `extracting` with nothing to move it. Refusing that state forever would
    // make this endpoint useless for the one failure it was built to cover.
    it('allows a re-run once an in-flight row has gone stale', () => {
      expect(planGraphRetry(doc({ graphStatus: 'extracting', updatedAt: agoMs(GRAPH_STALE_RUN_MS + 1000) }))).toBeNull()
      expect(planGraphRetry(doc({ graphStatus: 'pending', updatedAt: agoMs(GRAPH_STALE_RUN_MS + 1000) }))).toBeNull()
    })

    it('treats a missing or unreadable timestamp as stale, not as live', () => {
      // A permanently stuck document is worse than a duplicate run: the
      // duplicate replaces the same rows wholesale and is recoverable.
      for (const stamp of [null, undefined, '', 'no soy una fecha']) {
        expect(planGraphRetry(doc({ graphStatus: 'extracting', updatedAt: stamp }))).toBeNull()
      }
    })

    it('still refuses a run that is only a minute old', () => {
      expect(planGraphRetry(doc({ graphStatus: 'extracting', updatedAt: agoMs(60_000) }))).not.toBeNull()
    })
  })

  it('refuses when there is no text — the fix is an ingest retry, not this', () => {
    expect(planGraphRetry(doc({ extractedText: '' }))?.reason).toMatch(/todavía no tiene texto/)
    expect(planGraphRetry(doc({ extractedText: '   ' }))?.reason).toBeTruthy()
    expect(planGraphRetry(doc({ extractedText: null }))?.reason).toBeTruthy()
  })

  it('answers in Spanish, because the reason reaches the user', () => {
    const refusal = planGraphRetry(doc({ extractedText: null }))
    expect(refusal?.reason).toMatch(/[áéíóúñ¿]/i)
  })
})
