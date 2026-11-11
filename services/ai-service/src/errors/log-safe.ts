// LOG-SAFE `err` SERIALIZER for every pino logger ai-service creates.
//
// ⚠ A DATABASE ERROR CARRIES THE ROW. pino's default `err` serializer copies
// `message`, `stack` and every enumerable own property. On a `postgres`
// (postgres.js 3.4) `PostgresError` that includes `detail`
// (`Key (title)=(…) already exists.`), `where`, and a `message` that can
// quote the offending value (`invalid input syntax for type uuid: "…"`).
// With `debug` on, the driver also makes `query` and `parameters` enumerable.
// So `log.error({ err }, …)` on a failed write of chunk text puts that text in
// the container log.
//
// What is safe: the class name, the Postgres SQLSTATE (`23505`, `57014`…),
// a Node system error's `code`, `errno` and `syscall` (`ECONNREFUSED`, -111,
// `connect`) and the stack FRAMES. Any other error keeps its message too,
// truncated, because an upstream or validation error is useless without it.

/** A Postgres SQLSTATE: five characters, digits and capitals. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * A Node system error code (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`…). Until
 * 2026-11-10 only a SQLSTATE was kept, so `db/migrate.ts`'s fatal on a
 * database it could not reach said `Error` and nothing else.
 */
const NODE_CODE = /^E[A-Z0-9_]+$/;

/** A Node `syscall` (`connect`, `getaddrinfo`): one lowercase word. */
const SYSCALL = /^[a-z_]{1,32}$/;

/** How much of a non-database message reaches the log. */
const MAX_MESSAGE_CHARS = 500;

/** How far down a `cause` chain the checks look. */
const MAX_CAUSE_DEPTH = 5;

function className(err: object): string {
  const ctor = (err as { constructor?: { name?: unknown } }).constructor;
  const ctorName = typeof ctor?.name === 'string' ? ctor.name : '';
  const name = (err as { name?: unknown }).name;
  // A subclass that never set `name` still says `Error` there; its
  // constructor is the more specific of the two.
  if (ctorName && ctorName !== 'Object' && (name === 'Error' || typeof name !== 'string')) {
    return ctorName;
  }
  return typeof name === 'string' && name ? name : ctorName || 'Error';
}

/**
 * The SQLSTATE or Node system error code of this error or of the first error
 * in its `cause` chain that has one, with that error's `errno` and `syscall`.
 */
function errCode(err: unknown): { code: string; errno?: number; syscall?: string } | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur && typeof cur === 'object'; depth++) {
    const { code, errno, syscall } = cur as { code?: unknown; errno?: unknown; syscall?: unknown };
    if (typeof code === 'string' && (SQLSTATE.test(code) || NODE_CODE.test(code))) {
      return {
        code,
        ...(Number.isInteger(errno) ? { errno: errno as number } : {}),
        ...(typeof syscall === 'string' && SYSCALL.test(syscall) ? { syscall } : {}),
      };
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Only the `    at fn (file:line:col)` frames of a stack: its first lines
 * repeat the message. Strict on purpose, so a message line that merely
 * starts with "at " is not mistaken for a frame.
 */
const FRAME = /^\s+at (?:.+ \()?(?:file:\/\/|node:|\/|[A-Za-z]:\\|<anonymous>)[^()\n]*?(?::\d+:\d+)?\)?$/;
function framesOnly(stack: unknown): string | undefined {
  if (typeof stack !== 'string') return undefined;
  const frames = stack.split('\n').filter((line) => FRAME.test(line));
  return frames.length ? frames.join('\n') : undefined;
}

/** drizzle's query-error text, also when a wrapper copied it into its own message. */
const QUERY_TEXT = /Failed query:|\nparams:/;

/**
 * Is this, or anything in its `cause` chain, a database error? Then its text
 * (message, detail, query, parameters) may quote a row. `in`, not a value
 * read: postgres.js attaches `query` / `parameters` NON-enumerable unless
 * `debug` is on.
 */
export function isDatabaseError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur && typeof cur === 'object'; depth++) {
    const e = cur as { code?: unknown; message?: unknown };
    if ('query' in e || 'params' in e || 'parameters' in e) return true;
    if (typeof e.code === 'string' && SQLSTATE.test(e.code)) return true;
    if (typeof e.message === 'string' && QUERY_TEXT.test(e.message)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

const REDACTED = '[database error text withheld]';

/**
 * A pino serializer for the `err` key. A DATABASE error (see
 * {@link isDatabaseError}) keeps only `type`, `code` (SQLSTATE or Node code),
 * `errno`, `syscall` and the stack frames: no `message`, `detail`, `query`, `parameters`, `cause` or any other
 * own property. Any other error keeps its message as well, truncated. A string
 * the caller chose passes, unless it is drizzle's query text.
 */
export function safeErrSerializer(err: unknown): unknown {
  if (err === null || err === undefined) return err;
  if (typeof err === 'string') return QUERY_TEXT.test(err) ? REDACTED : err;
  if (typeof err !== 'object') return { type: typeof err };
  const out: {
    type: string;
    code?: string;
    errno?: number;
    syscall?: string;
    message?: string;
    stack?: string;
  } = { type: className(err), ...errCode(err) };
  if (!isDatabaseError(err)) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') out.message = message.slice(0, MAX_MESSAGE_CHARS);
  }
  const stack = framesOnly((err as { stack?: unknown }).stack);
  if (stack) out.stack = stack;
  return out;
}

/**
 * For a `console` line, or a log message built as text: the class name and
 * code (`PostgresError(23505)`, `Error(ECONNREFUSED)`). NEVER the message.
 */
export function errSummary(err: unknown): string {
  if (err === null || err === undefined) return String(err);
  if (typeof err !== 'object') return typeof err;
  const code = errCode(err)?.code;
  const name = className(err);
  return code ? `${name}(${code})` : name;
}

/**
 * For a line that used to print `err.message`: {@link errSummary} alone for a
 * database error, and with the message (truncated) for any other.
 */
export function safeErrMessage(err: unknown, max = 300): string {
  if (typeof err === 'string') return QUERY_TEXT.test(err) ? REDACTED : err.slice(0, max);
  if (isDatabaseError(err)) return errSummary(err);
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message !== 'string' || message === '') return errSummary(err);
  return `${errSummary(err)}: ${message.slice(0, max)}`;
}

/**
 * The options every ai-service pino logger shares: the Fastify instance
 * (`server.ts`), the background `rootLogger` (`logger.ts`) and the OpenTelemetry
 * diagnostics logger (`telemetry/otel.ts`). Children inherit them.
 */
export const LOG_SAFE_OPTIONS = {
  redact: ['req.headers.authorization'],
  serializers: {
    // pino and Fastify type `err` as returning `{ type, message, stack }`;
    // this one leaves `message` out on purpose for a database error.
    err: safeErrSerializer as (err: Error) => { type: string; message: string; stack: string },
  },
};
