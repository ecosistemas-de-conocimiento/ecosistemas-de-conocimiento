/**
 * EVERY WORD OF THE LOCAL SEMIÓTICA CORPUS COPY — for the name check in
 * `semiosisDemo.test.ts`.
 *
 * 🔴 WHY. Every active member's name parts go into ecosistema 8's roster, and
 * the gate redacts each part wherever it stands capitalised in a documento
 * (`lib/anonymise/gate.ts`, `rosterNames`); with `keepPublicFigures` on, a
 * public figure sharing a part with a member is never restored
 * (`lib/anonymise/publicFigureRestore.ts`). So a demo student's name part that
 * also occurs in the corpus damages the corpus: "Santiago" would redact
 * Santiago Abascal in the far-right case files. The demo names must use parts
 * that occur NOWHERE in it.
 *
 * Reads `.md .txt .json .html .tsv .csv` directly, `.docx`/`.pptx` through
 * `unzip`, `.pdf` through `pdftotext` (≈30 s for the 351 PDFs, measured
 * 2026-10-28 on the dev laptop, 8 in parallel). The result is cached in the OS
 * temp dir, keyed on the folder's file list, sizes and mtimes.
 *
 * Words are accent- and case-folded ({@link foldWord}), split on anything that
 * is not a letter — the gate's whole-word, accent-blind match.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const SEMIOTICA_CORPUS_DIR = path.join(homedir(), 'chamba/cide/plan/docs/Textos del proyecto/Semiótica')

export const foldWord = (w: string): string =>
  w
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()

const WORD = /\p{L}+/gu
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.html', '.htm', '.tsv', '.csv', '.xml'])

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(p))
    else if (e.isFile()) out.push(p)
  }
  return out.sort()
}

async function textOf(file: string): Promise<string> {
  const ext = path.extname(file).toLowerCase()
  try {
    if (TEXT_EXT.has(ext)) return readFileSync(file, 'utf8')
    if (ext === '.docx' || ext === '.pptx' || ext === '.xlsx') {
      const { stdout } = await run('unzip', ['-p', file], { maxBuffer: 512 * 1024 * 1024, encoding: 'latin1' })
      // XML inside a zip is UTF-8; re-decode, then drop the tags.
      return Buffer.from(stdout, 'latin1').toString('utf8').replace(/<[^>]+>/g, ' ')
    }
    if (ext === '.pdf') {
      const { stdout } = await run('pdftotext', ['-q', file, '-'], { maxBuffer: 512 * 1024 * 1024 })
      return stdout
    }
  } catch {
    // An unreadable file adds no words; the count of read files says how many.
  }
  return ''
}

export interface CorpusVocabulary {
  words: Set<string>
  files: number
}

/** null when the folder is absent (CI, another machine). */
export async function corpusVocabulary(dir: string = SEMIOTICA_CORPUS_DIR): Promise<CorpusVocabulary | null> {
  if (!existsSync(dir)) return null
  const files = listFiles(dir)
  const key = createHash('sha256')
  for (const f of files) {
    const s = statSync(f)
    key.update(`${f}\0${s.size}\0${s.mtimeMs}\n`)
  }
  const cache = path.join(tmpdir(), `edc-semiotica-vocab-${key.digest('hex').slice(0, 16)}.txt`)
  if (existsSync(cache)) {
    return { words: new Set(readFileSync(cache, 'utf8').split('\n').filter(Boolean)), files: files.length }
  }
  const words = new Set<string>()
  const queue = [...files]
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
        for (const m of (await textOf(f)).matchAll(WORD)) words.add(foldWord(m[0]))
      }
    }),
  )
  writeFileSync(cache, [...words].join('\n'))
  return { words, files: files.length }
}

/** `/usr/share/dict/spanish`, folded; null when absent. */
export function spanishDictionary(file = '/usr/share/dict/spanish'): Set<string> | null {
  if (!existsSync(file)) return null
  return new Set(readFileSync(file, 'utf8').split('\n').map((w) => foldWord(w.trim())).filter(Boolean))
}
