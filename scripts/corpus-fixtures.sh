#!/usr/bin/env bash
# Build every e2e upload fixture from the corpus-generativo repo.
#
# WHY THIS EXISTS. The fixtures this replaces were invented here: two
# hand-written PDFs carrying nonsense canary words (ZANAHORIA-E2E-BACKEND,
# NUBELIRIO) and `es-clip.mp3`, a 45-second recording committed as a binary with
# no recorded provenance. They tested the plumbing and nothing else. The corpus
# is 250 documents built to look like what this product actually receives —
# testimonies, cartas de presentación, oral biographies — with deliberate
# ground-truth regularities seeded through them (see its README). Testing
# against that instead means a broken chunker or a bad retrieval config shows up
# on the shape of document we will really be handed.
#
# WHY NOTHING HERE IS COMMITTED. `../corpus-generativo` is a separate repo and
# gets regenerated (`gen_corpus.py`, seed 445). A vendored copy forks from it on
# the first regeneration and then quietly tests yesterday's corpus. So the
# fixtures are BUILT, the output directories are gitignored, and re-running this
# after a corpus update is the whole upgrade path.
#
# WHAT IT PRODUCES, in both `apps/backend/e2e/fixtures` and `apps/web/e2e/fixtures`:
#
#   *.pdf           a long testimonio, rendered to a real PDF (scripts/lib/txt_to_pdf.py)
#   *.docx          a carta de presentación, copied from the corpus untouched
#   *.m4a           a testimonio read aloud (scripts/corpus-voices.sh)
#   fixtures.json   which file is which, and the marker word for each
#
# 🔴 READ `fixtures.json`, NEVER HARDCODE A FILENAME OR A MARKER. The selection
# is deterministic but the corpus is not frozen: a regeneration changes which
# document sorts first, and a test holding a literal filename then fails for a
# reason that has nothing to do with the code. `e2e/support/fixtures.ts` (backend)
# and `e2e/fixtures.ts` (web) read the manifest and are the only things that
# should know these names.
#
#   ./scripts/corpus-fixtures.sh
#
# Prerequisites: python3, ffmpeg, and a corpus-generativo checkout. The audio
# step additionally downloads ~97 MB of Piper the first time — see corpus-voices.sh.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORPUS_DIR="${CORPUS_DIR:-${ROOT}/../corpus-generativo}"
VOCES="${ROOT}/media/voces"
TARGETS=("${ROOT}/apps/backend/e2e/fixtures" "${ROOT}/apps/web/e2e/fixtures")

TXT="${CORPUS_DIR}/resultados/txt"
DOCX="${CORPUS_DIR}/resultados/docx"
MANIFEST="${CORPUS_DIR}/resultados/MANIFEST.csv"

if [[ ! -f "${MANIFEST}" ]]; then
  echo "corpus-generativo not found at ${CORPUS_DIR}." >&2
  echo "  git clone git@github.com:furenku/corpus-generativo.git ${CORPUS_DIR}" >&2
  echo "or set CORPUS_DIR to your checkout." >&2
  exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo "python3 not found." >&2; exit 1; }

# The voices are the expensive half (a model download, then ~14x realtime CPU),
# so they are cached in media/voces and only rebuilt when missing.
if ! compgen -G "${VOCES}/*.m4a" >/dev/null; then
  echo "[fixtures] no voices in ${VOCES} — building them first"
  "${ROOT}/scripts/corpus-voices.sh"
fi

# ── selection ────────────────────────────────────────────────────────────────
# Deterministic, and the three roles draw from DISJOINT slices of the corpus so
# no document is ever both the PDF and the recording:
#   pdf   <- testimonio, longitud `larga`   (long enough to chunk more than once)
#   docx  <- carta de presentación          (a real Word file, so mammoth is exercised)
#   audio <- testimonio, longitud `media`   (what corpus-voices.sh reads aloud)
PDF_SRC="$(ls "${TXT}"/*_testimonio_larga.txt | sort | head -1)"
DOCX_SRC="$(ls "${DOCX}"/*_carta_presentacion_*.docx | sort | head -1)"
AUDIO_SRC="$(ls "${VOCES}"/*.m4a | sort | head -1)"

[[ -n "${PDF_SRC}"   ]] || { echo "No *_testimonio_larga.txt in ${TXT}" >&2; exit 1; }
[[ -n "${DOCX_SRC}"  ]] || { echo "No carta_presentacion .docx in ${DOCX}" >&2; exit 1; }
[[ -n "${AUDIO_SRC}" ]] || { echo "No .m4a in ${VOCES}" >&2; exit 1; }

PDF_NAME="$(basename "${PDF_SRC}" .txt).pdf"
DOCX_NAME="$(basename "${DOCX_SRC}")"
AUDIO_NAME="$(basename "${AUDIO_SRC}")"

for dir in "${TARGETS[@]}"; do
  mkdir -p "${dir}"
  # Clear the directory rather than overwriting into it. A stale fixture from a
  # previous corpus is worse than a missing one: the tests still pass, against
  # a document nobody meant to test.
  find "${dir}" -mindepth 1 -maxdepth 1 -type f -delete

  python3 "${ROOT}/scripts/lib/txt_to_pdf.py" "${PDF_SRC}" "${dir}/${PDF_NAME}"
  cp "${DOCX_SRC}"  "${dir}/${DOCX_NAME}"
  cp "${AUDIO_SRC}" "${dir}/${AUDIO_NAME}"
done

# ── manifest ─────────────────────────────────────────────────────────────────
# The marker for each fixture is the subject's NAME, read out of the corpus's own
# MANIFEST.csv rather than parsed out of the prose. Names are unique across the
# 250 documents, so "this exact name came back" can only mean the text travelled
# from THIS file, through extraction, into the row.
#
# ⚠ THE AUDIO MARKER IS NOT ASSERTABLE. It is a transcriber's guess at a spoken
# proper noun, and Whisper will not reliably spell `Valdés Colín`. It is recorded
# so a human reading a failure knows whose testimony it is, and for nothing else.
CORPUS_HEAD="$(git -C "${CORPUS_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"

python3 - "$@" <<PY
import csv, json, os, subprocess

corpus   = ${CORPUS_DIR@Q}
manifest = {r["archivo"]: r for r in csv.DictReader(open(${MANIFEST@Q}, encoding="utf-8"))}

# The MIME type each fixture must be uploaded as. Recorded here rather than
# sniffed in the tests: this is the value the browser would send, and it has to
# stay inside MEDIA_MIME_TYPES in apps/backend/src/collections/Media.ts.
MIME = {
    ".pdf":  "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".m4a":  "audio/x-m4a",
}

def entry(source_basename, fixture_name, **extra):
    row = manifest[source_basename]
    return dict(
        file=fixture_name,
        source=source_basename,
        mimeType=MIME[os.path.splitext(fixture_name)[1]],
        marker=row["nombre"],
        ecosistema=row["ecosistema"],
        formato=row["formato"],
        words=int(row["palabras"]),
        **extra,
    )

def duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True).stdout.strip()
    return round(float(out), 1)

audio_file = ${AUDIO_NAME@Q}
data = {
    "_comment": (
        "GENERATED by scripts/corpus-fixtures.sh from the corpus-generativo repo. "
        "Do not edit; do not commit. Re-run the script after a corpus update."
    ),
    "corpusCommit": ${CORPUS_HEAD@Q},
    "pdf":   entry(${PDF_SRC@Q}.split("/")[-1],  ${PDF_NAME@Q}),
    "docx":  entry(${DOCX_NAME@Q},               ${DOCX_NAME@Q}),
    "audio": entry(
        audio_file.replace(".m4a", ".txt"),
        audio_file,
        durationSeconds=duration(os.path.join(${TARGETS[0]@Q}, audio_file)),
        markerIsAssertable=False,
    ),
}

for target in [${TARGETS[0]@Q}, ${TARGETS[1]@Q}]:
    with open(os.path.join(target, "fixtures.json"), "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

print(f"[fixtures] pdf   {data['pdf']['file']}  marker={data['pdf']['marker']!r}")
print(f"[fixtures] docx  {data['docx']['file']}  marker={data['docx']['marker']!r}")
print(f"[fixtures] audio {data['audio']['file']}  {data['audio']['durationSeconds']}s "
      f"({data['audio']['marker']}, not assertable)")
PY

echo "[fixtures] wrote to:"
for dir in "${TARGETS[@]}"; do echo "  ${dir#${ROOT}/}"; done
