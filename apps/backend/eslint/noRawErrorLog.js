/**
 * 🔴 NO LOG LINE CARRIES A RAW ERROR'S TEXT (P-07, re-audit 2026-11-10).
 *
 * drizzle's `DrizzleQueryError` keeps the failed query's params in `message`
 * and `stack`, and a pg `DatabaseError` can quote the row in its own. Node's
 * `util.format` prints both for `console.error('…', err)`, and a string the
 * caller built from them reaches the logger as plain text, past the `err`
 * serializer (`src/lib/errorSummary.ts`). So, in a `console.*` call or a
 * logger call (`logger.*`, `log.*`, `payload.logger.*`, `opts.log?.*`), this
 * rejects an argument that is, or interpolates:
 *   · an identifier named `err`, `error`, `e` or `cause`, or ending in `Err`
 *     or `Error`;
 *   · a `.message` or `.stack` member;
 *   · `String(<either>)`.
 * Allowed: `errSummary(…)`, `safeErrMessage(…)`, a member such as `err.name`
 * or `err.code`, and in a logger call the error itself under the `err` key or
 * as a whole argument, which the serializer redacts.
 */

const ERRORISH = /^(?:err|error|e|cause)$|(?:Err|Error)$/
const LEAKY_MEMBERS = new Set(['message', 'stack'])
const SAFE_CALLS = new Set(['errSummary', 'safeErrMessage'])
const LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'fatal'])

/** The last name in `a.b.c` / `a?.b`: `c` / `b`. */
function tailName(node) {
  if (!node) return undefined
  if (node.type === 'ChainExpression') return tailName(node.expression)
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return node.property.name
  }
  return undefined
}

/** 'console', 'logger' or undefined. */
function logKind(callee) {
  if (callee.type === 'ChainExpression') return logKind(callee.expression)
  if (callee.type !== 'MemberExpression' || callee.computed) return undefined
  if (callee.property.type !== 'Identifier' || !LEVELS.has(callee.property.name)) return undefined
  const receiver = tailName(callee.object)
  if (receiver === 'console') return 'console'
  if (receiver === 'logger' || receiver === 'log') return 'logger'
  return undefined
}

/**
 * The node that leaks, or undefined. `bareOk` is true where the logger's `err`
 * serializer will see the error object itself.
 */
function leak(node, bareOk) {
  if (!node) return undefined
  switch (node.type) {
    case 'Identifier':
      return !bareOk && ERRORISH.test(node.name) ? node : undefined
    case 'MemberExpression':
      return !node.computed && node.property.type === 'Identifier' && LEAKY_MEMBERS.has(node.property.name)
        ? node
        : undefined
    case 'ChainExpression':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
    case 'TSTypeAssertion':
      return leak(node.expression, bareOk)
    case 'CallExpression': {
      const name = tailName(node.callee)
      if (SAFE_CALLS.has(name)) return undefined
      if (name === 'String' && node.callee.type === 'Identifier') return leak(node.arguments[0], false)
      return undefined
    }
    case 'TemplateLiteral':
      for (const expr of node.expressions) {
        const hit = leak(expr, false)
        if (hit) return hit
      }
      return undefined
    case 'BinaryExpression':
      return node.operator === '+' ? leak(node.left, false) ?? leak(node.right, false) : undefined
    case 'LogicalExpression':
      return leak(node.left, bareOk) ?? leak(node.right, bareOk)
    case 'ConditionalExpression':
      return leak(node.consequent, bareOk) ?? leak(node.alternate, bareOk)
    case 'ArrayExpression':
      for (const el of node.elements) {
        const hit = leak(el, bareOk)
        if (hit) return hit
      }
      return undefined
    case 'SpreadElement':
      return leak(node.argument, bareOk)
    case 'ObjectExpression':
      for (const prop of node.properties) {
        if (prop.type === 'SpreadElement') {
          const hit = leak(prop.argument, false)
          if (hit) return hit
          continue
        }
        const key = !prop.computed && prop.key.type === 'Identifier' ? prop.key.name : undefined
        const hit = leak(prop.value, bareOk && key === 'err')
        if (hit) return hit
      }
      return undefined
    default:
      return undefined
  }
}

export default {
  meta: {
    type: 'problem',
    docs: { description: "No console or logger call carries a raw error's text (P-07)." },
    schema: [],
    messages: {
      raw: "A raw error's text can quote a database row. Log errSummary(err) or safeErrMessage(err), or pass the error as { err } to payload.logger.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const kind = logKind(node.callee)
        if (!kind) return
        for (const arg of node.arguments) {
          // Console prints an error whole; a logger hands a bare one, or one
          // under `err`, to the serializer.
          const bareOk = kind === 'logger'
          const hit = leak(arg, bareOk && (arg.type === 'Identifier' || arg.type === 'ObjectExpression'))
          if (hit) context.report({ node: hit, messageId: 'raw' })
        }
      },
    }
  },
}
