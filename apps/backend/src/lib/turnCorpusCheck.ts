/**
 * CONSISTENCY CHECK: chat turns in ai-service vs the backend's `messages`.
 *
 * Audit 2026-10-17 §3 items 1 and 2: on dev, `msg-2` (a live chunk under a
 * retired doc) and `msg-11` (live doc and chunk) outlived their deleted
 * conversations. This finds that class of row:
 *
 *   · `orphan-live`   🔴 a `msg-<id>` document whose `messages` row is gone,
 *                     with the document OR any chunk still live (no
 *                     `valid_to`, or one in the future). Retrievable.
 *   · `orphan-stored` the same, everything retired: hidden from every `asOf`
 *                     retrieve, but the text and vectors are still kept. A
 *                     delete whose after-commit erase failed leaves this.
 *   · `turn`          only with `allTurns` (`TURN_CHECK_ALL_TURNS=1`): a
 *                     `msg-<id>` document whose message row still exists.
 *                     Chat searches documents only since 2026-10-21 and turns
 *                     are no longer ingested, so every turn left in a corpus
 *                     is dead weight. Retrieval already drops them (web,
 *                     `apps/web/src/lib/turnChunks.ts`); this erases them.
 *   · `validity-mismatch` ANY ai-service document (turn or not) with a chunk
 *                     whose `valid_from` / `valid_to` differ from its
 *                     document's. ai-service mirrors validity onto chunks, so
 *                     this means something wrote around the API (the
 *                     2026-10-20 dev lane found one doc retired at microsecond
 *                     precision with its chunk still live).
 *
 * "Session gone" needs no check of its own: `messages.session_id` is NOT NULL,
 * so a message cannot outlive its session.
 *
 * 🔴 READ-ONLY BY DEFAULT. With `apply`, orphans are erased through
 * `admin.deleteDocument` (document and chunks in one call), and only from the
 * shared `eco-<id>` corpus that turns go to. Never by SQL, never chunks alone.
 * Mismatches are reported, never repaired: which side is right depends on the
 * row.
 *
 * A SCRIPT, NOT A JANITOR: `edc_ai` is a separate database, and a janitor
 * would need its URL inside the backend container. Run it by hand:
 * `scripts/check-turn-corpus.ts`. It reads both databases over read-only
 * connections (`turnCheckEnv`) and never boots Payload.
 */

import { sql } from '@payloadcms/db-postgres'

/** One `msg-*` document in ai-service, with its chunks summarised. */
export interface AiTurnRow {
  corpus: string
  org: string
  externalId: string
  docLive: boolean
  chunks: number
  liveChunks: number
}

export interface ValidityMismatchRow {
  corpus: string
  org: string
  externalId: string | null
  /** Chunks of that document whose validity differs from it. */
  chunks: number
}

export interface TurnProblem {
  kind: 'orphan-live' | 'orphan-stored' | 'turn'
  corpus: string
  org: string
  externalId: string
  messageId: string
}

/** Read-only, against the ai-service database. "Live" = no `valid_to`, or one in the future. */
export const AI_TURN_ROWS_SQL = `
SELECT c.name AS corpus, d.org, d.external_id AS "externalId",
       (d.valid_to IS NULL OR d.valid_to > now()) AS "docLive",
       count(ch.id)::int AS chunks,
       (count(ch.id) FILTER (WHERE ch.valid_to IS NULL OR ch.valid_to > now()))::int AS "liveChunks"
FROM documents d
JOIN corpora c ON c.id = d.corpus_id
LEFT JOIN chunks ch ON ch.document_id = d.id
WHERE d.external_id LIKE 'msg-%'
GROUP BY c.name, d.org, d.external_id, d.valid_to
ORDER BY c.name, d.external_id`

/** Read-only, against the ai-service database. Every document, not only turns. */
export const AI_VALIDITY_MISMATCH_SQL = `
SELECT c.name AS corpus, d.org, d.external_id AS "externalId", count(*)::int AS chunks
FROM chunks ch
JOIN documents d ON d.id = ch.document_id
JOIN corpora c ON c.id = d.corpus_id
WHERE d.valid_to IS DISTINCT FROM ch.valid_to OR d.valid_from IS DISTINCT FROM ch.valid_from
GROUP BY c.name, d.org, d.external_id
ORDER BY c.name, d.external_id`

const messageIdOf = (externalId: string): string | null => /^msg-(\d+)$/.exec(externalId)?.[1] ?? null

/** Pure: which rows point at a `messages` row that is gone. */
export function classifyTurnRows(rows: AiTurnRow[], existingMessageIds: Set<string>): TurnProblem[] {
  const problems: TurnProblem[] = []
  for (const r of rows) {
    const messageId = messageIdOf(r.externalId)
    if (messageId == null || existingMessageIds.has(messageId)) continue
    problems.push({
      kind: r.docLive || r.liveChunks > 0 ? 'orphan-live' : 'orphan-stored',
      corpus: r.corpus,
      org: r.org,
      externalId: r.externalId,
      messageId,
    })
  }
  return problems
}

/** The ecosistema id of a SHARED corpus (`eco-<id>`); null for anything else. */
export function organizationOfTurnCorpus(corpus: string): string | null {
  return /^eco-(\d+)$/.exec(corpus)?.[1] ?? null
}

export interface TurnCheckDeps {
  readTurnRows(): Promise<AiTurnRow[]>
  readValidityMismatches(): Promise<ValidityMismatchRow[]>
  /** Which of these `messages` ids still exist in the backend. */
  existingMessageIds(ids: string[]): Promise<Set<string>>
  /** How many `messages` rows the backend has at all. The wrong-database guard. */
  countMessages(): Promise<number>
  /** `admin.deleteDocument(corpus, externalId)` with that ecosistema's client. Used only with `apply`. */
  erase(corpus: string, externalId: string): Promise<void>
  log(line: string): void
}

export interface TurnCheckReport {
  apply: boolean
  turnDocs: number
  orphanLive: number
  orphanStored: number
  validityMismatches: number
  erased: number
  eraseFailed: number
  /** Orphans not erased because they sit outside an `eco-<id>` corpus. */
  skipped: number
  /** `messages` rows in the backend. 0 next to turn docs means a wrong DATABASE_URI. */
  backendMessages: number
  /** Why APPLY erased nothing, or null. Never set in read-only mode. */
  refused: string | null
}

/** Default for `TURN_CHECK_MAX_ERASE`. */
export const DEFAULT_MAX_ERASE = 50

/** 0 = ran clean. 1 = APPLY refused, or any erase failed. */
export function turnCheckExitCode(report: TurnCheckReport): 0 | 1 {
  return report.refused != null || report.eraseFailed > 0 ? 1 : 0
}

/**
 * Ids only in every line: never turn text.
 *
 * 🔴 TWO GUARDS BEFORE ANY ERASE. Nothing proves the backend and ai-service
 * databases belong to the same environment, and with the wrong DATABASE_URI
 * every turn looks orphaned. So APPLY erases nothing when:
 *   · the backend has 0 messages but ai-service holds `msg-*` docs, unless
 *     `force` (`TURN_CHECK_FORCE=1`);
 *   · the erasable orphans exceed `maxErase` (`TURN_CHECK_MAX_ERASE`, default
 *     50). Setting it explicitly is how an operator raises the cap. `force`
 *     does not lift it.
 */
export async function checkTurnCorpus(
  deps: TurnCheckDeps & { apply: boolean; maxErase?: number; force?: boolean; allTurns?: boolean },
): Promise<TurnCheckReport> {
  const rows = await deps.readTurnRows()
  const candidateIds = [...new Set(rows.map((r) => messageIdOf(r.externalId)).filter((id): id is string => id != null))]
  const existing = candidateIds.length > 0 ? await deps.existingMessageIds(candidateIds) : new Set<string>()
  const orphans = classifyTurnRows(rows, existing)
  const orphanIds = new Set(orphans.map((p) => `${p.corpus}/${p.externalId}`))
  // `allTurns`: every other `msg-<id>` doc too (see the header).
  const problems: TurnProblem[] = deps.allTurns
    ? [
        ...orphans,
        ...rows
          .filter((r) => !orphanIds.has(`${r.corpus}/${r.externalId}`))
          .map((r) => ({
            kind: 'turn' as const,
            corpus: r.corpus,
            org: r.org,
            externalId: r.externalId,
            messageId: messageIdOf(r.externalId) ?? '',
          })),
      ]
    : orphans
  const mismatches = await deps.readValidityMismatches()
  const backendMessages = await deps.countMessages()

  for (const p of problems) deps.log(`${p.kind} corpus=${p.corpus} org=${p.org} doc=${p.externalId}`)
  for (const m of mismatches) {
    deps.log(`validity-mismatch corpus=${m.corpus} org=${m.org} doc=${m.externalId ?? '(none)'} chunks=${m.chunks}`)
  }

  const report: TurnCheckReport = {
    apply: deps.apply,
    turnDocs: rows.length,
    orphanLive: problems.filter((p) => p.kind === 'orphan-live').length,
    orphanStored: problems.filter((p) => p.kind === 'orphan-stored').length,
    validityMismatches: mismatches.length,
    erased: 0,
    eraseFailed: 0,
    skipped: 0,
    backendMessages,
    refused: null,
  }

  const maxErase = deps.maxErase ?? DEFAULT_MAX_ERASE
  const erasable = problems.filter((p) => organizationOfTurnCorpus(p.corpus) != null).length
  const guards: string[] = []
  if (backendMessages === 0 && rows.length > 0 && !deps.force) {
    guards.push(
      `the backend has 0 messages but ai-service holds ${rows.length} msg-* docs: is DATABASE_URI ` +
        'the same environment? Set TURN_CHECK_FORCE=1 if it is',
    )
  }
  if (erasable > maxErase) {
    guards.push(
      `${erasable} ${deps.allTurns ? 'turns' : 'orphans'} to erase, above the cap of ${maxErase}: ` +
        'set TURN_CHECK_MAX_ERASE to raise it',
    )
  }
  for (const g of guards) deps.log(`warning ${g}`)
  if (!deps.apply) return report
  if (guards.length > 0) {
    report.refused = guards.join('; ')
    deps.log('refused: APPLY erased nothing')
    return report
  }

  for (const p of problems) {
    if (organizationOfTurnCorpus(p.corpus) == null) {
      report.skipped += 1
      deps.log(`skipped corpus=${p.corpus} doc=${p.externalId}: not a shared eco-<id> corpus, erase by hand`)
      continue
    }
    try {
      await deps.erase(p.corpus, p.externalId)
      report.erased += 1
      deps.log(`erased corpus=${p.corpus} doc=${p.externalId}`)
    } catch (err) {
      report.eraseFailed += 1
      const status = (err as { status?: unknown } | null)?.status
      deps.log(`erase failed corpus=${p.corpus} doc=${p.externalId}: ${status ?? (err instanceof Error ? err.name : 'unknown')}`)
    }
  }
  return report
}

/**
 * The connection string with every transaction READ ONLY
 * (`default_transaction_read_only`), so the check cannot write to `edc_ai`
 * even by mistake. Erasure goes through the ai-service API, never this.
 */
export function readOnlyUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    // 🔴 Not the original error: Node's carries the whole URL in `input`,
    // password included.
    throw new TypeError('the database URL is not a valid URL (value withheld)')
  }
  // MERGED, not overwritten: an existing `options` (search_path, …) stays.
  const existing = u.searchParams.get('options')?.trim()
  const readOnly = '-c default_transaction_read_only=on'
  u.searchParams.set('options', existing ? `${existing} ${readOnly}` : readOnly)
  return u.toString()
}

/**
 * What `scripts/check-turn-corpus.ts` connects to: BOTH databases read-only,
 * straight from the env, with no Payload boot. 🔴 Booting Payload for a check
 * ran the admin seed, the demo-seed gate, the bucket check and every janitor
 * (edc-1 runbook §4m); read-only then held for `edc_ai` only.
 *
 * Throws naming the missing variable, never a value.
 */
export function turnCheckEnv(env: Record<string, string | undefined>): {
  apply: boolean
  aiUrl: string
  backendUrl: string
  maxErase: number
  force: boolean
  allTurns: boolean
} {
  const ai = env.AI_DATABASE_URL?.trim()
  if (!ai) throw new Error('AI_DATABASE_URL is not set (the ai-service database, edc_ai).')
  const backend = env.DATABASE_URI?.trim()
  if (!backend) throw new Error('DATABASE_URI is not set (the backend database, edc_backend).')
  const rawCap = env.TURN_CHECK_MAX_ERASE?.trim()
  if (rawCap && !/^\d+$/.test(rawCap)) {
    throw new Error('TURN_CHECK_MAX_ERASE must be a whole number of turns (0 or more).')
  }
  return {
    apply: env.TURN_CHECK_APPLY === '1',
    aiUrl: readOnlyUrl(ai),
    backendUrl: readOnlyUrl(backend),
    maxErase: rawCap ? Number(rawCap) : DEFAULT_MAX_ERASE,
    force: env.TURN_CHECK_FORCE === '1',
    allTurns: env.TURN_CHECK_ALL_TURNS === '1',
  }
}

const ANY_DB_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*@[^\s'"]*/gi

/**
 * One printable line for an error, with no secret in it: the name, the code,
 * and the message with every `secrets` value and any `scheme://…@…` URL
 * replaced. 🔴 Never print the error object itself: Node's invalid-URL error
 * carries the full URL, password included, in `input`.
 */
export function describeError(err: unknown, secrets: Array<string | undefined>, depth = 0): string {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown } | null
  const name = err instanceof Error ? err.name : typeof e?.name === 'string' ? e.name : 'Error'
  const code = typeof e?.code === 'string' ? ` ${e.code}` : ''
  let message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error'
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]')
  message = message.replace(ANY_DB_URL, '[redacted-url]')
  // The Postgres error behind a drizzle "Failed query" lives in `cause`: keep
  // its code and redacted message, or the line says nothing useful.
  const cause = e?.cause != null && depth < 3 ? ` <- cause ${describeError(e.cause, secrets, depth + 1)}` : ''
  return `${name}${code}: ${message}${cause}`
}

type Exec = { execute(query: unknown): Promise<unknown> }
const rowsOf = async <T>(db: Exec, query: unknown): Promise<T[]> =>
  ((await db.execute(query)) as { rows?: T[] }).rows ?? []

/** The three readers, over the ai-service database and the backend one. */
export function sqlReaders(
  ai: Exec,
  backend: Exec,
): Pick<TurnCheckDeps, 'readTurnRows' | 'readValidityMismatches' | 'existingMessageIds' | 'countMessages'> {
  return {
    readTurnRows: () => rowsOf<AiTurnRow>(ai, sql.raw(AI_TURN_ROWS_SQL)),
    readValidityMismatches: () => rowsOf<ValidityMismatchRow>(ai, sql.raw(AI_VALIDITY_MISMATCH_SQL)),
    existingMessageIds: async (ids) => {
      const numeric = ids.map(Number).filter(Number.isSafeInteger)
      if (numeric.length === 0) return new Set()
      const found = await rowsOf<{ id: unknown }>(
        backend,
        sql`SELECT id FROM messages WHERE id IN (${sql.join(
          numeric.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
      return new Set(found.map((r) => String(r.id)))
    },
    countMessages: async () => {
      const [r] = await rowsOf<{ n: unknown }>(backend, sql.raw('SELECT count(*)::int AS n FROM messages'))
      return Number(r?.n ?? 0)
    },
  }
}
