/**
 * EVAL ITEMS — the question sets the platform admin runs from `/admin/evals`.
 *
 * Two kinds, one row each, per ecosistema:
 *   · `pregunta`   — a chat question. `expectedDocIds` are the documents a good
 *                    retrieval brings back (hit@k); `shouldRefuse` marks a
 *                    question the corpus does not cover. Feeds three measures:
 *                    citation support, retrieval and answer style.
 *   · `privacidad` — a SYNTHETIC text with planted names. `privateNames` must
 *                    leave the text, `publicNames` must stay. Feeds the
 *                    anonymisation-gate measure (`lib/evals/gateScore.ts`).
 *
 * 🔴 PLATFORM ADMIN ONLY, FAIL CLOSED (`isPlatformAdminUser`: active account
 * AND `isPlatformAdmin === true`, like `keepPublicFigures`). No membership role
 * opens it. A privacy text is synthetic by contract, but it is treated as
 * sensitive anyway: nobody else reads it, and a run never copies it
 * (`EvalRuns.results` keeps term verdicts only).
 *
 * `expectedDocIds` is a JSON list of `documents.id`, not a relationship: an
 * eval row must never block or cascade a document delete. A deleted document
 * simply stops being found.
 */
import type { CollectionBeforeValidateHook, CollectionConfig } from 'payload'
import { ValidationError } from 'payload'

import { isPlatformAdmin } from '../access'

export const EVAL_ITEM_KINDS = ['pregunta', 'privacidad'] as const
export type EvalItemKind = (typeof EVAL_ITEM_KINDS)[number]

/** What the gate is told the privacy text is (`GateContentKind`, minus conversations). */
export const EVAL_GATE_KINDS = ['documento', 'testimonio'] as const

const MAX_NAMES = 40
const MAX_DOCS = 10

/** A list of trimmed, distinct, non-empty strings; anything else is dropped. */
export function nameList(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,;]/) : []
  const out: string[] = []
  for (const p of parts) {
    const s = typeof p === 'string' ? p.trim() : ''
    if (s && s.length <= 200 && !out.includes(s)) out.push(s)
  }
  return out.slice(0, MAX_NAMES)
}

/** A list of positive integer document ids; anything else is dropped. */
export function docIdList(raw: unknown): number[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,;]+/) : []
  const out: number[] = []
  for (const p of parts) {
    const n = typeof p === 'number' ? p : typeof p === 'string' && /^\d+$/.test(p.trim()) ? Number(p.trim()) : NaN
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out.slice(0, MAX_DOCS)
}

const normalise: CollectionBeforeValidateHook = ({ data, originalDoc, req }) => {
  const next = { ...(data ?? {}) } as Record<string, unknown>
  const kind = next.kind ?? (originalDoc as Record<string, unknown> | undefined)?.kind
  if ('privateNames' in next) next.privateNames = nameList(next.privateNames)
  if ('publicNames' in next) next.publicNames = nameList(next.publicNames)
  if ('expectedDocIds' in next) next.expectedDocIds = docIdList(next.expectedDocIds)
  const merged = { ...((originalDoc ?? {}) as Record<string, unknown>), ...next }
  const blank = (v: unknown) => typeof v !== 'string' || v.trim() === ''
  if (kind === 'pregunta' && blank(merged.question)) {
    throw new ValidationError({ collection: 'eval-items', errors: [{ path: 'question', message: 'Falta la pregunta.' }], req })
  }
  if (kind === 'privacidad' && blank(merged.text)) {
    throw new ValidationError({ collection: 'eval-items', errors: [{ path: 'text', message: 'Falta el texto.' }], req })
  }
  return next
}

export const EvalItems: CollectionConfig = {
  slug: 'eval-items',
  admin: { group: 'Evaluaciones', useAsTitle: 'question', defaultColumns: ['organization', 'kind', 'question', 'updatedAt'] },
  access: { read: isPlatformAdmin, create: isPlatformAdmin, update: isPlatformAdmin, delete: isPlatformAdmin },
  hooks: { beforeValidate: [normalise] },
  fields: [
    { name: 'organization', type: 'relationship', relationTo: 'organizations', required: true, index: true },
    {
      name: 'kind',
      type: 'select',
      required: true,
      options: EVAL_ITEM_KINDS.map((value) => ({ value, label: value })),
    },
    { name: 'question', type: 'textarea', maxLength: 2000 },
    { name: 'expectedDocIds', type: 'json' },
    { name: 'shouldRefuse', type: 'checkbox', defaultValue: false },
    { name: 'notes', type: 'textarea', maxLength: 2000 },
    /** Synthetic only. Never copied into a run. */
    { name: 'text', type: 'textarea', maxLength: 20000 },
    { name: 'privateNames', type: 'json' },
    { name: 'publicNames', type: 'json' },
    {
      name: 'gateKind',
      type: 'select',
      defaultValue: 'documento',
      options: EVAL_GATE_KINDS.map((value) => ({ value, label: value })),
    },
  ],
}
