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
 *   · an identifier named `err`, `error`, `e`, `ex`, `cause` or `reason`, or
 *     ending in `Err` or `Error`;
 *   · any identifier bound by `catch (x)`, by `.catch((x) => …)` or by the
 *     rejection handler of `.then(ok, (x) => …)`, whatever its name (wave 11,
 *     2026-11-10);
 *   · a `.message` or `.stack` member;
 *   · a `.cause` member, or `.reason` on a `Promise.allSettled` result (`r`,
 *     `result`, `outcome`, `settled`, or ending in `Result`) or on any of the
 *     identifiers above, unless the logger's serializer gets it under `err`.
 *     `.reason` elsewhere is a domain string (`decision.reason`), left alone;
 *   · `String(<any of these>)`, `JSON.stringify(<any of these>)` or
 *     `<any of these>.toString()`.
 * Allowed: `errSummary(…)`, `safeErrMessage(…)`, a member such as `err.name`
 * or `err.code`, and in a logger call the error itself under the `err` key or
 * as a whole argument, which the serializer redacts.
 */

const ERRORISH = /^(?:err|error|e|ex|cause|reason)$|(?:Err|Error)$/
const LEAKY_MEMBERS = new Set(['message', 'stack'])
const SETTLED = /^(?:r|res|result|outcome|settled)$|(?:Result|Outcome|Settled)$/
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

/** `JSON.stringify`, also as `JSON?.stringify`. */
function isJsonStringify(callee) {
  if (callee.type === 'ChainExpression') return isJsonStringify(callee.expression)
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'JSON' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'stringify'
  )
}

/** Is this function the handler of a `.catch(…)` call, or `.then(…)`'s second? */
function isCatchHandler(fn) {
  const call = fn.parent
  if (call?.type !== 'CallExpression' || call.callee.type === 'Identifier') return false
  const method = tailName(call.callee)
  return (method === 'catch' && call.arguments[0] === fn) || (method === 'then' && call.arguments[1] === fn)
}

/**
 * Was this identifier bound by `catch (x)`, `.catch((x) => …)` or
 * `.then(ok, (x) => …)`? Then it holds whatever was thrown, whatever it is
 * called.
 */
function isCaught(sourceCode, id) {
  for (let scope = sourceCode.getScope(id); scope; scope = scope.upper) {
    const variable = scope.set.get(id.name)
    if (!variable) continue
    return variable.defs.some(
      (def) =>
        def.type === 'CatchClause' ||
        (def.type === 'Parameter' && def.node.params[0] === def.name && isCatchHandler(def.node)),
    )
  }
  return false
}

/**
 * The node that leaks, or undefined. `bareOk` is true where the logger's `err`
 * serializer will see the error object itself. `caught(id)` says whether an
 * identifier was bound by a catch.
 */
function leak(node, bareOk, caught) {
  if (!node) return undefined
  switch (node.type) {
    case 'Identifier':
      return !bareOk && (ERRORISH.test(node.name) || caught(node)) ? node : undefined
    case 'MemberExpression': {
      const name = !node.computed && node.property.type === 'Identifier' ? node.property.name : undefined
      if (LEAKY_MEMBERS.has(name)) return node
      if (bareOk) return undefined
      // `.cause` and a settled `.reason` hold an error object, not its text.
      if (name === 'cause') return node
      const owner = node.object.type === 'Identifier' ? node.object : undefined
      return name === 'reason' && owner && (SETTLED.test(owner.name) || ERRORISH.test(owner.name) || caught(owner))
        ? node
        : undefined
    }
    case 'ChainExpression':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
    case 'TSTypeAssertion':
      return leak(node.expression, bareOk, caught)
    case 'CallExpression': {
      const name = tailName(node.callee)
      if (SAFE_CALLS.has(name)) return undefined
      if (name === 'String' && node.callee.type === 'Identifier') return leak(node.arguments[0], false, caught)
      if (isJsonStringify(node.callee)) return leak(node.arguments[0], false, caught)
      if (name === 'toString' && node.callee.type === 'MemberExpression') return leak(node.callee.object, false, caught)
      return undefined
    }
    case 'TemplateLiteral':
      for (const expr of node.expressions) {
        const hit = leak(expr, false, caught)
        if (hit) return hit
      }
      return undefined
    case 'BinaryExpression':
      return node.operator === '+' ? leak(node.left, false, caught) ?? leak(node.right, false, caught) : undefined
    case 'LogicalExpression':
      return leak(node.left, bareOk, caught) ?? leak(node.right, bareOk, caught)
    case 'ConditionalExpression':
      return leak(node.consequent, bareOk, caught) ?? leak(node.alternate, bareOk, caught)
    case 'ArrayExpression':
      for (const el of node.elements) {
        const hit = leak(el, bareOk, caught)
        if (hit) return hit
      }
      return undefined
    case 'SpreadElement':
      return leak(node.argument, bareOk, caught)
    case 'ObjectExpression':
      for (const prop of node.properties) {
        if (prop.type === 'SpreadElement') {
          const hit = leak(prop.argument, false, caught)
          if (hit) return hit
          continue
        }
        const key = !prop.computed && prop.key.type === 'Identifier' ? prop.key.name : undefined
        const hit = leak(prop.value, bareOk && key === 'err', caught)
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
    const caught = (id) => isCaught(context.sourceCode, id)
    return {
      CallExpression(node) {
        const kind = logKind(node.callee)
        if (!kind) return
        for (const arg of node.arguments) {
          // Console prints an error whole; a logger hands a bare one, or one
          // under `err`, to the serializer.
          const bareOk = kind === 'logger'
          const hit = leak(arg, bareOk && (arg.type === 'Identifier' || arg.type === 'ObjectExpression'), caught)
          if (hit) context.report({ node: hit, messageId: 'raw' })
        }
      },
    }
  },
}
