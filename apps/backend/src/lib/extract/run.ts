/**
 * Every file kind's extractor, by kind. ⚠ RUNS INSIDE THE WORKER
 * (`./worker.mjs`); the server calls `extractInWorker` in `./sandbox.ts`.
 *
 * Imports stay relative (no `@/`): the worker loads this file through tsx,
 * outside the Next bundle.
 */

import type { ExtractKind } from './sandbox'

export async function extractFileText(kind: ExtractKind, bytes: Buffer, maxChars: number): Promise<string> {
  if (kind === 'pdf') {
    // The worker is a fresh realm, so drizzle-kit's `Array.prototype.random`
    // (which pdfjs rejects) is never defined here.
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(bytes))
    const { text } = await extractText(pdf, { mergePages: true })
    return Array.isArray(text) ? text.join('\n\n') : text
  }
  if (kind === 'xlsx') return (await import('./spreadsheet')).extractXlsxText(bytes, { maxChars })
  if (kind === 'csv') return (await import('./spreadsheet')).extractCsvText(bytes, { maxChars })
  // 🔴 Text only: never rendered back as HTML. See `./html.ts`.
  if (kind === 'html') return (await import('./html')).extractHtmlText(bytes, { maxChars })
  const mammoth = await import('mammoth')
  const result = await (mammoth.default ?? mammoth).extractRawText({ buffer: bytes })
  return result.value
}
