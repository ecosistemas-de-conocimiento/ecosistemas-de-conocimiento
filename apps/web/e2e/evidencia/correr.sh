#!/usr/bin/env bash
# Runs the evidence specs inside the official Playwright image, on Docker's own
# bridge network.
#
#   apps/web/e2e/evidencia/correr.sh v1               # every role
#   apps/web/e2e/evidencia/correr.sh v1 participante  # one role
#
# ⚠ Why a container: on the dev box, other sessions' test suites create and
# destroy throwaway Postgres containers every few seconds. Each one adds a
# `veth` interface, Chromium on the host reads that as a network change, and
# aborts the page load with net::ERR_NETWORK_CHANGED (measured 2026-10-27).
# A container has its own network namespace and never sees those interfaces.
#
# ⚠ It mounts the folder ABOVE the main checkout, at its own path: that holds
# the worktree, the main checkout's node_modules store (a linked worktree's
# node_modules point into it) and the credential files `escena.ts` reads.
# Mounting the worktree path alone showed an empty `e2e/evidencia/` inside the
# container (measured 2026-10-27; cause not found).
set -euo pipefail
video="${1:?uso: correr.sh <v1|v2|v3|borrador> [spec…]}"; shift || true
web="$(cd "$(dirname "$0")/../.." && pwd)"
repo="$(cd "$web/../.." && pwd)"
main_repo="$(cd "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
root="$(cd "$main_repo/.." && pwd)"
env_file="${EVID_ENV_FILE:-$root/.env}"
demo_file="${EVID_DEMO_USERS_FILE:-$root/.env.demo-users}"
# EVID_ADMIN_EMAIL: the dev backend's SEED_ADMIN_EMAIL, kept in a 0600 file
# beside the others (written from `docker exec <backend> printenv` on the box).
if [[ -z "${EVID_ADMIN_EMAIL:-}" && -r "$root/.env.evidencia" ]]; then
  EVID_ADMIN_EMAIL="$(sed -n 's/^EVID_ADMIN_EMAIL=//p' "$root/.env.evidencia")"
  export EVID_ADMIN_EMAIL
fi

exec docker run --rm --init --ipc=host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$root:$root" \
  -e EVID_ENV_FILE="$env_file" -e EVID_DEMO_USERS_FILE="$demo_file" \
  -e EVID_VIDEO="$video" -e EVID_ADMIN_EMAIL -e EVID_HOLD_MS -e EVID_ECOSISTEMA -e EVID_WEB_URL -e EVID_LIMPIAR \
  -w "$web" mcr.microsoft.com/playwright:v1.62.1-noble \
  node node_modules/@playwright/test/cli.js test -c e2e/evidencia "$@"
