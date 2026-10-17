/**
 * TEST-ONLY stand-in for `lib/documentColumns.ts`, for unit tests whose fake
 * Payload records `update` calls and honours a `where`.
 *
 * It replays each narrow write as the equivalent `payload.update`, so those
 * fakes keep seeing the same writes. The real SQL is covered against a real
 * Postgres in `documentColumns.pg.test.ts`.
 *
 *   vi.mock('@/lib/documentColumns', () => import('@/lib/documentColumns.testFake'))
 */

import type { UpdateDocumentColumnsArgs } from './documentColumns'

type FakePayload = { update(args: Record<string, unknown>): Promise<unknown> }

export async function updateDocumentColumns(
  payload: unknown,
  args: UpdateDocumentColumnsArgs,
): Promise<number> {
  const p = payload as FakePayload
  const common = { collection: 'documents', data: args.data, overrideAccess: true, context: { __skipDocsExtract: true } }
  if (!args.where?.length) {
    const res = await p.update({ ...common, id: args.id })
    return res == null ? 0 : 1
  }
  const res = (await p.update({
    ...common,
    where: { and: [{ id: { equals: args.id } }, ...args.where] },
  })) as { docs?: unknown[] } | null
  return res?.docs?.length ?? 0
}

/** For a fake Payload's `db.drizzle` when this module is mocked in: never called. */
export const NO_DRIZZLE = {
  async execute(): Promise<never> {
    throw new Error('db.drizzle reached in a unit test: mock @/lib/documentColumns with documentColumns.testFake')
  },
}
