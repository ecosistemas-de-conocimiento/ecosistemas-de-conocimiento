/**
 * SPLITTING A DOCUMENT FOR THE DETECTOR.
 *
 * ── WHY THE DETECTOR CANNOT SEE THE WHOLE DOCUMENT AT ONCE ──────────────────
 *
 * The limit is the number of FINDINGS, not the length of the input. ai-service
 * caps a `quick`-tier reply at 400 output tokens, and the model's JSON list of
 * findings costs ~15–25 tokens each (measured 2026-10-17, local stack, real
 * model, 12 calls): a 218-word text came back complete with 11 findings in
 * 206–290 tokens, and every text from 1,191 words up was cut off at 400 tokens
 * after ~15–23 findings — invalid JSON, so the document was held. Every
 * multi-paragraph testimony was held. Small chunks keep each reply's list short.
 *
 * ── 🔴 THE INVARIANT ────────────────────────────────────────────────────────
 *
 * The chunks PARTITION the text: concatenated in order they are the input,
 * byte for byte, and each carries its true `[start, end)` offsets. Separators
 * (blank lines, the space after a sentence) stay attached to the chunk before
 * them, so nothing falls between two chunks where no detector would look.
 *
 * Boundaries fall between paragraphs, then between sentences, and only as a
 * last resort between words — never inside a word. A name that spans a
 * sentence boundary is not a case this has to handle; a name inside one
 * 250-word run-on sentence that gets hard-split could in principle be cut,
 * and stage 4 (verify, chunked differently because placeholders change the
 * lengths) is what catches that.
 */

export interface TextChunk {
  start: number
  end: number
  text: string
}

export function countWords(text: string): number {
  const m = text.match(/\S+/g)
  return m ? m.length : 0
}

/** Split `text` into pieces that END with the matched separator. Concatenation is lossless. */
function splitAfter(text: string, separator: RegExp): string[] {
  const out: string[] = []
  let last = 0
  for (const m of text.matchAll(separator)) {
    const end = m.index + m[0].length
    if (end > last) out.push(text.slice(last, end))
    last = end
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const PARAGRAPH = /\n[ \t]*\n\s*/g
const SENTENCE = /[.!?…]+["'»”)\]]*\s+/g
const WORD = /\S+\s*/g

/** Break one paragraph into units of at most `budget` words: sentences, then words. */
function units(paragraph: string, budget: number): string[] {
  if (countWords(paragraph) <= budget) return [paragraph]
  return splitAfter(paragraph, SENTENCE).flatMap((s) =>
    countWords(s) <= budget ? [s] : splitAfter(s, WORD),
  )
}

/**
 * Pack whole paragraphs into chunks of at most `budgetWords` words.
 *
 * ⚠ An empty text yields `[]`, and the caller must decide
 * what that means — the detector treats it as "nothing to send", which is
 * honest because there is nothing in it to find.
 */
export function chunkText(text: string, budgetWords: number): TextChunk[] {
  if (!Number.isFinite(budgetWords) || budgetWords < 1) {
    throw new RangeError(`chunkText: budget must be a positive word count, got ${budgetWords}`)
  }
  if (text.length === 0) return []

  const pieces = splitAfter(text, PARAGRAPH).flatMap((p) => units(p, budgetWords))

  const chunks: TextChunk[] = []
  let start = 0
  let buf = ''
  let bufWords = 0
  const flush = () => {
    if (buf.length === 0) return
    chunks.push({ start, end: start + buf.length, text: buf })
    start += buf.length
    buf = ''
    bufWords = 0
  }
  for (const piece of pieces) {
    const w = countWords(piece)
    if (bufWords > 0 && bufWords + w > budgetWords) flush()
    buf += piece
    bufWords += w
  }
  flush()
  return chunks
}
