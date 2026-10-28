#!/bin/bash
# OLD vs NEW detector prompt on the synthetic inputs, Spark only ($0, no hosted fallback).
#
#   run.sh <spark env file> <out dir> <old prompt file>
#
# The env file holds ANONYMISE_DETECT_URL / _MODEL / _API_KEY (copied from the dev
# backend container's env, mode 0600, shredded after). Nothing here prints them.
# "new" is the prompt in the checked-out tree; "old" swaps in <old prompt file>
# through GATE_SYSTEM_PROMPT_FILE. GATE_ORG only labels the calls: the Spark
# backend books nothing.
set -euo pipefail
ENV_FILE=$1
OUT=$2
OLD=$3
HERE=$(cd "$(dirname "$0")" && pwd)
BACKEND=$(cd "$HERE/../../.." && pwd)
mkdir -p "$OUT"
set -a; . "$ENV_FILE"; set +a
unset AI_SERVICE_URL AI_SERVICE_API_KEY AI_SERVICE_ADMIN_API_KEY OPENROUTER_API_KEY
cd "$BACKEND"
for f in "$HERE"/inputs/*.txt; do
  name=$(basename "$f" .txt)
  for prompt in old new; do
    extra=()
    [ "$prompt" = old ] && extra=(GATE_SYSTEM_PROMPT_FILE="$OLD")
    echo "== $name $prompt $(date -u +%H:%M:%S) load $(cut -d' ' -f1-3 /proc/loadavg)"
    env GATE_BACKEND=spark GATE_KIND=documento GATE_RUNS=2 GATE_ORG=7 GATE_TEXT_FILE="$f" \
      GATE_OUT="$OUT/$name-$prompt.jsonl" "${extra[@]}" \
      timeout 900 node_modules/.bin/payload run scripts/measure-anonymise-gate.ts 2>&1 \
      | grep -E "^backend:|^system prompt:|HTTP|Error|error" | grep -v "^\[anonymise-detect\] openai-compat" | head -5 || true
  done
done
echo DONE
