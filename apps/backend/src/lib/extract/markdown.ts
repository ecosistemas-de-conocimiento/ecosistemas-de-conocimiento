/**
 * A Markdown note (Obsidian vault flavour) as plain text for the ingest path.
 *
 * PURE: bytes or a string in, `{ text, metadata }` out. No I/O, no Payload, so
 * it can run in the extract worker thread.
 *
 *   front matter     stripped; `tags` / `aliases` kept in `metadata`
 *   [[T|alias]]      → `alias`;  [[T]] → `T`;  [[T#H]] → `T > H`
 *                    the raw target `T` (or `T#H`) goes to `metadata.links`,
 *                    in order, de-duplicated — for the graph-seeding step
 *   ![[embed]]       dropped, and NOT a link (it is a transclusion)
 *   ![img](src)      dropped
 *   <!-- -->, %% %%  dropped (HTML and Obsidian comments are private notes)
 *   everything else  kept as written: headings, lists, tables, fenced code
 *
 * ⚠ Nothing inside a fenced code block is rewritten.
 */

import { DEFAULT_MAX_CHARS, decodeText, TextTooLongError, type ExtractOptions } from './text'

export type MarkdownMetadata = {
  tags: string[]
  aliases: string[]
  /** Raw wikilink targets, before any `|alias`. */
  links: string[]
}

export type MarkdownExtract = { text: string; metadata: MarkdownMetadata }

const FRONT_MATTER = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/
const FENCE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm
const EMBED = /!\[\[[^\]\n]*\]\]/g
const IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const OBSIDIAN_COMMENT = /%%[\s\S]*?%%/g
const WIKILINK = /\[\[([^\]\n]+?)\]\]/g

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2').trim()

/** `tags`/`aliases` from a front-matter block: inline `[a, b]`, `a, b`, or a `- a` list. */
function readList(yaml: string, keys: string[]): string[] {
  const lines = yaml.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*)[ \t]*:(.*)$/.exec(lines[i])
    if (!m || !keys.includes(m[1].toLowerCase())) continue
    const inline = m[2].trim()
    if (inline) {
      const body = inline.startsWith('[') && inline.endsWith(']') ? inline.slice(1, -1) : inline
      out.push(...body.split(',').map(unquote))
      continue
    }
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^[ \t]*-[ \t]+(.*)$/.exec(lines[j])
      if (!item) break
      out.push(unquote(item[1]))
    }
  }
  return out.filter(Boolean)
}

function visible(target: string): string {
  const [page, ...subs] = target.split('#')
  return [page, ...subs.filter((s) => !s.startsWith('^'))]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' > ')
}

export function extractMarkdownText(
  source: Uint8Array | string,
  opts: ExtractOptions = {},
): MarkdownExtract {
  let md = (typeof source === 'string' ? source : decodeText(source)).replace(/\r\n?/g, '\n')
  if (md.charCodeAt(0) === 0xfeff) md = md.slice(1)

  const metadata: MarkdownMetadata = { tags: [], aliases: [], links: [] }
  const fm = FRONT_MATTER.exec(md)
  if (fm) {
    metadata.tags = readList(fm[1], ['tags', 'tag']).map((t) => t.replace(/^#/, ''))
    metadata.aliases = readList(fm[1], ['aliases', 'alias'])
    md = md.slice(fm[0].length)
  }

  const links = new Set<string>()
  const rewrite = (part: string) =>
    part
      .replace(HTML_COMMENT, '')
      .replace(OBSIDIAN_COMMENT, '')
      .replace(EMBED, '')
      .replace(IMAGE, '')
      .replace(WIKILINK, (_all, inner: string) => {
        const [target, alias] = inner.split(/\\?\|/, 2)
        if (target.trim()) links.add(target.trim())
        return alias?.trim() || visible(target)
      })

  let text = ''
  let at = 0
  for (const fence of md.matchAll(FENCE)) {
    text += rewrite(md.slice(at, fence.index)) + fence[0]
    at = fence.index + fence[0].length
  }
  text = (text + rewrite(md.slice(at))).trim()
  metadata.links = [...links]

  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  if (text.length > maxChars) throw new TextTooLongError(maxChars)
  return { text, metadata }
}
