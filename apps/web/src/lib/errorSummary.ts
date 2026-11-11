/**
 * LOG-SAFE ERROR SUMMARIES (P-07, re-audit 2026-11-10). The web side of the
 * backend's `src/lib/errorSummary.ts`; same names, so the shared lint rule
 * (`eslint.config.js`) accepts both.
 *
 * ⚠ A BACKEND ERROR CAN CARRY A ROW. The web proxies the backend: a failed
 * query there is drizzle text (`Failed query: <sql>\nparams: <params>`), and a
 * wrapper that copies a response body into its own `message` brings that text
 * here. `JSON.parse` quotes the body it could not read in its `SyntaxError`.
 * Node prints `message` and `stack` when a console call is handed the error.
 *
 * What is safe: the error's class name and its code (`ECONNREFUSED`, a
 * SQLSTATE, `ai_unavailable`), which say what went wrong without saying about
 * whom. Not in `$lib/server`: the client stores log too.
 */

/** A code worth printing: short, one word. Anything longer may be text. */
const CODE = /^[A-Za-z0-9_.-]{2,40}$/;
/** A Postgres SQLSTATE: five characters, digits and capitals. */
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** drizzle's message shape, also when a wrapper copied it into its own message. */
const QUERY_TEXT = /Failed query:|\nparams:/;

function className(err: object): string {
  const ctor = (err as { constructor?: { name?: unknown } }).constructor;
  const ctorName = typeof ctor?.name === 'string' ? ctor.name : '';
  const name = (err as { name?: unknown }).name;
  // A subclass that never set `name` still says `Error` there; its
  // constructor is the more specific of the two.
  if (ctorName && ctorName !== 'Object' && (name === 'Error' || typeof name !== 'string')) return ctorName;
  return typeof name === 'string' && name ? name : ctorName || 'Error';
}

/** The code of this error or of anything in its `cause` chain (`fetch failed` keeps it on the cause). */
function errCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && CODE.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Para logs: nombre del error + código si lo hay. NUNCA message ni stack. */
export function errSummary(err: unknown): string {
  if (err === null || err === undefined) return String(err);
  if (typeof err !== 'object') return typeof err;
  const code = errCode(err);
  const name = className(err);
  return code ? `${name}(${code})` : name;
}

/**
 * Could this error's text quote a row? A database error anywhere in the
 * `cause` chain, drizzle's text in a message, or a `SyntaxError`, which
 * quotes the body it failed to parse.
 */
export function isUnsafeText(err: unknown): boolean {
  if (typeof err === 'string') return QUERY_TEXT.test(err);
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const e = cur as { query?: unknown; params?: unknown; code?: unknown; message?: unknown };
    if (cur instanceof SyntaxError) return true;
    if ('query' in e || 'params' in e) return true;
    if (typeof e.code === 'string' && SQLSTATE.test(e.code)) return true;
    if (typeof e.message === 'string' && QUERY_TEXT.test(e.message)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * For a log line that used to print `err.message`: {@link errSummary} and the
 * message (truncated) for an ordinary error, {@link errSummary} alone when the
 * text may quote a row.
 */
export function safeErrMessage(err: unknown, max = 300): string {
  if (isUnsafeText(err)) return errSummary(err);
  if (typeof err === 'string') return err.slice(0, max);
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message !== 'string' || message === '') return errSummary(err);
  return `${errSummary(err)}: ${message.slice(0, max)}`;
}
