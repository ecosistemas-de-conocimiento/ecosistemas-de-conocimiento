/**
 * 🔴 The production `startGate` (P-02): after the gate and ingest
 * (`enqueueIngestForDoc`), the graph of the NEW text is rebuilt
 * (`rebuildDocumentGraph`): the re-gate never re-extracts it otherwise. A
 * failure is logged by name only (`errSummary`), never its message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const order: string[] = []
const enqueueIngestForDoc = vi.fn(async () => {
  order.push('enqueue')
})
const rebuildDocumentGraph = vi.fn(async () => {
  order.push('rebuild')
})
vi.mock('@/collections/Documents', () => ({ enqueueIngestForDoc, mayReadGatedOriginal: () => true }))
vi.mock('./graph/documentGraph', () => ({ rebuildDocumentGraph, purgeDocumentGraph: vi.fn() }))
vi.mock('./aiClient', () => ({ getAdminAIClient: () => ({}) }))

import { liveDeps } from './anonymisationControls'

const row = { id: 10, uploadedBy: 2, extractedText: 'texto', anonymise: true, anonymisationStatus: 'n/a', redactedText: null }

beforeEach(() => {
  order.length = 0
  enqueueIngestForDoc.mockClear()
  rebuildDocumentGraph.mockClear()
})

describe('liveDeps().startGate', () => {
  it('gates and ingests, THEN rebuilds the graph; its promise ends when both are done', async () => {
    const deps = await liveDeps()
    await deps.startGate({} as never, row, 1)
    expect(order).toEqual(['enqueue', 'rebuild'])
    expect(rebuildDocumentGraph).toHaveBeenCalledWith({}, 10)
  })

  it('🔴 a failed gate logs the error name only, and never rejects', async () => {
    const err = Object.assign(new Error('Failed query: update documents params: Ana Ruiz'), { name: 'Error' })
    enqueueIngestForDoc.mockRejectedValueOnce(err)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = await liveDeps()
    await expect(deps.startGate({} as never, row, 1)).resolves.toBeUndefined()
    expect(rebuildDocumentGraph).not.toHaveBeenCalled()
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Ana Ruiz')
    spy.mockRestore()
  })
})
