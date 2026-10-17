/**
 * `GET /api/lenguas?organization=<id>` — which languages an ecosistema's
 * PUBLISHED DOCUMENTOS are about, how many of each, and which documento is in
 * which. It backs the "Lengua" filters in `apps/web` (biblioteca, grafo, chat)
 * and the line of the chat's deterministic summary that names them.
 *
 * ── 🔴 WHY A ROUTE, AND NOT `where[lengua]` OVER REST ────────────────────────
 *
 * `documents.lengua` has field `read` access (`lenguaReadable` in
 * `collections/Documents.ts`) that needs the row to decide. Payload checks a
 * `where` path with `getEntityPermissions({ fetchData: false })` — no row — so
 * that check fails closed and EVERY non-override `where[lengua]` is refused
 * (read in `payload@3.88.0`, `database/queryValidation/validateSearchParams.js`).
 * Relaxing `lenguaReadable` to let the query through would weaken the second
 * of the two mechanisms that keep a language off a testimonio. So this route
 * reads with `overrideAccess` and restates the rules itself:
 *
 *   · the caller must belong to the ecosistema (`authoriseOrganization`, the
 *     graph routes' gate — a platform admin may name any, ADR §7.1);
 *   · only `publicationStatus = published` — drafts are their owner's;
 *   · only `contentKind = documento`, in the query AND again in `lenguaIndex`.
 *     On a testimonio `lengua` is a re-identification key (Documents.ts,
 *     `enforceLenguaDocumentoOnly`). The column is null there; this route does
 *     not rely on that.
 *
 * ⚠ NO MINIMUM-SUPPORT THRESHOLD, deliberately. A documento is filed under its
 * author's own name and its text states the language openly (Documents.ts,
 * the `lengua` field). A count of one documento names nobody new.
 */

import type { Endpoint, PayloadRequest } from 'payload'

import { authoriseOrganization } from './graph'
import { jsonResponse, queryParam } from './http'

/**
 * Upper bound on rows read per call. The seeded corpus has 191 documentos with
 * a lengua (quoted: `seed/backfillCorpusLabels.cli.ts` commit c7009ab). Past
 * the cap the response says `truncated: true` rather than undercounting quietly.
 */
export const MAX_LENGUA_ROWS = 5000

export interface LenguaFacet {
  lengua: string
  documentos: number
}

export interface LenguaIndex {
  lenguas: LenguaFacet[]
  documentos: Array<{ id: string; lengua: string }>
}

/**
 * Tally rows into facets plus the per-document map.
 *
 * 🔴 `=== 'documento'`, failing closed, like `lenguaReadable`. An unknown or
 * missing kind drops the row.
 */
export function lenguaIndex(
  rows: ReadonlyArray<{ id?: unknown; contentKind?: unknown; lengua?: unknown }>,
): LenguaIndex {
  const counts = new Map<string, number>()
  const documentos: LenguaIndex['documentos'] = []
  for (const row of rows) {
    if (row.contentKind !== 'documento') continue
    const lengua = typeof row.lengua === 'string' ? row.lengua.trim() : ''
    if (!lengua) continue
    if (typeof row.id !== 'number' && typeof row.id !== 'string') continue
    counts.set(lengua, (counts.get(lengua) ?? 0) + 1)
    documentos.push({ id: String(row.id), lengua })
  }
  const lenguas = [...counts]
    .map(([lengua, documentos]) => ({ lengua, documentos }))
    .sort((a, b) => b.documentos - a.documentos || a.lengua.localeCompare(b.lengua, 'es'))
  return { lenguas, documentos }
}

export const lenguasEndpoint: Endpoint = {
  path: '/lenguas',
  method: 'get',
  handler: async (req: PayloadRequest) => {
    const auth = await authoriseOrganization(req, queryParam(req, 'organization'))
    if (auth instanceof Response) return auth

    const result = await req.payload.find({
      collection: 'documents',
      // 🔴 Every constraint in the query, first. See the header.
      where: {
        and: [
          { organization: { equals: auth.organizationId } },
          { publicationStatus: { equals: 'published' } },
          { contentKind: { equals: 'documento' } },
          { lengua: { exists: true } },
        ],
      },
      // ⚠ `contentKind` beside `lengua`: `lenguaIndex` re-checks it, and the
      // projection would otherwise strip it (Documents.ts, `lenguaReadable`).
      select: { lengua: true, contentKind: true },
      depth: 0,
      limit: MAX_LENGUA_ROWS,
      pagination: false,
      overrideAccess: true,
    })

    const rows = (result.docs ?? []) as Array<{ id?: unknown; contentKind?: unknown; lengua?: unknown }>
    return jsonResponse(
      {
        organizationId: auth.organizationId,
        ...lenguaIndex(rows),
        truncated: rows.length >= MAX_LENGUA_ROWS,
      },
      // A tenant-scoped answer; a shared proxy must not hold it.
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  },
}
