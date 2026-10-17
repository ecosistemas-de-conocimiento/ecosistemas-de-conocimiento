#!/usr/bin/env bash
# Generation-quality eval harness (promptfoo) for ai-service.
#
#   scripts/eval-generation.sh fake     zero cost — target must point CHAT_COMPLETIONS_URL
#                                       at test-support/fake-provider/
#   scripts/eval-generation.sh real     🔴 SPENDS MONEY. Explicit OK required.
#
# MANUAL ONLY. Not in CI, not in `npm test`. See evals/README.md for what it
# measures, what it costs, and the explicit-OK rule.
set -euo pipefail

MODE="${1:-fake}"
shift || true

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/evals"

# Defaults point at a locally booted ai-service and a NEUTRAL placeholder token.
# `dev-key` is a stand-in, not a key that exists anywhere: whatever you pass
# must map to an `API_KEYS` entry on the TARGET, and the tenant behind it is
# the target's business, not this harness's. Override both from the
# environment for any target that is not a throwaway local stack.
export AI_SERVICE_URL="${AI_SERVICE_URL:-http://localhost:3000}"
export AI_SERVICE_KEY="${AI_SERVICE_KEY:-dev-key}"

# `--no-cache` because a cached row is not evidence: the point of a run is to
# re-measure. `-j 1` because the target enforces 30 requests/min on
# /v1/generate* (src/server-limits.ts) and a parallel fan-out trips it.
PROMPTFOO_ARGS=(eval --no-cache -j 1)

case "$MODE" in
  fake)
    PROMPTFOO_ARGS+=(-c promptfooconfig.fake.yaml)
    echo "[eval:generation] FAKE mode — zero cost. Target: $AI_SERVICE_URL"
    echo "[eval:generation] The target MUST point CHAT_COMPLETIONS_URL at the fake provider"
    echo "[eval:generation] (test-support/fake-provider/), or these cases buy real tokens and fail."
    ;;
  mock)
    echo "[eval:generation] 'mock' mode was renamed 'fake' on 2026-10-02 (MOCK_LLM was removed)." >&2
    exit 2
    ;;
  real)
    PROMPTFOO_ARGS+=(-c promptfooconfig.yaml)
    export AI_EVAL_JUDGE_MODEL="${AI_EVAL_JUDGE_MODEL:-openai/gpt-4o-mini}"
    if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
      echo "[eval:generation] OPENROUTER_API_KEY is unset — the judge cannot run." >&2
      exit 1
    fi
    if [[ "${AI_EVAL_CONFIRM:-}" != "yes" ]]; then
      cat >&2 <<'MSG'
[eval:generation] REFUSING to run the paid config.

  This spends real OpenRouter money twice per case: once on the target model,
  once on the LLM judge. Rodrigo's conserve-tokens rule means no LLM-judge
  sweep runs without an explicit OK.

  With that OK, re-run as:  AI_EVAL_CONFIRM=yes scripts/eval-generation.sh real
MSG
      exit 1
    fi
    echo "[eval:generation] REAL mode — SPENDING MONEY. Target: $AI_SERVICE_URL"
    echo "[eval:generation] Judge: openrouter:$AI_EVAL_JUDGE_MODEL"
    ;;
  *)
    echo "usage: scripts/eval-generation.sh [fake|real] [extra promptfoo args]" >&2
    exit 2
    ;;
esac

# PREFLIGHT: promptfoo stores its results in SQLite via libsql, and the libsql
# native binding ships as an OPTIONAL dependency (@libsql/linux-x64-gnu on this
# platform). An install done with `--omit=optional` — which is what the
# Dockerfile and CI use, deliberately, to avoid dragging 594 packages and ~2.2GB
# of playwright/onnxruntime/chromium into images that never run an eval — leaves
# promptfoo unable to start. It fails with a wall of install advice that does not
# mention the flag that caused it, so name the cause here instead.
if [[ ! -x "$REPO_ROOT/node_modules/.bin/promptfoo" ]]; then
  echo "[eval:generation] promptfoo is not installed in this checkout." >&2
  echo "[eval:generation] The harness needs a FULL install: run \`npm ci\` (no --omit flags)." >&2
  exit 1
fi

exec "$REPO_ROOT/node_modules/.bin/promptfoo" "${PROMPTFOO_ARGS[@]}" "$@"
