import type { Access, CollectionConfig } from 'payload'

import { GRAPH_RELATION_TYPES } from '../lib/graph/types'

/**
 * AN EDGE, AS ONE DOCUMENT EVIDENCED IT. `plan/adr-corpus-graph.md` §4.1.
 *
 * ⚠ ONE ROW PER `(document, edge)`, NOT ONE ROW PER EDGE. The aggregate across
 * documents is computed at read time. That is what makes an edge's SUPPORT — the
 * number of distinct published documents that evidence it — a `COUNT(DISTINCT
 * document_id)` rather than a number somebody has to keep up to date.
 *
 * 🔴 It is also what makes `GRAPH_MIN_SUPPORT` (default 3) enforceable
 * (ADR §7.3.3). "The testimony that mentions both place X and event Y" is by
 * construction a support-1 edge, and a support-1 edge does not exist as far as
 * any surface of this product is concerned. Collapsing to one row per edge would
 * throw away the only column that answers the question.
 *
 * ── ⚠ SYMMETRIC EDGES ──────────────────────────────────────────────────────
 *
 * `relacionado_con` has no direction. A→B and B→A are the same fact, and stored
 * as two rows they would survive the UNIQUE index (the tuples genuinely differ)
 * and DOUBLE the edge's apparent support — which could push a support-1 edge
 * past the threshold designed to hide it. `lib/graph/writer.ts` orders the two
 * entity ids ascending before insert so the two collapse into one row.
 *
 * ── ACCESS: SERVER-ONLY, INCLUDING READ ────────────────────────────────────
 *
 * Relations are replaced wholesale per document by the extraction pipeline, in
 * the same transaction as that document's mentions, so no write surface is
 * offered.
 *
 * 🔴 READ IS SERVER-ONLY TOO. This table holds rows for UNPUBLISHED documents
 * by design, and — worse — every row here is a SUPPORT-1 EDGE on its own. An
 * org-scoped `read` would hand `GET /api/graphRelations` to every member with
 * `GRAPH_MIN_SUPPORT` bypassed entirely, which is exactly the side door §7.3.3
 * names. The threshold is a `GROUP BY … HAVING`, which Payload access control
 * cannot express; it lives in `lib/graph/queries.ts`. See the header of
 * `GraphEntities.ts` for the full argument.
 *
 * 🔴 `UNIQUE (document_id, from_entity_id, to_entity_id, type)` is hand-written
 * into the migration; see `src/migrations/README.md`.
 */

const serverOnly: Access = () => false

export const GraphRelations: CollectionConfig = {
  slug: 'graphRelations',
  admin: {
    group: 'Grafo',
    useAsTitle: 'id',
    defaultColumns: ['fromEntity', 'type', 'toEntity', 'document', 'organization'],
    description:
      'Relaciones entre nodos, una fila por documento que las evidencia. Escritas únicamente por la extracción.',
  },
  access: {
    // 🔴 Server-only, like the other two. See the header on GraphEntities.ts:
    // Payload access can express one of ADR §6's three gates, and this table
    // holds rows for UNPUBLISHED drafts by design.
    read: serverOnly,
    create: serverOnly,
    update: serverOnly,
    delete: serverOnly,
  },
  fields: [
    {
      /** Denormalised so a tenant-scoped query needs no join. See GraphEntities. */
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { readOnly: true },
    },
    {
      /** 🔴 The evidence. An edge with no document behind it is an assertion. */
      name: 'document',
      type: 'relationship',
      relationTo: 'documents',
      required: true,
      index: true,
      admin: { readOnly: true },
    },
    {
      name: 'fromEntity',
      type: 'relationship',
      relationTo: 'graphEntities',
      required: true,
      index: true,
      admin: { readOnly: true },
    },
    {
      name: 'toEntity',
      type: 'relationship',
      relationTo: 'graphEntities',
      required: true,
      index: true,
      admin: { readOnly: true },
    },
    {
      name: 'type',
      type: 'select',
      required: true,
      index: true,
      options: GRAPH_RELATION_TYPES.map((value) => ({ value, label: value })),
      admin: { readOnly: true },
    },
  ],
}
