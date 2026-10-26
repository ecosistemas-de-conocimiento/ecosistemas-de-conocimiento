#!/usr/bin/env bash
# Upload a folder of real documents into ecosistemas, through the web app's own
# path: "Mis documentos" upload (POST /api/documentos), then the publish button
# (POST /api/documents/:id/publish). No database writes.
#
# HOW TO RUN
#
#   WEB=https://dev.ecosistemasdeconocimiento.com \
#   EDC_EMAIL=… EDC_PASSWORD=… \
#   SRC="/path/to/source folder" \
#   scripts/ingest/ingest-folder.sh scripts/ingest/discapacidad-2026-10.tsv [--apply]
#
#   Dry run is the default: it checks every manifest row (file exists, type,
#   size under the app's 20 MiB cap) and uploads nothing.
#
#   Optional:
#     LOG=…               result log, one TSV line per row (default: <manifest>.log)
#     BUDGET_SSH=root@…   with BUDGET_PG (postgres container name) and
#     BUDGET_FLOOR_USD=1  stop before an upload when that org's ai-service
#                         budget_state.remaining_usd is under the floor
#     GRAPH_WAIT_S=900    how long to wait for graph extraction per document
#
#   Resumable: a row whose path is already `published` in LOG is skipped.
#
# THE MANIFEST
#
#   TSV, `#` lines are comments: path (relative to SRC), organization id,
#   contentKind (documento | testimonio), title. A `testimonio` row goes through
#   the anonymisation gate and is only published once the gate clears it; this
#   script publishes it anyway only if the backend accepts the publish.
#
# PACING
#
#   One document at a time: upload, wait for ingest `ready`, publish, wait for
#   `published`, wait for the graph to leave pending/extracting. Each step polls
#   every 3 s. The embeddings of one document go to ai-service in one call.
set -euo pipefail

MANIFEST=${1:?usage: ingest-folder.sh <manifest.tsv> [--apply]}
APPLY=0; [ "${2:-}" = --apply ] && APPLY=1
: "${SRC:?SRC (source folder) is required}"
LOG=${LOG:-$MANIFEST.log}
GRAPH_WAIT_S=${GRAPH_WAIT_S:-900}
MAX_BYTES=$((20 * 1024 * 1024)) # apps/web/src/lib/config.ts MAX_UPLOAD_BYTES

ts() { date -u +%H:%M:%S; }

remaining_usd() { # org id → remaining USD, or empty when the check is off
  [ -n "${BUDGET_SSH:-}" ] || return 0
  ssh "$BUDGET_SSH" "docker exec ${BUDGET_PG:?} psql -U edc -d edc_ai -tAc \
    \"select remaining_usd from budget_state where org='edc-eco-$1'\""
}

# Signs in again before every document: a run takes hours, longer than a session token.
login() {
  local jar; jar=$(mktemp)
  jq -n --arg e "$EDC_EMAIL" --arg p "$EDC_PASSWORD" '{email:$e,password:$p}' |
    curl -sf -c "$jar" -H 'Content-Type: application/json' -H "Origin: $WEB" \
      --data-binary @- "$WEB/api/auth/login" >/dev/null || { rm -f "$jar"; echo "login failed"; exit 1; }
  # ⚠ curl's jar writes HttpOnly cookies (the session) as `#HttpOnly_<domain>` lines.
  SESSION_COOKIES=$(sed 's/^#HttpOnly_//' "$jar" | awk '!/^#/ && NF>=7 {printf "%s=%s; ", $6, $7}')
  rm -f "$jar"
}
[ $APPLY = 1 ] && : "${WEB:?}" "${EDC_EMAIL:?}" "${EDC_PASSWORD:?}"

api() { # org method path [curl args…]
  local org=$1 method=$2 path=$3; shift 3
  curl -s -X "$method" -H "Origin: $WEB" -H "Cookie: ${SESSION_COOKIES}eco_selected=$org" \
    "$@" "$WEB$path"
}

wait_field() { # org id field timeout_s done_regex → final value
  local org=$1 id=$2 field=$3 limit=$4 re=$5 v="" t=0
  while [ "$t" -lt "$limit" ]; do
    v=$(api "$org" GET "/api/documents/$id" | jq -r --arg f "$field" '.[$f] // .doc[$f] // empty' 2>/dev/null || true)
    [[ "$v" =~ $re ]] && break
    sleep 3; t=$((t + 3))
  done
  echo "${v:-unknown}"
}

n=0
grep -v '^#' "$MANIFEST" | while IFS=$'\t' read -r path org kind title; do
  [ -n "$path" ] || continue
  n=$((n + 1))
  file="$SRC/$path"
  if [ ! -f "$file" ]; then echo "[$n] MISSING $path"; continue; fi
  size=$(stat -c %s "$file")
  if [ "$size" -gt "$MAX_BYTES" ]; then echo "[$n] TOO BIG ($size) $path"; continue; fi
  case "$path" in
    *.pdf) mime=application/pdf ;;
    *.docx) mime=application/vnd.openxmlformats-officedocument.wordprocessingml.document ;;
    *) echo "[$n] UNSUPPORTED $path"; continue ;;
  esac
  if [ $APPLY = 0 ]; then echo "[$n] ok org=$org $kind $size B · $title"; continue; fi
  if [ -f "$LOG" ] && awk -F'\t' -v p="$path" '$2==p && $5=="published"' "$LOG" | grep -q .; then
    echo "[$n] skip (published) $path"; continue
  fi

  rem=$(remaining_usd "$org")
  if [ -n "$rem" ] && awk -v r="$rem" -v f="${BUDGET_FLOOR_USD:-1}" 'BEGIN{exit !(r<f)}'; then
    echo "$(ts) [$n] STOP: edc-eco-$org has \$$rem left, floor \$${BUDGET_FLOOR_USD:-1}"; exit 2
  fi

  t0=$(date +%s)
  login
  # ⚠ Quoted: curl -F splits an unquoted `@a,b` into two files (exit 26).
  res=$(api "$org" POST /api/documentos -F "file=@\"$file\";type=$mime" \
    -F "contentKind=$kind" -F "name=$title")
  id=$(jq -r '.doc.id // .id // empty' <<<"$res" 2>/dev/null || true)
  if [ -z "$id" ]; then
    echo "$(ts) [$n] UPLOAD FAILED $path: $(head -c 300 <<<"$res")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(ts)" "$path" "$org" "" upload-failed "" "" >>"$LOG"
    continue
  fi
  ingest=$(wait_field "$org" "$id" ingestStatus 1800 '^(ready|failed)$')
  pub=draft
  if [ "$ingest" = ready ]; then
    # The POST moves the row to `publishing` before it returns; a failed move
    # lands back on `draft` with `publicationError` set (lib/publishDocument.ts).
    code=$(api "$org" POST "/api/documents/$id/publish" -o /dev/null -w '%{http_code}')
    if [[ "$code" == 2* ]]; then
      pub=$(wait_field "$org" "$id" publicationStatus 1800 '^(published|draft)$')
    else
      pub="publish-http-$code"
    fi
  fi
  graph=$(wait_field "$org" "$id" graphStatus "$GRAPH_WAIT_S" '^(ready|failed|skipped|n/a)$')
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(ts)" "$path" "$org" "$id" "$pub" "$ingest/$graph" \
    "$(($(date +%s) - t0))s" >>"$LOG"
  echo "$(ts) [$n] doc $id ingest=$ingest publish=$pub graph=$graph $(($(date +%s) - t0))s · $title"
done
