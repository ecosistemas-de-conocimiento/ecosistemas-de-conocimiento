#!/usr/bin/env bash
# Turn testimonies from the corpus-generativo repo into spoken-audio fixtures.
#
# WHY THIS EXISTS. We have no recording of a real testimony, and we are not going
# to fake one with a real person's voice. The audio path (upload -> transcribe ->
# ingest) still needs something with Mexican Spanish in it: names, place names,
# "descacharrización", "ovitrampa", the words the transcriber will actually meet.
# So we read the synthetic corpus aloud with a synthetic voice.
#
# WHY PIPER AND NOT A CLOUD TTS. Free, offline after the first run, no account and
# no key in anyone's shell. ~63 MB model, ~14x realtime on CPU. The es_MX voices
# are trained on Mexican Spanish, so the vowels and the intonation are right —
# espeak-ng (used by services/audio-service/scripts/make-fixtures.sh) is a formant
# synthesiser and sounds like a robot, which is fine for a recall assertion and
# useless for demoing the product to a human.
#
# WHY THE CORPUS IS NOT VENDORED. `../corpus-generativo` is its own repo and gets
# regenerated (gen_corpus.py, seed 445). Copying its text in here would fork it on
# the first regeneration. We read it in place instead. Point CORPUS_DIR elsewhere
# if your checkout lives somewhere else.
#
#   ./scripts/corpus-voices.sh            # 3 testimonies
#   COUNT=10 ./scripts/corpus-voices.sh   # more
#   VOICE=es_MX-ald-medium ./scripts/corpus-voices.sh   # the other speaker
#
# Output: media/voces/*.m4a  (media/ is gitignored — no audio blobs in this repo)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORPUS_DIR="${CORPUS_DIR:-${ROOT}/../corpus-generativo}"
CACHE="${ROOT}/.cache/piper"
OUT="${ROOT}/media/voces"
COUNT="${COUNT:-3}"
VOICE="${VOICE:-es_MX-claude-high}"

# Two speakers exist. `claude` (high) is the clearer read; `ald` (medium) is a
# different voice, useful when you need two people in one demo.
case "${VOICE}" in
  es_MX-claude-high)  VOICE_PATH="es/es_MX/claude/high" ;;
  es_MX-ald-medium)   VOICE_PATH="es/es_MX/ald/medium" ;;
  *) echo "Unknown VOICE '${VOICE}'. Use es_MX-claude-high or es_MX-ald-medium." >&2; exit 1 ;;
esac

TXT="${CORPUS_DIR}/resultados/txt"
if [[ ! -d "${TXT}" ]]; then
  echo "corpus-generativo not found at ${CORPUS_DIR}." >&2
  echo "Clone it next to this repo:" >&2
  echo "  git clone git@github.com:furenku/corpus-generativo.git ${CORPUS_DIR}" >&2
  echo "or set CORPUS_DIR to your checkout." >&2
  exit 1
fi

command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not found." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found." >&2; exit 1; }

# Piper lives in its own venv. It is a test-fixture tool, not a runtime dependency,
# so it stays out of the workspace and out of anyone's global site-packages.
if [[ ! -x "${CACHE}/venv/bin/piper" ]]; then
  echo "[voces] installing piper-tts into ${CACHE}/venv (~34 MB, once)"
  mkdir -p "${CACHE}"
  python3 -m venv "${CACHE}/venv"
  "${CACHE}/venv/bin/pip" -q install piper-tts
fi

MODEL="${CACHE}/${VOICE}.onnx"
if [[ ! -f "${MODEL}" ]]; then
  echo "[voces] downloading voice ${VOICE} (~63 MB, once)"
  BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/${VOICE_PATH}"
  curl -sSL --fail -o "${MODEL}"      "${BASE}/${VOICE}.onnx"
  curl -sSL --fail -o "${MODEL}.json" "${BASE}/${VOICE}.onnx.json"
fi

mkdir -p "${OUT}"

# Deterministic pick, so re-running gives the same fixtures. `sort` over the
# filenames, not `shuf` — a fixture set that changes under you is not a fixture set.
mapfile -t FILES < <(ls "${TXT}"/*_testimonio_*.txt | sort | head -n "${COUNT}")
if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No testimonies found in ${TXT}." >&2
  exit 1
fi

for f in "${FILES[@]}"; do
  id="$(basename "${f}" .txt)"
  # Drop the first two lines: a "TESTIMONIO — Name" title and a metadata line
  # (role, age, place, date). A person speaking does not read their own header,
  # and leaving it in teaches the transcript a shape real audio will never have.
  tail -n +3 "${f}" | sed '/^$/d' > "${CACHE}/_body.txt"

  echo "[voces] ${id}"
  # length-scale slows the read slightly; sentence-silence puts a real breath
  # between paragraphs. Both make it sound less like a machine reading a list.
  "${CACHE}/venv/bin/piper" \
    --model "${MODEL}" \
    --length-scale 1.08 \
    --sentence-silence 0.45 \
    -f "${CACHE}/_raw.wav" < "${CACHE}/_body.txt"

  # Mono 16 kHz AAC: what a phone recording actually looks like, and inside the
  # allowlist in apps/backend/src/collections/Media.ts (audio/x-m4a).
  ffmpeg -nostdin -hide_banner -loglevel error -y \
    -i "${CACHE}/_raw.wav" -ac 1 -ar 16000 -c:a aac -b:a 48k \
    "${OUT}/${id}.m4a"
done

rm -f "${CACHE}/_raw.wav" "${CACHE}/_body.txt"
echo "[voces] wrote ${#FILES[@]} file(s) to ${OUT}"
ls -lh "${OUT}"
