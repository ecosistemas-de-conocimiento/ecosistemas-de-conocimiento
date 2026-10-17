// The retrieve metadata-filter SQL builder — the ONE place a wire `filter`
// becomes a SQL predicate on `chunks.metadata`. Every retrieval leg (dense,
// lexical/tsvector, sparse) appends the same clause, so a filter means the same
// thing in `dense` and `hybrid` mode and on `/v1/retrieve` and `/v1/retrieve/multi`.
//
// Two shapes per key, both type-sensitive the way jsonb is (`"12"` ≠ `12`):
//   - `key: value`               → jsonb containment, `"metadata" @> {...}`
//                                  (the original behaviour, unchanged).
//   - `key: { "$in": [v1, v2] }` → set membership on that key's value,
//                                  `("metadata" -> key) IN (v1, v2)`.
// Keys combine with AND. A chunk whose `metadata` is NULL, or that lacks a
// filtered key, never matches a non-empty filter.
//
// Validation (non-empty, size cap, element types) lives in the contract
// (`src/contract/rag.ts`); this module assumes a validated filter. Every key
// and value is a BOUND PARAMETER — nothing caller-supplied reaches the SQL text.

import { sql, type SQL } from 'drizzle-orm';

import { isInOperand } from '../../contract/rag.js';

export { IN_OPERATOR, MAX_IN_VALUES, isInOperand } from '../../contract/rag.js';

/**
 * The `AND …` predicate for a retrieve `filter`. Absent or `{}` ⇒ an empty
 * fragment, byte-identical to the behaviour before `filter` existed.
 */
export function metadataFilterClause(filter?: Record<string, unknown>): SQL {
  if (filter === undefined) return sql``;
  const containment: Record<string, unknown> = {};
  const sets: SQL[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (isInOperand(value)) {
      sets.push(
        sql` AND ("metadata" -> ${key}) IN (SELECT jsonb_array_elements(${JSON.stringify(value.$in)}::jsonb))`,
      );
    } else {
      containment[key] = value;
    }
  }
  const parts: SQL[] = [];
  if (Object.keys(containment).length > 0) {
    parts.push(sql` AND "metadata" @> ${JSON.stringify(containment)}::jsonb`);
  }
  parts.push(...sets);
  return sql.join(parts);
}
