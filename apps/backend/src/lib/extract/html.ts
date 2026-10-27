/**
 * A web page as plain text for the ingest path.
 *
 * 🔴 TEXT ONLY, NEVER MARKUP. Nothing downstream renders this as HTML, and the
 * stored file is served as `text/plain` (see `textUploadsAreText` in
 * `collections/Media.ts`). `parse5` only parses: it runs no script and fetches
 * no linked resource — `<img>`, `<iframe>`, `<link>` are dropped unread.
 *
 * Kept: headings (`#` per level), paragraphs, list items (`- `), table rows
 * (cells joined with ` | `), `<pre>` as written. Dropped: script, style, nav,
 * head, and the embedded or interactive elements in `SKIP`.
 */

import { parse } from 'parse5'

import { DEFAULT_MAX_CHARS, decodeText, LineSink, type ExtractOptions } from './text'

type Node = {
  nodeName: string
  value?: string
  childNodes?: Node[]
  content?: Node
}

const SKIP = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
  'nav',
  'svg',
  'math',
  'iframe',
  'object',
  'embed',
  'canvas',
  'audio',
  'video',
  'img',
  'button',
  'select',
])

const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hr',
  'li',
  'main',
  'ol',
  'p',
  'section',
  'summary',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'tr',
  'ul',
])

const HEADING = /^h([1-6])$/

class Writer {
  private inline = ''
  constructor(readonly sink: LineSink) {}

  text(s: string): void {
    this.inline += s
  }

  /** End the current line, if it holds any text. */
  flush(prefix = ''): void {
    const line = this.inline.replace(/\s+/g, ' ').trim()
    this.inline = ''
    if (line) this.sink.push(prefix + line)
  }
}

/** Every text node under `node`, whitespace collapsed — for one table cell. */
function inlineText(node: Node): string {
  if (node.nodeName === '#text') return node.value ?? ''
  if (SKIP.has(node.nodeName)) return ''
  if (node.nodeName === 'br') return ' '
  return (node.childNodes ?? []).map(inlineText).join(' ')
}

function walk(node: Node, w: Writer): void {
  const name = node.nodeName
  if (name === '#text') return w.text(node.value ?? '')
  if (name.startsWith('#') && name !== '#document' && name !== '#document-fragment') return
  if (SKIP.has(name)) return

  if (name === 'br') return w.flush()

  if (name === 'pre') {
    w.flush()
    const raw = inlinePre(node).replace(/^\n/, '').replace(/\s+$/, '')
    for (const line of raw.split('\n')) w.sink.push(line)
    return
  }

  if (name === 'tr') {
    w.flush()
    const cells = (node.childNodes ?? [])
      .filter((c) => c.nodeName === 'td' || c.nodeName === 'th')
      .map((c) => inlineText(c).replace(/\s+/g, ' ').trim())
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
    if (cells.length > 0) w.sink.push(cells.join(' | '))
    return
  }

  const heading = HEADING.exec(name)
  if (heading) {
    w.flush()
    for (const child of node.childNodes ?? []) walk(child, w)
    return w.flush('#'.repeat(Number(heading[1])) + ' ')
  }

  if (name === 'li') {
    w.flush()
    for (const child of node.childNodes ?? []) walk(child, w)
    return w.flush('- ')
  }

  const block = BLOCK.has(name)
  if (block) w.flush()
  for (const child of node.childNodes ?? []) walk(child, w)
  if (block) w.flush()
}

/** `<pre>` text with its whitespace intact. */
function inlinePre(node: Node): string {
  if (node.nodeName === '#text') return node.value ?? ''
  if (SKIP.has(node.nodeName)) return ''
  if (node.nodeName === 'br') return '\n'
  return (node.childNodes ?? []).map(inlinePre).join('')
}

export function extractHtmlText(bytes: Uint8Array, opts: ExtractOptions = {}): string {
  const doc = parse(decodeText(bytes)) as unknown as Node
  const w = new Writer(new LineSink(opts.maxChars ?? DEFAULT_MAX_CHARS))
  walk(doc, w)
  w.flush()
  return w.sink.text()
}
