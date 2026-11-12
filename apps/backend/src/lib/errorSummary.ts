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
 * What is safe: the error's class name, the Postgres SQLSTATE (`57P01`,
 * `40P01`, `57014`…) and a Node system error's `code`, `errno` and `syscall`
 * (`ECONNREFUSED`, -111, `connect`), which say what went wrong without saying
 * about whom.
 * `err.name` alone is not enough for drizzle: `DrizzleQueryError` never sets
 * `name`, so it reads `Error`; the constructor name is used instead.
 */

/** A Postgres SQLSTATE: five characters, digits and capitals. */
const SQLSTATE = /^[0-9A-Z]{5}$/

/** A Node system error code (`ECONNREFUSED`, `ETIMEDOUT`…); kept since 2026-11-10. */
const NODE_CODE = /^E[A-Z0-9_]+$/

/** A Node `syscall` (`connect`, `getaddrinfo`): one lowercase word. */
const SYSCALL = /^[a-z_]{1,32}$/

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

/**
 * The SQLSTATE or Node system error code of this error or of the first error
 * in its `cause` chain that has one, with that error's `errno` and `syscall`.
 */
function errCode(err: unknown): { code: string; errno?: number; syscall?: string } | undefined {
  let cur: unknown = err
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const { code, errno, syscall } = cur as { code?: unknown; errno?: unknown; syscall?: unknown }
    if (typeof code === 'string' && (SQLSTATE.test(code) || NODE_CODE.test(code))) {
      return {
        code,
        ...(Number.isInteger(errno) ? { errno: errno as number } : {}),
        ...(typeof syscall === 'string' && SYSCALL.test(syscall) ? { syscall } : {}),
      }
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

/** Para logs: nombre del error + código (Postgres o de Node) si lo hay. NUNCA message, params ni query (DrizzleQueryError mete los params en message). */
export function errSummary(err: unknown): string {
  if (err === null || err === undefined) return String(err)
  if (typeof err !== 'object') return typeof err
  const code = errCode(err)?.code
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

/**
 * Text that can only come from a database error and may quote a value: the
 * row being written, a key, the input Postgres refused. drizzle's shape (also
 * when a wrapper copied it into its own message), and every Postgres 16
 * message, DETAIL or CONTEXT that cites its input:
 *   · `Key (email)=(…)`, `Failing row contains (…)` (23505, 23503, 23502, 23514);
 *   · `invalid input syntax for type integer: "…"`, `invalid input value for
 *     enum x: "…"`, `malformed array|record|range literal: "…"` (22P02);
 *   · `value "…" is out of range for type`, `…out of range: "…"`, `value too
 *     long for type` (22003, 22008, 22001);
 *   · JSON's `Token "…" is invalid`, `…but found "…"`, `Escape sequence "…"`,
 *     `CONTEXT: JSON data, line 1: …`;
 *   · `invalid byte sequence for encoding`, `syntax error at or near "…"`,
 *     `syntax error in tsquery: "…"`, `invalid value "…" for`, and any text a
 *     wrapper prefixed with `DETAIL:` or `CONTEXT:`; constraint violations.
 * A clean reason (`no_audio_stream: the file has no audio`) matches none.
 *
 * ⚠ Valid as both a JS and a Postgres (ARE) regex: `scripts/clean-stored-errors.ts`
 * prefilters in SQL with this same source (`lib/storedReason.ts`). No `\b`
 * (a backspace in Postgres) and no `.` (it matches a newline only in Postgres).
 */
export const ROW_TEXT_SOURCE = [
  'Failed query:',
  '\\nparams:',
  '\\)=\\(',
  'Failing row contains \\(',
  'DETAIL:',
  'CONTEXT:',
  'JSON data, line',
  'invalid input (syntax|value) for ',
  'malformed [a-z]+ literal',
  'value too long for type',
  'is out of range for type',
  'out of range: "',
  'Token "',
  'but found "',
  'Escape sequence "',
  'invalid byte sequence for encoding',
  'character with byte sequence',
  'at or near "',
  'in ts(query|vector): "',
  'of jsonpath input',
  'is not a valid [a-z]+ digit',
  '" does not exist',
  'unrecognized [a-z ]+ "',
  'LINE [0-9]+:',
  'invalid value "',
  'invalid hexadecimal (digit|data)',
  'violates (unique|foreign key|not-null|check|exclusion) constraint',
].join('|')
const QUERY_TEXT = new RegExp(ROW_TEXT_SOURCE)

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

export const REDACTED = '[database error text withheld]'

/**
 * A pino serializer for the `err` key:
 * `logger: { options: { serializers: { err: safeErrSerializer } }, destination: defaultLoggerOptions }`.
 *
 * A DATABASE error (see {@link isDatabaseError}) keeps only its type, its
 * code (SQLSTATE or Node), `errno`, `syscall` and its stack frames: no `message`, `query`, `params`, `detail`,
 * `cause` or any other own property. Any other error keeps its message too
 * (truncated), since a Payload validation error is useless without it.
 * A string already chosen by the caller passes, unless it is drizzle's text.
 */
export function safeErrSerializer(err: unknown): unknown {
  if (err === null || err === undefined) return err
  if (typeof err === 'string') return QUERY_TEXT.test(err) ? REDACTED : err
  if (typeof err !== 'object') return { type: typeof err }
  const out: {
    type: string
    code?: string
    errno?: number
    syscall?: string
    message?: string
    stack?: string
  } = { type: className(err), ...errCode(err) }
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
 *
 * Also what a row's reason column (`ingestError`, `publicationError`…) gets:
 * the web hands those to the browser. A string is another service's error
 * text (an ai-service callback), withheld when it is drizzle's.
 */
export function safeErrMessage(err: unknown, max = 300): string {
  if (isDatabaseError(err)) return errSummary(err)
  if (typeof err === 'string' && QUERY_TEXT.test(err)) return REDACTED
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : errSummary(err)
  return message.slice(0, max)
}
