#!/bin/bash
# OLD vs NEW detector prompt, Spark only (GATE_BACKEND=spark: no hosted fallback).
S=/tmp/claude-1000/-home-furenku-chamba-cide-ecosistemas-de-conocimiento/e0642291-cfa2-453e-ba53-15eba47cd2e0/scratchpad
OUT=$S/q24/out
mkdir -p $OUT
chmod 700 $OUT
for f in $S/q24/q24-public.txt $S/q24/q24-classes.txt $S/q24/q10.txt $S/q24/kinship.txt $S/q24/xochi2.txt $S/q24/staff-draft.txt; do
  name=$(basename $f .txt)
  for prompt in old new; do
    extra=""
    [ $prompt = old ] && extra="GATE_SYSTEM_PROMPT_FILE=$S/old-prompt.txt"
    echo "== $name $prompt $(date -u +%H:%M:%S)"
    env GATE_BACKEND=spark GATE_KIND=documento GATE_RUNS=2 GATE_ORG=7 GATE_TEXT_FILE=$f GATE_OUT=$OUT/$name-$prompt.jsonl $extra \
      timeout 900 $S/m.sh node_modules/.bin/payload run scripts/measure-anonymise-gate.ts 2>&1 \
      | grep -E "^backend:|^system prompt:|openai-compat|HTTP|Error|error" | grep -v "^\[anonymise-detect\] openai-compat" | head -5
  done
done
echo DONE
