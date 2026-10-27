/**
 * Shared helpers for the text-based upload kinds (csv, html).
 *
 * `looksLikeText` is the content sniff: csv and html have no magic number, so
 * file-type detects nothing and Payload falls back to the extension. This is
 * the check that the bytes really are text — never a binary renamed `.csv`.
 */

export class TextTooLongError extends Error {
  constructor(maxChars: number) {
    super(`text_too_long: the file produces more than ${maxChars} characters of text`)
  }
}

/**
 * The file would cost more memory or time than an extraction may spend.
 * Also what a worker killed for running out of heap reports (`./sandbox.ts`).
 */
export class ExtractTooLargeError extends Error {
  constructor(detail: string) {
    super(`extract_too_large: ${detail}`)
  }
}

const startsWith = (b: Uint8Array, magic: number[]) => magic.every((byte, i) => b[i] === byte)

const BINARY_MAGICS: number[][] = [
  [0x4d, 0x5a], // MZ — Windows executable
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat / Java class
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O
  [0x23, 0x21], // #! — a script
  [0x50, 0x4b, 0x03, 0x04], // ZIP
  [0x25, 0x50, 0x44, 0x46], // %PDF
]

/** Tab, LF, FF, CR are text; every other C0 control (NUL included) is not. */
const isControl = (c: number) => c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d

/**
 * Is this WHOLE file plain text (UTF-8, Windows-1252 or BOM-marked UTF-16)?
 *
 * 🔴 Every byte is read, not a head sample: a text head over a binary tail
 * passed the old 8 KB sniff. Uploads are size-capped, so this is one linear
 * pass. A UTF-16 file is judged on its DECODED text — a BOM alone used to wave
 * any bytes after it through.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  const utf16 =
    bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null
  if (utf16) {
    if (bytes.length % 2 !== 0) return false
    let text: string
    try {
      text = new TextDecoder(utf16, { fatal: true }).decode(bytes.subarray(2))
    } catch {
      return false
    }
    for (let i = 0; i < text.length; i++) if (isControl(text.charCodeAt(i))) return false
    return true
  }
  if (BINARY_MAGICS.some((m) => startsWith(bytes, m))) return false
  for (let i = 0; i < bytes.length; i++) if (isControl(bytes[i])) return false
  return true
}

/** UTF-8 (BOM dropped), BOM-marked UTF-16, else Windows-1252 — Excel's Spanish default. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    // `ignoreBOM: false` (the default) strips a UTF-8 BOM.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

/** Collects output lines and stops the moment they pass `maxChars`. */
export class LineSink {
  readonly lines: string[] = []
  private size = 0
  constructor(private readonly maxChars: number) {}

  push(line: string): void {
    this.size += line.length + 1
    if (this.size > this.maxChars + 1) throw new TextTooLongError(this.maxChars)
    this.lines.push(line)
  }

  text(): string {
    return this.lines.join('\n')
  }
}

export type ExtractOptions = { maxChars?: number }

/** Mirrors `DOCUMENT_TEXT_MAX_LENGTH` in `collections/Documents.ts`, which passes it explicitly. */
export const DEFAULT_MAX_CHARS = 2_000_000
