/**
 * THE SEED'S BRAKE. A concurrency limit, a minimum gap between starts, and a
 * wait for a draft's in-process work — so a 250-document seed stays under
 * ai-service's 100 requests/min per key instead of being refused by it.
 *
 * ⚠ EXTENSIONLESS IMPORTS, and none at all here: `seed/corpus.ts` is reached
 * from `payload.config.ts` (see the note in `seed/admin.ts`).
 */

export interface ThrottleClock {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export interface ThrottleOptions extends ThrottleClock {
  /** At most this many `fn` calls in flight. */
  concurrency: number
  /** At least this long between two starts, across all workers. */
  spacingMs: number
  /** Called for an item whose `fn` threw. The run continues. */
  onError?: (item: unknown, err: unknown) => void
}

/**
 * Run `fn` over `items` with a concurrency cap and a minimum spacing between
 * starts. ⚠ One failure does not stop the rest — see `ingestSeededDocuments`.
 */
export async function throttledEach<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  opts: ThrottleOptions,
): Promise<void> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? realSleep
  const concurrency = Math.max(1, Math.floor(opts.concurrency))
  const spacing = Math.max(0, opts.spacingMs)
  let cursor = 0
  // The earliest instant the next start may happen. Reserved synchronously, so
  // two workers waking together cannot both take the same slot.
  let nextStart = -Infinity

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      const slot = Math.max(now(), nextStart)
      nextStart = slot + spacing
      const wait = slot - now()
      if (wait > 0) await sleep(wait)
      try {
        await fn(items[index] as T)
      } catch (err) {
        opts.onError?.(items[index], err)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}

/** The two status columns a draft's in-process work moves. */
export interface DraftStatus {
  ingestStatus?: unknown
  anonymisationStatus?: unknown
}

/**
 * Has the draft path's in-process work finished for this row?
 *
 *   · the gate refused it (`held` / `rejected`): done, nothing follows;
 *   · the gate is still running (`pending`): not done — two model calls;
 *   · otherwise done once ingest has left `pending` / `extracting`, i.e. the
 *     enqueue to ai-service happened (`embedding`) or failed.
 */
export function draftSettled(row: DraftStatus): boolean {
  if (row.anonymisationStatus === 'held' || row.anonymisationStatus === 'rejected') return true
  if (row.anonymisationStatus === 'pending') return false
  return row.ingestStatus !== 'pending' && row.ingestStatus !== 'extracting'
}

export interface SettleOptions extends ThrottleClock {
  pollMs: number
  timeoutMs: number
}

/**
 * Poll `read` until {@link draftSettled}, or until the timeout. Returns whether
 * it settled. ⚠ Bounded: a row whose hook never fired must not hang the seed.
 */
export async function waitForDraftSettled(
  read: () => Promise<DraftStatus | null>,
  opts: SettleOptions,
): Promise<boolean> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? realSleep
  const deadline = now() + opts.timeoutMs
  for (;;) {
    const row = await read()
    if (row && draftSettled(row)) return true
    if (now() >= deadline) return false
    await sleep(opts.pollMs)
  }
}

export interface IdleOptions extends ThrottleClock {
  pollMs: number
  timeoutMs: number
  /** Idle this many polls in a row: one quiet poll can fall between two jobs. */
  quietPolls: number
}

/**
 * Poll `isIdle` until it has said yes `quietPolls` times in a row, or until the
 * timeout. Returns whether it went idle. The seed CLI uses it so `payload run`'s
 * `process.exit(0)` does not kill in-process work (`seed/demo.ts`).
 */
export async function waitUntilIdle(
  isIdle: () => Promise<boolean>,
  opts: IdleOptions,
): Promise<boolean> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? realSleep
  const deadline = now() + opts.timeoutMs
  let quiet = 0
  for (;;) {
    quiet = (await isIdle()) ? quiet + 1 : 0
    if (quiet >= opts.quietPolls) return true
    if (now() >= deadline) return false
    await sleep(opts.pollMs)
  }
}
