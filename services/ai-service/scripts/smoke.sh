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
#   AI_SERVICE_ORG          (ignored — see below; kept only to warn)
#
# 🔴 THE ORG IS DERIVED FROM THE TOKEN, NEVER CONFIGURED. `GET /v1/` echoes the
# org the bearer token resolves to, and `GET /v1/budget/:org` 403s unless the
# path org equals exactly that (src/routes/budget.ts). A separately-configured
# org slug can therefore only ever AGREE with the token or BREAK the smoke —
# it can never make it check more. It broke it: `AI_SERVICE_ORG` was set to
# `edc` while the dev tenant's org is `example.org`, and every run failed at step 5
# with `403 cannot read budget for org '...'` — red runs saying nothing about the
# service: steps 1-4 green, including the real LLM call, step 5 403. Do not re-add a configured org.
#
# Flags:
#   --quick   Run only steps 1-3 (no LLM call). For post-deploy hooks where
#             burning OpenRouter budget on every push is wasteful.
#
# Exit codes:
#   0  all steps passed
#   1  any step failed (HTTP non-2xx, missing field, bad JSON, ...)
#   2  bad invocation (missing env var, missing python3, unknown flag)

set -euo pipefail

# ---------------------------------------------------------------------------
# Args + env
# ---------------------------------------------------------------------------

QUICK=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    -h|--help)
      sed -n '1,42p' "$0"
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

# Strip any trailing slash on the base URL so we can concatenate paths cleanly.
BASE="${AI_SERVICE_URL%/}"

# ⚠ python3, NOT jq. jq is not part of any image or box this script is
# guaranteed to run on: the self-hosted `ci-runner` box has it only because
# somebody installed it by hand (machine-inventory.md: "machine state installed
# by hand, not by any workflow"), so a rebuild of that box would silently take
# it away. python3 is preinstalled on ubuntu-latest, on ci-runner and on every
# dev machine here. test.yml's deploy step made the same choice for the same
# reason. Do not "simplify" this back to a jq one-liner.
if ! command -v python3 >/dev/null 2>&1; then
  echo "smoke: python3 is required but not installed" >&2
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

# json_check <dotted.path> <kind> [arg]   — reads $RESP_BODY.
#   kind=eq      arg is the expected value, compared as a string
#                ("ok", "true", "openrouter", ...)
#   kind=string  the value must be a non-empty JSON string
#   kind=number  the value must be a JSON number; arg, if given, is a minimum
#   kind=print   print the value and exit 0 (used to lift the org out of /v1/)
#
# Exits non-zero with a one-line reason on stdout when the assertion does not
# hold. A missing key, a null, a wrong type and a non-JSON body are all
# failures — none of them may read as success.
json_check() {
  python3 - "$RESP_BODY" "$@" <<'PY'
import json, sys

body_file, path, kind = sys.argv[1], sys.argv[2], sys.argv[3]
arg = sys.argv[4] if len(sys.argv) > 4 else None

try:
    with open(body_file) as fh:
        doc = json.load(fh)
except Exception as exc:                       # empty body, HTML error page, ...
    print("body is not valid JSON (%s)" % type(exc).__name__)
    sys.exit(1)

cur = doc
for part in path.split("."):
    if not isinstance(cur, dict) or part not in cur:
        print("no field '%s' in the response body" % path)
        sys.exit(1)
    cur = cur[part]

if kind == "print":
    # `True`/`False` would print Python-cased; only strings are ever printed.
    print(cur if isinstance(cur, str) else json.dumps(cur))
    sys.exit(0)

if kind == "eq":
    # json.dumps for scalars gives 'true'/'false'/'1.5'; strings compare raw.
    actual = cur if isinstance(cur, str) else json.dumps(cur)
    if actual != arg:
        print("%s is %r, expected %r" % (path, actual, arg))
        sys.exit(1)
    sys.exit(0)

if kind == "string":
    if not isinstance(cur, str) or not cur:
        print("%s is not a non-empty string (got %r)" % (path, cur))
        sys.exit(1)
    sys.exit(0)

if kind == "number":
    # bool is an int subclass in Python — exclude it explicitly.
    if isinstance(cur, bool) or not isinstance(cur, (int, float)):
        print("%s is not a number (got %r)" % (path, cur))
        sys.exit(1)
    if arg is not None and cur < float(arg):
        print("%s is %r, expected >= %s" % (path, cur, arg))
        sys.exit(1)
    sys.exit(0)

print("smoke: internal error — unknown json_check kind %r" % kind)
sys.exit(2)
PY
}

# assert_json <step> <dotted.path> <kind> [arg]
assert_json() {
  local step="$1"; shift
  local reason
  if ! reason="$(json_check "$@")"; then
    fail "$step ($reason)"
  fi
}

echo "smoke: target=$BASE quick=$QUICK"

# ---------------------------------------------------------------------------
# Step 1 — GET /health (liveness, no auth)
# ---------------------------------------------------------------------------
echo "-> step 1: GET /health"
fetch GET "/health"
assert_status "step 1: /health" 200
assert_json   "step 1: /health body has status=ok" status eq ok

# ---------------------------------------------------------------------------
# Step 2 — GET /health/ready (readiness; depends on Postgres + Redis)
# ---------------------------------------------------------------------------
# Real shape is `{ status, checks: { database: { ok: bool }, redis: { ok: bool } } }`.
# We assert both subchecks report ok:true.
echo "-> step 2: GET /health/ready"
fetch GET "/health/ready"
assert_status "step 2: /health/ready"            200
assert_json   "step 2: /health/ready status=ok"  status                eq ok
assert_json   "step 2: /health/ready database.ok" checks.database.ok   eq true
assert_json   "step 2: /health/ready redis.ok"    checks.redis.ok      eq true

# ---------------------------------------------------------------------------
# Step 3 — GET /v1/ (authenticated ping) — AND the source of the org slug
# ---------------------------------------------------------------------------
echo "-> step 3: GET /v1/"
fetch GET "/v1/" -H "Authorization: Bearer $AI_SERVICE_SMOKE_TOKEN"
assert_status "step 3: /v1/"                 200
assert_json   "step 3: /v1/ echoes org"      org     string
assert_json   "step 3: /v1/ echoes project"  project string

# The org the token actually resolves to. Step 5 uses this and nothing else.
ORG="$(json_check org print)"
PROJECT="$(json_check project print)"
echo "   token scope: org=$ORG project=$PROJECT"

if [ -n "${AI_SERVICE_ORG:-}" ] && [ "${AI_SERVICE_ORG}" != "$ORG" ]; then
  echo "   NOTE: AI_SERVICE_ORG='${AI_SERVICE_ORG}' is set and does not match the token's org."
  echo "         It is IGNORED — the org is read from the token. Unset it; a stale value here"
  echo "         is what kept this smoke red from 2026-05-19 to 2026-07-11."
fi

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
assert_status "step 4: /v1/generate/sync"              200
assert_json   "step 4: text non-empty"      text       string
assert_json   "step 4: modelUsed present"   modelUsed  string
assert_json   "step 4: provider=openrouter" provider   eq openrouter
assert_json   "step 4: costUsd >= 0"        costUsd    number 0
assert_json   "step 4: traceId present"     traceId    string

# ---------------------------------------------------------------------------
# Step 5 — GET /v1/budget/:org  (org from step 3, never from configuration)
# ---------------------------------------------------------------------------
echo "-> step 5: GET /v1/budget/$ORG"
fetch GET "/v1/budget/$ORG" -H "Authorization: Bearer $AI_SERVICE_SMOKE_TOKEN"
assert_status "step 5: /v1/budget/:org"                    200
assert_json   "step 5: remainingUsd is number" remainingUsd number
assert_json   "step 5: limitUsd is number"     limitUsd     number
assert_json   "step 5: spentUsd is number"     spentUsd     number
assert_json   "step 5: currency is string"     currency     string

echo "smoke: all 5 steps OK"
exit 0
