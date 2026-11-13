/**
 * Upload the corpus PDF fixture as a real document and read its state back.
 *
 * Shared by the suites that need a REAL pass through extract → gate → ingest
 * (`anonymisation.e2e.ts`, `holds.e2e.ts`, `tenancy.e2e.ts`), so none of them
 * fakes the row the pipeline is supposed to produce.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect } from 'vitest'

import { apiGet, apiJson, uploadBytes, uploadFixture, type ApiResult, type Caller } from './api'
import { REPO_ROOT } from './env'
import { fixtures } from './fixtures'

export interface DocRow {
  ingestStatus?: string
  ingestError?: string | null
  anonymisationStatus?: string
  anonymisationError?: string | null
  ingestId?: string | null
}

export async function docRow(caller: Caller, id: number): Promise<DocRow> {
  const res = await apiGet(caller, `/api/documents/${id}?depth=0`)
  const d = res.body ?? {}
  return {
    ingestStatus: d.ingestStatus,
    ingestError: d.ingestError,
    anonymisationStatus: d.anonymisationStatus,
    anonymisationError: d.anonymisationError,
    ingestId: d.ingestId,
  }
}

/** `POST /api/media` + `POST /api/documents` with `kind: 'pdf'`. Returns the document id. */
export async function uploadPdfDocument(
  caller: Caller,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const pdf = fixtures().pdf
  const media = await uploadFixture(caller, pdf.file, pdf.mimeType, `${name}.pdf`)
  return createPdfDocument(caller, name, media, extra)
}

/**
 * Render `text` to a real PDF with the same writer `scripts/corpus-fixtures.sh`
 * uses (`scripts/lib/txt_to_pdf.py`), so a test can choose the words the
 * extractor will hand the gate.
 */
export function pdfFromText(text: string): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edc-e2e-pdf-'))
  try {
    const src = path.join(dir, 'in.txt')
    const out = path.join(dir, 'out.pdf')
    fs.writeFileSync(src, text, 'utf8')
    execFileSync('python3', [path.join(REPO_ROOT, 'scripts/lib/txt_to_pdf.py'), src, out])
    return fs.readFileSync(out)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Like {@link uploadPdfDocument}, with a PDF rendered from `text` in the test. */
export async function uploadPdfTextDocument(
  caller: Caller,
  name: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const media = await uploadBytes(caller, pdfFromText(text), 'application/pdf', `${name}.pdf`)
  return createPdfDocument(caller, name, media, extra)
}

async function createPdfDocument(
  caller: Caller,
  name: string,
  media: ApiResult,
  extra: Record<string, unknown>,
): Promise<number> {
  expect(media.status, media.text.slice(0, 300)).toBe(201)

  const doc = await apiJson(caller, 'POST', '/api/documents', {
    uploadConsentVersion: 1, // = UPLOAD_CONSENT_VERSION (src/lib/uploadConsent.ts)
    name,
    kind: 'pdf',
    mode: 'rag-retrieve',
    mediaFile: media.body.doc.id,
    ...extra,
  })
  expect(doc.status, doc.text.slice(0, 300)).toBe(201)
  return Number(doc.body.doc.id)
}
