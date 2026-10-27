/**
 * THE STUDENT VIEW'S READS, as SQL over one ecosistema.
 *
 * Every statement takes `organizationId` and puts it in a `WHERE` on
 * `documents` (and on every other tenant table it reads). The callers in
 * `endpoints/estudiante.ts` decide WHO may ask; this file decides nothing
 * about access, it only never crosses an ecosistema.
 *
 * 🔴 What may leave for someone who is NOT the uploader is entity LABELS from
 * PUBLISHED documents (the graph's own published-only gate) and names of
 * published `documento`s. Never a peer's text, never a draft.
 * The graph's noise gate and no-private-persona gate (`lib/graph/queries.ts`)
 * apply to every mention read here.
 */

import { sql } from '@payloadcms/db-postgres'

import {
  intArray,
  notNoise,
  publicPersonaOnly,
  rowsOf,
  toCount,
  toId,
  toText,
  type GraphQueryPayload,
  type GraphSql,
} from '../graph/queries'

export type StudentDb = GraphQueryPayload

export interface Labelled {
  id: number
  label: string
  docs: number
}

const run = async (p: StudentDb, q: GraphSql) => rowsOf(await p.db.drizzle.execute(q))

const labelled = (r: Record<string, unknown>): Labelled => ({
  id: toId(r.entity_id),
  label: toText(r.label),
  docs: toCount(r.docs),
})

const published = (on: boolean): GraphSql => (on ? sql` AND d.publication_status = 'published'` : sql``)

/**
 * `tema` entities per uploader. `publishedOnly` is false ONLY when the one
 * uploader asked is the caller (their own drafts count for their own topics).
 */
export async function topicsByUser(
  p: StudentDb,
  organizationId: number,
  userIds: readonly number[],
  opts: { publishedOnly: boolean; limit?: number },
): Promise<Map<number, Labelled[]>> {
  const out = new Map<number, Labelled[]>()
  if (userIds.length === 0) return out
  const rows = await run(
    p,
    sql`
    SELECT d.uploaded_by_id AS user_id, e.id AS entity_id, e.label AS label,
           COUNT(DISTINCT d.id)::int AS docs
      FROM graph_mentions m
      JOIN documents d ON d.id = m.document_id AND d.organization_id = ${organizationId}${published(opts.publishedOnly)}
      JOIN graph_entities e ON e.id = m.entity_id AND e.organization_id = ${organizationId}
     WHERE m.organization_id = ${organizationId}
       AND d.uploaded_by_id = ANY(${intArray(userIds)})
       AND e.type = 'tema'${notNoise('e')}${publicPersonaOnly('e')}
     GROUP BY d.uploaded_by_id, e.id, e.label
     ORDER BY docs DESC, e.label ASC`,
  )
  const limit = opts.limit ?? 30
  for (const r of rows) {
    const uid = toId(r.user_id)
    const list = out.get(uid) ?? []
    if (list.length < limit) list.push(labelled(r))
    out.set(uid, list)
  }
  return out
}

/** Public-figure `persona` entities named in the caller's own documentos. */
export async function authorsOfUser(p: StudentDb, organizationId: number, userId: number): Promise<Labelled[]> {
  const rows = await run(
    p,
    sql`
    SELECT e.id AS entity_id, e.label AS label, COUNT(DISTINCT d.id)::int AS docs
      FROM graph_mentions m
      JOIN documents d ON d.id = m.document_id AND d.organization_id = ${organizationId}
      JOIN graph_entities e ON e.id = m.entity_id AND e.organization_id = ${organizationId}
     WHERE m.organization_id = ${organizationId}
       AND d.uploaded_by_id = ${userId}
       AND e.type = 'persona'${notNoise('e')}${publicPersonaOnly('e')}
     GROUP BY e.id, e.label
     ORDER BY docs DESC, e.label ASC
     LIMIT 30`,
  )
  return rows.map(labelled)
}

/**
 * Public-figure `persona` entities in PUBLISHED documents that also mention
 * one of `topicIds` — "authors near my topics". `docs` = shared documents.
 */
export async function authorsNearTopics(
  p: StudentDb,
  organizationId: number,
  topicIds: readonly number[],
  limit = 12,
): Promise<Labelled[]> {
  if (topicIds.length === 0) return []
  const rows = await run(
    p,
    sql`
    SELECT e.id AS entity_id, e.label AS label, COUNT(DISTINCT d.id)::int AS docs
      FROM graph_mentions m
      JOIN documents d ON d.id = m.document_id AND d.organization_id = ${organizationId} AND d.publication_status = 'published'
      JOIN graph_entities e ON e.id = m.entity_id AND e.organization_id = ${organizationId}
     WHERE m.organization_id = ${organizationId}
       AND e.type = 'persona'${notNoise('e')}${publicPersonaOnly('e')}
       AND m.document_id IN (SELECT tm.document_id FROM graph_mentions tm
                              WHERE tm.organization_id = ${organizationId}
                                AND tm.entity_id = ANY(${intArray(topicIds)}))
     GROUP BY e.id, e.label
     ORDER BY docs DESC, e.label ASC
     LIMIT ${limit}`,
  )
  return rows.map(labelled)
}

/** The ecosistema's most-documented topics (published only). */
export async function corpusTopTopics(p: StudentDb, organizationId: number, limit = 25): Promise<Labelled[]> {
  const rows = await run(
    p,
    sql`
    SELECT e.id AS entity_id, e.label AS label, COUNT(DISTINCT d.id)::int AS docs
      FROM graph_mentions m
      JOIN documents d ON d.id = m.document_id AND d.organization_id = ${organizationId} AND d.publication_status = 'published'
      JOIN graph_entities e ON e.id = m.entity_id AND e.organization_id = ${organizationId}
     WHERE m.organization_id = ${organizationId}
       AND e.type = 'tema'${notNoise('e')}${publicPersonaOnly('e')}
     GROUP BY e.id, e.label
     ORDER BY docs DESC, e.label ASC
     LIMIT ${limit}`,
  )
  return rows.map(labelled)
}

export interface DocRef {
  id: number
  name: string
}

/** Published documentos about `topicIds`, not uploaded by `excludeUploader`. */
export async function readingsForTopics(
  p: StudentDb,
  organizationId: number,
  topicIds: readonly number[],
  excludeUploader: number,
  limit = 6,
): Promise<DocRef[]> {
  if (topicIds.length === 0) return []
  const rows = await run(
    p,
    sql`
    SELECT d.id AS id, d.name AS name, COUNT(DISTINCT m.entity_id)::int AS hits
      FROM graph_mentions m
      JOIN documents d ON d.id = m.document_id AND d.organization_id = ${organizationId} AND d.publication_status = 'published'
      JOIN graph_entities e ON e.id = m.entity_id AND e.organization_id = ${organizationId}
     WHERE m.organization_id = ${organizationId}
       AND d.content_kind = 'documento'
       AND d.uploaded_by_id <> ${excludeUploader}
       AND m.entity_id = ANY(${intArray(topicIds)})${notNoise('e')}${publicPersonaOnly('e')}
     GROUP BY d.id, d.name
     ORDER BY hits DESC, d.id DESC
     LIMIT ${limit}`,
  )
  return rows.map((r) => ({ id: toId(r.id), name: toText(r.name) }))
}

/** Every published documento's name — matched against author names in JS. */
export async function publishedDocumentoNames(p: StudentDb, organizationId: number): Promise<DocRef[]> {
  const rows = await run(
    p,
    sql`
    SELECT d.id AS id, d.name AS name FROM documents d
     WHERE d.organization_id = ${organizationId}
       AND d.publication_status = 'published'
       AND d.content_kind = 'documento'
     ORDER BY d.id
     LIMIT 5000`,
  )
  return rows.map((r) => ({ id: toId(r.id), name: toText(r.name) }))
}

export interface OwnDoc {
  id: number
  name: string
  createdAt: string
  status: string
  kind: string
}

/** The uploader's own documents in this ecosistema, newest first. */
export async function documentsOf(p: StudentDb, organizationId: number, userId: number, limit = 100): Promise<OwnDoc[]> {
  const rows = await run(
    p,
    sql`
    SELECT d.id AS id, d.name AS name, d.created_at AS created_at,
           d.publication_status AS status, d.content_kind AS kind
      FROM documents d
     WHERE d.organization_id = ${organizationId} AND d.uploaded_by_id = ${userId}
     ORDER BY d.created_at DESC
     LIMIT ${limit}`,
  )
  return rows.map((r) => ({
    id: toId(r.id),
    name: toText(r.name),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : toText(r.created_at),
    status: toText(r.status),
    kind: toText(r.kind),
  }))
}

/**
 * 🔴 The caller's OWN text, for author-citation extraction. Only ever called
 * with the caller's own id; the text never leaves the server.
 */
export async function ownTexts(p: StudentDb, organizationId: number, userId: number): Promise<string[]> {
  const rows = await run(
    p,
    sql`
    SELECT LEFT(COALESCE(d.redacted_text, d.extracted_text, d.body_markdown, ''), 40000) AS text
      FROM documents d
     WHERE d.organization_id = ${organizationId} AND d.uploaded_by_id = ${userId}
       AND d.content_kind = 'documento'
     ORDER BY d.created_at DESC
     LIMIT 30`,
  )
  return rows.map((r) => toText(r.text)).filter(Boolean)
}

/** Published document ids of these uploaders — the RAG scope. */
export async function publishedDocumentIdsOf(
  p: StudentDb,
  organizationId: number,
  userIds: readonly number[],
): Promise<number[]> {
  if (userIds.length === 0) return []
  const rows = await run(
    p,
    sql`
    SELECT d.id AS id FROM documents d
     WHERE d.organization_id = ${organizationId}
       AND d.publication_status = 'published'
       AND d.uploaded_by_id = ANY(${intArray(userIds)})
     ORDER BY d.id
     LIMIT 500`,
  )
  return rows.map((r) => toId(r.id))
}

/** The caller's own conversation titles in this ecosistema, newest first. */
export async function sessionTitlesOf(p: StudentDb, organizationId: number, userId: number, limit = 20): Promise<string[]> {
  const rows = await run(
    p,
    sql`
    SELECT s.title AS title FROM sessions s
     WHERE s.organization_id = ${organizationId} AND s.user_id = ${userId}
       AND s.title IS NOT NULL AND s.title <> 'New chat' AND s.title <> ''
     ORDER BY COALESCE(s.last_used_at, s.created_at) DESC
     LIMIT ${limit}`,
  )
  return rows.map((r) => toText(r.title))
}

export interface StudentRow {
  id: number
  name: string
}

/**
 * Active `estudiante` members of this ecosistema whose consent flag is on.
 * `flag` is a column name chosen by this file, never by a caller's input.
 * ⚠ `role::text`: the enum may not carry `estudiante` until the roles lane
 * lands; a text comparison is valid either way.
 */
export async function consentingStudents(
  p: StudentDb,
  organizationId: number,
  flag: 'share_with_peers' | 'share_activity',
): Promise<StudentRow[]> {
  const column = flag === 'share_with_peers' ? sql`sp.share_with_peers` : sql`sp.share_activity`
  const rows = await run(
    p,
    sql`
    SELECT u.id AS id, COALESCE(NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(mb.person_name), ''), 'Estudiante') AS name
      FROM student_profiles sp
      JOIN users u ON u.id = sp.user_id AND u.is_active = true
      JOIN memberships mb ON mb.user_id = sp.user_id AND mb.organization_id = ${organizationId}
                         AND mb.is_active = true AND mb.role::text = 'estudiante'
      JOIN organizations o ON o.id = ${organizationId} AND o.is_active = true
     WHERE sp.organization_id = ${organizationId} AND ${column} = true
     ORDER BY name ASC
     LIMIT 500`,
  )
  const seen = new Set<number>()
  const out: StudentRow[] = []
  for (const r of rows) {
    const id = toId(r.id)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: toText(r.name) })
  }
  return out
}
