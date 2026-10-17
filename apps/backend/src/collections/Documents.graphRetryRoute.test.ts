/**
 * `POST /api/documents/:id/graph-retry` — the ROUTE, not the plan.
 *
 * Payload hands `req.routeParams.id` over as a STRING. Passed straight into
 * `scheduleGraphExtractionForDoc`, it reached the `graph_*` rows' `document`
 * relationship, and on dev Payload refused it with "The following field is
 * invalid: Document". A number worked. So the id is coerced once, at the
 * route boundary: digits only, else 400.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))

const scheduleGraphExtraction = vi.fn()
vi.mock('@/lib/graph/schedule', () => ({
  scheduleGraphExtraction: (...args: unknown[]) => scheduleGraphExtraction(...args),
}))

import { Documents } from './Documents'

type Handler = (req: never) => Promise<Response>
const endpoint = (Documents.endpoints as unknown as { path: string; handler: Handler }[]).find(
  (e) => e.path === '/:id/graph-retry',
)!

const row = {
  id: 7,
  uploadedBy: 3,
  organization: 1,
  name: 'acta.pdf',
  contentKind: 'documento',
  extractedText: 'un texto suficientemente largo para el grafo',
  graphStatus: 'failed',
  updatedAt: new Date().toISOString(),
}

function makeReq(id: string | undefined) {
  const findByID = vi.fn(async () => row)
  return {
    findByID,
    req: {
      user: { id: 3 },
      routeParams: { id },
      payload: { findByID, update: async () => row },
    } as never,
  }
}

beforeEach(() => scheduleGraphExtraction.mockClear())

describe('graph-retry route: the URL id', () => {
  it('reaches the graph pipeline as a NUMBER, not the route-param string', async () => {
    const { req } = makeReq('7')
    const res = await endpoint.handler(req)
    expect(res.status).toBe(202)
    expect(scheduleGraphExtraction).toHaveBeenCalledTimes(1)
    const call = scheduleGraphExtraction.mock.calls[0]![0] as { docId: unknown }
    expect(call.docId).toBe(7)
  })

  it.each(['abc', '7abc', '-1', '0', '1.5', ' ', '', undefined])(
    '400s a non-digit id %j before touching Payload',
    async (id) => {
      const { req, findByID } = makeReq(id)
      const res = await endpoint.handler(req)
      expect(res.status).toBe(400)
      expect(findByID).not.toHaveBeenCalled()
    },
  )
})
