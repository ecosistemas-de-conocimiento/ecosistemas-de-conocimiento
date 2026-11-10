/**
 * 🔴 STALE TITLES IN AI-SERVICE (P-13 follow-up, 2026-11-10). A gated
 * `documento` ingested before commit 018eec27 still carries the uploader's raw
 * file name in ai-service: on the document row and on every chunk's
 * `metadata.title`, which is what a chat citation shows. Since then every
 * ingest sends {@link documentTitleFor}. This rewrites the copies already
 * there, through `PATCH /v1/corpus/:name/titles`, which touches the title only:
 * no text is sent, nothing is re-embedded.
 *
 * Scope, per ecosistema: every PUBLISHED, non-revision row that is a gated
 * `documento` ({@link titleIsGated}) or a `testimonio`; its shared-corpus copy
 * and, when the uploader has one, its draft-corpus copy (retired by the publish
 * move, still there). Ungated documentos keep their name by design and are
 * not touched. Conversation turns are not `documents` rows (measured 0 stale on
 * dev, 2026-11-10).
 *
 * 🔴 Never selected: a row held for consent ({@link notConsentHeldSql},
 * {@link isConsentHeld}), and any draft — which covers every draft of
 * ecosistema 8 (the workshop rows, unpublished until their authors consent).
 * {@link inScope} re-checks both on each row the query returns.
 *
 * Every call asks first with `dryRun` and, with `apply`, then sends only the
 * documents ai-service reported as `changed`: a row already right is skipped
 * and a second run writes nothing. No title is logged: ids and counts only.
 */

import type { sql } from '@payloadcms/db-postgres'

import { documentTitleFor, titleIsGated } from './contentKind'
import { isConsentHeld, notConsentHeldSql, type ConsentDb } from './consentHold'
import { draftCorpus, publishedCorpus } from './corpus'

type Sql = ReturnType<typeof sql>
const drizzleSql = async () => (await import('@payloadcms/db-postgres')).sql

export interface TitleRow {
  id: number
  organizationId: number
  uploadedBy: number | null
  contentKind: string | null
  publicationStatus: string | null
  consentHeld: boolean
  anonymise: boolean | null
  name: string | null
  redactedTitle: unknown
}

/**
 * The per-row guard, on top of the query's WHERE. Published only: no draft of
 * any ecosistema, so none of ecosistema 8's.
 */
export function inScope(row: TitleRow): boolean {
  if (isConsentHeld(row)) return false
  if (row.publicationStatus !== 'published') return false
  if (row.contentKind === 'testimonio') return true
  return row.contentKind === 'documento' && titleIsGated(row.anonymise)
}

/** The title every ingest sends for this row today. */
export function wantedTitle(row: TitleRow): string {
  return documentTitleFor({
    contentKind: row.contentKind,
    name: row.name,
    anonymise: row.anonymise,
    anonymisationReport: row.redactedTitle === undefined ? null : { redactedTitle: row.redactedTitle },
  })
}

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  ((result as { rows?: Record<string, unknown>[] })?.rows ?? []) as Record<string, unknown>[]

export async function selectTitleRows(db: ConsentDb, organizationId?: number): Promise<TitleRow[]> {
  const sql = await drizzleSql()
  const parts: Sql[] = [
    sql`publication_status = 'published'`,
    sql`revision_of_id IS NULL`,
    sql.raw(notConsentHeldSql()),
    sql`(content_kind = 'testimonio' OR (content_kind = 'documento' AND anonymise IS NOT FALSE))`,
  ]
  if (organizationId !== undefined) parts.push(sql`organization_id = ${organizationId}`)
  const found = rowsOf(
    await db.execute(
      sql`SELECT id, organization_id, uploaded_by_id, content_kind, publication_status, consent_held,
                 anonymise, name, anonymisation_report->'redactedTitle' AS redacted_title
            FROM documents WHERE ${sql.join(parts, sql` AND `)} ORDER BY organization_id, id`,
    ),
  )
  return found
    .map((r) => ({
      id: Number(r.id),
      organizationId: Number(r.organization_id),
      uploadedBy: r.uploaded_by_id === null || r.uploaded_by_id === undefined ? null : Number(r.uploaded_by_id),
      contentKind: (r.content_kind as string | null) ?? null,
      publicationStatus: (r.publication_status as string | null) ?? null,
      consentHeld: r.consent_held === true,
      anonymise: (r.anonymise as boolean | null) ?? null,
      name: (r.name as string | null) ?? null,
      redactedTitle: r.redacted_title ?? undefined,
    }))
    .filter(inScope)
}

/** Structural: `client.admin` of `@edc/ai-client`. */
export interface TitlesClient {
  setDocumentTitles(
    corpus: string,
    documents: Array<{ externalId: string; title: string }>,
    opts?: { dryRun?: boolean },
  ): Promise<{ documents: Array<{ externalId: string; changed: boolean; chunksChanged: number }>; notFound: string[] }>
}

export interface CorpusReport {
  organizationId: number
  /** `shared` or `draft`; the corpus name is not logged (it carries a user id). */
  copy: 'shared' | 'draft'
  sent: number
  /** Document ids whose ai-service title differed. */
  changed: number[]
  chunksChanged: number
  notFound: number
  /** True when ai-service has no such corpus. */
  missingCorpus: boolean
}

export interface RefreshTitlesReport {
  apply: boolean
  selected: number
  corpora: CorpusReport[]
  /** Ids written (0 on a dry run). */
  written: number[]
}

export interface RefreshTitlesOpts {
  apply: boolean
  organizationId?: number
  /** Documents per call; ai-service accepts up to 200. */
  batchSize?: number
  /** Pause after every ai-service call (the /v1 cap is 100 requests/min per key). */
  delayMs?: number
  clientFor: (organizationId: number) => TitlesClient
  sleep?: (ms: number) => Promise<void>
}

/** `@edc/ai-client`'s `NotFoundError` (`CORPUS_NOT_FOUND`): a draft corpus that was never created. */
const isNotFound = (err: unknown): boolean => (err as { status?: unknown } | null)?.status === 404

export async function refreshAiTitles(db: ConsentDb, opts: RefreshTitlesOpts): Promise<RefreshTitlesReport> {
  const batchSize = Math.min(Math.max(1, opts.batchSize ?? 100), 200)
  const delayMs = opts.delayMs ?? 1000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const rows = await selectTitleRows(db, opts.organizationId)

  // corpus → (copy, org, rows)
  const groups = new Map<string, { copy: 'shared' | 'draft'; organizationId: number; rows: TitleRow[] }>()
  const add = (corpus: string, copy: 'shared' | 'draft', row: TitleRow) => {
    const g = groups.get(corpus) ?? { copy, organizationId: row.organizationId, rows: [] }
    g.rows.push(row)
    groups.set(corpus, g)
  }
  for (const row of rows) {
    add(publishedCorpus(row.organizationId), 'shared', row)
    if (row.uploadedBy !== null) add(draftCorpus(row.organizationId, row.uploadedBy), 'draft', row)
  }

  const report: RefreshTitlesReport = { apply: opts.apply, selected: rows.length, corpora: [], written: [] }
  for (const [corpus, g] of groups) {
    const client = opts.clientFor(g.organizationId)
    const r: CorpusReport = {
      organizationId: g.organizationId,
      copy: g.copy,
      sent: 0,
      changed: [],
      chunksChanged: 0,
      notFound: 0,
      missingCorpus: false,
    }
    report.corpora.push(r)
    for (let i = 0; i < g.rows.length && !r.missingCorpus; i += batchSize) {
      const batch = g.rows.slice(i, i + batchSize).map((row) => ({ externalId: String(row.id), title: wantedTitle(row) }))
      r.sent += batch.length
      let probe
      try {
        probe = await client.setDocumentTitles(corpus, batch, { dryRun: true })
      } catch (err) {
        if (!isNotFound(err)) throw err
        r.missingCorpus = true
        r.notFound += batch.length
        break
      } finally {
        await sleep(delayMs)
      }
      r.notFound += probe.notFound.length
      const changed = new Set(probe.documents.filter((d) => d.changed).map((d) => d.externalId))
      r.chunksChanged += probe.documents.reduce((n, d) => n + (d.changed ? d.chunksChanged : 0), 0)
      r.changed.push(...[...changed].map(Number))
      if (!opts.apply || changed.size === 0) continue
      const res = await client.setDocumentTitles(
        corpus,
        batch.filter((d) => changed.has(d.externalId)),
        { dryRun: false },
      )
      await sleep(delayMs)
      report.written.push(...res.documents.filter((d) => d.changed).map((d) => Number(d.externalId)))
    }
  }
  return report
}
