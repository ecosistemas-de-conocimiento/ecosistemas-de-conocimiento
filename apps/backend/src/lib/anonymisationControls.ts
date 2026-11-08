/**
 * ONE DOCUMENT'S ANONYMISATION SCREEN (owner decision 2026-11-07).
 *
 *   GET   /api/documents/:id/anonimizacion   the view below
 *   PATCH /api/documents/:id/anonimizacion   { keepDocumentAuthor?, keepCitedAuthors? }
 *                                            (boolean, or null = the ecosistema's)
 *
 * 🔴 WHO: the document's uploader, anyone holding `holds:review` in the
 * document's ecosistema, and a platform admin. Everyone else gets 403, on GET
 * and PATCH. Checked here, in server code; the two switch columns refuse every
 * API write (`gateWritesOnly` in `collections/Documents.ts`), so this is their
 * only writer.
 *
 * 🔴 NEVER A RE-IDENTIFICATION MAP (ADR-0019): the view carries only names the
 * gate LEFT IN (`authorsKept`, `publicFiguresKept`, `citedAuthorsKept`) that the
 * output text still shows, plus counts. Never a removed name, never a name ↔
 * pseudonym pair, never `redactedText`, `heldText` or `extractedText`.
 *
 * ── WHAT A CHANGE DOES ───────────────────────────────────────────────────────
 *
 * Every changed key writes an `anonymisation-setting-changes` row FIRST (who,
 * document, key, before, after; never text).
 *
 *   gate `pending`, publication        409, nothing saved
 *     `publishing` / `unpublishing`
 *   `ready`, `held` or `approved` on   withdrawn from both corpora, both old  `started`
 *     a gated row, and the new         copies ERASED, reset with the new
 *     effective switches differ from   switches in one guarded write, then
 *     the verdict's (report            gated again, detached
 *     `settings`)                      (`regateDocumentsById`, `requireErase`)
 *   the same, switches equal to the    saved only                             `not-needed`
 *     verdict's
 *   `rejected`, no verdict yet, or     saved only                             `saved-only`
 *     not gated                        (`not-needed` when nothing changed)
 *
 * ⚠ Re-gating a hold re-runs a probabilistic verdict; it happens only when
 * the settings it was made under no longer apply, which also makes the old
 * hold unapprovable (`lib/holdReview.ts` `HoldSettingsChangedError`). An
 * approval made under other settings is re-gated too: its text was cleared
 * with other names in it. A rejection is a human "no" and stays.
 * ⚠ A row that was `published` ends a draft, as `regateDocumentsById` does; a
 * participant's upload is published again by the ingest callback
 * (`lib/autoPublish.ts`) when the new verdict is `ready`. A `held` verdict
 * never publishes.
 * ⚠ An old copy that could not be erased stops the re-gate: the row stays a
 * private, reset draft (502), and nothing re-ingests next to it.
 */

import type { Endpoint, Payload, PayloadRequest } from 'payload'

import { isPlatformAdminUser } from '../access'
import { rowMustPassGate } from './anonymiseDocument'
import { organizationIdsForUserWithPermission, PERMISSIONS, relationId } from './permissions'
import {
  ANONYMISE_SWITCHES,
  effectiveSwitches,
  switchesApply,
  type AnonymiseSwitch,
  type EffectiveSwitch,
} from './publicFigures'
import type { CorpusDeleter } from './publishDocument'
import { regateDocumentsById } from './regateDocumentsById'
import { recordSettingChanges } from '../collections/AnonymisationSettingChanges'

type Id = number | string
type Row = Record<string, unknown>

export type GateStatusView = 'n/a' | 'pending' | 'held' | 'ready' | 'approved' | 'rejected'
const STATUSES: readonly GateStatusView[] = ['n/a', 'pending', 'held', 'ready', 'approved', 'rejected']

export interface AnonimizacionView {
  id: Id
  name: string | null
  contentKind: string | null
  gated: boolean
  publicationStatus: string | null
  status: GateStatusView
  kept: { authors: string[]; publicFigures: string[]; citedAuthors: string[] }
  counts: {
    stages: Array<{ stage: string; removed: number }>
    pseudonyms: number | null
    addresses: number | null
  } | null
  switches: Record<AnonymiseSwitch, EffectiveSwitch>
}

export type RegateOutcome = 'started' | 'not-needed' | 'saved-only'

export type SwitchPatch = Partial<Record<AnonymiseSwitch, boolean | null>>

/** A client's body → the known switches, or a Spanish error. Unknown keys and other values are refused. */
export function parseSwitchPatch(raw: unknown): SwitchPatch | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Faltan las opciones.'
  const out: SwitchPatch = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(ANONYMISE_SWITCHES as readonly string[]).includes(k)) return `Opción desconocida: ${k.slice(0, 40)}`
    if (typeof v !== 'boolean' && v !== null) return `Valor no válido para ${k}.`
    out[k as AnonymiseSwitch] = v
  }
  if (Object.keys(out).length === 0) return 'Faltan las opciones.'
  return out
}

/**
 * 🔴 May this user see and change this document's switches? The uploader, a
 * `holds:review` holder IN THE DOCUMENT'S ECOSISTEMA, or a platform admin.
 */
export async function mayControlAnonymisation(payload: Payload, user: unknown, row: Row): Promise<boolean> {
  if (!user) return false
  if (isPlatformAdminUser(user)) return true
  const userId = (user as { id?: unknown }).id
  if (typeof userId !== 'number' && typeof userId !== 'string') return false
  const uploader = relationId(row.uploadedBy)
  if (uploader !== null && String(uploader) === String(userId)) return true
  const org = relationId(row.organization)
  if (org === null) return false
  const ids = await organizationIdsForUserWithPermission(payload, userId, PERMISSIONS.holdsReview)
  return ids.some((id) => String(id) === String(org))
}

/** The names on a keep log that the visible output text still shows. */
function keptNames(raw: unknown, visible: string): string[] {
  if (!Array.isArray(raw) || !visible) return []
  const names = raw
    .map((e) => (e && typeof e === 'object' ? (e as { name?: unknown }).name : null))
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '' && visible.includes(n))
  return [...new Set(names)]
}

/** Counts only, from a stored `GateReport`. */
function countsOf(raw: unknown): AnonimizacionView['counts'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as { stages?: unknown; pseudonyms?: unknown; addresses?: unknown }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const stages = Array.isArray(r.stages)
    ? r.stages
        .filter((s): s is { stage: string; removed?: unknown } => !!s && typeof (s as { stage?: unknown }).stage === 'string')
        .map((s) => ({
          stage: s.stage,
          removed: Array.isArray(s.removed)
            ? s.removed.reduce((n: number, c) => n + (num((c as { count?: unknown })?.count) ?? 0), 0)
            : 0,
        }))
    : []
  return { stages, pseudonyms: num(r.pseudonyms), addresses: num(r.addresses) }
}

function statusOf(row: Row): GateStatusView {
  const s = row.anonymisationStatus
  return typeof s === 'string' && (STATUSES as readonly string[]).includes(s) ? (s as GateStatusView) : 'n/a'
}

export function viewOf(row: Row, switches: Record<AnonymiseSwitch, EffectiveSwitch>): AnonimizacionView {
  const status = statusOf(row)
  // 🔴 Only text every reader of the published document may see: a cleared result.
  const visible = (status === 'ready' || status === 'approved') && typeof row.redactedText === 'string' ? row.redactedText : ''
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return {
    id: row.id as Id,
    name: str(row.name),
    contentKind: str(row.contentKind),
    gated: rowMustPassGate(row),
    publicationStatus: str(row.publicationStatus),
    status,
    kept: {
      authors: keptNames(row.authorsKept, visible),
      publicFigures: keptNames(row.publicFiguresKept, visible),
      citedAuthors: keptNames(row.citedAuthorsKept, visible),
    },
    counts: countsOf(row.anonymisationReport),
    switches,
  }
}

export interface ControlDeps {
  /** Admin client for the ecosistema (retire and erase are admin routes). */
  clientFor: (organizationId: Id) => CorpusDeleter
  /** Gate and ingest one reset row, DETACHED: must not wait on the model. */
  startGate: (payload: Payload, row: Row, organizationId: Id) => void
}

export type ControlResult =
  | { status: 200; body: AnonimizacionView | (AnonimizacionView & { regate: RegateOutcome }) }
  | { status: 400 | 401 | 403 | 404 | 409 | 502; message: string }

async function readRow(payload: Payload, id: string): Promise<Row | null> {
  return ((await payload
    .findByID({ collection: 'documents', id: id as never, depth: 0, overrideAccess: true })
    .catch(() => null)) as Row | null) ?? null
}

async function guarded(payload: Payload, row: Row, data: Row): Promise<boolean> {
  const res = (await payload.update({
    collection: 'documents',
    where: {
      and: [
        { id: { equals: row.id } },
        { anonymisationStatus: row.anonymisationStatus == null ? { exists: false } : { equals: row.anonymisationStatus } },
        { publicationStatus: { equals: row.publicationStatus } },
      ],
    },
    data,
    depth: 0,
    overrideAccess: true,
    context: { __skipDocsExtract: true },
  } as never)) as unknown as { docs?: Row[] }
  return (res?.docs?.length ?? 0) > 0
}

export async function getAnonimizacion(payload: Payload, user: unknown, id: string | undefined): Promise<ControlResult> {
  if (!user) return { status: 401, message: 'Inicia sesión.' }
  if (!id) return { status: 404, message: 'No existe ese documento.' }
  const row = await readRow(payload, id)
  if (!row) return { status: 404, message: 'No existe ese documento.' }
  if (!(await mayControlAnonymisation(payload, user, row))) {
    return { status: 403, message: 'No puedes ver la anonimización de este documento.' }
  }
  const org = relationId(row.organization) as Id
  return { status: 200, body: viewOf(row, await effectiveSwitches(payload, org, row)) }
}

export async function patchAnonimizacion(
  payload: Payload,
  user: unknown,
  id: string | undefined,
  rawBody: unknown,
  deps: ControlDeps,
): Promise<ControlResult> {
  if (!user) return { status: 401, message: 'Inicia sesión.' }
  if (!id) return { status: 404, message: 'No existe ese documento.' }
  const row = await readRow(payload, id)
  if (!row) return { status: 404, message: 'No existe ese documento.' }
  if (!(await mayControlAnonymisation(payload, user, row))) {
    return { status: 403, message: 'No puedes cambiar la anonimización de este documento.' }
  }
  const patch = parseSwitchPatch(rawBody)
  if (typeof patch === 'string') return { status: 400, message: patch }
  if (!switchesApply(row.contentKind)) {
    return { status: 400, message: 'Estas opciones no aplican a una conversación.' }
  }
  // 🔴 Another writer owns the row right now: nothing is saved.
  if (
    row.anonymisationStatus === 'pending' ||
    row.publicationStatus === 'publishing' ||
    row.publicationStatus === 'unpublishing'
  ) {
    return { status: 409, message: 'El documento se está procesando. Inténtalo en un momento.' }
  }

  const org = relationId(row.organization) as Id
  const before = await effectiveSwitches(payload, org, row)
  const next: Row = { ...row, ...patch }
  const after = await effectiveSwitches(payload, org, next)
  const data: Row = {}
  for (const k of ANONYMISE_SWITCHES) if (k in patch) data[k] = patch[k]
  const respond = async (regate: RegateOutcome): Promise<ControlResult> => {
    const fresh = (await readRow(payload, id)) ?? next
    return { status: 200, body: { ...viewOf(fresh, after), regate } }
  }
  const conflict: ControlResult = { status: 409, message: 'El documento cambió mientras se guardaba. Vuelve a intentarlo.' }

  /**
   * 🔴 THE AUDIT ROW FIRST (audit 2026-11-07, item B), the review log's rule:
   * a row for a change that then did not land (409) is confusing and
   * harmless; a change with no row is not. Raw values: null = the ecosistema's.
   */
  const raw = (v: unknown) => (typeof v === 'boolean' ? v : null)
  const changes = ANONYMISE_SWITCHES.filter((k) => k in patch && raw(row[k]) !== raw(patch[k])).map((key) => ({
    organization: org,
    document: row.id as Id,
    actor: (user as { id?: Id }).id ?? null,
    scope: 'documento' as const,
    key,
    before: raw(row[key]),
    after: raw(patch[key]),
  }))
  if (changes.length > 0) await recordSettingChanges(payload as never, changes)

  /**
   * 🔴 WHICH VERDICTS ARE RE-GATED (audit 2026-11-07, E2): a `ready`, `held`
   * or `approved` gated row whose new effective switches differ from the ones
   * its verdict was made under (the report's `settings`). A hold or an approval
   * made under other settings must not survive to be released; `rejected` is a
   * human "no" and stays (saved only), as does a row with no verdict yet (the
   * next gate run reads the new values).
   */
  const verdict = row.anonymisationStatus
  const regatable = rowMustPassGate(row) && (verdict === 'ready' || verdict === 'held' || verdict === 'approved')
  const made = madeUnder(row)
  const stale = ANONYMISE_SWITCHES.some((k) => after[k].value !== made[k])
  if (!regatable || !stale) {
    if (!(await guarded(payload, row, data))) return conflict
    const changed = ANONYMISE_SWITCHES.some((k) => before[k].value !== after[k].value)
    return respond(!regatable && changed ? 'saved-only' : 'not-needed')
  }

  // Withdraw, ERASE both old copies, reset with the new switches in the same
  // guarded write, then gate again, detached (`regateDocumentsById`).
  const report = await regateDocumentsById(payload, {
    ids: [row.id as Id],
    organizationId: org,
    apply: true,
    allowTestimonio: true,
    client: deps.clientFor(org),
    resetData: { ...data, heldTextHash: null },
    requireErase: true,
    gate: async (reset) => deps.startGate(payload, reset, org),
  })
  const outcome = report.lines[0]?.outcome
  if (report.lines[0]?.refused === 'in-flight' || outcome === 'changed-meanwhile') return conflict
  if (outcome === 'regated' || outcome === 'withdrawn-only') return respond('started')
  if (outcome === 'erase-failed') {
    return {
      status: 502,
      message: 'Se retiró el documento, pero no se pudieron borrar sus copias anteriores. No se volvió a anonimizar.',
    }
  }
  return { status: 502, message: 'No se pudo volver a anonimizar el documento. No se guardó nada.' }
}

/** The switches the row's current verdict was made under; absent = both off (`lib/holdReview.ts`). */
function madeUnder(row: Row): Record<AnonymiseSwitch, boolean> {
  const s = (row.anonymisationReport as { settings?: Partial<Record<AnonymiseSwitch, unknown>> } | null)?.settings
  return { keepDocumentAuthor: s?.keepDocumentAuthor === true, keepCitedAuthors: s?.keepCitedAuthors === true }
}

/** The production seam: the ecosistema's admin client, and the ingest pipeline. */
async function liveDeps(): Promise<ControlDeps> {
  const { getAdminAIClient } = await import('./aiClient')
  return {
    clientFor: (organizationId) => getAdminAIClient(organizationId) as unknown as CorpusDeleter,
    startGate: (payload, row, organizationId) => {
      setImmediate(() => {
        void (async () => {
          const uploadedById = relationId(row.uploadedBy)
          if (uploadedById == null) throw new Error('no uploader on the row')
          const { enqueueIngestForDoc } = await import('@/collections/Documents')
          await enqueueIngestForDoc({
            payload,
            docId: row.id as number,
            organizationId,
            uploadedById,
            fresh: {
              ...(row as Record<string, never>),
              anonymise: row.anonymise ?? null,
              anonymisationStatus: (row.anonymisationStatus as string | null | undefined) ?? null,
              redactedText: (row.redactedText as string | null | undefined) ?? null,
            },
            extractedText: String(row.extractedText),
          })
        })().catch((err) => {
          console.error('[anonimizacion] re-gate after a switch change failed for doc', row.id, err instanceof Error ? err.message : err)
        })
      })
    },
  }
}
const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

const toResponse = (r: ControlResult): Response =>
  r.status === 200 ? json(r.body, 200) : json({ errors: [{ message: r.message }] }, r.status)

/** Mounted on `documents`: `/api/documents/:id/anonimizacion`. */
export function anonimizacionEndpoints(deps?: ControlDeps): Endpoint[] {
  const idOf = (req: PayloadRequest) => (req.routeParams as { id?: string } | undefined)?.id
  return [
    {
      path: '/:id/anonimizacion',
      method: 'get',
      handler: async (req) => toResponse(await getAnonimizacion(req.payload, req.user, idOf(req))),
    },
    {
      path: '/:id/anonimizacion',
      method: 'patch',
      handler: async (req) => {
        let body: unknown
        try {
          body = await req.json?.()
        } catch {
          return toResponse({ status: 400, message: 'El cuerpo no es JSON válido.' })
        }
        return toResponse(await patchAnonimizacion(req.payload, req.user, idOf(req), body, deps ?? (await liveDeps())))
      },
    },
  ]
}
