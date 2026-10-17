import { describe, expect, it, vi } from 'vitest'

import { AIClient } from '@edc/ai-client'

import { retireDeletedDocument } from './publishDocument'

/**
 * Deleting a document used to leave its chunks embedded and retrievable: the
 * row disappeared from the UI while the ecosistema's assistant kept quoting it.
 * Then it RETIRED them (closed the validity window), which hid them but kept
 * every chunk and its text stored. Now it DELETES them, and retires only when
 * the delete fails.
 *
 * ⚠ FETCH-LEVEL FAKE, NOT A MOCKED CLIENT. The client is the real
 * `@edc/ai-client` `AIClient`; only `fetch` is fake. So these tests also pin the
 * wire: the HTTP method, the path, and the `X-AI-Org` header that puts the call
 * in the ecosistema's own ai-service org.
 */

interface Call {
  method: string
  path: string
  org: string | null
}

type Responder = (call: Call) => { status: number; body: unknown }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const deleted = () => ({ status: 200, body: { deleted: { chunks: 3, documents: 1 } } })
const validityOk = () => ({ status: 200, body: { documentId: 'x', validFrom: null, validTo: 'x' } })

function makeDeps(respond: Responder = (c) => (c.method === 'DELETE' ? deleted() : validityOk())) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      path: decodeURIComponent(url.pathname),
      org: new Headers(init?.headers).get('x-ai-org'),
    }
    calls.push(call)
    const { status, body } = respond(call)
    return json(status, body)
  })
  const client = new AIClient({
    baseUrl: 'http://ai.test',
    apiKey: 'k',
    // The ecosistema's own org, exactly as `getAdminAIClient(3)` builds it.
    org: 'eco-3',
    fetch: fetchImpl as unknown as typeof fetch,
    retry: { attempts: 1 },
  })
  const warn = vi.fn()
  return {
    deps: { payload: { logger: { warn } } as never, client },
    calls,
    warn,
  }
}

const NOW = new Date('2026-08-18T12:00:00.000Z')
const DOC = { id: 7, organization: 3, uploadedBy: 9 }

const deletes = (calls: Call[]) => calls.filter((c) => c.method === 'DELETE').map((c) => c.path)
const retires = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH').map((c) => c.path)

describe('retireDeletedDocument', () => {
  it('🔴 DELETES from BOTH corpora, whatever the row claims its state was', async () => {
    // A row can be deleted mid-transition, when copies legitimately exist in
    // both places. Trusting `publicationStatus` is how you leave the one that
    // mattered — so the state is deliberately a lie here.
    const { deps, calls } = makeDeps()
    await retireDeletedDocument(deps, { ...DOC, publicationStatus: 'draft' }, NOW)

    expect(deletes(calls).sort()).toEqual([
      '/v1/corpus/eco-3-draft-9/documents/7',
      '/v1/corpus/eco-3/documents/7',
    ])
    // A successful delete needs no retire.
    expect(retires(calls)).toEqual([])
  })

  it('🔴 sends every call under the ecosistema org', async () => {
    const { deps, calls } = makeDeps()
    await retireDeletedDocument(deps, DOC, NOW)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.org === 'eco-3')).toBe(true)
  })

  it('treats ai-service "no such corpus / document" as done, with no fallback', async () => {
    // A markdown note was never ingested; its draft corpus may not even exist.
    const { deps, calls } = makeDeps((c) =>
      c.path.includes('draft')
        ? { status: 404, body: { error: { code: 'CORPUS_NOT_FOUND', message: 'nope' } } }
        : { status: 404, body: { error: { code: 'DOCUMENT_NOT_FOUND', message: 'nope' } } },
    )
    await retireDeletedDocument(deps, DOC, NOW)
    expect(deletes(calls)).toHaveLength(2)
    expect(retires(calls)).toEqual([])
  })

  it('🔴 falls back to RETIRING when the delete fails', async () => {
    const { deps, calls, warn } = makeDeps((c) =>
      c.method === 'DELETE' ? { status: 500, body: { error: 'boom' } } : validityOk(),
    )
    await retireDeletedDocument(deps, DOC, NOW)

    expect(retires(calls).sort()).toEqual([
      '/v1/corpus/eco-3-draft-9/documents/7/validity',
      '/v1/corpus/eco-3/documents/7/validity',
    ])
    expect(warn).toHaveBeenCalled()
  })

  it('🔴 an ai-service without the delete ROUTE also falls back — a bare 404 is not "gone"', async () => {
    // Fastify answers an unknown route with 404 and no ai-service code. Reading
    // that as "already deleted" would skip the retire and leave it retrievable.
    const { deps, calls } = makeDeps((c) =>
      c.method === 'DELETE'
        ? { status: 404, body: { message: 'Route DELETE:/v1/corpus/x not found', statusCode: 404 } }
        : validityOk(),
    )
    await retireDeletedDocument(deps, DOC, NOW)
    expect(retires(calls)).toHaveLength(2)
  })

  it('one unreachable corpus does not stop it reaching the other', async () => {
    // The shared corpus is the one that might still be serving this document to
    // colleagues. A failure on the draft corpus must not cost us that call.
    const { deps, calls, warn } = makeDeps((c) =>
      c.path.includes('draft') ? { status: 500, body: {} } : deleted(),
    )
    await retireDeletedDocument(deps, DOC, NOW)
    expect(deletes(calls)).toContain('/v1/corpus/eco-3/documents/7')
    expect(warn).toHaveBeenCalled()
  })

  it('never throws — the row is already gone and there is nothing to roll back', async () => {
    const { deps } = makeDeps(() => ({ status: 500, body: {} }))
    await expect(retireDeletedDocument(deps, DOC, NOW)).resolves.toBeUndefined()
  })

  it('accepts populated relationships, not only bare ids', async () => {
    const { deps, calls } = makeDeps()
    await retireDeletedDocument(deps, { id: 7, organization: { id: 3 }, uploadedBy: { id: 9 } }, NOW)
    expect(deletes(calls)).toEqual(
      expect.arrayContaining(['/v1/corpus/eco-3/documents/7', '/v1/corpus/eco-3-draft-9/documents/7']),
    )
  })

  it('with no ecosistema there is no corpus to name — it says so instead of guessing', async () => {
    const { deps, calls, warn } = makeDeps()
    await retireDeletedDocument(deps, { id: 7, organization: null, uploadedBy: 9 }, NOW)
    expect(calls).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('deletes from the shared corpus even when the uploader is unknown', async () => {
    // A server-side write can leave `uploadedBy` empty. The draft corpus is
    // then unnameable, but the SHARED one is exactly the leak that matters.
    const { deps, calls } = makeDeps()
    await retireDeletedDocument(deps, { id: 7, organization: 3, uploadedBy: null }, NOW)
    expect(deletes(calls)).toEqual(['/v1/corpus/eco-3/documents/7'])
  })
})
