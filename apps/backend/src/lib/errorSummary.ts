/**
 * LOG-SAFE ERROR SUMMARIES (P-07, audit 2026-11-10).
 *
 * ⚠ A DATABASE ERROR CARRIES THE ROW. drizzle-orm's `DrizzleQueryError`
 * (drizzle-orm 0.45.2 `errors.js`, the version @payloadcms/db-postgres 3.88
 * resolves) builds its `message` as `Failed query: <sql>\nparams: <params>`,
 * and keeps `query` and `params` as own properties. `stack` starts with that
 * same message. So logging `err`, `err.message`, `String(err)` or `err.stack`
 * on a failed `UPDATE documents SET extracted_text = $1` writes a whole
 * testimony, names included, into the container log.
 *
 * What is safe: the error's class name and the Postgres SQLSTATE (`57P01`,
 * `40P01`, `57014`…), which say what went wrong without saying about whom.
 * `err.name` alone is not enough for drizzle: `DrizzleQueryError` never sets
 * `name`, so it reads `Error`; the constructor name is used instead.
 */

/** A Postgres SQLSTATE: five characters, digits and capitals. */
const SQLSTATE = /^[0-9A-Z]{5}$/

function className(err: object): string {
  const ctor = (err as { constructor?: { name?: unknown } }).constructor
  const ctorName = typeof ctor?.name === 'string' ? ctor.name : ''
  const name = (err as { name?: unknown }).name
  // A subclass that never set `name` (DrizzleQueryError) still says `Error`
  // there; its constructor is the more specific of the two.
  if (ctorName && ctorName !== 'Object' && (name === 'Error' || name === 'error' || typeof name !== 'string')) {
    return ctorName
  }
  return typeof name === 'string' && name ? name : ctorName || 'Error'
}

/** The SQLSTATE of this error or of anything in its `cause` chain. */
function pgCode(err: unknown): string | undefined {
  let cur: unknown = err
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && SQLSTATE.test(code)) return code
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

/** Para logs: nombre del error + código de Postgres si lo hay. NUNCA message, params ni query (DrizzleQueryError mete los params en message). */
export function errSummary(err: unknown): string {
  if (err === null || err === undefined) return String(err)
  if (typeof err !== 'object') return typeof err
  const code = pgCode(err)
  const name = className(err)
  return code ? `${name}(${code})` : name
}

/**
 * Only the `    at fn (file:line:col)` frames of a stack: its first lines
 * repeat the message. Strict on purpose, so a message line that merely
 * starts with "at " is not mistaken for a frame.
 */
const FRAME = /^\s+at (?:.+ \()?(?:file:\/\/|node:|\/|[A-Za-z]:\\|<anonymous>)[^()\n]*?(?::\d+:\d+)?\)?$/
function framesOnly(stack: unknown): string | undefined {
  if (typeof stack !== 'string') return undefined
  const frames = stack.split('\n').filter((line) => FRAME.test(line))
  return frames.length ? frames.join('\n') : undefined
}

/** drizzle's message shape, also when a wrapper copied it into its own message. */
const QUERY_TEXT = /Failed query:|\nparams:/

/**
 * Is this, or anything in its `cause` chain, a database error? Then its text
 * (message, detail, query, params) may quote a row.
 */
export function isDatabaseError(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const e = cur as { query?: unknown; params?: unknown; code?: unknown; message?: unknown }
    if ('query' in e || 'params' in e) return true
    if (typeof e.code === 'string' && SQLSTATE.test(e.code)) return true
    if (typeof e.message === 'string' && QUERY_TEXT.test(e.message)) return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

const REDACTED = '[database error text withheld]'

/**
 * A pino serializer for the `err` key:
 * `logger: { options: { serializers: { err: safeErrSerializer } }, destination: defaultLoggerOptions }`.
 *
 * A DATABASE error (see {@link isDatabaseError}) keeps only its type, its
 * SQLSTATE and its stack frames: no `message`, `query`, `params`, `detail`,
 * `cause` or any other own property. Any other error keeps its message too
 * (truncated), since a Payload validation error is useless without it.
 * A string already chosen by the caller passes, unless it is drizzle's text.
 */
export function safeErrSerializer(err: unknown): unknown {
  if (err === null || err === undefined) return err
  if (typeof err === 'string') return QUERY_TEXT.test(err) ? REDACTED : err
  if (typeof err !== 'object') return { type: typeof err }
  const out: { type: string; code?: string; message?: string; stack?: string } = {
    type: className(err),
  }
  const code = pgCode(err)
  if (code) out.code = code
  if (!isDatabaseError(err)) {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string') out.message = message.slice(0, 500)
  }
  const stack = framesOnly((err as { stack?: unknown }).stack)
  if (stack) out.stack = stack
  return out
}

/**
 * For a log line that used to print `err.message`: the same message for an
 * ordinary error (truncated), {@link errSummary} for a database one.
 */
export function safeErrMessage(err: unknown, max = 300): string {
  if (isDatabaseError(err)) return errSummary(err)
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : errSummary(err)
  return message.slice(0, max)
}
