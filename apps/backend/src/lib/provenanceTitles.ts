/**
 * 🔴 STALE TITLES IN SAVED ANSWERS (2026-11-10). `messages.provenance` keeps
 * each citation's title as ai-service returned it at answer time, and the
 * citation card shows it on every later read (`toBrowserProvenance`, web
 * `$lib/server/citationProvenance`). An answer that cited a gated `documento`
 * before its ingest sent {@link documentTitleFor} still names its raw file.
 * This rewrites that title, and only that, to `documentTitleFor(<row now>)`.
 *
 * The citation: `provenance.chunks[i].metadata` (or a bare chunk array, the
 * older shape), its `documents` row in `metadata.docId` (a digit string), its
 * title in `metadata.title`. `documentId` is ai-service's own uuid.
 *
 * Scope: a citation of a `documento` whose title is gated ({@link titleIsGated})
 * and whose stored `title` differs. Nothing else is written:
 *   · an ungated documento, a testimonio, a conversation turn (`msg-…`): left
 *     as is; a stored title that differs from its neutral one is COUNTED;
 *   · a citation of a row that no longer exists: counted;
 *   · 🔴 a message that cites ANY row held for consent ({@link isConsentHeld}):
 *     the whole message is left alone and counted;
 *   · the old title found anywhere else in the message (`content`,
 *     `generationMeta`, another provenance field): REPORTED by message id, never
 *     rewritten (free text).
 *
 * One `jsonb_set` per citation, by path: the rest of the JSON is untouched.
 * Raw SQL, so no Payload hook runs (the conversation ingest hook) and
 * `updatedAt` stays. Batched by message id, one transaction per batch, rows
 * locked `FOR UPDATE` while the batch decides. A citation already right is
 * skipped, so a second run writes nothing. No title is returned or logged: ids
 * and counts only.
 */

import type { sql } from '@payloadcms/db-postgres'

import { documentTitleFor, titleFor, titleIsGated } from './contentKind'
import { isConsentHeld, type ConsentDb } from './consentHold'

type Sql = ReturnType<typeof sql>
const drizzleSql = async () => (await import('@payloadcms/db-postgres')).sql

/** Structural: Payload's `db.drizzle`, or the test harness's drizzle handle. */
export interface ProvenanceDb extends ConsentDb {
  transaction?<T>(run: (tx: ConsentDb) => Promise<T>): Promise<T>
}

export interface ProvenanceTitlesReport {
  apply: boolean
  /** Messages with a provenance read. */
  scanned: number
  /** Messages with at least one stale gated citation (written ones on apply). */
  stale: number[]
  /** Stale gated citations, over {@link stale}. */
  staleCitations: number
  /** Ids written (empty on a dry run). */
  written: number[]
  /** 🔴 Messages left alone because they cite a row held for consent. */
  consentHeld: number[]
  /** Citations of ungated documentos / testimonios / conversation turns whose title is not the neutral one. Not written. */
  openStale: { documento: number; testimonio: number; conversacion: number; other: number }
  /** Citations of a `documents` id with no row. Not written. */
  missingDocument: number
  /** Messages where an old title also appears outside the citation's `title`. Not written. */
  titleElsewhere: number[]
}

export interface ProvenanceTitlesOpts {
  apply: boolean
  /** Only the messages of this ecosistema's sessions. */
  organizationId?: number
  /** Messages per batch (one transaction each). */
  batchSize?: number
}

interface Citation {
  /** The JSON path to `metadata.title`, for `jsonb_set`. */
  path: string[]
  docId: string
  title: unknown
}

interface Fix {
  path: string[]
  title: string
  old: string
}

interface DocRow {
  id: number
  contentKind: unknown
  name: unknown
  anonymise: unknown
  anonymisationReport: unknown
  consentHeld: boolean
}

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  ((result as { rows?: Record<string, unknown>[] })?.rows ?? []) as Record<string, unknown>[]

const asJson = (v: unknown): unknown => {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

/** Every chunk's `metadata.docId` and `metadata.title`, with the path to the title. */
export function citationsOf(provenance: unknown): Citation[] {
  const bare = Array.isArray(provenance)
  const chunks = bare ? provenance : (provenance as { chunks?: unknown } | null)?.chunks
  if (!Array.isArray(chunks)) return []
  const out: Citation[] = []
  chunks.forEach((chunk, i) => {
    const metadata = (chunk as { metadata?: unknown } | null)?.metadata
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return
    const raw = (metadata as { docId?: unknown }).docId
    if (typeof raw !== 'string' && typeof raw !== 'number') return
    const path = [...(bare ? [] : ['chunks']), String(i), 'metadata', 'title']
    out.push({ path, docId: String(raw).trim(), title: (metadata as { title?: unknown }).title })
  })
  return out
}

/** A conversation turn's synthetic id (`conversationIngest.messageIdFromExternalId`). */
const isTurnId = (docId: string): boolean => /^msg-.+$/.test(docId)

async function readDocs(db: ConsentDb, ids: number[]): Promise<Map<string, DocRow>> {
  const out = new Map<string, DocRow>()
  if (ids.length === 0) return out
  const sql = await drizzleSql()
  const found = rowsOf(
    await db.execute(
      sql`SELECT id, content_kind, name, anonymise, anonymisation_report, consent_held
            FROM documents WHERE id IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`,
    ),
  )
  for (const r of found) {
    out.set(String(r.id), {
      id: Number(r.id),
      contentKind: r.content_kind,
      name: r.name,
      anonymise: r.anonymise,
      anonymisationReport: asJson(r.anonymisation_report),
      consentHeld: r.consent_held === true,
    })
  }
  return out
}

/** `needle` as it reads inside a JSON string. */
const jsonInner = (needle: string): string => JSON.stringify(needle).slice(1, -1)

/** Does `needle` occur anywhere in `provenance` but the paths in `skip`? */
function occursOutside(provenance: unknown, skip: string[][], needle: string): boolean {
  const copy = JSON.parse(JSON.stringify(provenance)) as unknown
  for (const path of skip) {
    let node = copy as Record<string, unknown>
    for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>
    delete node[path[path.length - 1]!]
  }
  return JSON.stringify(copy).includes(jsonInner(needle))
}

export async function backfillProvenanceTitles(
  db: ProvenanceDb,
  opts: ProvenanceTitlesOpts,
): Promise<ProvenanceTitlesReport> {
  const sql = await drizzleSql()
  const batchSize = Math.min(Math.max(1, opts.batchSize ?? 200), 1000)
  const report: ProvenanceTitlesReport = {
    apply: opts.apply,
    scanned: 0,
    stale: [],
    staleCitations: 0,
    written: [],
    consentHeld: [],
    openStale: { documento: 0, testimonio: 0, conversacion: 0, other: 0 },
    missingDocument: 0,
    titleElsewhere: [],
  }

  const batch = async (tx: ConsentDb, after: number): Promise<number | null> => {
    const org = opts.organizationId
    const messages = rowsOf(
      await tx.execute(
        sql`SELECT m.id, m.provenance, m.content, m.generation_meta FROM messages m
              ${org === undefined ? sql`` : sql`JOIN sessions s ON s.id = m.session_id AND s.organization_id = ${org}`}
             WHERE m.id > ${after} AND m.provenance IS NOT NULL
             ORDER BY m.id LIMIT ${batchSize}
             ${opts.apply ? sql`FOR UPDATE OF m` : sql``}`,
      ),
    )
    if (messages.length === 0) return null
    const parsed = messages.map((m) => ({
      id: Number(m.id),
      provenance: asJson(m.provenance),
      content: typeof m.content === 'string' ? m.content : '',
      meta: JSON.stringify(asJson(m.generation_meta) ?? null),
    }))
    const cites = parsed.map((m) => citationsOf(m.provenance))
    const ids = [...new Set(cites.flat().map((c) => c.docId).filter((d) => /^\d+$/.test(d)))].map(Number)
    const docs = await readDocs(tx, ids)

    const fixes = new Map<number, Fix[]>()
    parsed.forEach((m, k) => {
      report.scanned += 1
      const citations = cites[k]!
      if (citations.some((c) => isConsentHeld(docs.get(c.docId)))) {
        report.consentHeld.push(m.id)
        return
      }
      const fix: Fix[] = []
      for (const c of citations) {
        if (isTurnId(c.docId)) {
          if (typeof c.title === 'string' && c.title !== titleFor('conversacion')) report.openStale.conversacion += 1
          continue
        }
        if (!/^\d+$/.test(c.docId)) continue
        const row = docs.get(c.docId)
        if (!row) {
          report.missingDocument += 1
          continue
        }
        // Absent title: nothing named, nothing to rewrite.
        if (typeof c.title !== 'string') continue
        const wanted = documentTitleFor(row)
        if (c.title === wanted) continue
        if (row.contentKind === 'documento' && titleIsGated(row.anonymise)) {
          fix.push({ path: c.path, title: wanted, old: c.title })
        } else if (row.contentKind === 'documento') report.openStale.documento += 1
        else if (row.contentKind === 'testimonio') report.openStale.testimonio += 1
        else report.openStale.other += 1
      }
      if (fix.length === 0) return
      fixes.set(m.id, fix)
      report.stale.push(m.id)
      report.staleCitations += fix.length
      const elsewhere = (old: string): boolean =>
        old.trim() !== '' &&
        (m.content.includes(old) ||
          m.meta.includes(jsonInner(old)) ||
          occursOutside(
            m.provenance,
            fix.map((f) => f.path),
            old,
          ))
      if (fix.some((f) => elsewhere(f.old))) report.titleElsewhere.push(m.id)
    })

    if (opts.apply) {
      for (const [id, fix] of fixes) {
        let expr: Sql = sql`provenance`
        let guard: Sql = sql`TRUE`
        for (const f of fix) {
          const path = `{${f.path.join(',')}}`
          expr = sql`jsonb_set(${expr}, ${path}::text[], to_jsonb(${f.title}::text), false)`
          // Still the title this batch read: a concurrent rewrite makes it a no-op.
          guard = sql`${guard} AND provenance #>> ${path}::text[] = ${f.old}`
        }
        const res = rowsOf(
          await tx.execute(sql`UPDATE messages SET provenance = ${expr} WHERE id = ${id} AND ${guard} RETURNING id`),
        )
        if (res.length > 0) report.written.push(id)
      }
    }
    return parsed[parsed.length - 1]!.id
  }

  let after = 0
  for (;;) {
    const step = (tx: ConsentDb) => batch(tx, after)
    const next = opts.apply && typeof db.transaction === 'function' ? await db.transaction(step) : await step(db)
    if (next === null) break
    after = next
  }
  return report
}
