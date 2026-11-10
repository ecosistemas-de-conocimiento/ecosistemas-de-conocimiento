/**
 * The `documents` column allowlist for `documentColumns.ts`, in a module of its
 * own so the test fake (`documentColumns.testFake.ts`) can enforce the same
 * list without importing the module it replaces (a mocked module importing
 * itself never resolves).
 *
 * 🔴 Audit 2026-10-27: `publicFiguresKept` was missing here, every gate write
 * threw on Postgres, and the unit tests passed on the fake writer.
 */
export const DOCUMENT_COLUMNS = {
  id: 'id',
  kind: 'kind',
  contentKind: 'content_kind',
  publicationStatus: 'publication_status',
  publicationError: 'publication_error',
  ingestStatus: 'ingest_status',
  ingestError: 'ingest_error',
  ingestId: 'ingest_id',
  graphStatus: 'graph_status',
  graphError: 'graph_error',
  graphPromptVersion: 'graph_prompt_version',
  graphExtractedAt: 'graph_extracted_at',
  wikiLinks: 'wiki_links',
  anonymisationStatus: 'anonymisation_status',
  anonymisationError: 'anonymisation_error',
  anonymisationReport: 'anonymisation_report',
  anonymisationSurvivors: 'anonymisation_survivors',
  redactedText: 'redacted_text',
  heldText: 'held_text',
  heldTextHash: 'held_text_hash',
  publicFiguresKept: 'public_figures_kept',
  authorsKept: 'authors_kept',
  testimonioTitle: 'testimonio_title',
  // The note editor's autosave (`PATCH /api/documents/:id/note`, `lib/studentNotes.ts`).
  name: 'name',
  bodyMarkdown: 'body_markdown',
  isPinned: 'is_pinned',
  // "Publicar cambios" (`lib/studentNotes.ts`).
  reindexIngestId: 'reindex_ingest_id',
  updatedAt: 'updated_at',
} as const

/** True when `field` is in the allowlist. */
export function isDocumentColumnField(field: string): field is keyof typeof DOCUMENT_COLUMNS {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_COLUMNS, field)
}
