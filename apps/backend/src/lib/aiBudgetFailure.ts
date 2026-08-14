/**
 * ai-service BUDGET failure → user-facing response mapping.
 *
 * WHY THIS MODULE IS PURE
 * -----------------------
 * It deliberately imports NOTHING — not `@edc/ai-client`, not `payload`,
 * not `next/server`. It takes the DUCK-TYPED shape of a thrown ai-client error
 * (`{ status, body }`) and returns plain data. That keeps the mapping, the
 * canonical wording, the ownership predicate and the operator logging unit
 * testable on their own, independent of the client package version.
 *
 * THE WIRE CONTRACT IT DECODES (ai-service)
 * -----------------------------------------
 * `/v1/generate`, `/v1/generate/sync` and `/v1/embed` answer a budget failure
 * with HTTP 402 and a body that is exactly one of:
 *
 *   { error: 'BudgetNotConfigured', org, message }
 *   { error: 'BudgetExceeded', org, requested, remaining, shortfallUsd, message }
 *
 * These two are DIFFERENT operator problems and must never collapse into one:
 * "nobody ever provisioned a budget row for this org" vs "the cap is spent".
 * The user sees the same sentence either way; the operator must not.
 *
 * Endpoints that CANNOT produce a budget failure, so handling them would be
 * dead code:
 *   - `/v1/route`    — fail-safe by design; catches everything, always 200s with
 *                      a fallback decision.
 *   - `/v1/retrieve` — reserves no budget.
 *   - `/v1/ingest`   — reserves no budget (embedding happens later, async, and
 *                      reports through the ai-service callback).
 *
 * ⚠ THIS MODULE CURRENTLY HAS NO CALL SITE IN THIS BACKEND, AND THAT IS
 * EXPECTED — the backend only calls `/v1/ingest`, `/v1/admin/*` and
 * `/v1/capabilities`, none of which reserve budget. Generation happens in
 * `apps/web`, which has its own copy. It is kept here because the ingest path
 * is the obvious next caller: the moment this backend calls a
 * budget-reserving endpoint, the mapping, the wording and the disclosure rule
 * must already exist rather than being reinvented at the call site.
 *
 * 🔴 IT DECODES HTTP 402 ONLY, WHICH IS NOT THE WHOLE WIRE CONTRACT. On
 * `/v1/generate/stream` a budget failure arrives as an SSE `error` FRAME
 * carrying a `code` — there is no 402, because the status line was already sent
 * when streaming began. `classifyAIBudgetFailure` cannot see that and will
 * return `null` for it. Anything that consumes a stream must handle the frame
 * as well as the status. That path lives in `apps/web` today.
 */

/**
 * The ONE user-facing sentence for "ai-service could not serve this request".
 *
 * One sentence, one place. Keep it byte-identical everywhere it is shown.
 *
 * It is deliberately generic: it names no amount, no cap, no org, and no
 * provider. A user cannot act on a budget number that belongs to someone else,
 * and leaking it across tenants would be a disclosure bug (see
 * `isRequesterBudgetOwner`). What the user CAN act on is "go tell whoever runs
 * this", which is exactly what the sentence says.
 */
export const AI_UNAVAILABLE_MESSAGE =
  'El servicio de IA no está disponible. Contacta a la persona que administra el sistema.'

/** Machine-readable code callers branch on. Pairs with `AI_UNAVAILABLE_STATUS`. */
export const AI_UNAVAILABLE_CODE = 'ai_unavailable'

/**
 * HTTP status for a budget failure. 503, NOT 402: the payment problem belongs to
 * the operator, not to the person typing. Deliberately WITHOUT `Retry-After` —
 * we have no idea when someone will top up the cap, and a wrong hint would make
 * clients hammer a service that is going to keep refusing.
 */
export const AI_UNAVAILABLE_STATUS = 503

/** Which of the two budget problems occurred. Never merge these. */
export type BudgetFailureKind = 'not_configured' | 'exceeded'

/** Decoded 402 budget failure. Amounts are absent for `not_configured`. */
export interface AIBudgetFailure {
  kind: BudgetFailureKind
  /** Org the FAILING BUDGET belongs to — not necessarily the requester's org. */
  org: string
  requestedUsd?: number
  remainingUsd?: number
  shortfallUsd?: number
}

/** Operator-facing log line for a missing budget row. */
export const BUDGET_NOT_CONFIGURED_LOG =
  'ai-service budget failure: NO BUDGET CONFIGURED for org — provision a budget row'

/** Operator-facing log line for a spent cap. */
export const BUDGET_EXCEEDED_LOG =
  'ai-service budget failure: BUDGET EXHAUSTED for org — top up the cap'

/** Read a number off an unknown record; undefined when absent or unparseable. */
function num(source: Record<string, unknown>, key: string): number | undefined {
  const raw = source[key]
  if (raw === null || raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function str(source: Record<string, unknown>, key: string): string {
  const raw = source[key]
  return typeof raw === 'string' ? raw : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/**
 * Decode a thrown ai-client error into a budget failure, or `null` when it is
 * not one.
 *
 * DUCK-TYPED ON PURPOSE. `@edc/ai-client` exposes a `BudgetExceededError`
 * class, but (a) it has no class for `BudgetNotConfigured` — that one arrives as
 * a plain `AIServiceError` carrying the raw body — and (b) `instanceof` breaks
 * the moment two copies of the package are resolved. Reading `status` + `body`
 * works for every version and for a hand-rolled `fetch` caller.
 *
 * Fields are read from `body` first (the wire contract) and then from the error
 * object itself, because `BudgetExceededError` also copies them onto the
 * instance.
 *
 * `null` means "not a budget failure" — the caller must fall through to its
 * existing catch-all. A 402 whose discriminator we do not recognise also returns
 * `null` rather than being guessed into one of the two kinds; mislabelling would
 * send an operator to fix the wrong thing.
 */
export function classifyAIBudgetFailure(err: unknown): AIBudgetFailure | null {
  const error = asRecord(err)
  const body = asRecord(error.body)

  const status = Number(error.status)
  const discriminator = str(body, 'error') || str(error, 'error')

  // The discriminator is authoritative; status is a guard so a non-402 error
  // carrying a stray `error` field can never be read as a budget failure. A
  // missing/unparseable status (NaN) is tolerated — some callers rethrow without
  // it — and then the discriminator alone decides.
  if (Number.isFinite(status) && status !== 402) return null

  if (discriminator === 'BudgetNotConfigured') {
    return { kind: 'not_configured', org: str(body, 'org') || str(error, 'org') }
  }

  if (discriminator === 'BudgetExceeded') {
    const failure: AIBudgetFailure = {
      kind: 'exceeded',
      org: str(body, 'org') || str(error, 'org'),
    }
    const requested = num(body, 'requested') ?? num(error, 'requested')
    const remaining = num(body, 'remaining') ?? num(error, 'remaining')
    const shortfall = num(body, 'shortfallUsd') ?? num(error, 'shortfallUsd')
    if (requested !== undefined) failure.requestedUsd = requested
    if (remaining !== undefined) failure.remainingUsd = remaining
    if (shortfall !== undefined) failure.shortfallUsd = shortfall
    return failure
  }

  return null
}

/**
 * May the requester be shown the amounts / limits / org name on this failure?
 *
 * TRUE only when the failing budget is the requester's own. Both keys must be
 * present and equal. An unknown requester (`null`) is NEVER an owner — absence
 * of information is not permission.
 *
 * ⚠ THE FLIP POINT HAS ARRIVED BUT IS NOT WIRED. This predicate used to be
 * documented as permanently false, because the backend it came from was
 * single-org. THIS product is multitenant: `memberships` gives every request a
 * real organization, so a caller CAN now be compared against the org named in a
 * budget failure.
 *
 * It is still unwired, for a reason worth knowing: ai-service derives its `org`
 * from a boot-time API-key map, so every tenant here reaches it under ONE key
 * and one `org` value (see `lib/aiClient.ts`). The org in a budget failure is
 * therefore the KEY's org, not the tenant's — comparing a real membership
 * against it would match everyone or no one. Wire this up when ai-service can
 * attribute spend per tenant, and not before.
 */
export function isRequesterBudgetOwner(
  errOrg: string | null | undefined,
  requesterOrgKey: string | null | undefined,
): boolean {
  const a = (errOrg ?? '').trim()
  const b = (requesterOrgKey ?? '').trim()
  if (!a || !b) return false
  return a === b
}

/** Body shape returned to the caller on a budget failure. */
export interface AIUnavailableBody {
  ok: false
  code: typeof AI_UNAVAILABLE_CODE
  message: string
  /** Owner-only diagnostics. Omitted unless `isRequesterBudgetOwner` is true. */
  budget?: {
    kind: BudgetFailureKind
    org: string
    requestedUsd?: number
    remainingUsd?: number
    shortfallUsd?: number
  }
}

/**
 * Build the response body. `message` is ALWAYS the canonical sentence — the
 * ownership carve-out adds diagnostics, it never rewrites the user-facing text.
 */
export function aiUnavailableBody(
  failure: AIBudgetFailure | null,
  requesterOrgKey: string | null | undefined,
): AIUnavailableBody {
  const base: AIUnavailableBody = {
    ok: false,
    code: AI_UNAVAILABLE_CODE,
    message: AI_UNAVAILABLE_MESSAGE,
  }
  if (!failure || !isRequesterBudgetOwner(failure.org, requesterOrgKey)) return base
  return { ...base, budget: { ...failure } }
}

/** Injectable console seam so tests assert on calls instead of stdout. */
export interface BudgetLogger {
  error: (message: string, fields: Record<string, unknown>) => void
  warn: (message: string, fields: Record<string, unknown>) => void
}

const defaultLogger: BudgetLogger = {
  error: (message, fields) => console.error(message, fields),
  warn: (message, fields) => console.warn(message, fields),
}

/**
 * Log the REAL cause server-side, in full, at `console.error`. The user gets one
 * opaque sentence; the operator must get everything, including which of the two
 * budget problems it is — the fixes are different (provision a row vs top up).
 *
 * Returns the decoded failure so a caller can classify and log in one step, and
 * `null` when `err` was not a budget failure (nothing is logged in that case —
 * the caller's own catch-all owns it).
 */
export function logAIBudgetFailure(
  err: unknown,
  surface: string,
  logger: BudgetLogger = defaultLogger,
): AIBudgetFailure | null {
  const failure = classifyAIBudgetFailure(err)
  if (!failure) return null

  const fields: Record<string, unknown> = {
    err,
    budgetFailure: failure.kind,
    org: failure.org,
    surface,
  }
  if (failure.requestedUsd !== undefined) fields.requestedUsd = failure.requestedUsd
  if (failure.remainingUsd !== undefined) fields.remainingUsd = failure.remainingUsd
  if (failure.shortfallUsd !== undefined) fields.shortfallUsd = failure.shortfallUsd

  logger.error(
    failure.kind === 'not_configured' ? BUDGET_NOT_CONFIGURED_LOG : BUDGET_EXCEEDED_LOG,
    fields,
  )
  return failure
}

/** Advisory flag ai-service rides on generate / generate.sync / embed responses. */
export interface AIResponseWarning {
  code: string
  message: string
}

/**
 * Log ai-service advisory warnings (today only `BUDGET_SOFT_CAP`) once each, at
 * `warn`. A soft-cap warning is the only advance notice an operator gets before
 * requests start failing outright, so dropping it silently costs the one chance
 * to top up before users are affected.
 *
 * NOT WIRED ON THE tabular_query PATH, and that is not an oversight:
 * `@edc/ai-client`'s `textToSql` reduces the `/v1/generate/sync` response
 * to `guardReadOnlySelect(gen.text)` and DISCARDS `gen.warnings` before returning
 * (read in `dist/text-to-sql.js`). Surfacing them there needs a change inside the
 * package, which is out of scope here. This helper is the one-liner that call
 * sites use the moment a warnings-carrying response reaches this backend.
 */
export function logAIWarnings(
  warnings: AIResponseWarning[] | null | undefined,
  surface: string,
  logger: BudgetLogger = defaultLogger,
): void {
  if (!Array.isArray(warnings)) return
  for (const warning of warnings) {
    if (!warning || typeof warning.code !== 'string' || !warning.code) continue
    logger.warn('ai-service warning', {
      aiWarningCode: warning.code,
      aiWarningMessage: typeof warning.message === 'string' ? warning.message : '',
      surface,
    })
  }
}
