#!/usr/bin/env bash
# scripts/smoke.sh — post-deploy smoke for ai-service.
#
# Runs a fixed sequence of HTTP checks against a live ai-service deploy.
# Designed to be invoked locally OR from .github/workflows/smoke.yml after a
# deploy. NO tokens are baked into this script — everything is read
# from env vars. The corresponding GitHub Actions secrets are documented in
# README.md under "Deploy + smoke".
#
# Env:
#   AI_SERVICE_URL          (required) e.g. https://ai.example.com
#   AI_SERVICE_SMOKE_TOKEN  (required) bearer token with `app` role
#   AI_SERVICE_ORG          (optional) org slug; defaults to "demo"
#
# Flags:
#   --quick   Run only steps 1-3 (no LLM call). Used by the 15-min scheduled
#             cron + by every post-deploy hook where burning OpenRouter budget
#             every push is wasteful.
#
# Exit codes:
#   0  all steps passed
#   1  any step failed (HTTP non-2xx, missing field, jq parse error, ...)
#   2  bad invocation (missing env var, missing jq, unknown flag)

set -euo pipefail

# ---------------------------------------------------------------------------
# Args + env
# ---------------------------------------------------------------------------

QUICK=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    -h|--help)
      sed -n '1,30p' "$0"
      exit 0
      ;;
    *)
      echo "smoke: unknown flag '$arg'" >&2
      exit 2
      ;;
  esac
done

: "${AI_SERVICE_URL:?AI_SERVICE_URL is required}"
: "${AI_SERVICE_SMOKE_TOKEN:?AI_SERVICE_SMOKE_TOKEN is required}"
AI_SERVICE_ORG="${AI_SERVICE_ORG:-demo}"

# Strip any trailing slash on the base URL so we can concatenate paths cleanly.
BASE="${AI_SERVICE_URL%/}"

if ! command -v jq >/dev/null 2>&1; then
  echo "smoke: jq is required but not installed" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# fetch <method> <path> [extra curl args...]
#   - GETs / POSTs the target, writes body to $RESP_BODY, status to $RESP_CODE.
#   - Does NOT pass -f so we can inspect non-2xx bodies before failing.
fetch() {
  local method="$1"; shift
  local path="$1"; shift
  RESP_BODY="$(mktemp)"
  RESP_CODE="$(
    curl -sS -o "$RESP_BODY" -w '%{http_code}' \
      -X "$method" \
      "$BASE$path" \
      "$@"
  )"
}

# fail <step name>
#   Print the captured response (HTTP code + body) and bail.
fail() {
  local step="$1"
  echo "smoke: FAIL at step: $step" >&2
  echo "  HTTP: ${RESP_CODE:-<no response>}" >&2
  if [ -n "${RESP_BODY:-}" ] && [ -f "$RESP_BODY" ]; then
    echo "  Body:" >&2
    sed 's/^/    /' "$RESP_BODY" >&2
  fi
  exit 1
}

# assert_status <step> <expected>
assert_status() {
  local step="$1" expected="$2"
  if [ "$RESP_CODE" != "$expected" ]; then
    fail "$step (expected HTTP $expected, got $RESP_CODE)"
  fi
}

# assert_jq <step> <jq filter>
#   Runs the filter against $RESP_BODY; fails if the filter errors or returns
#   "null" / "false". Surfaces both the failing filter and the body.
assert_jq() {
  local step="$1" filter="$2"
  local result
  if ! result="$(jq -er "$filter" "$RESP_BODY" 2>/dev/null)"; then
    fail "$step (jq filter failed: $filter)"
  fi
  if [ -z "$result" ] || [ "$result" = "null" ] || [ "$result" = "false" ]; then
    fail "$step (jq returned empty/false for: $filter)"
  fi
}

echo "smoke: target=$BASE org=$AI_SERVICE_ORG quick=$QUICK"

# ---------------------------------------------------------------------------
# Step 1 — GET /health (liveness, no auth)
# ---------------------------------------------------------------------------
echo "-> step 1: GET /health"
fetch GET "/health"
assert_status "step 1: /health" 200
assert_jq    "step 1: /health body has status=ok" '.status == "ok"'

# ---------------------------------------------------------------------------
# Step 2 — GET /health/ready (readiness; depends on Postgres + Redis)
# ---------------------------------------------------------------------------
# Real shape is `{ status, checks: { database: { ok: bool }, redis: { ok: bool } } }`.
# We assert both subchecks report ok:true.
echo "-> step 2: GET /health/ready"
fetch GET "/health/ready"
assert_status "step 2: /health/ready"          200
assert_jq    "step 2: /health/ready status=ok"          '.status == "ok"'
assert_jq    "step 2: /health/ready database.ok"        '.checks.database.ok == true'
assert_jq    "step 2: /health/ready redis.ok"           '.checks.redis.ok == true'

# ---------------------------------------------------------------------------
# Step 3 — GET /v1/ (authenticated ping)
# ---------------------------------------------------------------------------
echo "-> step 3: GET /v1/"
fetch GET "/v1/" -H "Authorization: Bearer $AI_SERVICE_SMOKE_TOKEN"
assert_status "step 3: /v1/"                 200
assert_jq    "step 3: /v1/ echoes org"      '.org    | type == "string" and length > 0'
assert_jq    "step 3: /v1/ echoes project"  '.project | type == "string" and length > 0'

if [ "$QUICK" -eq 1 ]; then
  echo "smoke: --quick complete (steps 1-3) OK"
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 4 — POST /v1/generate/sync (real OpenRouter call, tiny prompt)
# ---------------------------------------------------------------------------
# Inline specOverride is the cheapest path: avoids registry lookups, picks the
# model directly. effortLevel=quick keeps token budget minimal. The unitKey is
# a stable string so this never collides with real generations.
echo "-> step 4: POST /v1/generate/sync"
SYNC_BODY='{
  "unit": {
    "unitKey": "smoke-test",
    "unitType": "smoke",
    "input": {},
    "specOverride": {
      "promptTemplate": "Say hello in exactly three words.",
      "model": "deepseek/deepseek-chat-v3.1"
    }
  },
  "effortLevel": "quick"
}'
fetch POST "/v1/generate/sync" \
  -H "Authorization: Bearer $AI_SERVICE_SMOKE_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$SYNC_BODY"
assert_status "step 4: /v1/generate/sync"                200
assert_jq    "step 4: text non-empty"      '.text       | type == "string" and length > 0'
assert_jq    "step 4: modelUsed present"   '.modelUsed  | type == "string" and length > 0'
assert_jq    "step 4: provider=openrouter" '.provider   == "openrouter"'
assert_jq    "step 4: costUsd >= 0"        '.costUsd    | type == "number" and . >= 0'
assert_jq    "step 4: traceId present"     '.traceId    | type == "string" and length > 0'

# ---------------------------------------------------------------------------
# Step 5 — GET /v1/budget/:org
# ---------------------------------------------------------------------------
echo "-> step 5: GET /v1/budget/$AI_SERVICE_ORG"
fetch GET "/v1/budget/$AI_SERVICE_ORG" -H "Authorization: Bearer $AI_SERVICE_SMOKE_TOKEN"
assert_status "step 5: /v1/budget/:org"               200
assert_jq    "step 5: remainingUsd is number" '.remainingUsd | type == "number"'
assert_jq    "step 5: limitUsd is number"     '.limitUsd     | type == "number"'
assert_jq    "step 5: spentUsd is number"     '.spentUsd     | type == "number"'
assert_jq    "step 5: currency is string"     '.currency     | type == "string" and length > 0'

echo "smoke: all 5 steps OK"
exit 0
