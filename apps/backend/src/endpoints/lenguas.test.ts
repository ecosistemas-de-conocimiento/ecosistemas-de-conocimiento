/**
 * `GET /api/lenguas` — which languages an ecosistema's published documentos
 * are about, and which documento is in which.
 *
 * The endpoint exists because `documents.lengua` cannot be queried over REST:
 * its field `read` access (`lenguaReadable`) needs the row, and Payload checks
 * a `where` path with no row at all, so every non-override `where[lengua]` is
 * refused. This route reads with `overrideAccess` and therefore restates both
 * privacy constraints itself — the tests below pin them.
 */

import { describe, expect, it } from 'vitest'
import type { PayloadRequest } from 'payload'

import { lenguasEndpoint, lenguaIndex } from './lenguas'

const MEMBER = { id: 1, email: 'ana@example.test', isActive: true }
const ADMIN = { id: 2, email: 'root@example.test', isActive: true, isPlatformAdmin: true }

interface FindArgs {
  collection: string
  where?: Record<string, unknown>
  overrideAccess?: boolean
}

function fakeRequest(
  url: string,
  options: { user?: Record<string, unknown> | null; memberOf?: number[]; docs?: unknown[] } = {},
) {
  const finds: FindArgs[] = []
  const memberOf = options.memberOf ?? []
  const payload = {
    async find(args: FindArgs) {
      finds.push(args)
      if (args.collection === 'memberships') {
        return { docs: memberOf.map((id) => ({ id, organization: id, role: 'member', isActive: true })) }
      }
      if (args.collection === 'organizations') {
        return { docs: memberOf.map((id) => ({ id, name: `Eco ${id}`, isActive: true })) }
      }
      return { docs: options.docs ?? [] }
    },
  }
  const req = {
    user: options.user === undefined ? MEMBER : options.user,
    payload,
    searchParams: new URL(url, 'http://test.local').searchParams,
    headers: new Headers(),
  } as unknown as PayloadRequest
  return { req, finds }
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>

describe('lenguaIndex — the tally', () => {
  it('counts documentos per language, most first, ties alphabetical in Spanish', () => {
    const out = lenguaIndex([
      { id: 1, contentKind: 'documento', lengua: 'mixteco' },
      { id: 2, contentKind: 'documento', lengua: 'zapoteco' },
      { id: 3, contentKind: 'documento', lengua: 'mixteco' },
      { id: 4, contentKind: 'documento', lengua: 'amuzgo' },
    ])
    expect(out.lenguas).toEqual([
      { lengua: 'mixteco', documentos: 2 },
      { lengua: 'amuzgo', documentos: 1 },
      { lengua: 'zapoteco', documentos: 1 },
    ])
    expect(out.documentos).toEqual([
      { id: '1', lengua: 'mixteco' },
      { id: '2', lengua: 'zapoteco' },
      { id: '3', lengua: 'mixteco' },
      { id: '4', lengua: 'amuzgo' },
    ])
  })

  it('🔴 ignores anything that is not a documento, even when the row carries a lengua', () => {
    // The column is nulled on a testimonio by `enforceLenguaDocumentoOnly`.
    // This route reads with `overrideAccess`, so `lenguaReadable` does not run;
    // this is the check that still holds if the hook ever does not.
    const out = lenguaIndex([
      { id: 1, contentKind: 'testimonio', lengua: 'tsotsil' },
      { id: 2, contentKind: null, lengua: 'mixe' },
      { id: 3, contentKind: 'documento', lengua: '  ' },
      { id: 4, contentKind: 'documento', lengua: ' mixe ' },
    ])
    expect(out.lenguas).toEqual([{ lengua: 'mixe', documentos: 1 }])
    expect(out.documentos).toEqual([{ id: '4', lengua: 'mixe' }])
  })
})

describe('GET /api/lenguas', () => {
  it('is registered as a GET on /lenguas', () => {
    expect(lenguasEndpoint.path).toBe('/lenguas')
    expect(lenguasEndpoint.method).toBe('get')
  })

  it('401s an anonymous caller', async () => {
    const { req } = fakeRequest('/api/lenguas?organization=7', { user: null })
    expect((await lenguasEndpoint.handler(req)).status).toBe(401)
  })

  it('🔴 403s a caller who is not a member of that ecosistema, without reading documents', async () => {
    const { req, finds } = fakeRequest('/api/lenguas?organization=7', { memberOf: [8] })
    expect((await lenguasEndpoint.handler(req)).status).toBe(403)
    expect(finds.some((f) => f.collection === 'documents')).toBe(false)
  })

  it('🔴 reads PUBLISHED DOCUMENTOS of THAT ecosistema only — every constraint in the query', async () => {
    const { req, finds } = fakeRequest('/api/lenguas?organization=7', {
      memberOf: [7],
      docs: [{ id: 5, contentKind: 'documento', lengua: 'náhuatl' }],
    })
    const res = await lenguasEndpoint.handler(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const read = finds.find((f) => f.collection === 'documents')!
    expect(read.where).toEqual({
      and: [
        { organization: { equals: 7 } },
        { publicationStatus: { equals: 'published' } },
        { contentKind: { equals: 'documento' } },
        { lengua: { exists: true } },
      ],
    })
    expect(await json(res)).toMatchObject({
      organizationId: 7,
      lenguas: [{ lengua: 'náhuatl', documentos: 1 }],
      documentos: [{ id: '5', lengua: 'náhuatl' }],
    })
  })

  it('lets a platform admin name any ecosistema — same rows, same constraints', async () => {
    const { req, finds } = fakeRequest('/api/lenguas?organization=9', { user: ADMIN })
    expect((await lenguasEndpoint.handler(req)).status).toBe(200)
    const read = finds.find((f) => f.collection === 'documents')!
    expect(JSON.stringify(read.where)).toContain('"documento"')
  })
})
