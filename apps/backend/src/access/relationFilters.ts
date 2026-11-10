/**
 * 🔴 A FILTER OR A SORT READS NOTHING THE CALLER COULD NOT READ ROW BY ROW —
 * ON EVERY COLLECTION (wave 10, audit 2026-11-10).
 *
 * Payload does not apply the target's read access when a `where` or a `sort`
 * crosses a relationship. Wave 9 closed that on `documents` and the two review
 * logs; the same probe still answered elsewhere. As a colleague, measured on
 * real Postgres before this file: `GET /api/media?where[uploadedBy.email]
 * [like]=<substring>` returned the row for the real substring and nothing for
 * `zzzz`, confirming a colleague's email; on `ratings`, `session.title`,
 * `user.email` and `message.content` did the same, so a colleague could read a
 * private conversation's title and its messages' text out letter by letter.
 *
 * Two rules, applied by ONE hook, {@link relationFilterHook}, that
 * {@link applyRelationFilters} adds to every collection of the built config
 * (Payload's own `payload-*` collections included):
 *
 *   1. {@link resolveRelationCrossings}: a path into another collection only
 *      matches rows of it the caller may read there; a sort through one is
 *      stripped; a `readDistinct` on one is refused;
 *   2. {@link unreadablePath}: a path on a field the caller may not read in
 *      every row (`hidden`, or a field `access.read`) is refused (`where`,
 *      `readDistinct`) or stripped (`sort`). Payload asks a field's read
 *      access WITHOUT a document when it validates a `where`, so a rule that
 *      depends on the row cannot answer there.
 *
 * `documents` and the review logs keep their own rule on top
 * (`custom.gatedQueryPrefix`, `constrainGatedQueriesAt` in
 * `collections/Documents.ts`): crossings into `documents` are walked through
 * and judged by the gated-row allowlist instead.
 *
 * A platform admin and a server read (`overrideAccess`) are not touched.
 * `relationFilters.pg.test.ts` probes each collection over REST.
 */

import type {
  CollectionBeforeOperationHook,
  PayloadRequest,
  SanitizedCollectionConfig,
  SanitizedConfig,
  Where,
} from 'payload'
import { Forbidden, QueryError } from 'payload'

import { isPlatformAdminUser } from './index'

/**
 * Payload's `where` operators (`payload@3.88.0` `types/constants`, not exported
 * from the package root). A key outside it under a path is a nested path
 * (`where[mediaFile][filename][like]`).
 */
export const WHERE_OPERATORS: ReadonlySet<string> = new Set([
  'equals', 'contains', 'not_equals', 'in', 'all', 'not_in', 'exists', 'greater_than',
  'greater_than_equal', 'less_than', 'less_than_equal', 'like', 'not_like', 'within',
  'intersects', 'near',
])

/** The parts of a Payload `sort` (`'a,-b'` or `['a', '-b']`). */
export function sortParts(sort: unknown): string[] {
  if (typeof sort === 'string') return sort.split(',').map((s) => s.trim()).filter(Boolean)
  if (Array.isArray(sort)) return sort.filter((s): s is string => typeof s === 'string')
  return []
}

/** The parts of a sanitized field these walks need. */
export type QueryField = {
  name?: string
  type: string
  relationTo?: string | string[]
  hidden?: boolean
  access?: { read?: unknown }
  custom?: { queryJudgedBy?: string }
  flattenedFields?: QueryField[]
  blocks?: { flattenedFields?: QueryField[] }[]
}

/** A `where` that matches no row. */
export const NO_ROWS: Where = { id: { in: [] } }

/** The fields under a group, a tab, an array or a block. `null` on a leaf. */
function childFields(field: QueryField): QueryField[] | null {
  if (field.flattenedFields) return field.flattenedFields
  if (field.blocks) return field.blocks.flatMap((b) => b.flattenedFields ?? [])
  return null
}

const isRelation = (field: QueryField) => field.type === 'relationship' || field.type === 'upload'

/**
 * Where `path` first leaves for another collection's rows: the relationship
 * (`at`), its target (`slug`) and the rest of the path under it. `null` when it
 * never does, or only names the relation's id (`session`, `session.id`,
 * `uploadedBy`), which says nothing the row does not already show.
 *
 * `follow` relations into `documents` are walked through rather than stopped
 * at: the gated-row allowlist judges those columns. A polymorphic relationship
 * is left to Payload, which refuses a path through it (measured in
 * `relationFilters.pg.test.ts`). A segment the config does not know is left to
 * Payload's own path check.
 */
export function relationCrossing(
  path: string,
  fields: QueryField[],
  req: PayloadRequest,
  follow: boolean,
): { at: string; slug: string; rest: string } | null {
  const segments = path.split('.')
  let current = fields
  for (let i = 0; i < segments.length; i++) {
    const field = current.find((f) => f.name === segments[i])
    if (!field) return null
    if (isRelation(field)) {
      if (typeof field.relationTo !== 'string') return null
      const rest = segments.slice(i + 1).join('.')
      if (follow && field.relationTo === 'documents') {
        current = fieldsOf(req, 'documents')
        continue
      }
      if (rest === '' || rest === 'id') return null
      return { at: segments.slice(0, i + 1).join('.'), slug: field.relationTo, rest }
    }
    const inner = childFields(field)
    if (!inner) return null
    current = inner
  }
  return null
}

/**
 * The first field on `path`, in the collection's own fields, that the caller
 * may not read in every row: `hidden`, or with a field `access.read`. The walk
 * stops at a relationship (checked itself): past it the target's own hook
 * judges. A field whose rule lives in its collection's own hook says so in
 * `custom.queryJudgedBy` (`memberships.user`: `limitQueriesOnUser`).
 */
export function unreadablePath(path: string, fields: QueryField[]): string | null {
  const segments = path.split('.')
  let current = fields
  for (let i = 0; i < segments.length; i++) {
    const field = current.find((f) => f.name === segments[i])
    if (!field) return null
    const guarded = field.hidden === true || typeof field.access?.read === 'function'
    if (guarded && !field.custom?.queryJudgedBy) return segments.slice(0, i + 1).join('.')
    if (isRelation(field)) return null
    const inner = childFields(field)
    if (!inner) return null
    current = inner
  }
  return null
}

function fieldsOf(req: PayloadRequest, slug: string): QueryField[] {
  const collection = (req.payload?.collections as Record<string, { config?: { flattenedFields?: unknown } }> | undefined)?.[slug]
  return (collection?.config?.flattenedFields as QueryField[] | undefined) ?? []
}

/** `[path, operators]` for every leaf under a where key, nested-object paths flattened to dots. */
function leavesUnder(path: string, value: unknown, into: [string, unknown][]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    into.push([path, value])
    return
  }
  const ops = Object.entries(value as Record<string, unknown>).filter(([k]) => WHERE_OPERATORS.has(k))
  if (ops.length > 0) into.push([path, Object.fromEntries(ops)])
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (!WHERE_OPERATORS.has(key)) leavesUnder(`${path}.${key}`, inner, into)
  }
}

/** Every leaf path of a `where`, through `and` / `or` in any letter case. */
function leafPaths(where: unknown, into: string[] = []): string[] {
  if (!where || typeof where !== 'object') return into
  if (Array.isArray(where)) {
    for (const w of where) leafPaths(w, into)
    return into
  }
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    const lower = key.toLowerCase()
    if (lower === 'and' || lower === 'or') {
      if (value && typeof value === 'object') leafPaths(Object.values(value), into)
      continue
    }
    const leaves: [string, unknown][] = []
    leavesUnder(key, value, leaves)
    into.push(...leaves.map(([p]) => p))
  }
  return into
}

/**
 * 🔴 A PATH THROUGH A RELATIONSHIP ONLY MATCHES ROWS OF THE TARGET THE CALLER
 * MAY READ THERE (wave 9, R1; every collection since wave 10).
 *
 * Each leaf that crosses into another collection (`session.title`,
 * `uploadedBy.email`, `message.content`…, at any depth) becomes
 * `<relation> in <ids>`, the ids found by running the rest of the path on the
 * target as the caller (`overrideAccess: false`). The target's own read access
 * decides, so the list is the config's, not ours: a new relationship is
 * covered the day it is added. The rest of the path is resolved the same way
 * before it runs (`follow` off), so a deeper hop (`session.user.email`) cannot
 * cross unchecked either; the target's own hook then runs on that query too.
 *
 * Idempotent: what it writes (`<relation> in [...]`) never crosses again.
 * A target the caller may not read at all matches nothing. A value that is
 * not an operator object matches nothing.
 */
export async function resolveRelationCrossings(
  where: unknown,
  fields: QueryField[],
  req: PayloadRequest,
  follow: boolean,
): Promise<unknown> {
  if (!where || typeof where !== 'object') return where
  if (Array.isArray(where)) {
    const out = await Promise.all(where.map((w) => resolveRelationCrossings(w, fields, req, follow)))
    return out.some((w, i) => w !== where[i]) ? out : where
  }
  const parts: Where[] = []
  let changed = false
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    const lower = key.toLowerCase()
    if (lower === 'and' || lower === 'or') {
      const inner = value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value) : value
      const next = await resolveRelationCrossings(inner, fields, req, follow)
      if (next !== inner) changed = true
      parts.push({ [key]: next } as Where)
      continue
    }
    const leaves: [string, unknown][] = []
    leavesUnder(key, value, leaves)
    const resolved = await Promise.all(
      leaves.map(async ([path, op]): Promise<Where | null> => {
        const crossing = relationCrossing(path, fields, req, follow)
        if (!crossing) return null
        if (!op || typeof op !== 'object' || Array.isArray(op)) return NO_ROWS
        const inner = await resolveRelationCrossings({ [crossing.rest]: op }, fieldsOf(req, crossing.slug), req, false)
        const ids = await readableIds(req, crossing.slug, inner as Where)
        return ids.length === 0 ? NO_ROWS : { [crossing.at]: { in: ids } }
      }),
    )
    if (resolved.every((r) => r === null)) {
      parts.push({ [key]: value } as Where)
      continue
    }
    changed = true
    parts.push({ and: resolved.map((r, i) => r ?? ({ [leaves[i]![0]]: leaves[i]![1] } as Where)) })
  }
  if (!changed) return where
  return parts.length === 1 ? parts[0] : { and: parts }
}

/**
 * Ids of the `slug` rows matching `where` that the caller may read.
 *
 * ⚠ `pagination: false` IS LOAD-BEARING: Payload's default page is 10 rows, and
 * a truncated list silently drops matches (`relationFilters.pg.test.ts` reads
 * more than 10). `select: { id: true }`: only the id column is read, not
 * `messages.content` or a document's text for every match.
 *
 * ⚠ THE LIST IS MATERIALISED. `ratings/count?where[message.content][like]=…`
 * over one caller's own messages (2 KB each), measured on torre 2026-11-10,
 * load average ~2 on 16 cores: 20 000 matching ids answered in 0.8-1.4 s;
 * 65 000 failed with a 500 (`Maximum call stack size exceeded` in drizzle's
 * `mergeQueries`, building the `IN` list). Only the caller's own readable rows
 * count, so the failure says nothing new. Real lists are far smaller
 * (inferred: a member reads their own messages and their ecosistemas'
 * published files, hundreds to low thousands). A subquery instead of the list
 * is not a drop-in: the target's access `where` under the relation's prefix,
 * on a `hasMany` relation, may match on one related row and the filter on
 * another (a documento in two conversations, one of them the caller's, and
 * `session.title` matching the other; inferred, not measured).
 */
async function readableIds(req: PayloadRequest, slug: string, where: Where): Promise<(string | number)[]> {
  try {
    const { docs } = await req.payload.find({
      collection: slug as never,
      where,
      depth: 0,
      pagination: false,
      select: { id: true } as never,
      overrideAccess: false,
      user: req.user,
      req,
    })
    return docs.map((d) => (d as { id: string | number }).id)
  } catch (err) {
    if (err instanceof Forbidden) return []
    throw err
  }
}

const QUERY_OPERATIONS = new Set(['read', 'count', 'readDistinct', 'update', 'delete'])

/**
 * Rules 1 and 2 on one operation's args. `follow` walks through relations into
 * `documents` (the gated hook); `fieldRule` off leaves field reads to the
 * collection's own allowlist (`documents`). Reads, counts and distinct reads,
 * and the bulk `update` / `delete` (`PATCH` / `DELETE /api/<slug>?where=…`),
 * whose matched rows come back in the response.
 */
export function constrainRelationQueries(options: { follow: boolean; fieldRule: boolean }) {
  type HookArgs = Parameters<CollectionBeforeOperationHook>[0]
  return async (hookArgs: HookArgs): Promise<HookArgs['args']> => {
    const { args, collection, operation, req } = hookArgs
    if (!QUERY_OPERATIONS.has(operation)) return args
    const a = args as { overrideAccess?: boolean; where?: Where; sort?: unknown; field?: unknown }
    // REST leaves it undefined (= access applies); the local API defaults it to true.
    if (a.overrideAccess === true) return args
    const user = req.user
    if (!user || isPlatformAdminUser(user)) return args

    const fields = (collection as { flattenedFields?: QueryField[] } | undefined)?.flattenedFields
    // Fail closed: without the config no path can be judged.
    if (!fields) throw new Forbidden(req.t)
    const crosses = (path: string) => relationCrossing(path, fields, req, options.follow) !== null
    const unreadable = (path: string) => (options.fieldRule ? unreadablePath(path, fields) : null)

    if (typeof a.field === 'string') {
      if (crosses(a.field)) throw new Forbidden(req.t)
      const bad = unreadable(a.field)
      if (bad) throw new QueryError([{ path: bad }])
    }
    const refused = leafPaths(a.where).map(unreadable).filter((p): p is string => p !== null)
    if (refused.length > 0) throw new QueryError([...new Set(refused)].map((path) => ({ path })))

    let next = args as typeof args & { where?: Where; sort?: unknown }
    const where = await resolveRelationCrossings(a.where, fields, req, options.follow)
    if (where !== a.where) next = { ...next, where: where as Where }
    const parts = sortParts(a.sort)
    const kept = parts.filter((p) => {
      const path = p.replace(/^[-+]/, '')
      return !crosses(path) && !unreadable(path)
    })
    if (kept.length !== parts.length) {
      next = { ...next, sort: kept.length === 0 ? undefined : Array.isArray(a.sort) ? kept : kept.join(',') }
    }
    return next as typeof args
  }
}

const plainRule = constrainRelationQueries({ follow: false, fieldRule: true })

/**
 * The hook on every collection. A collection whose rows carry the gated
 * columns (`documents`, and the review logs through `document.`) sets
 * `custom.gatedQueryPrefix` and gets `constrainGatedQueriesAt(prefix)`, which
 * runs the same rules plus the gated-row allowlist. Imported lazily:
 * `Documents.ts` is a large module graph, and it imports this file.
 */
export const relationFilterHook: CollectionBeforeOperationHook = async (hookArgs) => {
  const prefix = (hookArgs.collection as { custom?: { gatedQueryPrefix?: unknown } } | undefined)?.custom?.gatedQueryPrefix
  if (typeof prefix === 'string') {
    const gated = (await import('../collections/Documents')).constrainGatedQueriesAt(prefix)
    return (await gated(hookArgs)) ?? hookArgs.args
  }
  return plainRule(hookArgs)
}

/** Does any field, at any depth, cross into another collection or hide its value from some callers? */
export function needsRelationFilters(fields: QueryField[]): boolean {
  return fields.some((f) => {
    if (isRelation(f) || f.hidden === true || typeof f.access?.read === 'function') return true
    const inner = childFields(f)
    return inner !== null && needsRelationFilters(inner)
  })
}

/**
 * 🔴 RUNS ON THE SANITIZED CONFIG (`.then(...)` in `payload.config.ts`), so
 * Payload's own `payload-locked-documents` and `payload-preferences`, added
 * inside `buildConfig`, get the hook too. Last in `beforeOperation`: a
 * collection's own hook (`limitQueriesOnUser`) judges the query as sent.
 * `relationFilters.pg.test.ts` walks the built config and fails on a
 * collection that needs the hook and lacks it.
 */
export function applyRelationFilters(config: SanitizedConfig): SanitizedConfig {
  for (const collection of config.collections as SanitizedCollectionConfig[]) {
    if (!needsRelationFilters(collection.flattenedFields as unknown as QueryField[])) continue
    const hooks = (collection.hooks.beforeOperation ??= [])
    if (!hooks.includes(relationFilterHook)) hooks.push(relationFilterHook)
  }
  return config
}
