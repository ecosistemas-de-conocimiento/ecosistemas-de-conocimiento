/**
 * ONE DOCUMENT'S ANONYMISATION SCREEN (owner decision 2026-11-07), and the
 * ecosistema re-gate behind Ajustes.
 *
 *   GET   /api/documents/:id/anonimizacion             the view below
 *   PATCH /api/documents/:id/anonimizacion             { keepDocumentAuthor?, keepCitedAuthors?,
 *                                                        keepPublicFigures? } (boolean, or null =
 *                                                        the ecosistema's)
 *   POST  /api/documents/:id/anonimizacion/reintentar  re-run a re-gate that is pending or failed
 *   GET   /api/organizations/:id/anonimizacion         { pendingRegate, regating, unpublishedByRegate }
 *   POST  /api/organizations/:id/anonimizacion/reintentar   202 { started, pendingRegate }
 *
 * 🔴 WHO (audit 2026-11-07, X1-X4): an ACTIVE account, and then the
 * document's uploader or a `holds:review` holder, each with an ACTIVE
 * membership in the document's ecosistema, or an active platform admin. A
 * colleague of the same ecosistema gets 403; anyone without an active
 * membership there gets 404, like a document that does not exist. Checked here, in server code; the switch columns refuse every
 * API write (`gateWritesOnly` in `collections/Documents.ts`), so this is their
 * only writer. 🔴 `keepPublicFigures` is a platform admin's only (owner ruling
 * Q16 A): anyone else sending it gets 403, and it applies to a `documento` only.
 * The view's `editable` says which switches this caller may change (R-09).
 * The ecosistema endpoints (status and "Reintentar"): `organization:manage`
 * there — the responsable since 2026-11-10, the same people who save
 * Ajustes — or a platform admin.
 *
 * 🔴 NEVER A RE-IDENTIFICATION MAP (ADR-0019): the view carries only names the
 * gate LEFT IN (`authorsKept`, `publicFiguresKept`, `citedAuthorsKept`) that the
 * output text still shows, plus counts. Never a removed name, never a name ↔
 * pseudonym pair, never `redactedText`, `heldText` or `extractedText`.
 * 🔴 `name` is the uploaded file name only for a caller who may read it
 * (`mayReadGatedOriginal(…, 'identity')`); anyone else gets the neutral title
 * (`titleFor`): a testimonio's file name may name the speaker (X5).
 * `pendingRegate` is true while the text still keeps a name the current
 * settings would remove (an ecosistema default just turned off, or a re-gate
 * that could not erase): the screen must not say it is gone yet. `retryable`:
 * that, or a re-gate that failed, on a row nobody else is writing right now.
 * `unpublishedByRegate`: a re-gate took it out of the shared corpus and it is
 * still a draft (a participant's upload is published again on its own).
 *
 * ── WHAT A CHANGE DOES ───────────────────────────────────────────────────────
 *
 * Every changed key writes an `anonymisation-setting-changes` row FIRST (who,
 * document, key, before, after; never text).
 *
 *   gate `pending`, publication        409, nothing saved
 *     `publishing` / `unpublishing`
 *   `ready`, `held` or `approved` on   withdrawn from both corpora, both old  `started`
 *     a gated row, and a switch now    copies ERASED and its graph rows
 *     ON that the verdict ran OFF, or  purged, reset with the new switches
 *     now OFF while the verdict kept   in one guarded write, then gated
 *     a name under it (a hold or an    again, detached (`regateDocumentsById`,
 *     approval always counts as kept)  `requireErase`)
 *   the same, but a switch now OFF     saved, and the verdict's `settings`    `not-needed`
 *     under which the `ready` verdict  updated: nothing to remove, nothing
 *     kept nobody (I-02)               unpublished
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
 * never publishes. Anyone else's stays a draft, flagged `unpublishedByRegate`
 * (kept in `anonymisationReport.regate`, re-stamped after the gate rewrites
 * the report).
 * ⚠ An old copy (or graph row) that could not be erased stops the re-gate
 * BEFORE the reset (502): the row keeps its verdict, its copies retired
 * (hidden), the switch IS saved and the failure stamped
 * (`anonymisationReport.regate.failedAt`), so the view offers "Reintentar"
 * (`retryable`) and the 502 says what already changed (I-05).
 * ⚠ An ecosistema default turned OFF re-gates what kept a name under it
 * ({@link regateInheritors}): bounded in-process retries, rows mid-gate
 * waited for, a cap on concurrent gates. A row that still fails stays
 * `pendingRegate`/`retryable`; the ecosistema endpoint counts and retries them.
 * 🔴 Never a draft the re-gate did not unpublish (`draftOutsideRegate`): only
 * its own PATCH re-gates it, and its own "Reintentar" only after that failed.
 */

import type { Endpoint, Payload, PayloadRequest } from 'payload'

import { isActiveUser, isPlatformAdminUser } from '../access'
import { rowMustPassGate } from './anonymiseDocument'
import { CONSENT_HELD_MESSAGE, isConsentHeld, NOT_CONSENT_HELD } from './consentHold'
import { knownContentKind, titleFor, titleIsGated } from './contentKind'
import { errSummary } from './errorSummary'
import { organizationIdsForUser, organizationIdsForUserWithPermission, PERMISSIONS, relationId } from './permissions'
import {
  ANONYMISE_SWITCHES,
  effectiveSwitches,
  keptUnder,
  switchesApply,
  verdictMismatch,
  verdictRecorded,
  verdictSettings,
  type AnonymiseSwitch,
  type EffectiveSwitch,
} from './publicFigures'
import type { CorpusDeleter } from './publishDocument'
import { regateDocumentsById } from './regateDocumentsById'
import { recordSettingChanges } from '../collections/AnonymisationSettingChanges'

type Id = number | string
type Row = Record<string, unknown>
type Switches = Record<AnonymiseSwitch, EffectiveSwitch>

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
  switches: Switches
  /**
   * 🔴 May THIS caller change each switch here (R-09)? The page draws a
   * `false` one read-only and never sends it; the PATCH refuses it anyway.
   * `keepPublicFigures`: a platform admin, on a `documento`. The author
   * switches: anyone who may open this view, on a kind they apply to.
   */
  editable: Record<AnonymiseSwitch, boolean>
  /** True while the stored verdict keeps a name the current switches would remove. */
  pendingRegate: boolean
  /** A failed re-gate, or `pendingRegate` (not on a draft the re-gate did not unpublish), and nobody else is writing the row: "Reintentar". */
  retryable: boolean
  /** A re-gate unpublished it and it is still a draft. */
  unpublishedByRegate: boolean
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
 * 🔴 May this user see and change this document's switches?
 *   `ok`         an active platform admin, or an active account with an
 *                active membership in the document's ecosistema that is its
 *                uploader, or holds `holds:review` there AND the row is held
 *                or published (A-07, audit 2026-11-10: a colleague's private
 *                draft is not a reviewer's to read or re-gate);
 *   `forbidden`  a colleague with an active membership there (403), a
 *                reviewer on a draft that is not held included;
 *   `not-found`  anyone else (404: another ecosistema learns nothing).
 */
export async function controlAccess(payload: Payload, user: unknown, row: Row): Promise<'ok' | 'forbidden' | 'not-found'> {
  if (!user || !isActiveUser(user)) return 'not-found'
  if (isPlatformAdminUser(user)) return 'ok'
  const userId = (user as { id?: unknown }).id
  if (typeof userId !== 'number' && typeof userId !== 'string') return 'not-found'
  const org = relationId(row.organization)
  if (org === null) return 'not-found'
  const same = (ids: Id[]) => ids.some((id) => String(id) === String(org))
  if (!same(await organizationIdsForUser(payload, userId))) return 'not-found'
  const uploader = relationId(row.uploadedBy)
  if (uploader !== null && String(uploader) === String(userId)) return 'ok'
  // 🔴 A-07: a reviewer reaches only what review is for — held or published rows.
  if (row.anonymisationStatus !== 'held' && row.publicationStatus !== 'published') return 'forbidden'
  return same(await organizationIdsForUserWithPermission(payload, userId, PERMISSIONS.holdsReview)) ? 'ok' : 'forbidden'
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

// ── The re-gate's own marks, in `anonymisationReport.regate` ────────────────
//
// ⚠ In the report because `documents` has no column for them and gets none in
// this wave (`collections/Documents.ts` is edc-1's). The gate REWRITES the
// report, which is fine for `failedAt` (a new verdict ends the failure) and is
// why `unpublished` is re-stamped after the gate (`restampUnpublished`).

interface RegateMark {
  /** When a re-gate last failed on this verdict, and how. */
  failedAt?: string
  reason?: 'erase-failed' | 'failed'
  /** A re-gate reset this row from `published`. */
  unpublished?: boolean
}

function reportOf(row: Row): Record<string, unknown> {
  const r = row.anonymisationReport
  return r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : {}
}

function markOf(row: Row): RegateMark {
  const m = reportOf(row).regate
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as RegateMark) : {}
}

function withMark(row: Row, mark: RegateMark | null): Record<string, unknown> {
  const { regate: _old, ...rest } = reportOf(row)
  return mark && Object.keys(mark).length > 0 ? { ...rest, regate: mark } : rest
}

/** Another writer owns the row right now. */
function busy(row: Row): boolean {
  return (
    row.anonymisationStatus === 'pending' ||
    row.publicationStatus === 'publishing' ||
    row.publicationStatus === 'unpublishing'
  )
}

/** A gated row with a verdict the switches acted on. */
function regatable(row: Row): boolean {
  const verdict = row.anonymisationStatus
  return rowMustPassGate(row) && (verdict === 'ready' || verdict === 'held' || verdict === 'approved')
}

/**
 * 🔴 Turned off, and the verdict may still show a name under it: its keep log
 * is non-empty, or it is a hold or an approval (whose logs say nothing: a
 * hold's are cleared, an approval's text is a reviewer's).
 */
function keepsNameUnder(row: Row, key: AnonymiseSwitch): boolean {
  return row.anonymisationStatus !== 'ready' || keptUnder(row, key)
}

/**
 * 🔴 A DRAFT THE RE-GATE DID NOT UNPUBLISH IS NOT THE ECOSISTEMA'S TO RE-GATE
 * (owner rule 2026-11-04, the Semiosis workshop drafts held without their
 * authors' consent; coordinator decision 2026-11-10, audit `taller-2026-11-10`
 * routes #1-#3). Its text must not go to a model because a default changed or
 * someone pressed the ecosistema's "Reintentar": the ecosistema job skips it
 * ({@link settleOne}), the ecosistema count leaves it out
 * ({@link organizationCounts}), and its own "Reintentar" only retries a re-gate
 * that already failed on it ({@link retryableOf}). Only an explicit change on
 * that document (the PATCH) re-gates it. A draft the re-gate itself took out of
 * the shared corpus (`regate.unpublished`) is still the job's (I-01).
 */
function draftOutsideRegate(row: Row): boolean {
  return row.publicationStatus === 'draft' && markOf(row).unpublished !== true
}

/** The stored verdict keeps a name some current switch would remove. */
export function pendingRegateOf(row: Row, switches: Switches): boolean {
  if (!regatable(row)) return false
  return verdictMismatch(row, switches).some((k) => !switches[k].value && keepsNameUnder(row, k))
}

export type RegatePlan = 'none' | 'refresh' | 'regate'

/**
 * 🔴 WHAT A VERDICT NEEDS UNDER THESE SWITCHES (coordinator decision
 * 2026-11-10, I-02):
 *   `regate`   a switch now ON the verdict ran OFF (unless `offOnly`: the
 *              ecosistema job, where OFF→ON reprocesses nothing), or a switch
 *              now OFF under which it kept a name ({@link keepsNameUnder});
 *   `refresh`  only switches now OFF under which the `ready` verdict kept
 *              nobody: nothing to remove, so nothing is withdrawn or
 *              unpublished; its `settings` are brought up to date instead;
 *   `none`     nothing differs, or not a gated verdict.
 */
export function regatePlan(row: Row, switches: Switches, opts: { offOnly?: boolean } = {}): RegatePlan {
  if (!regatable(row)) return 'none'
  let plan: RegatePlan = 'none'
  for (const k of verdictMismatch(row, switches)) {
    if (switches[k].value) {
      if (!opts.offOnly) return 'regate'
      continue
    }
    if (keepsNameUnder(row, k)) return 'regate'
    plan = 'refresh'
  }
  return plan
}

/** The report with `settings` brought to the current OFF values of the switches that kept nobody. */
function refreshedReport(row: Row, switches: Switches): Record<string, unknown> {
  const made = verdictSettings(row)
  const settings: Record<string, boolean> = {
    keepDocumentAuthor: made.keepDocumentAuthor,
    keepCitedAuthors: made.keepCitedAuthors,
  }
  if (verdictRecorded(row, 'keepPublicFigures')) settings.keepPublicFigures = made.keepPublicFigures
  for (const k of verdictMismatch(row, switches)) if (!switches[k].value) settings[k] = false
  return { ...reportOf(row), settings }
}

/**
 * {@link AnonimizacionView.editable}: the same rules the PATCH applies, so the
 * page never offers a switch the PATCH would refuse. `user` already passed
 * {@link controlAccess}.
 */
export function editableSwitches(user: unknown, row: Row): Record<AnonymiseSwitch, boolean> {
  const applies = switchesApply(row.contentKind)
  return {
    keepDocumentAuthor: applies,
    keepCitedAuthors: applies,
    keepPublicFigures: applies && row.contentKind === 'documento' && isPlatformAdminUser(user),
  }
}

export function viewOf(
  row: Row,
  switches: Switches,
  /** `mayReadGatedOriginal(user, row, 'identity')`: false → the neutral title. */
  mayReadName: boolean,
  /** {@link editableSwitches}; omitted = nothing editable (fails closed). */
  editable: Record<AnonymiseSwitch, boolean> = { keepDocumentAuthor: false, keepCitedAuthors: false, keepPublicFigures: false },
): AnonimizacionView {
  const status = statusOf(row)
  // 🔴 Only text every reader of the published document may see: a cleared result.
  const visible = (status === 'ready' || status === 'approved') && typeof row.redactedText === 'string' ? row.redactedText : ''
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  const pendingRegate = pendingRegateOf(row, switches)
  const mark = markOf(row)
  return {
    id: row.id as Id,
    // 🔴 P-13: a gated documento shows its redacted title (else "Documento") to
    // everyone here, its uploader too: this page never shows a removed name.
    name:
      mayReadName && !(knownContentKind(row) === 'documento' && titleIsGated(row.anonymise))
        ? str(row.name)
        : titleFor(knownContentKind(row), null, row),
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
    editable,
    pendingRegate,
    retryable: retryableOf(row, switches, pendingRegate),
    unpublishedByRegate: mark.unpublished === true && row.publicationStatus === 'draft',
  }
}

function retryableOf(row: Row, switches: Switches, pending = pendingRegateOf(row, switches)): boolean {
  const failed = typeof markOf(row).failedAt === 'string'
  return regatable(row) && !busy(row) && (failed || (pending && !draftOutsideRegate(row)))
}

export interface ControlDeps {
  /** Admin client for the ecosistema (retire and erase are admin routes). */
  clientFor: (organizationId: Id) => CorpusDeleter
  /**
   * Gate and ingest one reset row. Must not make the caller wait on the model:
   * the PATCH never awaits what it returns; the ecosistema job uses the
   * returned promise (resolved when the gate is done) to cap concurrent gates.
   */
  startGate: (payload: Payload, row: Row, organizationId: Id) => void | Promise<unknown>
  /** P-02: purge the document's graph rows. Default `purgeDocumentGraph` (`lib/graph/documentGraph.ts`). */
  purgeGraph?: (payload: Payload, documentId: Id) => Promise<unknown>
}

export type ControlResult =
  | { status: 200; body: AnonimizacionView | (AnonimizacionView & { regate: RegateOutcome }) }
  | { status: 400 | 401 | 403 | 404 | 409 | 502; message: string }

/** Lazy: `collections/Documents.ts` mounts this module's endpoints at load. */
async function mayReadName(user: unknown, row: Row): Promise<boolean> {
  const { mayReadGatedOriginal } = await import('@/collections/Documents')
  return mayReadGatedOriginal(user, row as never, 'identity')
}

const NOT_FOUND: ControlResult = { status: 404, message: 'No existe ese documento.' }
const BUSY: ControlResult = { status: 409, message: 'El documento se está procesando. Inténtalo en un momento.' }
const CONFLICT: ControlResult = { status: 409, message: 'El documento cambió mientras se guardaba. Vuelve a intentarlo.' }

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

/**
 * One background write of `anonymisationReport` only (`updateDocumentColumns`:
 * no read-merge-write of the other columns), guarded on the state read.
 */
async function writeReport(payload: Payload, row: Row, report: Record<string, unknown>): Promise<boolean> {
  const { updateDocumentColumns } = await import('./documentColumns')
  const n = await updateDocumentColumns(payload as never, {
    id: row.id as Id,
    data: { anonymisationReport: report },
    where: [
      { anonymisationStatus: { equals: (row.anonymisationStatus as string | null | undefined) ?? null } },
      { publicationStatus: { equals: (row.publicationStatus as string | null | undefined) ?? null } },
    ],
  })
  return n > 0
}

/** Who may run this document's controls: the shared preamble of GET, PATCH and the retry. */
async function loadForControl(
  payload: Payload,
  user: unknown,
  id: string | undefined,
  forbidden: string,
): Promise<{ row: Row; org: Id } | ControlResult> {
  if (!user) return { status: 401, message: 'Inicia sesión.' }
  if (!id) return NOT_FOUND
  const row = await readRow(payload, id)
  if (!row) return NOT_FOUND
  const access = await controlAccess(payload, user, row)
  if (access === 'not-found') return NOT_FOUND
  if (access === 'forbidden') return { status: 403, message: forbidden }
  return { row, org: relationId(row.organization) as Id }
}

const isResult = (v: unknown): v is ControlResult => !!v && typeof v === 'object' && 'status' in v

export async function getAnonimizacion(payload: Payload, user: unknown, id: string | undefined): Promise<ControlResult> {
  const loaded = await loadForControl(payload, user, id, 'No puedes ver la anonimización de este documento.')
  if (isResult(loaded)) return loaded
  const { row, org } = loaded
  return {
    status: 200,
    body: viewOf(row, await effectiveSwitches(payload, org, row), await mayReadName(user, row), editableSwitches(user, row)),
  }
}

/**
 * 🔴 THE 502s SAY WHAT ALREADY CHANGED (audit 2026-11-10, I-05): by the time
 * an erase fails, the copies are retired and the chat no longer finds the
 * document; "nothing was saved" would be false.
 */
function failureMessage(outcome: 'erase-failed' | 'failed', saved: boolean | null): string {
  const prefix = saved === true ? 'Se guardó el cambio, pero ' : saved === false ? 'No se guardó el cambio: ' : ''
  const cap = (s: string) => (prefix ? s : s.charAt(0).toUpperCase() + s.slice(1))
  return outcome === 'erase-failed'
    ? `${prefix}${cap('no se pudieron borrar las copias anteriores. El documento ya no aparece en el chat. Reintenta.')}`
    : `${prefix}${cap('no se pudo volver a anonimizar el documento. Reintenta.')}`
}

export async function patchAnonimizacion(
  payload: Payload,
  user: unknown,
  id: string | undefined,
  rawBody: unknown,
  deps: ControlDeps,
): Promise<ControlResult> {
  const loaded = await loadForControl(payload, user, id, 'No puedes cambiar la anonimización de este documento.')
  if (isResult(loaded)) return loaded
  const { row, org } = loaded
  const patch = parseSwitchPatch(rawBody)
  if (typeof patch === 'string') return { status: 400, message: patch }
  if (!switchesApply(row.contentKind)) {
    return { status: 400, message: 'Estas opciones no aplican a una conversación.' }
  }
  if ('keepPublicFigures' in patch) {
    // 🔴 Owner ruling Q16 A: which public names reach the corpus is the platform's call.
    if (!isPlatformAdminUser(user)) {
      return { status: 403, message: 'Solo la administración de la plataforma cambia esta opción.' }
    }
    if (row.contentKind !== 'documento') return { status: 400, message: 'Esta opción solo aplica a un documento.' }
  }
  // 🔴 Another writer owns the row right now: nothing is saved.
  if (busy(row)) return BUSY
  // 🔴 Held for consent: no re-gate, purge or ingest starts from here (lib/consentHold.ts).
  if (isConsentHeld(row)) return { status: 409, message: CONSENT_HELD_MESSAGE }

  const before = await effectiveSwitches(payload, org, row)
  const next: Row = { ...row, ...patch }
  const after = await effectiveSwitches(payload, org, next)
  const data: Row = {}
  for (const k of ANONYMISE_SWITCHES) if (k in patch) data[k] = patch[k]
  const respond = async (regate: RegateOutcome): Promise<ControlResult> => {
    const fresh = (await readRow(payload, String(row.id))) ?? next
    return { status: 200, body: { ...viewOf(fresh, after, await mayReadName(user, fresh), editableSwitches(user, fresh)), regate } }
  }

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
   * 🔴 WHICH VERDICTS ARE RE-GATED: {@link regatePlan}. A hold or an approval
   * made under other settings must not survive to be released; `rejected` is
   * a human "no" and stays (saved only), as does a row with no verdict yet
   * (the next gate run reads the new values).
   */
  // ⚠ A verdict that did not record `keepPublicFigures` ran under the value in
  // force until this change (or kept somebody under it): assume that, so
  // turning it on for this document re-gates.
  const planned: Row = verdictRecorded(row, 'keepPublicFigures')
    ? row
    : {
        ...row,
        anonymisationReport: {
          ...reportOf(row),
          settings: {
            ...verdictSettings(row),
            keepPublicFigures: before.keepPublicFigures.value || keptUnder(row, 'keepPublicFigures'),
          },
        },
      }
  const plan = regatePlan(planned, after)
  if (plan !== 'regate') {
    const write = plan === 'refresh' ? { ...data, anonymisationReport: { ...reportOf(row), settings: refreshedReport(planned, after).settings } } : data
    if (!(await guarded(payload, row, write))) return CONFLICT
    const changed = ANONYMISE_SWITCHES.some((k) => before[k].value !== after[k].value)
    return respond(!regatable(row) && changed ? 'saved-only' : 'not-needed')
  }
  const outcome = await regateRow(payload, row, data, deps)
  if (outcome === 'conflict') return CONFLICT
  if (outcome === 'started') return respond('started')
  // The switch is saved and the failure stamped, so the view offers "Reintentar".
  const saved = await stampFailure(payload, row, outcome, data)
  return { status: 502, message: failureMessage(outcome, saved) }
}

/**
 * `POST /api/documents/:id/anonimizacion/reintentar` (I-01/I-04): run the
 * re-gate again on a row whose view says `retryable`. Same access as the
 * PATCH; no switch changes, so no audit row.
 */
export async function retryAnonimizacion(
  payload: Payload,
  user: unknown,
  id: string | undefined,
  deps: ControlDeps,
): Promise<ControlResult> {
  const loaded = await loadForControl(payload, user, id, 'No puedes cambiar la anonimización de este documento.')
  if (isResult(loaded)) return loaded
  const { row, org } = loaded
  if (busy(row)) return BUSY
  // 🔴 Held for consent: no re-gate, purge or ingest starts from here (lib/consentHold.ts).
  if (isConsentHeld(row)) return { status: 409, message: CONSENT_HELD_MESSAGE }
  const switches = await effectiveSwitches(payload, org, row)
  if (!retryableOf(row, switches)) return { status: 400, message: 'No hay nada pendiente.' }
  const outcome = await regateRow(payload, row, {}, deps)
  if (outcome === 'conflict') return CONFLICT
  if (outcome === 'started') {
    const fresh = (await readRow(payload, String(row.id))) ?? row
    return {
      status: 200,
      body: { ...viewOf(fresh, switches, await mayReadName(user, fresh), editableSwitches(user, fresh)), regate: 'started' },
    }
  }
  await stampFailure(payload, row, outcome, {})
  return { status: 502, message: failureMessage(outcome, null) }
}

/**
 * Stamp a failed re-gate on the verdict (with `data`, the PATCH's switches, in
 * the same guarded write). Never throws. True when it landed.
 */
async function stampFailure(payload: Payload, row: Row, reason: 'erase-failed' | 'failed', data: Row): Promise<boolean> {
  const report = withMark(row, { ...markOf(row), failedAt: new Date().toISOString(), reason })
  try {
    return Object.keys(data).length > 0
      ? await guarded(payload, row, { ...data, anonymisationReport: report })
      : await writeReport(payload, row, report)
  } catch (err) {
    console.error(`[anonimizacion] doc ${String(row.id)}: could not stamp the failed re-gate:`, errSummary(err))
    return false
  }
}

/**
 * After the gate rewrote the report: put back `regate.unpublished` on a row
 * that is still a draft, so the screen keeps saying why. Never throws.
 */
async function restampUnpublished(payload: Payload, id: Id): Promise<void> {
  try {
    const row = await readRow(payload, String(id))
    if (!row || row.publicationStatus !== 'draft' || markOf(row).unpublished === true) return
    await writeReport(payload, row, withMark(row, { ...markOf(row), unpublished: true }))
  } catch (err) {
    console.error(`[anonimizacion] doc ${String(id)}: could not re-stamp the re-gate's unpublish:`, errSummary(err))
  }
}

/**
 * Withdraw, ERASE both old copies and purge the graph rows (`requireErase`:
 * before the reset), reset with `data` in the same guarded write, then gate
 * again, detached (`regateDocumentsById`). Shared by the PATCH, the retry and
 * the ecosistema job. `track` receives the detached gate's promise (never
 * rejects).
 */
async function regateRow(
  payload: Payload,
  row: Row,
  data: Row,
  deps: ControlDeps,
  track?: (gate: Promise<void>) => void,
): Promise<'started' | 'conflict' | 'erase-failed' | 'failed'> {
  const org = relationId(row.organization) as Id
  const unpublished = row.publicationStatus === 'published' || markOf(row).unpublished === true
  const purge =
    deps.purgeGraph ??
    (async (p: Payload, docId: Id) => {
      const { purgeDocumentGraph } = await import('./graph/documentGraph')
      return purgeDocumentGraph(p, docId)
    })
  const report = await regateDocumentsById(payload, {
    ids: [row.id as Id],
    organizationId: org,
    apply: true,
    allowTestimonio: true,
    client: deps.clientFor(org),
    // A new run: the old failure goes; the unpublish is remembered.
    resetData: { ...data, heldTextHash: null, anonymisationReport: withMark(row, unpublished ? { unpublished: true } : null) },
    requireErase: true,
    purgeGraph: (docId) => purge(payload, docId),
    gate: async (reset) => {
      let started: Promise<unknown>
      try {
        started = Promise.resolve(deps.startGate(payload, reset, org))
      } catch (err) {
        started = Promise.reject(err)
      }
      const done = started
        .then(() => (unpublished ? restampUnpublished(payload, reset.id as Id) : undefined))
        .catch((err) => console.error(`[anonimizacion] doc ${String(reset.id)}: re-gate failed:`, errSummary(err)))
      track?.(done)
    },
  })
  const outcome = report.lines[0]?.outcome
  if (report.lines[0]?.refused === 'in-flight' || outcome === 'changed-meanwhile') return 'conflict'
  if (outcome === 'regated' || outcome === 'withdrawn-only') return 'started'
  if (outcome === 'erase-failed') return 'erase-failed'
  return 'failed'
}

// ── The ecosistema job ──────────────────────────────────────────────────────

const intEnv = (name: string, fallback: number, min: number): number => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= min ? Math.floor(v) : fallback
}

/**
 * The job's knobs, read per run (env):
 *   ANONYMISE_REGATE_CONCURRENCY      gates at once in this process   2
 *   ANONYMISE_REGATE_ATTEMPTS         tries per row                   3
 *   ANONYMISE_REGATE_RETRY_MS         first backoff, then doubled     2000
 *   ANONYMISE_REGATE_PENDING_WAIT_MS  how long to wait on a row       900000 (15 min)
 *                                     whose gate is running
 *   ANONYMISE_REGATE_PENDING_POLL_MS  how often to look at it         3000
 * Defaults inferred, not measured: 2 gates × the detector's 3 chunks in
 * flight (`detector.ts`) stays well under ai-service's 100 requests/min/IP
 * (quoted, `publishJanitor.ts`) and gives the one Spark room.
 */
export function regateTuning() {
  return {
    concurrency: intEnv('ANONYMISE_REGATE_CONCURRENCY', 2, 1),
    attempts: intEnv('ANONYMISE_REGATE_ATTEMPTS', 3, 1),
    retryMs: intEnv('ANONYMISE_REGATE_RETRY_MS', 2000, 0),
    pendingWaitMs: intEnv('ANONYMISE_REGATE_PENDING_WAIT_MS', 15 * 60_000, 0),
    pendingPollMs: intEnv('ANONYMISE_REGATE_PENDING_POLL_MS', 3000, 1),
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 🔴 ONE CAP FOR EVERY ECOSISTEMA JOB IN THE PROCESS (audit 2026-11-10, I-14):
 * `startGate` is detached, so without it N inheritors meant N gates at once.
 */
const gatesInFlight = new Set<Promise<void>>()
async function gateSlot(): Promise<void> {
  while (gatesInFlight.size >= regateTuning().concurrency) await Promise.race(gatesInFlight)
}
function trackGate(gate: Promise<void>, mine: Promise<void>[]): void {
  gatesInFlight.add(gate)
  mine.push(gate)
  void gate.finally(() => gatesInFlight.delete(gate))
}

type SettleOutcome = 'regated' | 'refreshed' | 'none' | 'failed' | 'pending'

/**
 * One row of the ecosistema job: re-read, plan ({@link regatePlan}, OFF only;
 * a stamped failure is always re-gated), and up to `attempts` tries with a
 * doubling backoff. A row mid-gate is handed back (`pending`); a busy row
 * (publishing) waits like a failure. What still fails is stamped.
 */
async function settleOne(payload: Payload, id: Id, org: Id, deps: ControlDeps, mine: Promise<void>[]): Promise<SettleOutcome> {
  const t = regateTuning()
  let last: Row | null = null
  let lastOutcome: 'erase-failed' | 'failed' = 'failed'
  for (let attempt = 1; attempt <= t.attempts; attempt++) {
    const row = await readRow(payload, String(id))
    if (!row) return 'none'
    if (row.anonymisationStatus === 'pending') return 'pending'
    // 🔴 Held for consent: never purged, gated or rebuilt by this job.
    if (isConsentHeld(row)) return 'none'
    // 🔴 Never purged, reset, gated or rebuilt by this job (`draftOutsideRegate`).
    if (draftOutsideRegate(row)) return 'none'
    const switches = await effectiveSwitches(payload, org, row)
    const plan = regatable(row) && typeof markOf(row).failedAt === 'string' ? 'regate' : regatePlan(row, switches, { offOnly: true })
    if (plan === 'none') return 'none'
    last = row
    if (!busy(row)) {
      if (plan === 'refresh') {
        if (await writeReport(payload, row, refreshedReport(row, switches)).catch(() => false)) return 'refreshed'
      } else {
        await gateSlot()
        try {
          const outcome = await regateRow(payload, row, {}, deps, (gate) => trackGate(gate, mine))
          if (outcome === 'started') return 'regated'
          if (outcome !== 'conflict') lastOutcome = outcome
        } catch (err) {
          console.error(`[anonimizacion] doc ${String(id)}: re-gate attempt ${attempt} threw:`, errSummary(err))
        }
      }
    }
    if (attempt < t.attempts) await sleep(t.retryMs * 2 ** (attempt - 1))
  }
  const fresh = (await readRow(payload, String(id))) ?? last
  if (fresh) await stampFailure(payload, fresh, lastOutcome, {})
  return 'failed'
}

/**
 * 🔴 AN ECOSISTEMA DEFAULT TURNED OFF RE-GATES WHAT KEPT A NAME UNDER IT
 * (coordinator decisions 2026-11-07 X7 and 2026-11-10 I-01/I-02/I-03/I-14).
 * Every gated `documento`/`testimonio` of the ecosistema, except a draft the
 * re-gate did not unpublish ({@link draftOutsideRegate}), is planned against
 * its CURRENT effective switches ({@link settleOne}): a verdict that kept a
 * name under a switch now off goes through {@link regateRow}; one that kept
 * nobody only gets its `settings` updated (not unpublished); a stamped
 * failure is re-gated. OFF→ON reprocesses nothing. Started from the
 * `Organizations` afterChange hook (the change itself is audited there) and
 * from the ecosistema's "Reintentar", detached.
 *
 * 🔴 A ROW MID-GATE (`pending`, I-03) is not skipped: its gate read the
 * switches when it started, maybe the old ones. It is waited for (polled,
 * up to `pendingWaitMs`) and, once its verdict lands, planned against the
 * switches in force THEN, like any other: a verdict made under the old value
 * that kept a name is re-gated (withdrawn first if it was auto-published
 * meanwhile), one made under the new value needs nothing. A row still
 * mid-gate at the deadline is left; when its gate ends it shows
 * `pendingRegate` and the ecosistema's count and "Reintentar" pick it up.
 *
 * ⚠ Waits until the new value is readable (the hook runs before the commit),
 * so the gate never re-runs under the old default (`waitForDefault`).
 * ⚠ In process: a restart drops the job (a persistent queue is stage 2); what
 * it had not done stays visible through `pendingRegate`.
 */
export async function regateInheritors(
  payload: Payload,
  organizationId: Id,
  keys: readonly AnonymiseSwitch[],
  deps: ControlDeps,
  opts: { waitForDefault?: boolean } = {},
): Promise<{ regated: Id[]; refreshed: Id[]; failed: Id[]; stillPending: Id[] }> {
  const out = { regated: [] as Id[], refreshed: [] as Id[], failed: [] as Id[], stillPending: [] as Id[] }
  if (keys.length === 0) return out
  const { invalidateFeatures, resolveFeatures } = await import('./features')
  if (opts.waitForDefault !== false) {
    for (let attempt = 0; ; attempt++) {
      const org = (await payload
        .findByID({ collection: 'organizations', id: organizationId as never, depth: 0, overrideAccess: true })
        .catch(() => null)) as { features?: unknown } | null
      if (org && keys.every((k) => resolveFeatures(org.features)[k] === false)) break
      if (attempt >= 20) {
        console.error(`[anonimizacion] ecosistema ${String(organizationId)}: the new default never became readable; nothing re-gated`)
        return out
      }
      await sleep(100)
    }
  }
  invalidateFeatures(organizationId)
  const found = (await payload.find({
    collection: 'documents',
    where: {
      and: [
        { organization: { equals: organizationId } },
        { contentKind: { in: ['documento', 'testimonio'] } },
        { anonymisationStatus: { in: ['ready', 'held', 'approved', 'pending'] } },
        NOT_CONSENT_HELD,
      ],
    },
    depth: 0,
    pagination: false,
    overrideAccess: true,
    select: { id: true },
  } as never)) as unknown as { docs?: Row[] }

  const mine: Promise<void>[] = []
  const tally = (id: Id, r: SettleOutcome) => {
    if (r === 'regated') out.regated.push(id)
    else if (r === 'refreshed') out.refreshed.push(id)
    else if (r === 'failed') out.failed.push(id)
  }
  const waiting: Id[] = []
  for (const { id } of found.docs ?? []) {
    const r = await settleOne(payload, id as Id, organizationId, deps, mine)
    if (r === 'pending') waiting.push(id as Id)
    else tally(id as Id, r)
  }
  const t = regateTuning()
  const deadline = Date.now() + t.pendingWaitMs
  while (waiting.length > 0 && Date.now() < deadline) {
    await sleep(t.pendingPollMs)
    for (const id of [...waiting]) {
      const r = await settleOne(payload, id, organizationId, deps, mine)
      if (r === 'pending') continue
      waiting.splice(waiting.indexOf(id), 1)
      tally(id, r)
    }
  }
  out.stillPending = waiting
  // The job lasts as long as its gates: `regating` stays true meanwhile.
  await Promise.allSettled(mine)
  return out
}

/**
 * Test seam for the hook: the deps the ecosistema job runs with, and its last
 * run so a test can await it. Production leaves `deps` null (the live client).
 */
export const ecosystemRegate: { deps: ControlDeps | null; last: Promise<unknown> } = { deps: null, last: Promise.resolve() }

const running = new Map<string, Promise<void>>()

/** Is an ecosistema job running (or queued) for it in this process? */
export function ecosystemRegating(organizationId: Id): boolean {
  return running.has(String(organizationId))
}

/**
 * Called by the `Organizations` afterChange hook and the ecosistema's retry:
 * detached, never throws. A second call while one runs is queued after it.
 */
export function startEcosystemRegate(
  payload: Payload,
  organizationId: Id,
  keys: readonly AnonymiseSwitch[],
  opts: { waitForDefault?: boolean } = {},
): void {
  if (keys.length === 0) return
  const key = String(organizationId)
  const prev = running.get(key) ?? Promise.resolve()
  const job: Promise<void> = prev.then(
    () =>
      new Promise<void>((resolve) => {
        setImmediate(() => {
          void (async () => regateInheritors(payload, organizationId, keys, ecosystemRegate.deps ?? (await liveDeps()), opts))()
            .then((r) => {
              if (r.failed.length > 0 || r.stillPending.length > 0) {
                console.error(
                  `[anonimizacion] ecosistema ${key}: ${r.failed.length} documents not re-gated, ${r.stillPending.length} still mid-gate`,
                )
              }
            })
            .catch((err) => console.error('[anonimizacion] ecosistema re-gate failed:', errSummary(err)))
            .finally(resolve)
        })
      }),
  )
  running.set(key, job)
  void job.finally(() => {
    if (running.get(key) === job) running.delete(key)
  })
  ecosystemRegate.last = job
}

export interface OrganizationAnonimizacionView {
  /** Gated documents whose verdict still keeps a name the current switches remove, or whose re-gate failed. */
  pendingRegate: number
  /** An ecosistema job is running for it in this process. */
  regating: boolean
  /** Documents a re-gate unpublished that are still drafts. */
  unpublishedByRegate: number
}

type OrgResult =
  | { status: 200 | 202; body: OrganizationAnonimizacionView | { started: boolean; pendingRegate: number } }
  | { status: 401 | 403 | 404; message: string }

/** `organization:manage` in that ecosistema (403 for another member), or a platform admin. */
async function organizationAccess(payload: Payload, user: unknown, id: string | undefined): Promise<OrgResult | null> {
  if (!user) return { status: 401, message: 'Inicia sesión.' }
  const notFound: OrgResult = { status: 404, message: 'No existe ese ecosistema.' }
  if (!id || !isActiveUser(user)) return notFound
  if (isPlatformAdminUser(user)) return null
  const userId = (user as { id?: unknown }).id
  if (typeof userId !== 'number' && typeof userId !== 'string') return notFound
  const has = (ids: Id[]) => ids.some((x) => String(x) === String(id))
  if (!has(await organizationIdsForUser(payload, userId))) return notFound
  if (!has(await organizationIdsForUserWithPermission(payload, userId, PERMISSIONS.organizationManage))) {
    return { status: 403, message: 'No puedes ver la anonimización de este ecosistema.' }
  }
  return null
}

/** The counts behind the ecosistema view. Reads only the columns the plan needs. */
export async function organizationCounts(payload: Payload, organizationId: Id): Promise<{ pendingRegate: number; unpublishedByRegate: number }> {
  const found = (await payload.find({
    collection: 'documents',
    where: {
      and: [
        { organization: { equals: organizationId } },
        { contentKind: { in: ['documento', 'testimonio'] } },
        // 🔴 A row held for consent is never "pending": "Reintentar" never reaches it.
        NOT_CONSENT_HELD,
      ],
    },
    depth: 0,
    pagination: false,
    overrideAccess: true,
    select: {
      organization: true,
      contentKind: true,
      anonymise: true,
      anonymisationStatus: true,
      publicationStatus: true,
      anonymisationReport: true,
      authorsKept: true,
      citedAuthorsKept: true,
      publicFiguresKept: true,
      keepDocumentAuthor: true,
      keepCitedAuthors: true,
      keepPublicFigures: true,
    },
  } as never)) as unknown as { docs?: Row[] }
  let pendingRegate = 0
  let unpublishedByRegate = 0
  for (const row of found.docs ?? []) {
    if (markOf(row).unpublished === true && row.publicationStatus === 'draft') unpublishedByRegate++
    if (!regatable(row) || draftOutsideRegate(row)) continue
    if (typeof markOf(row).failedAt === 'string' || pendingRegateOf(row, await effectiveSwitches(payload, organizationId, row))) {
      pendingRegate++
    }
  }
  return { pendingRegate, unpublishedByRegate }
}

export async function getOrganizationAnonimizacion(payload: Payload, user: unknown, id: string | undefined): Promise<OrgResult> {
  const refused = await organizationAccess(payload, user, id)
  if (refused) return refused
  const counts = await organizationCounts(payload, id as string)
  return { status: 200, body: { ...counts, regating: ecosystemRegating(id as string) } }
}

/** Start the ecosistema job over every pending or failed row, unless one is already running. */
export async function retryOrganizationAnonimizacion(payload: Payload, user: unknown, id: string | undefined): Promise<OrgResult> {
  const refused = await organizationAccess(payload, user, id)
  if (refused) return refused
  const { pendingRegate } = await organizationCounts(payload, id as string)
  const started = !ecosystemRegating(id as string) && pendingRegate > 0
  if (started) startEcosystemRegate(payload, id as string, ANONYMISE_SWITCHES, { waitForDefault: false })
  return { status: 202, body: { started, pendingRegate } }
}

/** The production seam: the ecosistema's admin client, and the ingest pipeline. Exported for its test. */
export async function liveDeps(): Promise<ControlDeps> {
  const { getAdminAIClient } = await import('./aiClient')
  return {
    clientFor: (organizationId) => getAdminAIClient(organizationId) as unknown as CorpusDeleter,
    startGate: (payload, row, organizationId) =>
      new Promise<void>((resolve) => {
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
            // P-02: the graph of the NEW text, through the normal live path.
            const { rebuildDocumentGraph } = await import('./graph/documentGraph')
            await rebuildDocumentGraph(payload, row.id as Id)
          })()
            .catch((err) => {
              console.error('[anonimizacion] re-gate after a switch change failed for doc', row.id, errSummary(err))
            })
            .finally(resolve)
        })
      }),
  }
}
const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

const toResponse = (r: ControlResult | OrgResult): Response =>
  'body' in r ? json(r.body, r.status) : json({ errors: [{ message: r.message }] }, r.status)

const idOf = (req: PayloadRequest) => (req.routeParams as { id?: string } | undefined)?.id

/** Mounted on `documents`: `/api/documents/:id/anonimizacion[/reintentar]`. */
export function anonimizacionEndpoints(deps?: ControlDeps): Endpoint[] {
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
    {
      path: '/:id/anonimizacion/reintentar',
      method: 'post',
      handler: async (req) => toResponse(await retryAnonimizacion(req.payload, req.user, idOf(req), deps ?? (await liveDeps()))),
    },
  ]
}

/** Mounted on `organizations` (`collections/Organizations.ts`): `/api/organizations/:id/anonimizacion[/reintentar]`. */
export function organizationAnonimizacionEndpoints(): Endpoint[] {
  return [
    {
      path: '/:id/anonimizacion',
      method: 'get',
      handler: async (req) => toResponse(await getOrganizationAnonimizacion(req.payload, req.user, idOf(req))),
    },
    {
      path: '/:id/anonimizacion/reintentar',
      method: 'post',
      handler: async (req) => toResponse(await retryOrganizationAnonimizacion(req.payload, req.user, idOf(req))),
    },
  ]
}
