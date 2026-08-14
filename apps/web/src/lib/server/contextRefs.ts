/**
 * CANONICAL ref-field mapping — the frontend-server side.
 *
 * The backend stores `sessions.contextScope` and `messages.contextRefs` as
 * polymorphic `hasMany` Payload relationships: each ref is `{ relationTo, value }`
 * where `value` is the numeric entity id (or, with `depth>=1`, the populated
 * entity object). The engine + the FE store speak a neutral `{ kind, id, label }`.
 *
 * This module owns the SINGLE kind↔collection map the FE shares with the engine
 * kind registry, plus the two translations used at the BFF boundary:
 *   - `refsToRelationships`  store/engine refs → Payload `[{relationTo,value}]`
 *     (drops the `org` sentinel: empty IS whole-org per the contract).
 *   - `relationshipsToRefs`  Payload value (ids OR depth>=1 objects) → store refs,
 *     recovering the entity name as `label` when the object is populated.
 *
 * ⚠ Keep `KIND_TO_COLLECTION` identical to the backend's own contextRefs map and
 * to `CHAT_KIND_REGISTRY` (`$lib/engine/registry`). Two kinds only: the tenant
 * organization and uploaded documents.
 */

import type { ContextRef } from '$lib/types';

export type ContextRefCollection = 'organizations' | 'documents';

/** engine kind ⇄ Payload collection slug. The one map both directions read. */
export const KIND_TO_COLLECTION: Record<string, ContextRefCollection> = {
  org: 'organizations',
  document: 'documents',
};

export const COLLECTION_TO_KIND: Record<ContextRefCollection, string> = {
  organizations: 'org',
  documents: 'document',
};

/** The display field that holds an entity's human name, per collection. */
const NAME_FIELD: Record<ContextRefCollection, string> = {
  organizations: 'name',
  documents: 'name',
};

/** Payload polymorphic relationship value at depth 0 (id) or depth ≥1 (object). */
export interface PayloadPolyRef {
  relationTo: string;
  value: number | string | Record<string, unknown>;
}

function isCollection(s: string): s is ContextRefCollection {
  return s in COLLECTION_TO_KIND;
}

/**
 * Map store/engine refs → Payload polymorphic relationship values. The `org`
 * sentinel (and any ref without a numeric id) is dropped: an empty relationship
 * IS whole-org per the contract. Returns `[]` for an org-wide / empty scope.
 */
export function refsToRelationships(refs: ContextRef[] | undefined | null): PayloadPolyRef[] {
  if (!Array.isArray(refs)) return [];
  const out: PayloadPolyRef[] = [];
  for (const ref of refs) {
    if (!ref || ref.kind === 'org') continue;
    const relationTo = KIND_TO_COLLECTION[ref.kind];
    if (!relationTo) continue;
    const value = Number(ref.id);
    if (!Number.isInteger(value)) continue;
    out.push({ relationTo, value });
  }
  return out;
}

/** Pull a numeric id out of a depth-0 id or a depth≥1 populated object. */
function idOf(value: PayloadPolyRef['value']): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return /^\d+$/.test(value) ? Number(value) : null;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === 'number' ? id : typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : null;
  }
  return null;
}

/** Pull the entity name from a depth≥1 populated object, if present. */
function labelOf(collection: ContextRefCollection, value: PayloadPolyRef['value']): string | null {
  if (value && typeof value === 'object') {
    const field = NAME_FIELD[collection];
    const v = (value as Record<string, unknown>)[field];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/**
 * Map Payload polymorphic relationship values → store/engine refs. Recovers the
 * entity name as `label` when the value is a depth≥1 populated object; otherwise
 * falls back to an empty label (the kind registry refines the pill display).
 * Unknown collections are skipped.
 */
export function relationshipsToRefs(value: unknown): ContextRef[] {
  if (!Array.isArray(value)) return [];
  const out: ContextRef[] = [];
  for (const raw of value as PayloadPolyRef[]) {
    if (!raw || typeof raw.relationTo !== 'string' || !isCollection(raw.relationTo)) continue;
    const kind = COLLECTION_TO_KIND[raw.relationTo];
    const id = idOf(raw.value);
    if (id == null) continue;
    const label = labelOf(raw.relationTo, raw.value) ?? '';
    out.push(label ? { kind, id, label } : { kind, id, label: '' });
  }
  return out;
}
