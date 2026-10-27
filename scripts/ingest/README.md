# scripts/ingest

Upload a folder of real documents into an ecosistema through the app's own path
(Mis documentos upload, then publish). No database writes.

- `ingest-folder.sh <manifest.tsv> [--apply]`: dry run by default. Resumable from its log.
  Stops under a per-org budget floor. Run the script itself for its full header.
- `pptx-to-pdf.sh <out dir> <file.pptx>…`: LibreOffice export (needs `libreoffice-impress`).

## Manifests live outside this repo

🔴 A manifest is never committed here. Source filenames and titles can carry real people's
names, so manifests sit in `plan/docs/ingest-manifests/` and are passed by path.

Format: TSV, `#` lines are comments. Columns: path (relative to `SRC`), organization id,
contentKind (`documento`), title, optional `anonymise` (the anonymisation gate).
Titles must not name private people.
