import type { Access, CollectionConfig } from 'payload'

/**
 * "THIS DOCUMENT MENTIONS THIS ENTITY." `plan/adr-corpus-graph.md` §4.1.
 *
 * ⚠ ONE ROW PER `(document, entity)` PAIR, NOT PER OCCURRENCE. How often the
 * entity was named inside the document lives in `occurrences`. The distinction
 * is the whole basis of `GRAPH_MIN_SUPPORT` (ADR §7.3.3): support is a count of
 * DISTINCT DOCUMENTS, and a table with one row per occurrence would let a single
 * repetitive testimony look like three independent sources.
 *
 * ⚠ THE LINK TO CONTENT IS `documents.id`, NEVER A CHUNK ID. 🔴
 * `chunks.id` in ai-service is a fresh uuid on every re-ingest
 * (`ingest.worker.ts:270`), so a chunk id is not a stable key and the graph must
 * never store one (ADR §5.5).
 *
 * ── 🔴 `snippet` AND WHY IT IS OFTEN NULL ──────────────────────────────────
 *
 * `snippet` is a short verbatim quotation answering "why is this entity here".
 * It is written ONLY when the source document's `contentKind` is `documento`,
 * and is NULL for a `testimonio` or a `conversacion` (ADR §7.3.4). A verbatim
 * quotation from a testimony is the most direct re-identification surface in the
 * whole design, and the safest thing to do with data that has no product need
 * and a real leak cost is not to have it
 * (`plan/anonimizacion-y-voces.md` §3.2's reasoning, applied here).
 *
 * The gate lives in `lib/graph/writer.ts`, at the last moment before the insert,
 * so no path into this table can bypass it.
 *
 * ── ACCESS: SERVER-ONLY, INCLUDING READ ────────────────────────────────────
 *
 * Writes are server-only because the extraction pipeline replaces a document's
 * mentions WHOLESALE inside one transaction, so an individually edited row
 * would be deleted by the next run.
 *
 * 🔴 READ IS SERVER-ONLY TOO, AND THIS TABLE IS WHY. Extraction runs on DRAFTS
 * (ADR §5.1), so these rows exist for unpublished documents by design — and a
 * `documento` draft's rows carry a verbatim `snippet`. An org-scoped `read`
 * would have published `GET /api/graphMentions` to every member of the
 * ecosistema, which is a same-ecosistema, cross-person read of a colleague's
 * PRIVATE draft: precisely what `visibleToCaller`
 * (`collections/Documents.ts:65-77`) exists to prevent, reached around the side.
 *
 * The published-only gate (ADR §6.2) and minimum support (§7.3.3) are joins and
 * a `HAVING`, which Payload access control cannot express. They live in
 * `lib/graph/queries.ts`, and nothing reads this table until that exists. The
 * full argument is in the header of `GraphEntities.ts`.
 *
 * 🔴 `UNIQUE (document_id, entity_id)` is hand-written into the migration; see
 * `src/migrations/README.md`.
 */

const serverOnly: Access = () => false

export const GraphMentions: CollectionConfig = {
  slug: 'graphMentions',
  admin: {
    group: 'Grafo',
    useAsTitle: 'id',
    defaultColumns: ['document', 'entity', 'occurrences', 'organization'],
    description:
      'Menciones: qué documento nombra qué nodo. Escritas únicamente por la extracción.',
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
      name: 'document',
      type: 'relationship',
      relationTo: 'documents',
      required: true,
      index: true,
      admin: { readOnly: true },
    },
    {
      name: 'entity',
      type: 'relationship',
      relationTo: 'graphEntities',
      required: true,
      index: true,
      admin: { readOnly: true },
    },
    {
      /**
       * ⚠ THIS LANDS IN POSTGRES AS `numeric`, NOT `integer`. ADR §4.1 says
       * integer; Payload's `type: 'number'` has one mapping and that is it.
       *
       * 🔴 Consequence for `lib/graph/queries.ts`: `SUM(occurrences)` over a
       * `numeric` column comes back from `pg` as a STRING, not a number. Coerce
       * it. The bug it causes is silent and shaped like `"12" > 3 === false`.
       *
       * ⚠ Support counts are `COUNT(DISTINCT document_id)` and are unaffected —
       * this column is the per-document tally, never the support figure.
       */
      name: 'occurrences',
      type: 'number',
      required: true,
      defaultValue: 1,
      admin: {
        readOnly: true,
        description: 'Cuántas veces se nombró el nodo en este documento, sumando ventanas.',
      },
    },
    {
      /**
       * 🔴 NULL UNLESS `contentKind = 'documento'`. See the file header — this
       * is a privacy rule, not an optional field.
       */
      name: 'snippet',
      type: 'textarea',
      admin: {
        readOnly: true,
        description:
          'Cita breve que justifica la mención. Vacío salvo en documentos: nunca se guarda para testimonios ni conversaciones.',
      },
    },
  ],
}
