/**
 * The field rule of `relationFilters.ts`, on a field Payload itself lets
 * through. Payload asks a field's read access WITHOUT a row when it validates
 * a `where` or a `sort`; a rule that answers yes there and no on some rows
 * (`readMembershipUser` does) would let a filter read the rows it hides. No
 * such field is left unjudged in the config today (`ratings.comment` answers
 * no without a row, so Payload refuses it: `relationFilters.pg.test.ts`), so
 * this pins the rule on a made-up one.
 */

import type { PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { constrainRelationQueries, needsRelationFilters, unreadablePath, type QueryField } from './relationFilters'

const yesWithoutARow = () => true
const fields: QueryField[] = [
  { name: 'stars', type: 'number' },
  { name: 'note', type: 'text', access: { read: yesWithoutARow } },
  { name: 'judged', type: 'text', access: { read: yesWithoutARow }, custom: { queryJudgedBy: 'its own hook' } },
  { name: 'meta', type: 'group', flattenedFields: [{ name: 'secret', type: 'text', hidden: true }] },
  { name: 'owner', type: 'relationship', relationTo: 'users' },
]
const member = { id: 2, collection: 'users', isActive: true }
const req = { user: member, payload: { collections: {} }, t: (k: string) => k } as unknown as PayloadRequest
const rule = constrainRelationQueries({ follow: false, fieldRule: true })
const run = (args: Record<string, unknown>, user: unknown = member) =>
  rule({ args, operation: 'read', collection: { flattenedFields: fields }, req: { ...req, user } } as never)

describe('🔴 a field the caller may not read in every row is not a filter', () => {
  it('finds the guarded field on a path, at any depth, and stops at a relation', () => {
    expect(unreadablePath('note', fields)).toBe('note')
    expect(unreadablePath('meta.secret', fields)).toBe('meta.secret')
    expect(unreadablePath('stars', fields)).toBeNull()
    expect(unreadablePath('judged', fields)).toBeNull()
    expect(unreadablePath('owner.email', fields)).toBeNull()
  })

  it('refuses a where on it, through OR in any case and the nested spelling', async () => {
    await expect(run({ where: { note: { like: 'x' } } })).rejects.toThrow(/cannot be queried: note/)
    await expect(run({ where: { Or: [{ stars: { equals: 1 } }, { note: { like: 'x' } }] } })).rejects.toThrow(/note/)
    await expect(run({ where: { meta: { secret: { exists: true } } } })).rejects.toThrow(/meta\.secret/)
    await expect(run({ field: 'note' })).rejects.toThrow(/note/)
  })

  it('strips a sort on it and keeps the rest', async () => {
    expect(((await run({ sort: '-note,stars' })) as { sort?: unknown }).sort).toBe('stars')
    expect(((await run({ sort: ['meta.secret'] })) as { sort?: unknown }).sort).toBeUndefined()
  })

  it('leaves a platform admin, a server read and the other fields alone', async () => {
    const args = { where: { note: { like: 'x' } }, sort: 'note' }
    expect(await run(args, { ...member, isPlatformAdmin: true })).toBe(args)
    expect(await run({ ...args, overrideAccess: true })).toEqual({ ...args, overrideAccess: true })
    const own = { where: { stars: { equals: 1 }, judged: { equals: 'x' } }, sort: '-stars' }
    expect(await run(own)).toBe(own)
  })

  it('a collection needs the hook for a relation, a hidden field or a field read', () => {
    expect(needsRelationFilters([{ name: 'a', type: 'text' }])).toBe(false)
    expect(needsRelationFilters([{ name: 'f', type: 'upload', relationTo: 'media' }])).toBe(true)
    expect(needsRelationFilters([{ name: 'g', type: 'group', flattenedFields: [{ name: 'h', type: 'text', hidden: true }] }])).toBe(true)
    expect(needsRelationFilters([{ name: 'n', type: 'text', access: { read: yesWithoutARow } }])).toBe(true)
  })
})
