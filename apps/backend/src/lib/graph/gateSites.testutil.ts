/**
 * 🔴 GATE 5, PER READ SITE — a test helper, not production code.
 *
 * A whole-statement regex is not enough: `entitySupportCte` carries the persona
 * filter, every statement embeds it, so a regex over the full SQL passed even
 * when the statement's OWN mention read had no filter (entityDocumentsQuery
 * before the fix, retrieveDocumentsQuery after it). This splits the SQL into
 * the SELECT blocks that read `graph_mentions` / `graph_relations`, drops every
 * nested sub-SELECT from each block (CTE bodies, IN-subqueries), and lets the
 * caller look for the gate in what is left — the read's own FROM/JOIN/WHERE.
 *
 * The relation gate is itself a sub-SELECT (`JOIN LATERAL (…) g5`), so a
 * LATERAL group is kept.
 */

export type GraphTable = 'graph_mentions' | 'graph_relations'

/** The SQL comment `seedGuard.ts` puts in each of its EXISTS sub-SELECTs. */
export const SEED_GUARD_MARK = '/* seed-guard */'

/**
 * The no-private-persona filter on a mention read, any aliases (owner,
 * 2026-10-24: no private individuals in the graph). A persona passes only when
 * the row is marked public AND the mention comes from a `documento`.
 */
export const MENTION_GATE =
  /\((\w+)\.type <> 'persona' OR \(\w+\.content_kind = 'documento' AND \1\.public_figure\)\)/

/** The no-private-persona filter on a relation read, both ends. */
export const RELATION_GATE =
  /JOIN LATERAL \( SELECT 1 AS ok WHERE NOT EXISTS \(SELECT 1 FROM graph_entities pe WHERE pe\.id IN \(r\.from_entity_id, r\.to_entity_id\) AND pe\.type = 'persona' AND NOT \(d\.content_kind = 'documento' AND pe\.public_figure\)\) \) g5 ON TRUE/

/** Index of the paren that closes the group opened at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i
  }
  return -1
}

/** The innermost group around `at` — its contents — or the whole text at top level. */
function enclosing(text: string, at: number): string {
  let depth = 0
  for (let i = at; i >= 0; i--) {
    if (text[i] === ')') depth++
    else if (text[i] === '(') {
      if (depth === 0) return text.slice(i + 1, closing(text, i))
      depth--
    }
  }
  return text
}

/** `block` with every nested sub-SELECT blanked out, except a LATERAL gate. */
function ownScope(block: string): string {
  let out = ''
  let i = 0
  while (i < block.length) {
    if (block[i] === '(') {
      const end = closing(block, i)
      const group = block.slice(i, end + 1)
      const lateral = /JOIN LATERAL $/.test(block.slice(0, i))
      out += /\bSELECT\b/.test(group) && !lateral ? '(…)' : group
      i = end + 1
    } else {
      out += block[i]
      i++
    }
  }
  return out
}

/**
 * One entry per `FROM|JOIN <table> <alias>` in the SQL: the text of the SELECT
 * that read sits in, minus its nested sub-SELECTs. Whitespace is collapsed.
 */
export function readSites(sqlText: string, table: GraphTable): string[] {
  const text = sqlText.replace(/\s+/g, ' ')
  const sites: string[] = []
  const re = new RegExp(`\\b(?:FROM|JOIN) ${table} \\w+`, 'g')
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // ⚠ The wikilink seed guard (`seedGuard.ts`) reads `graph_mentions` only
    // inside EXISTS checks on `seeded`, about the SAME entity the gated outer
    // read already filtered. It returns no row, so it is not a read site. Its
    // marker sits right before its own FROM.
    if (text.slice(Math.max(0, m.index - SEED_GUARD_MARK.length - 1), m.index).trim() === SEED_GUARD_MARK) continue
    sites.push(ownScope(enclosing(text, m.index)))
  }
  return sites
}
