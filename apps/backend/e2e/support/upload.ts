/**
 * Upload the corpus PDF fixture as a real document and read its state back.
 *
 * Shared by the suites that need a REAL pass through extract → gate → ingest
 * (`anonymisation.e2e.ts`, `holds.e2e.ts`, `tenancy.e2e.ts`), so none of them
 * fakes the row the pipeline is supposed to produce.
 */

import { expect } from 'vitest'

import { apiGet, apiJson, uploadFixture, type Caller } from './api'
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
  expect(media.status, media.text.slice(0, 300)).toBe(201)

  const doc = await apiJson(caller, 'POST', '/api/documents', {
    name,
    kind: 'pdf',
    mode: 'rag-retrieve',
    mediaFile: media.body.doc.id,
    ...extra,
  })
  expect(doc.status, doc.text.slice(0, 300)).toBe(201)
  return Number(doc.body.doc.id)
}
