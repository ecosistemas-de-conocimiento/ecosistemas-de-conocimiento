#!/usr/bin/env bash
# Generate the Spanish speech fixture used by tests/test_transcribe_e2e.py.
#
# We do NOT commit an audio blob: no binaries in git, no licensing question, and
# a generated fixture proves the toolchain works on the machine running it.
#
# Requires espeak-ng (a ~4 MB apt package) plus ffmpeg. espeak-ng is a formant
# synthesiser, so the result is robotic — which is deliberately harder for the
# model than real speech. The e2e test therefore asserts CONTENT-WORD RECALL
# (did the expected Spanish words appear?) rather than an exact string or a WER
# threshold, because a WER number against synthetic speech would be a number
# about espeak, not about our pipeline.
#
#   sudo apt-get install -y espeak-ng ffmpeg
#   ./scripts/make-fixtures.sh
#
# If espeak-ng is unavailable, the e2e test SKIPS. It does not silently pass.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="${HERE}/../tests/fixtures"
mkdir -p "${FIXTURES}"

if ! command -v espeak-ng >/dev/null 2>&1; then
  echo "espeak-ng not found. Install it (apt-get install espeak-ng) and re-run." >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found." >&2
  exit 1
fi

# The sentence is duplicated in tests/test_transcribe_e2e.py — keep them in sync.
TEXT="La reunión del comité de transparencia se celebró el martes en la ciudad de Morelia. Se aprobó el presupuesto para el programa de educación ambiental."

echo "[fixtures] synthesising Spanish speech with espeak-ng"
espeak-ng -v es -s 140 -w "${FIXTURES}/_raw.wav" "${TEXT}"

# Normalise to what the service consumes, so the fixture exercises the real path.
ffmpeg -nostdin -hide_banner -loglevel error -y \
  -i "${FIXTURES}/_raw.wav" -ac 1 -ar 16000 -c:a pcm_s16le \
  "${FIXTURES}/spanish-sample.wav"

# Also produce an m4a so the format-conversion path is exercised end to end.
ffmpeg -nostdin -hide_banner -loglevel error -y \
  -i "${FIXTURES}/spanish-sample.wav" -c:a aac -b:a 64k \
  "${FIXTURES}/spanish-sample.m4a"

rm -f "${FIXTURES}/_raw.wav"
echo "[fixtures] wrote ${FIXTURES}/spanish-sample.{wav,m4a}"
