#!/usr/bin/env bash
# Convert slide decks to PDF so the app can take them (it accepts PDF and DOCX).
# No manual tweaking: LibreOffice's own export, nothing else.
# ⚠ Needs the Impress component (Debian/Ubuntu: libreoffice-impress); without it
#   soffice answers "source file could not be loaded".
#
#   scripts/ingest/pptx-to-pdf.sh <out dir> <file.pptx>…
#
# Then add the PDF to a manifest with its path relative to that manifest's SRC.
set -euo pipefail
OUT=${1:?usage: pptx-to-pdf.sh <out dir> <file.pptx>…}; shift
mkdir -p "$OUT"
# A private profile: a desktop LibreOffice already running would otherwise swallow the job.
PROFILE=$(mktemp -d); trap 'rm -rf "$PROFILE"' EXIT
soffice -env:UserInstallation="file://$PROFILE" --headless --convert-to pdf --outdir "$OUT" "$@"
