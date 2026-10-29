import { describe, expect, it, vi } from 'vitest'

import { eraseLateDocument, organizationOfDocumentCorpus } from './documentLateErasure'

const log = { warn: vi.fn(), info: vi.fn() }

function fakeClient(deleteImpl: () => Promise<unknown>) {
  const calls: Array<[string, string, string]> = []
  const client = {
    admin: {
      deleteDocument: vi.fn(async (corpus: string, id: string) => {
        calls.push(['delete', corpus, id])
        return deleteImpl()
      }),
      setDocumentValidity: vi.fn(async (corpus: string, id: string) => {
        calls.push(['retire', corpus, id])
        return {}
      }),
    },
  }
  return { client, calls }
}

describe('organizationOfDocumentCorpus', () => {
  it('reads the ecosistema of a shared and of a draft corpus', () => {
    expect(organizationOfDocumentCorpus('eco-3')).toBe('3')
    expect(organizationOfDocumentCorpus('eco-3-draft-5')).toBe('3')
  })
  it('refuses anything else', () => {
    for (const c of ['', 'eco-', 'eco-x', 'other-3', 'eco-3-draft-', 'eco-3-draft-5-x', 'eco-3-draft-5/x']) {
      expect(organizationOfDocumentCorpus(c)).toBeNull()
    }
  })
})

describe('eraseLateDocument', () => {
  it('erases through that ecosistema’s client', async () => {
    const { client, calls } = fakeClient(async () => ({ deleted: true }))
    const orgs: string[] = []
    const out = await eraseLateDocument({
      documentId: '42',
      corpus: 'eco-3-draft-5',
      log,
      corpusClient: (org) => {
        orgs.push(String(org))
        return client
      },
    })
    expect(out).toBe('erased')
    expect(orgs).toEqual(['3'])
    expect(calls).toEqual([['delete', 'eco-3-draft-5', '42']])
  })

  it('treats ai-service’s own not-found as success', async () => {
    const { client } = fakeClient(async () => {
      throw Object.assign(new Error('nf'), { status: 404, code: 'DOCUMENT_NOT_FOUND' })
    })
    expect(await eraseLateDocument({ documentId: '42', corpus: 'eco-3', log, corpusClient: () => client })).toBe(
      'absent',
    )
  })

  it('🔴 on a real failure, retires the copy and still throws so the sender retries', async () => {
    const { client, calls } = fakeClient(async () => {
      throw Object.assign(new Error('unavailable'), { status: 503 })
    })
    await expect(
      eraseLateDocument({ documentId: '42', corpus: 'eco-3', log, corpusClient: () => client }),
    ).rejects.toThrow('unavailable')
    expect(calls).toEqual([
      ['delete', 'eco-3', '42'],
      ['retire', 'eco-3', '42'],
    ])
  })

  it('⚠ a bare 404 (an ai-service without the route) is NOT absence', async () => {
    const { client } = fakeClient(async () => {
      throw Object.assign(new Error('route'), { status: 404 })
    })
    await expect(
      eraseLateDocument({ documentId: '42', corpus: 'eco-3', log, corpusClient: () => client }),
    ).rejects.toThrow()
  })

  it('skips a non-numeric id or a foreign corpus without calling ai-service', async () => {
    const corpusClient = vi.fn()
    expect(await eraseLateDocument({ documentId: 'msg-1', corpus: 'eco-3', log, corpusClient })).toBe('skipped')
    expect(await eraseLateDocument({ documentId: '42', corpus: 'other', log, corpusClient })).toBe('skipped')
    expect(await eraseLateDocument({ documentId: '42', corpus: undefined, log, corpusClient })).toBe('skipped')
    expect(corpusClient).not.toHaveBeenCalled()
  })
})
