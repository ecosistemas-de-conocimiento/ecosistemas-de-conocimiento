/**
 * A web page as plain text for the ingest path.
 *
 * 🔴 TEXT ONLY, NEVER MARKUP. Nothing downstream renders this as HTML, and the
 * stored file is served as `text/plain` (see `textUploadsAreText` in
 * `collections/Media.ts`). `parse5`'s tokenizer only tokenizes: it runs no
 * script and fetches no linked resource — `<img>`, `<iframe>`, `<link>` are
 * dropped unread.
 *
 * 🔴 A STREAM OF TOKENS, NEVER A TREE. parse5's tree builder is quadratic on
 * deep nesting (390 KB of nested tags took 40 s, audit 2026-10-26) and the old
 * recursive walk overflowed the stack near 20,000 levels. Tokens arrive in
 * document order and each is handled in O(1) with a few flags and counters,
 * so nesting depth costs nothing. Implied end tags (`<li>uno<li>dos`,
 * `<td>a<td>b`) are closed the way a browser would for these elements.
 *
 * Kept: headings (`#` per level), paragraphs, list items (`- `), table rows
 * (cells joined with ` | `), `<pre>` as written. Dropped: script, style, nav,
 * head, and the embedded or interactive elements in `SKIP`.
 */

import { Tokenizer, TokenizerMode, type TokenHandler } from 'parse5'

import { DEFAULT_MAX_CHARS, decodeText, LineSink, type ExtractOptions } from './text'

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
  'title',
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

/** Elements that never have content or an end tag. */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** Elements whose content the tokenizer must read as text, not markup. */
const RAW_MODE: Record<string, Tokenizer['state']> = {
  script: TokenizerMode.SCRIPT_DATA,
  style: TokenizerMode.RAWTEXT,
  xmp: TokenizerMode.RAWTEXT,
  iframe: TokenizerMode.RAWTEXT,
  noembed: TokenizerMode.RAWTEXT,
  noframes: TokenizerMode.RAWTEXT,
  noscript: TokenizerMode.RAWTEXT,
  title: TokenizerMode.RCDATA,
  textarea: TokenizerMode.RCDATA,
  plaintext: TokenizerMode.PLAINTEXT,
}

/** Turns the token stream into lines. Every handler is O(1) in nesting depth. */
class Extractor implements TokenHandler {
  private inline = ''
  /** The SKIP element being skipped, and how deep inside same-named ones. */
  private skipTag: string | null = null
  private skipDepth = 0
  private preDepth = 0
  private pre = ''
  private liOpen = false
  private row: string[] | null = null
  private cell: string | null = null

  /** Set right after construction: the tokenizer needs the handler first. */
  tokenizer!: Tokenizer

  constructor(readonly sink: LineSink) {}

  private flush(prefix = ''): void {
    const line = this.inline.replace(/\s+/g, ' ').trim()
    this.inline = ''
    if (line) this.sink.push(prefix + line)
  }

  private closeCell(): void {
    if (this.row && this.cell !== null) this.row.push(this.cell.replace(/\s+/g, ' ').trim())
    this.cell = null
  }

  private closeRow(): void {
    this.closeCell()
    const cells = this.row
    this.row = null
    if (!cells) return
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
    if (cells.length > 0) this.sink.push(cells.join(' | '))
  }

  private closeLi(): void {
    if (this.liOpen) this.flush('- ')
    this.liOpen = false
  }

  private closePre(): void {
    const raw = this.pre.replace(/^\n/, '').replace(/\s+$/, '')
    this.pre = ''
    for (const line of raw.split('\n')) this.sink.push(line)
  }

  private text(s: string): void {
    if (this.skipTag) return
    if (this.preDepth > 0) this.pre += s
    else if (this.cell !== null) this.cell += s
    else if (this.row) return // whitespace between cells
    else this.inline += s
  }

  onStartTag(token: { tagName: string; selfClosing: boolean }): void {
    const name = token.tagName
    if (this.skipTag) {
      if (name === this.skipTag && !token.selfClosing) this.skipDepth++
      // `<head>` has no end tag when `<body>` opens it implicitly.
      else if (this.skipTag === 'head' && name === 'body') this.skipTag = null
      return
    }
    if (SKIP.has(name)) {
      if (VOID.has(name) || token.selfClosing) return
      this.skipTag = name
      this.skipDepth = 1
      this.tokenizer.inForeignNode = name === 'svg' || name === 'math'
      if (RAW_MODE[name] !== undefined) this.tokenizer.state = RAW_MODE[name]
      return
    }
    if (RAW_MODE[name] !== undefined) this.tokenizer.state = RAW_MODE[name]

    if (name === 'br') {
      if (this.preDepth > 0) this.pre += '\n'
      else if (this.cell !== null) this.cell += ' '
      else this.flush()
      return
    }
    if (name === 'pre') {
      if (this.preDepth++ === 0) this.flush()
      return
    }
    if (this.preDepth > 0) return
    if (name === 'tr') {
      this.closeRow()
      this.flush()
      this.row = []
      return
    }
    if (name === 'td' || name === 'th') {
      if (!this.row) {
        this.flush()
        this.row = []
      }
      this.closeCell()
      this.cell = ''
      return
    }
    if (this.cell !== null) return // markup inside a cell is inline text
    if (name === 'li') {
      if (this.liOpen) this.closeLi()
      else this.flush()
      this.liOpen = true
      return
    }
    if (HEADING.test(name) || BLOCK.has(name)) this.flush()
  }

  onEndTag(token: { tagName: string }): void {
    const name = token.tagName
    if (this.skipTag) {
      if (name === this.skipTag && --this.skipDepth === 0) {
        this.skipTag = null
        this.tokenizer.inForeignNode = false
      }
      return
    }
    if (name === 'pre') {
      if (this.preDepth > 0 && --this.preDepth === 0) this.closePre()
      return
    }
    if (this.preDepth > 0) return
    if (name === 'td' || name === 'th') return this.closeCell()
    if (name === 'tr' || name === 'table' || name === 'tbody' || name === 'thead' || name === 'tfoot') {
      return this.closeRow()
    }
    if (this.cell !== null) return
    if (name === 'li') return this.closeLi()
    if (name === 'ul' || name === 'ol') this.closeLi()
    const heading = HEADING.exec(name)
    if (heading) return this.flush('#'.repeat(Number(heading[1])) + ' ')
    if (BLOCK.has(name)) this.flush()
  }

  onCharacter(token: { chars: string }): void {
    this.text(token.chars)
  }
  onWhitespaceCharacter(token: { chars: string }): void {
    this.text(token.chars)
  }
  onNullCharacter(): void {}
  onComment(): void {}
  onDoctype(): void {}

  onEof(): void {
    if (this.preDepth > 0) this.closePre()
    this.closeRow()
    this.closeLi()
    this.flush()
  }
}

export function extractHtmlText(bytes: Uint8Array, opts: ExtractOptions = {}): string {
  const extractor = new Extractor(new LineSink(opts.maxChars ?? DEFAULT_MAX_CHARS))
  extractor.tokenizer = new Tokenizer({}, extractor)
  extractor.tokenizer.write(decodeText(bytes), true)
  return extractor.sink.text()
}
