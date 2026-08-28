import type { Access, CollectionConfig } from 'payload'

import { GRAPH_ENTITY_TYPES } from '../lib/graph/types'

/**
 * A NODE OF THE CORPUS GRAPH. `plan/adr-corpus-graph.md` §4.1.
 *
 * One row per `(ecosistema, type, canonicalKey)`. Entities are SHARED across
 * the documents of one ecosistema and survive re-extraction — that is what
 * makes "re-run the whole corpus without duplicating nodes" true (ADR §5.5).
 *
 * ── 🔴 NOTHING WRITES THIS THROUGH THE API ─────────────────────────────────
 *
 * `create`, `update` and `delete` are `() => false` for everyone, platform
 * admins included. The only writer is the extraction pipeline
 * (`lib/graph/writer.ts`), which runs server-side with `overrideAccess: true`.
 *
 * That is not tidiness. A hand-edited entity would be silently overwritten by
 * the next re-extraction of any document that mentions it, so an editable node
 * would be a promise the pipeline breaks. If a label ever needs correcting, the
 * mechanism is an alias or a prompt change plus a backfill — not a PATCH.
 *
 * ── 🔴 AND NOTHING READS IT THROUGH THE API EITHER, YET ────────────────────
 *
 * `read` is `() => false` as well, and that is a DELIBERATE narrowing of what
 * this collection was first written with (`withinMyOrganizations()`).
 *
 * ADR §6 requires THREE gates on every shared read of graph data:
 *   1. `organization_id = $1`, named explicitly;
 *   2. `documents.publication_status = 'published'`;
 *   3. minimum support, `GRAPH_MIN_SUPPORT` (default 3).
 *
 * Payload's access control can express the FIRST and only the first. Shipping
 * `withinMyOrganizations()` therefore publishes `GET /api/graphEntities` — and
 * the sibling mention/relation lists — to every member of the ecosistema with
 * gates 2 and 3 missing. Two concrete consequences, both of which the ADR
 * forbids in as many words:
 *
 *   · Graph rows exist for UNPUBLISHED DRAFTS by design (extraction runs on
 *     drafts, §5.1). A member could therefore enumerate the entities and the
 *     `snippet`s of a colleague's private draft — the exact same-ecosistema,
 *     cross-person leak `visibleToCaller` exists to prevent
 *     (`collections/Documents.ts:65-77`).
 *   · Minimum support would be bypassed entirely, which §7.3.3 names as "the
 *     side door that leaks what the view refuses to show".
 *
 * And `withinMyOrganizations()` returns bare `true` for a platform admin, so
 * for that role the list would be unbounded ACROSS ecosistemas — something
 * §6 states does not exist anywhere in this design.
 *
 * Nothing in the product reads these collections yet: the graph view and the
 * GraphRAG endpoint are later steps (§9), and both will read through
 * `lib/graph/queries.ts`, which applies all three gates in SQL. Until that
 * exists, "no reader" is the honest and safe access rule.
 *
 * 🔧 To re-open the Admin UI for operators, this is a one-line change — but
 * gates 2 and 3 come back with it, so it should be a deliberate decision and
 * not a convenience.
 *
 * ⚠ Read access was never the tenant boundary in any case. Every query in
 * `lib/graph/**` names `organization_id` in its own WHERE, and `organization`
 * is denormalised onto this table so it can (ADR §4.1, §6.1).
 *
 * ── 🔴 THE COMPOUND UNIQUE INDEX IS HAND-WRITTEN ───────────────────────────
 *
 * `UNIQUE (organization_id, type, canonical_key)` cannot be expressed in
 * Payload's field config, so it is appended by hand to the migration's `up()`
 * — see `src/migrations/README.md`. It is CORRECTNESS, not tuning: the writer
 * de-duplicates with a find-then-create, and a hook is a check, not a lock. Two
 * concurrent extractions naming the same entity both read "no row" and both
 * write. Only the database can close that.
 */

const serverOnly: Access = () => false

export const GraphEntities: CollectionConfig = {
  slug: 'graphEntities',
  admin: {
    group: 'Grafo',
    useAsTitle: 'label',
    defaultColumns: ['label', 'type', 'organization', 'canonicalKey'],
    description:
      'Nodos del grafo del corpus. Escritos únicamente por la extracción; de sólo lectura aquí.',
  },
  access: {
    // 🔴 See the header. Payload access can express one of ADR §6's three
    // gates; `lib/graph/queries.ts` will express all three, and nothing reads
    // this collection until it does.
    read: serverOnly,
    create: serverOnly,
    update: serverOnly,
    delete: serverOnly,
  },
  fields: [
    {
      /**
       * ⚠ THE ECOSISTEMA, DENORMALISED ON PURPOSE. It is derivable by joining
       * `documents` through `graph_mentions`, and it is carried anyway so every
       * graph query can name the tenant in its own WHERE with no join to get
       * there. `lib/corpus.ts:23-36` argues the general case: structural
       * isolation beats a filter predicate, because a predicate fails open the
       * day someone forgets a clause.
       */
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { readOnly: true, description: 'El ecosistema al que pertenece este nodo.' },
    },
    {
      /**
       * Part of the node's identity, so `Oaxaca` the `lugar` and `Oaxaca` the
       * `organizacion` are two nodes rather than one ambiguous one.
       *
       * ⚠ `persona` EXISTS HERE BUT IS NOT PRODUCIBLE FROM A TESTIMONY. The
       * rule is enforced twice in `lib/graph/` — a response schema without the
       * value, and an unconditional post-filter keyed on
       * `documents.contentKind` (ADR §5.3).
       */
      name: 'type',
      type: 'select',
      required: true,
      index: true,
      options: GRAPH_ENTITY_TYPES.map((value) => ({ value, label: value })),
      admin: { readOnly: true },
    },
    {
      name: 'label',
      type: 'text',
      required: true,
      admin: {
        readOnly: true,
        description: 'Forma para mostrar, en español, tal como se extrajo.',
      },
    },
    {
      /**
       * 🔴 THE IDENTITY COLUMN. `canonicalKey(label)` — see
       * `lib/graph/normalise.ts`, which also documents why `ñ` is preserved
       * while accents are folded.
       */
      name: 'canonicalKey',
      type: 'text',
      required: true,
      index: true,
      admin: {
        readOnly: true,
        description: 'Clave normalizada: sin acentos, en minúsculas. Define la identidad del nodo.',
      },
    },
    {
      name: 'aliases',
      type: 'json',
      admin: {
        readOnly: true,
        description: 'Otras formas superficiales vistas para este nodo.',
      },
    },
  ],
}
