/**
 * TEST-ONLY stand-in for `lib/messageColumns.ts`, for unit tests whose fake
 * Payload keeps rows in memory and answers `findByID` / `update`.
 *
 *   vi.mock('./messageColumns', () => import('./messageColumns.testFake'))
 *
 * Same guards as the real SQL (claim only from a runnable state; later writes
 * only while `embedding` + the run's token), read-then-write instead of one
 * statement. The real statements are in `messageColumns.ts`.
 */

// Not re-exported from './messageColumns': that module is the one being mocked,
// and importing it from its own mock factory deadlocks.
export const TURN_RUNNING_CODE = 'gate_running'

type FakePayload = {
  findByID(args: Record<string, unknown>): Promise<unknown>
  update(args: Record<string, unknown>): Promise<unknown>
}

async function read(payload: unknown, id: number | string): Promise<Record<string, unknown> | null> {
  return ((await (payload as FakePayload)
    .findByID({ collection: 'messages', id, depth: 0, overrideAccess: true })
    .catch(() => null)) ?? null) as Record<string, unknown> | null
}

async function write(payload: unknown, id: number | string, data: Record<string, unknown>): Promise<void> {
  await (payload as FakePayload).update({
    collection: 'messages',
    id,
    data,
    overrideAccess: true,
    context: { __skipConversationIngest: true },
  })
}

export async function claimTurn(
  payload: unknown,
  id: number | string,
  token: string,
  runnable: readonly string[],
): Promise<boolean> {
  const row = await read(payload, id)
  const status = typeof row?.corpusStatus === 'string' ? row.corpusStatus : 'pending'
  if (!row || !runnable.includes(status)) return false
  await write(payload, id, { corpusStatus: 'embedding', corpusError: token })
  return true
}

export async function finishTurn(
  payload: unknown,
  id: number | string,
  token: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const row = await read(payload, id)
  if (!row || row.corpusStatus !== 'embedding' || row.corpusError !== token) return false
  await write(payload, id, data)
  return true
}
